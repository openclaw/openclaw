// Install fixture mocks before importing the real maintenance owners.
import "./doctor-health.test-support.js";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { formatCliCommand } from "../cli/command-format.js";
import { retireHeartbeatWithDoctor } from "../commands/doctor-heartbeat-retirement.js";
import * as doctorMaintenance from "../commands/doctor-maintenance.js";
import { runDoctorSessionSqlite } from "../commands/doctor-session-sqlite.js";
import { loadExactSessionEntry } from "../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { cronRunLogEntryToDetail } from "../cron/run-history-detail.js";
import { CronService } from "../cron/service.js";
import { resolveCronJobsStorePathFromConfig } from "../cron/store.js";
import { resolveCronStoreKeyInDatabase } from "../cron/store/paths.js";
import { readCronQuarantinedJobsInDatabase } from "../cron/store/quarantine.kernel.js";
import {
  loadedCronStoreFromRows,
  loadCronRows,
  upsertCronJobRow,
} from "../cron/store/row-codec.js";
import {
  readCronRunRecordsInDatabase,
  recordCronRunInDatabase,
} from "../cron/store/run-history.kernel.js";
import { replaceCronRuntimeAuthorityRows } from "../cron/store/runtime-authority-store.js";
import { getCronStoreKysely } from "../cron/store/schema.js";
import * as runtimePaths from "../daemon/runtime-paths.js";
import type { GatewayServiceRuntime } from "../daemon/service-runtime.js";
import { seedCompletedRuntimePinMigration } from "../daemon/test-helpers/service-audit-runtime-pin.js";
import * as legacyGatewayLock from "../infra/gateway-lock-legacy.js";
import { acquireGatewayLock } from "../infra/gateway-lock.js";
import { executeSqliteQuerySync } from "../infra/kysely-sync.js";
import * as packageJson from "../infra/package-json.js";
import * as builtRuntime from "../infra/update-git-runtime.js";
import { getFileLockProcessStartTime } from "../shared/pid-alive.js";
import { withExistingOpenClawStateDatabaseReadOnly } from "../state/openclaw-state-db-readonly.js";
import { runOpenClawStateWriteTransaction } from "../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { createTestGatewayScheduler } from "../test-utils/gateway-scheduler-clock.js";
import type { OpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { runDoctorHealthFlow } from "./doctor-health.js";
const { mocks, createDoctorRuntime, createDoctorConfig, stubDoctorEnv, withDoctorState } =
  await import("./doctor-health.test-support.js");
const candidateVersion = "2026.9.4";
const candidateBuildId = "2026.9.4-synthetic-candidate";
const runDoctor = (runtime = createDoctorRuntime()) =>
  runDoctorHealthFlow(runtime, { repair: true, nonInteractive: true });
const unverifiedState = { kind: "data-at-risk", reason: "gateway-state-unverified" };
function expectUncalled(...calls: ReturnType<typeof vi.fn>[]) {
  for (const call of calls) {
    expect(call).not.toHaveBeenCalled();
  }
}
function expectResult(resultPath: string, result: Record<string, unknown>) {
  expect(mocks.writeUpdatePostInstallDoctorResult).toHaveBeenCalledWith({
    resultPath,
    result: expect.objectContaining(result),
  });
}
const failureFacts = (...facts: Record<string, unknown>[]) =>
  expect.arrayContaining(facts.map((fact) => expect.objectContaining(fact)));
async function expectRefusal(
  run: Promise<void>,
  env: NodeJS.ProcessEnv,
  facts: unknown,
  ...commands: string[]
) {
  await expect(run).rejects.toMatchObject({
    name: "DoctorMaintenanceRefusalError",
    refusal: unverifiedState,
    failureFacts: facts,
  });
  for (const command of commands) {
    await expect(run).rejects.toThrow(formatCliCommand(`openclaw ${command}`, env));
  }
}
function resultState(
  run: (state: OpenClawTestState, resultPath: string, before: Buffer) => Promise<void>,
) {
  return withDoctorState(async (state) => {
    await state.writeConfig({});
    const resultPath = state.path("doctor-result.json");
    vi.stubEnv("OPENCLAW_UPDATE_POST_INSTALL_DOCTOR_RESULT_PATH", resultPath);
    await run(state, resultPath, fs.readFileSync(state.configPath));
  });
}
function snapshot(runtime: GatewayServiceRuntime, port: number) {
  return {
    runtime,
    portUsage: { port, status: "busy" as const, listeners: [], hints: [] },
    healthy: true,
    staleGatewayPids: [],
    gatewayVersion: candidateVersion,
    gatewayBuildId: candidateBuildId,
    gatewayBootId: "candidate-boot",
  };
}

function managedService(state: OpenClawTestState, events: string[] = []) {
  let running = true;
  let pid = 4200;
  mocks.resident.mockImplementation(() => (running ? { pid } : undefined));
  const stop = vi.fn(async () => {
    events.push("stop");
    running = false;
  });
  const restart = vi.fn(async () => {
    events.push("restart");
    pid += 1;
    running = true;
    return { outcome: "completed" as const };
  });
  const service = {
    readCommand: async () => ({
      programArguments: [
        process.execPath,
        path.join(process.cwd(), "openclaw.mjs"),
        "gateway",
        "--port",
        "19754",
      ],
      environment: { OPENCLAW_STATE_DIR: state.stateDir, OPENCLAW_CONFIG_PATH: state.configPath },
    }),
    readRuntime: async (): Promise<GatewayServiceRuntime> => ({
      status: running ? "running" : "stopped",
      ...(running ? { pid } : {}),
      systemd: { managerUid: process.getuid?.() ?? 2001 },
    }),
    readLoadState: async () => ({ status: running ? "loaded" : "not-loaded" }),
    isLoaded: async () => running,
    // Stopping the process leaves the native autostart policy unchanged.
    isEnabled: async () => true,
    stop,
    restart,
  };
  mocks.service.mockReturnValue(service);
  return service;
}

function inspectStaleBuild() {
  mocks.inspectGatewayRestart.mockImplementation(async (params) => {
    const runtime = await params.service.readRuntime(params.env ?? process.env);
    const stale = runtime.pid === 4200;
    return {
      ...snapshot(runtime, params.port),
      healthy: !stale,
      gatewayBuildId: stale ? "2026.9.4-synthetic-previous" : candidateBuildId,
      gatewayBootId: stale ? "previous-boot" : "candidate-boot",
      ...(stale
        ? {
            buildIdMismatch: { expected: candidateBuildId, actual: "2026.9.4-synthetic-previous" },
          }
        : {}),
    };
  });
}

// Exercise the published 2026.6.33 parent's markers, not the current updater's builder.
beforeEach(() => {
  stubDoctorEnv({
    OPENCLAW_UPDATE_IN_PROGRESS: "1",
    OPENCLAW_UPDATE_DEFER_CONFIGURED_PLUGIN_INSTALL_REPAIR: "1",
    OPENCLAW_UPDATE_PARENT_SUPPORTS_DOCTOR_CONFIG_WRITE: "1",
    OPENCLAW_UPDATE_PARENT_ALLOWS_GATEWAY_ACTIVATION: undefined,
    OPENCLAW_UPDATE_PARENT_ALLOWS_GATEWAY_SERVICE_REPAIR: undefined,
    OPENCLAW_UPDATE_PARENT_SUPPORTS_GATEWAY_RESTART: undefined,
    OPENCLAW_UPDATE_RUN_HANDOFF: undefined,
    OPENCLAW_UPDATE_RUN_ID: undefined,
    OPENCLAW_UPDATE_POST_INSTALL_DOCTOR_RESULT_PATH: undefined,
    OPENCLAW_SERVICE_REPAIR_POLICY: undefined,
  });
  mocks.config.mockReset().mockReturnValue({});
  mocks.packageRoot.mockReturnValue(process.cwd());
  mocks.service.mockReset();
  mocks.probePortUsage.mockReset().mockResolvedValue("free");
  mocks.restartedHealthy = true;
  mocks.emulateNativeInstall = true;
  mocks.servicePlatform = undefined;
  mocks.taskDefinitelyStopped.mockReset().mockReturnValue(true);
  mocks.startupFallbackRuntime.mockReset().mockResolvedValue(null);
  mocks.outro.mockClear();
  mocks.runContributions.mockReset().mockResolvedValue(undefined);
  mocks.writeUpdatePostInstallDoctorResult.mockClear();
  vi.spyOn(packageJson, "readPackageVersion").mockResolvedValue(candidateVersion);
  vi.spyOn(builtRuntime, "readBuiltGatewayBuildId").mockResolvedValue(candidateBuildId);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

it.each(["stopped", "live", "unproved", "notification"] as const)(
  "keeps update Doctor successful with a %s heartbeat runtime owner",
  async (ownership) => {
    await resultState(async (state, resultPath) => {
      const cfg: OpenClawConfig = createDoctorConfig(state);
      await state.writeConfig(cfg);
      const configBefore = fs.readFileSync(state.configPath);
      const storePath = resolveCronJobsStorePathFromConfig(cfg, state.env);
      const runningAtMs = Date.now() - 1_000;
      const startupNotification = ownership === "notification";
      const offline = ownership === "stopped" || startupNotification;
      const storeKey = runOpenClawStateWriteTransaction(
        ({ db }) => {
          const key = resolveCronStoreKeyInDatabase(db, storePath, state.env);
          const job = upsertCronJobRow(
            db,
            key,
            {
              id: "interrupted-monitor",
              name: "Heartbeat",
              agentId: "main",
              declarationKey: "heartbeat:main",
              enabled: true,
              createdAtMs: runningAtMs,
              updatedAtMs: runningAtMs,
              schedule: { kind: "every", everyMs: 900_000, anchorMs: runningAtMs },
              sessionTarget: "main",
              wakeMode: "next-heartbeat",
              payload: { kind: "systemEvent", text: "legacy placeholder" },
              state: { runningAtMs, ...(startupNotification ? { consecutiveErrors: 9 } : {}) },
            },
            0,
          );
          replaceCronRuntimeAuthorityRows({ db, storeKey: key, jobs: [job] });
          const row = loadCronRows(db, key)[0]!;
          // Reproduce the discriminator written by the published heartbeat owner.
          executeSqliteQuerySync(
            db,
            getCronStoreKysely(db)
              .updateTable("cron_jobs")
              .set({
                payload_kind: "heartbeat",
                job_json: JSON.stringify({
                  ...JSON.parse(row.job_json),
                  payload: { kind: "heartbeat" },
                }),
              })
              .where("store_key", "=", key),
          );
          if (startupNotification) {
            recordCronRunInDatabase(db, {
              storeKey: key,
              jobId: job.id,
              runId: `cron:${job.id}:${runningAtMs}`,
              agentId: "main",
              startedAt: runningAtMs,
              endedAt: runningAtMs + 500,
              status: "failed",
              error: "synthetic provider failure",
              detail: cronRunLogEntryToDetail(
                {
                  ts: runningAtMs + 500,
                  jobId: job.id,
                  action: "finished",
                  status: "error",
                  completionStatus: "failed",
                  error: "synthetic provider failure",
                  runAtMs: runningAtMs,
                  durationMs: 500,
                },
                { storeKey: key },
              ),
            });
          }
          return key;
        },
        { env: state.env },
      );
      const read = () =>
        withExistingOpenClawStateDatabaseReadOnly(
          ({ db }) => ({
            rows: loadCronRows(db, storeKey),
            history: readCronRunRecordsInDatabase(db),
          }),
          { env: state.env },
        )!;
      const before = read();
      await seedCompletedRuntimePinMigration(state.env);
      let live: Awaited<ReturnType<typeof acquireGatewayLock>> | undefined;
      try {
        if (!offline) {
          // Admission has its own live-writer refusal coverage. Reach the migration
          // guard here with a real live owner or no established offline custody.
          vi.spyOn(doctorMaintenance, "beginDoctorMaintenance").mockResolvedValue(undefined);
          if (ownership === "live") {
            live = await acquireGatewayLock({
              env: state.env,
              role: "gateway",
              allowInTests: true,
            });
          }
          await expect(retireHeartbeatWithDoctor(cfg, state.env)).rejects.toThrow(
            "is running or its runtime owner is unproved",
          );
        }
        const service = managedService(state);
        mocks.config.mockReturnValue(cfg);
        mocks.runContributions.mockImplementation(async () => {
          if (offline) {
            expect(await service.readRuntime()).toMatchObject({ status: "stopped" });
          }
          await retireHeartbeatWithDoctor(cfg, state.env);
        });
        const runtime = createDoctorRuntime();
        await expect(runDoctor(runtime)).resolves.toBeUndefined();
        expect(runtime.exit).not.toHaveBeenCalledWith(1);
        const after = read();
        if (startupNotification) {
          expectResult(resultPath, { status: "ok" });
          expect(loadedCronStoreFromRows(after.rows).store.jobs[0]).toMatchObject({
            payload: { kind: "agentTurn" },
            enabled: true,
            state: { runningAtMs, consecutiveErrors: 9 },
          });
          expect(after.history).toEqual(before.history);
          const notified = Promise.withResolvers<void>();
          const enqueueSessionEvent = vi.fn(async () => {
            notified.resolve();
            return { ok: true as const };
          });
          const cron = new CronService({
            scheduler: createTestGatewayScheduler(),
            storePath,
            cronEnabled: true,
            defaultAgentId: "main",
            nowMs: () => runningAtMs + 1_000,
            log: { debug() {}, info() {}, warn() {}, error() {} },
            enqueueSystemEvent: vi.fn(),
            enqueueSessionEvent,
            runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
          });
          const gateway = await acquireGatewayLock({
            env: state.env,
            role: "gateway",
            allowInTests: true,
          });
          try {
            await gateway!.run(() => cron.start());
            await notified.promise;
            expect(enqueueSessionEvent).toHaveBeenCalledExactlyOnceWith(
              expect.stringContaining("10 consecutive run failures"),
              expect.objectContaining({ agentId: "main", jobId: "interrupted-monitor" }),
            );
            const settled = read();
            const recovered = loadedCronStoreFromRows(settled.rows).store.jobs[0]!;
            expect(recovered).toMatchObject({
              payload: { kind: "agentTurn" },
              enabled: false,
              state: { consecutiveErrors: 10, autoDisabled: { reason: "consecutive-failures" } },
            });
            expect(recovered.state.runningAtMs).toBeUndefined();
            expect(settled.history).toEqual(after.history);
            expect(
              withExistingOpenClawStateDatabaseReadOnly(
                ({ db }) => readCronQuarantinedJobsInDatabase(db, storeKey),
                { env: state.env },
              ),
            ).toEqual([]);
          } finally {
            cron.stop();
            await cron.waitForIdle();
            await gateway?.release();
          }
        } else if (ownership === "stopped") {
          expectResult(resultPath, { status: "ok" });
          expect(after.rows[0]?.payload_kind).toBe("agentTurn");
          expect(JSON.parse(after.rows[0]!.state_json)).toMatchObject({
            lastRunAtMs: runningAtMs,
            lastRunStatus: "error",
          });
          expect(JSON.parse(after.rows[0]!.state_json).runningAtMs).toBeUndefined();
          expect(after.history).toEqual([
            expect.objectContaining({
              jobId: "interrupted-monitor",
              status: "failed",
              startedAt: runningAtMs,
            }),
          ]);
        } else {
          expect(after).toEqual(before);
          expect(fs.readFileSync(state.configPath)).toEqual(configBefore);
          expectResult(resultPath, {
            status: "ok",
            warnings: [expect.stringContaining("Heartbeat migration deferred")],
          });
          expect(runtime.error).toHaveBeenCalledWith(
            expect.stringContaining("Heartbeat migration deferred"),
          );
        }
      } finally {
        await live?.release();
      }
    });
  },
);

it("imports retained legacy sessions after verified stop and before any candidate RPC", async () => {
  await withDoctorState(async (state) => {
    const storePath = state.statePath("agents", "main", "sessions", "sessions.json");
    const sessionKey = "agent:main:legacy";
    const sessionId = "retained-legacy-session";
    const cfg = { agents: { entries: { main: {} } }, session: { store: storePath } };
    await state.writeConfig(cfg);
    fs.mkdirSync(path.dirname(storePath), { recursive: true });
    fs.writeFileSync(storePath, JSON.stringify({ [sessionKey]: { sessionId, updatedAt: 1 } }));
    mocks.config.mockReturnValue(cfg);
    await seedCompletedRuntimePinMigration(state.env);
    const events: string[] = [];
    const service = managedService(state, events);
    vi.spyOn(legacyGatewayLock, "readLegacyGatewayLockIdentity").mockImplementation(async () => {
      const runtime = await service.readRuntime();
      return runtime.pid === 4200
        ? { pid: 4200, state: "alive", path: state.path("legacy-gateway.lock") }
        : undefined;
    });
    mocks.inspectGatewayRestart.mockImplementation(async () => {
      throw new Error("RPC attempted before retained session import");
    });
    mocks.probePortUsage.mockImplementation(async () => {
      expect(await service.readRuntime()).toMatchObject({ status: "stopped" });
      events.push("verified-stop");
      return "free";
    });
    mocks.runContributions.mockImplementation(async (ctx) => {
      expect(ctx.gatewayMaintenanceActive).toBe(true);
      expect(events).toEqual(["stop", "verified-stop"]);
      expect(service.restart).not.toHaveBeenCalled();
      const imported = await runDoctorSessionSqlite({
        cfg: ctx.cfg,
        env: state.env,
        allAgents: true,
        mode: "import",
      });
      expect(imported.totals).toMatchObject({ importedEntries: 1, archivedLegacyStoreFiles: 1 });
      events.push("import");
    });
    mocks.waitForGatewayHealthyRestart.mockImplementation(async (params) => {
      expect(events).toEqual(["stop", "verified-stop", "import", "restart"]);
      expect(
        loadExactSessionEntry({ env: state.env, agentId: "main", storePath, sessionKey })?.entry
          .sessionId,
      ).toBe(sessionId);
      expect(params).toMatchObject({
        expectedVersion: candidateVersion,
        expectedBuildId: candidateBuildId,
      });
      events.push("verified");
      return {
        ...snapshot(await service.readRuntime(), params.port),
        outcome: "ready",
        waitOutcome: "healthy",
      };
    });

    await runDoctor();

    expect(events).toEqual(["stop", "verified-stop", "import", "restart", "verified"]);
    expect(mocks.inspectGatewayRestart).not.toHaveBeenCalled();
    expect(mocks.outro).toHaveBeenCalledWith("Doctor complete.");
  });
});

it.each(["manager-refused", "old-listener-remains"] as const)(
  "reports stale stop failure before repair mutations: %s",
  async (failure) => {
    await resultState(async (state, resultPath, configBefore) => {
      const service = managedService(state);
      inspectStaleBuild();
      if (failure === "manager-refused") {
        service.stop.mockRejectedValueOnce(new Error("synthetic native stop refused"));
      } else {
        mocks.probePortUsage.mockResolvedValue("busy");
      }
      const facts = failureFacts({ check: "gateway-stop", code: "stale-gateway-stop-failed" });
      const run = runDoctor();

      await expectRefusal(run, state.env, facts, "gateway restart", "gateway status --deep");
      expect(service.stop).toHaveBeenCalledOnce();
      expectUncalled(mocks.config, mocks.runContributions);
      expect(fs.readFileSync(state.configPath)).toEqual(configBefore);
      expectResult(resultPath, {
        status: "error",
        configHash: "unchanged",
        maintenanceRefusal: unverifiedState,
        failureFacts: facts,
      });
      expect(mocks.outro).not.toHaveBeenCalledWith("Doctor complete.");
    });
  },
);

it("records advisory restoration when the service runs without verified readiness", async () => {
  // Exercise Gateway readiness after repair, not runtime capability admission.
  vi.spyOn(runtimePaths, "resolveNodeRuntimeInfo").mockResolvedValue({
    status: "supported",
    version: "26.8.1",
    sqliteVersion: "3.53.4",
    sqliteProbe: { available: true, version: "3.53.4", text: true, blob: true, json: true },
    nodeSharedSqlite: false,
  });
  await resultState(async (state, resultPath) => {
    await seedCompletedRuntimePinMigration(state.env);
    const events: string[] = [];
    const service = managedService(state, events);
    inspectStaleBuild();
    mocks.runContributions.mockImplementation(async () => {
      events.push("repair");
    });
    mocks.waitForGatewayHealthyRestart.mockImplementation(async (params) => {
      expect(events).toEqual(["stop", "repair", "restart"]);
      return {
        ...snapshot(await service.readRuntime(), params.port),
        healthy: false,
        gatewayBuildId: null,
        gatewayBootId: undefined,
        probeError: "synthetic replacement identity unavailable",
        outcome: "failed",
        waitOutcome: "timeout",
      };
    });
    const runtime = createDoctorRuntime();
    await expect(runDoctor(runtime)).resolves.toBeUndefined();
    expectResult(resultPath, {
      status: "ok",
      warnings: expect.arrayContaining(
        [
          "Gateway started but readiness was not verified",
          "synthetic readiness failure",
          ...["status --deep", "diagnostics export"].map((command) =>
            formatCliCommand(`openclaw gateway ${command}`, state.env),
          ),
        ].map((warning) => expect.stringContaining(warning)),
      ),
    });
    expectUncalled(runtime.error);
    expect(runtime.exit).not.toHaveBeenCalledWith(1);
    expect(mocks.outro).toHaveBeenCalledWith("Doctor complete.");
    expect(events).toEqual(["stop", "repair", "restart"]);
    expect(runtime.log).not.toHaveBeenCalledWith(
      "Gateway restarted and verified after Doctor repair.",
    );
  });
});

it.each([false, true])(
  "refuses repair behind a live legacy tempfile lock (external=%s)",
  async (external) => {
    if (external) {
      vi.stubEnv("OPENCLAW_SERVICE_REPAIR_POLICY", "external");
    }
    await resultState(async (state, resultPath, configBefore) => {
      const legacyTmpDir = state.path("legacy-tmp");
      const uid = process.getuid?.();
      const lockDir = path.join(legacyTmpDir, uid === undefined ? "openclaw" : `openclaw-${uid}`);
      fs.mkdirSync(lockDir, { recursive: true });
      const configHash = createHash("sha256").update(state.configPath).digest("hex").slice(0, 8);
      const lockPath = path.join(lockDir, `gateway.${configHash}.lock`);
      const startTime = getFileLockProcessStartTime(process.pid);
      expect(startTime).not.toBeNull();
      // 6.33's lock has no port or role; Linux uses the real /proc starttime.
      const lockBefore = JSON.stringify({
        pid: process.pid,
        startTime,
        createdAt: new Date().toISOString(),
        configPath: state.configPath,
      });
      fs.writeFileSync(lockPath, lockBefore);
      const tmpdir = vi.spyOn(os, "tmpdir").mockReturnValue(legacyTmpDir);
      const service = managedService(state);
      service.readCommand = async () => {
        throw new Error("synthetic native manager unavailable");
      };

      try {
        const serviceFailure = failureFacts({ code: "stale-gateway-service-unverified" });
        const run = runDoctor();
        await expectRefusal(
          run,
          state.env,
          external ? [] : serviceFailure,
          external ? "doctor --fix" : "gateway status --deep",
        );

        expectUncalled(service.stop, service.restart, mocks.config, mocks.runContributions);
        expect(fs.readFileSync(state.configPath)).toEqual(configBefore);
        expect(fs.readFileSync(lockPath, "utf8")).toBe(lockBefore);
        expect(fs.existsSync(resolveOpenClawStateSqlitePath(state.env))).toBe(false);
        expectResult(resultPath, {
          status: "error",
          configHash: "unchanged",
          maintenanceRefusal: unverifiedState,
          failureFacts: external
            ? [
                expect.objectContaining({
                  check: "doctor",
                  code: "doctor-failed",
                  message: expect.stringContaining("Legacy Gateway lock"),
                }),
              ]
            : serviceFailure,
        });
        expect(mocks.outro).not.toHaveBeenCalledWith("Doctor complete.");
      } finally {
        tmpdir.mockRestore();
      }
    });
  },
);
