import "./doctor-health.test-support.js";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as doctorMaintenance from "../commands/doctor-maintenance.js";
import * as nocow from "../commands/doctor-sqlite-nocow.js";
import { readConfigFileSnapshot } from "../config/config.js";
import { hashConfigRaw } from "../config/io.read-helpers.js";
import * as gatewayLock from "../infra/gateway-lock.js";
import {
  acquireGatewayStateOwner,
  acquireStateDatabaseSchemaLease,
} from "../infra/gateway-state-owner.js";
import { SQLITE_READONLY_CHILD_ARG } from "../infra/runtime-process-entrypoints.js";
import { DoctorStateMigrationRefusalError } from "../infra/state-migrations.messages.js";
import {
  collectUpdateDoctorFailureFacts,
  consumeUpdatePostInstallDoctorResult,
  createUpdatePostInstallDoctorResultPath,
  UpdateDoctorError,
} from "../infra/update-doctor-result.js";
import { buildUpdateDoctorEnv } from "../infra/update-runner-doctor.js";
import { readConfiguredParsedLogTail } from "../logging/log-tail.js";
import { flushLogger, resetLogger, setLoggerOverride } from "../logging/logger.js";
import { ExitError } from "../runtime.js";
import { createDeferredCore } from "../shared/deferred.js";
import { claimOpenClawAgentDatabaseLease } from "../state/openclaw-agent-db-lease.js";
import { closeOpenClawStateDatabaseByPath } from "../state/openclaw-state-db-cache.js";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import { writeDoctorGatewayConfig } from "./doctor-health-contribution-runners.gateway.js";
import { runDoctorHealthFlow } from "./doctor-health.js";
const { mocks, createDoctorRuntime, withDoctorState } =
  await import("./doctor-health.test-support.js");
const repairOptions = { repair: true, nonInteractive: true };
const readFiles = (paths: string[]) => paths.map((file) => fs.readFileSync(file));
const readConfig = (file: string) =>
  fs.existsSync(file) ? fs.readFileSync(file, "utf8") : undefined;

function expectNoCalls(...functions: Array<{ mock: { calls: unknown[] } }>) {
  for (const fn of functions) {
    expect(fn.mock.calls).toEqual([]);
  }
}

const snapshotProcesses = vi.hoisted(() => ({
  execFile: vi.fn<typeof import("node:child_process").execFile>(),
}));
vi.mock("node:child_process", async (importOriginal) => {
  const { promisify } = await import("node:util");
  const actual = await importOriginal<typeof import("node:child_process")>();
  snapshotProcesses.execFile.mockImplementation(actual.execFile);
  Object.defineProperty(
    snapshotProcesses.execFile,
    promisify.custom,
    Object.getOwnPropertyDescriptor(actual.execFile, promisify.custom)!,
  );
  return { ...actual, execFile: snapshotProcesses.execFile };
});

const maintenance = vi.hoisted(() => ({
  signal: new AbortController().signal,
  serviceUpdateVerdict: undefined,
  warnings: [],
  failureFacts: [],
  databaseWrites: undefined,
  run: <T>(operation: () => T): T => operation(),
  finish: vi.fn(),
  releaseState: vi.fn(),
  repairSqliteNoCow: vi.fn(),
  enableSqliteReclamation: vi.fn(),
  cleanupRetainedRuntimes: vi.fn(),
  release: vi.fn(),
}));
const resultWriter = await vi.importActual<typeof import("../infra/update-doctor-result.js")>(
  "../infra/update-doctor-result.js",
);
beforeEach(() => {
  mocks.writeUpdatePostInstallDoctorResult.mockImplementation(
    resultWriter.writeUpdatePostInstallDoctorResult,
  );
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("Doctor refused-migration maintenance outcome", () => {
  it.each([false, true])(
    "publishes only after maintenance custody settles (fails=$fails)",
    async (fails) => {
      await withDoctorState(async () => {
        const resultPath = createUpdatePostInstallDoctorResultPath();
        vi.stubEnv("OPENCLAW_UPDATE_POST_INSTALL_DOCTOR_RESULT_PATH", resultPath);
        const entered = createDeferredCore();
        const release = createDeferredCore();
        const failure = new Error("maintenance cleanup remains unsettled");
        maintenance.release.mockImplementationOnce(async () => {
          entered.resolve();
          await release.promise;
          if (fails) {
            throw failure;
          }
        });
        const work = runDoctorHealthFlow(createDoctorRuntime(), repairOptions);
        const outcome = work.catch((error: unknown) => error);
        await entered.promise;
        expect(mocks.writeUpdatePostInstallDoctorResult).not.toHaveBeenCalled();
        release.resolve();
        if (fails) {
          expect(await outcome).toBe(failure);
          expect(mocks.writeUpdatePostInstallDoctorResult).not.toHaveBeenCalled();
        } else {
          await work;
          expect(mocks.writeUpdatePostInstallDoctorResult).toHaveBeenCalledOnce();
        }
        await consumeUpdatePostInstallDoctorResult(resultPath);
      });
    },
  );

  beforeEach(() => {
    vi.clearAllMocks();
    maintenance.enableSqliteReclamation.mockReset();
    vi.spyOn(doctorMaintenance, "beginDoctorMaintenance").mockResolvedValue(maintenance);
    mocks.config.mockReturnValue({});
    mocks.packageRoot.mockReturnValue(undefined);
  });

  it.each([
    { fix: false, updating: "1", request: "1", repair: false, conversion: false },
    { fix: true, updating: undefined, request: undefined, repair: true, conversion: false },
    { fix: true, updating: "1", request: undefined, repair: false, conversion: true },
    { fix: true, updating: "1", request: "1", repair: true, conversion: true },
  ])(
    "gates SQLite repairs after checks and before restoration (fix=$fix, update=$updating, request=$request)",
    async ({ fix, updating, request, repair, conversion }) => {
      vi.stubEnv("OPENCLAW_UPDATE_IN_PROGRESS", updating);
      vi.stubEnv("OPENCLAW_DOCTOR_SQLITE_NOCOW_REPAIR", request);
      const entered = createDeferredCore();
      const proceed = createDeferredCore();
      const events: string[] = [];
      const advisory =
        "SQLite store on btrfs without NOCOW: /synthetic/store.sqlite. Run openclaw doctor --fix to rewrite it while the Gateway is stopped.";
      vi.spyOn(nocow, "inspectDoctorSqliteNoCow").mockReturnValue({
        paths: ["/synthetic/store.sqlite"],
        notes: [advisory],
      });
      mocks.runContributions.mockImplementationOnce(async () => {
        entered.resolve();
        await proceed.promise;
        events.push("checks completed");
      });
      for (const [fn, event] of [
        [maintenance.repairSqliteNoCow, "repair"],
        [maintenance.enableSqliteReclamation, "conversion"],
        [maintenance.cleanupRetainedRuntimes, "cleanup"],
        [maintenance.finish, "restoration"],
      ] as const) {
        fn.mockReset().mockImplementationOnce(async () => {
          events.push(event);
        });
      }
      const runtime = createDoctorRuntime();
      const work = runDoctorHealthFlow(runtime, { repair: fix, nonInteractive: true });
      await entered.promise;
      expectNoCalls(maintenance.repairSqliteNoCow, maintenance.enableSqliteReclamation);
      proceed.resolve();
      await work;
      expect(events).toEqual([
        "checks completed",
        ...(repair ? ["repair"] : []),
        ...(conversion ? ["conversion"] : []),
        ...(fix ? ["cleanup"] : []),
        "restoration",
      ]);
      expect(maintenance.enableSqliteReclamation).toHaveBeenCalledTimes(Number(conversion));
      expect(maintenance.repairSqliteNoCow.mock.calls).toEqual(
        repair ? [[["/synthetic/store.sqlite"]]] : [],
      );
      expect(runtime.log).toHaveBeenCalledWith(advisory);
      const deferred =
        "SQLite NOCOW repair deferred: the managed updater did not request the store rewrite in this run.";
      expect(runtime.log.mock.calls.some(([message]) => message === deferred)).toBe(fix && !repair);
    },
  );

  it("settles runtime exit before forwarding database write proof", async () => {
    const resultPath = createUpdatePostInstallDoctorResultPath();
    await withDoctorState(
      async (state) => {
        await state.writeConfig({ gateway: { mode: "local" } });
        const databaseGenerations = { [state.statePath("state/openclaw.sqlite")]: null };
        const databaseWrites = { unchanged: false, generations: databaseGenerations };
        let released = false;
        const release = vi.fn(async () => {
          released = true;
        });
        vi.mocked(doctorMaintenance.beginDoctorMaintenance).mockResolvedValueOnce({
          ...maintenance,
          get databaseWrites() {
            return released ? databaseWrites : undefined;
          },
          release,
        });
        const failure = new ExitError(130);
        mocks.runContributions.mockImplementationOnce(async (ctx) => {
          ctx.runtime.exit(130);
        });
        const runtime = createDoctorRuntime();
        const work = runDoctorHealthFlow(runtime, repairOptions, {
          inputHash: hashConfigRaw(null),
          assertCurrent() {},
          databaseGenerations,
        });
        await expect(work).rejects.toEqual(failure);
        expectNoCalls(runtime.exit, mocks.outro);
        expect(maintenance.finish).toHaveBeenCalledExactlyOnceWith(undefined, undefined, failure);
        expect(release).toHaveBeenCalledOnce();
        expect(runtime.error).toHaveBeenCalledWith(
          expect.stringContaining("Check the reported service state"),
        );
        expect(doctorMaintenance.beginDoctorMaintenance).toHaveBeenCalledWith(
          expect.objectContaining({ databaseGenerations }),
        );
        await expect(consumeUpdatePostInstallDoctorResult(resultPath)).resolves.toMatchObject({
          status: "error",
          databaseWrites,
        });
      },
      { OPENCLAW_UPDATE_POST_INSTALL_DOCTOR_RESULT_PATH: resultPath },
    );
  });

  it.each(["success", "validation", "conflict", "missing-receipt"] as const)(
    "uses the latest receipt for maintenance-time token recovery (%s)",
    async (outcome) => {
      await withDoctorState(async (state) => {
        const cfg = { gateway: { mode: "local" as const }, plugins: { enabled: false } };
        await state.writeConfig(cfg);
        const planned = await readConfigFileSnapshot();
        mocks.config.mockReturnValue(cfg);
        const runtime = createDoctorRuntime();
        mocks.runContributions.mockImplementationOnce(async (ctx) => {
          // The config-flow fixture skips planning; supply the revision observed before repair.
          ctx.configResult.confirmedConfigSource = {
            path: planned.path,
            hash: planned.hash ?? hashConfigRaw(planned.raw),
          };
          await writeDoctorGatewayConfig(ctx, {
            ...ctx.cfg,
            gateway: { ...ctx.cfg.gateway, port: 19091 },
          });
          const first = await readConfigFileSnapshot();
          maintenance.finish.mockImplementationOnce(async (_cfg, writeConfig) => {
            expect(writeConfig).toBeTypeOf("function");
            if (outcome === "conflict") {
              fs.appendFileSync(state.configPath, "\n// operator-only raw drift\n");
            } else if (outcome === "missing-receipt") {
              ctx.configResult.confirmedConfigSource = { path: first.path, hash: null };
            }
            const previous = ctx.cfg;
            const files = [state.configPath, state.configPath + ".bak"];
            const retained = readFiles(files);
            const candidate = {
              ...ctx.cfg,
              gateway: {
                ...ctx.cfg.gateway,
                auth: { mode: "token" as const, token: "maintenance-recovered-token" },
                ...(outcome === "validation" ? { port: 0 } : {}),
              },
            };
            if (outcome !== "success") {
              await expect(writeConfig(candidate)).rejects.toThrow("did not persist");
              expect(ctx.configWriteRefusal).toBe(
                outcome === "validation" ? "validation" : "config-conflict",
              );
              expect(ctx.cfg).toBe(previous);
              expect(readFiles(files)).toEqual(retained);
              expect(ctx.cfg.gateway?.auth?.token).toBeUndefined();
            } else {
              await writeConfig(candidate);
            }
          });
        });
        await runDoctorHealthFlow(runtime, repairOptions);
        expect(maintenance.finish).toHaveBeenCalledOnce();
        const persisted = await readConfigFileSnapshot();
        expect(persisted.sourceConfig.gateway?.port).toBe(19091);
        expect(persisted.sourceConfig.gateway?.auth?.token).toBe(
          outcome === "success" ? "maintenance-recovered-token" : undefined,
        );
        expect(runtime.exit.mock.calls).toEqual(outcome === "success" ? [] : [[1]]);
      });
    },
  );

  it("retains migration recovery and explains why source rollback cannot undo repaired state", async () => {
    await withDoctorState(
      async (state) => {
        const root = state.path("checkout");
        fs.mkdirSync(root);
        execFileSync("git", ["init", root], { stdio: "ignore" });
        mocks.packageRoot.mockReturnValue(root);
        const failure = new DoctorStateMigrationRefusalError([
          {
            id: "agent-ownership",
            phase: "shared",
            source: [],
            target: [],
            requiredness: "required",
            reversibility: "not-applicable",
            outcome: "refused",
            changes: [],
            warnings: ["Resolve the reported ownership mismatch before retrying."],
            refusal: {
              code: "agent-database-ownership-mismatch",
              message: "Resolve the reported ownership mismatch before retrying.",
            },
          },
        ]);
        const originalMessage = failure.message;
        mocks.runContributions.mockImplementationOnce(async () => {
          await state.writeConfig({ gateway: { mode: "local" } });
          throw failure;
        });
        setLoggerOverride({
          level: "warn",
          consoleLevel: "silent",
          file: state.path("warnings.log"),
        });
        try {
          const runtime = createDoctorRuntime();
          await expect(runDoctorHealthFlow(runtime, repairOptions)).rejects.toBe(failure);
          expect(failure.message.startsWith(originalMessage)).toBe(true);
          expect(failure.message).toContain(
            "Checking out the previous source is not enough: state repairs have already run.",
          );
          expect(failure.message).toContain("Follow the migration recovery instructions above");
          for (const instruction of ["git -C", "pnpm install", "openclaw gateway start"]) {
            expect(failure.message).not.toContain(instruction);
          }
          expect(JSON.parse(fs.readFileSync(state.configPath, "utf8"))).toEqual({
            gateway: { mode: "local" },
          });
          expect(maintenance.release).toHaveBeenCalledOnce();
          expect(maintenance.finish).toHaveBeenCalledExactlyOnceWith(undefined, undefined, failure);
          expectNoCalls(mocks.outro, runtime.error);
          await flushLogger();
          const tail = await readConfiguredParsedLogTail();
          expect(tail.lines.map((line) => line.message).join("\n")).toContain(failure.message);
        } finally {
          await flushLogger();
          setLoggerOverride(null);
          resetLogger();
        }
      },
      buildUpdateDoctorEnv({ allowGatewayServiceRepair: true, allowGatewayActivation: false }),
    );
  });
});

describe("Doctor maintenance admission", () => {
  it.each(
    (["gateway", "schema", "agent"] as const).flatMap((owner) =>
      [false, true].map((updating) => ({ owner, updating })),
    ),
  )(
    "preserves the live $owner owner before snapshots (updating=$updating)",
    async ({ owner, updating }) => {
      const resultPath = updating ? createUpdatePostInstallDoctorResultPath() : undefined;
      const env = {
        OPENCLAW_UPDATE_IN_PROGRESS: updating ? "1" : undefined,
        OPENCLAW_UPDATE_POST_INSTALL_DOCTOR_RESULT_PATH: resultPath,
      };
      await withDoctorState(async (state) => {
        mocks.config.mockReturnValue({});
        mocks.packageRoot.mockReturnValue(undefined);
        const database = openOpenClawStateDatabase({ env: state.env });
        if (owner === "agent") {
          claimOpenClawAgentDatabaseLease({
            agentId: "main",
            path: state.statePath("agents/main/agent/openclaw-agent.sqlite"),
            env: state.env,
          });
        }
        closeOpenClawStateDatabaseByPath(database.path);
        const before = readConfig(state.configPath);
        const stateOwner =
          owner === "gateway"
            ? acquireGatewayStateOwner({ databasePath: database.path })
            : owner === "schema"
              ? acquireStateDatabaseSchemaLease(database.path)
              : undefined;
        try {
          const gatewayAcquisitions = vi.spyOn(gatewayLock, "acquireGatewayLock");
          snapshotProcesses.execFile.mockClear();
          mocks.runContributions.mockClear();
          const runtime = createDoctorRuntime();
          const failure = await runDoctorHealthFlow(runtime, repairOptions, undefined, {
            incompatible: [],
            indeterminate: [],
          }).catch((error: unknown) => error);
          const result = resultPath
            ? await consumeUpdatePostInstallDoctorResult(resultPath)
            : undefined;
          expect(
            snapshotProcesses.execFile.mock.calls.filter(
              (call) => Array.isArray(call[1]) && call[1].includes(SQLITE_READONLY_CHILD_ARG),
            ),
          ).toEqual([]);
          if (updating) {
            expect(failure).toBeUndefined();
            expect(mocks.runContributions).not.toHaveBeenCalled();
            expect(result).toMatchObject({
              status: "ok",
              configHash: "unchanged",
              maintenanceRefusal: {
                kind: "deferred",
                reason: owner === "agent" ? "agent-database-in-use" : "coordinator-contention",
              },
              warnings: [expect.stringContaining("Doctor could not enter maintenance")],
            });
            expect(runtime.exit).toHaveBeenCalledWith(0);
          } else if (owner === "agent") {
            expect(failure).toBeInstanceOf(UpdateDoctorError);
            expect(collectUpdateDoctorFailureFacts(failure)).toEqual([
              {
                check: "doctor",
                code: "agent-database-lease-active",
                message:
                  "Doctor could not enter maintenance. An agent database is in use. Stop the Gateway and other OpenClaw processes or reboot, then rerun openclaw doctor --fix.",
              },
            ]);
          } else {
            expect(failure).toBeInstanceOf(Error);
            expect(String(failure)).toMatch(/Stop.*service|stop.*process/);
          }
          // Refuse without retrying ownership; snapshot/read startup cost depends on the host.
          expect(gatewayAcquisitions).toHaveBeenCalledOnce();
          expect(readConfig(state.configPath)).toBe(before);
        } finally {
          stateOwner?.release();
        }
      }, env);
    },
  );
});
