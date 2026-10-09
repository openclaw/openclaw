import { createHash } from "node:crypto";
import fs from "node:fs";
import { hostname } from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import * as restartHealthProbe from "../cli/daemon-cli/restart-health-probe.js";
import { waitForGatewayHealthyRestart } from "../cli/daemon-cli/restart-health.js";
import {
  ServiceInspectionError,
  ServiceOwnershipRefusalError,
} from "../daemon/service-inspection-error.js";
import type { GatewayService } from "../daemon/service.js";
import { createMockGatewayService, mockSystemAccountHome } from "../daemon/service.test-helpers.js";
import { createSystemdCommandQuery } from "../daemon/systemd-command-query.js";
import { readLoadedSystemdServiceRuntime } from "../daemon/systemd-loaded-runtime.js";
import * as gatewayLock from "../infra/gateway-lock.js";
import { acquireGatewayStateOwner } from "../infra/gateway-state-owner.js";
import { openNodeSqliteDatabase } from "../infra/node-sqlite.js";
import * as packageJson from "../infra/package-json.js";
import * as portsInspect from "../infra/ports-inspect.js";
import * as ancestry from "../infra/restart-stale-pids.js";
import * as sqliteSnapshotSource from "../infra/sqlite-snapshot-source.js";
import * as updateGitRuntime from "../infra/update-git-runtime.js";
import * as updateRunDriver from "../infra/update-run-driver.js";
import { readUpdateRunDriver } from "../infra/update-run-driver.js";
import {
  createUpdateRun,
  getUpdateRun,
  listUpdateRuns,
  recordUpdateRunPhase,
  recordUpdateRunStep,
  finishUpdateRun,
} from "../infra/update-run-ledger.js";
import { getFileLockProcessStartTime } from "../shared/pid-alive.js";
import {
  snapshotSourceFamily,
  writeUnreadableNewerStateSchema,
} from "../state/openclaw-database-preflight.test-support.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { withEnvAsync } from "../test-utils/env.js";
import { acquireTestPortBlock, type TestPortClaim } from "../test-utils/port-claims.js";
import { beginDoctorMaintenance } from "./doctor-maintenance.js";
import { mockDoctorServicePlatform } from "./doctor-maintenance.state-owner.test-support.js";
import {
  stoppedSystemdBinding,
  useDoctorMaintenanceRuntimeDirectory,
} from "./doctor-maintenance.test-support.js";

const mocks = vi.hoisted(() => ({
  resolveService: vi.fn<() => GatewayService>(),
  gatewayPid: process.pid + 100_000,
  nativeRuntimeDir: "",
  stops: 0,
}));
vi.mock("../daemon/service-process-membership.js", () => ({
  // This in-memory service places Doctor outside its synthetic process scope.
  inspectServiceProcessMembershipSync: (pid: number) =>
    pid === mocks.gatewayPid ? "outside" : "unknown",
}));

vi.mock("../daemon/service.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../daemon/service.js")>()),
  resolveGatewayService: (...args: []) => mocks.resolveService(...args),
}));

vi.mock("../cli/update-cli/update-command-service-drain.js", () => ({
  withGatewayMaintenanceDrain: async (_params: unknown, stop: () => Promise<unknown>) =>
    await stop(),
}));
vi.mock("../daemon/systemd-maintenance.js", () => ({
  prepareSystemdGatewayMaintenance: async () => false,
}));

vi.mock("./doctor-service-repair-policy.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./doctor-service-repair-policy.js")>()),
  shouldManageGatewayService: async () => true,
}));

vi.mock("../cli/daemon-cli/restart-health.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../cli/daemon-cli/restart-health.js")>()),
  waitForGatewayHealthyRestart: vi.fn(async () => ({ outcome: "ready", healthy: true })),
}));

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
useDoctorMaintenanceRuntimeDirectory(() => {
  mocks.nativeRuntimeDir = tempDirs.make("openclaw-doctor-finish-runtime-");
  return mocks.nativeRuntimeDir;
});
let gatewayPort: TestPortClaim;
beforeAll(async () => {
  gatewayPort = await acquireTestPortBlock({ offsets: [0] });
});
afterAll(async () => {
  await gatewayPort?.release();
});
beforeEach(() => {
  mockSystemAccountHome();
  vi.spyOn(ancestry, "inspectSelfAndAncestorPidsSync").mockReturnValue({
    pids: new Set([1, process.ppid, process.pid]),
    complete: true,
  });
  mocks.stops = 0;
  vi.mocked(waitForGatewayHealthyRestart).mockClear();
  // Exercise the real owner-lease reader without depending on a host listener or dist build.
  vi.spyOn(packageJson, "readPackageVersion").mockResolvedValue("2026.9.5");
  vi.spyOn(updateGitRuntime, "readBuiltGatewayBuildId").mockResolvedValue("doctor-fixture-build");
  vi.spyOn(portsInspect, "inspectPortUsage").mockImplementation(async (port) => ({
    port,
    status: "busy",
    listeners: [],
    hints: ["process details are unavailable"],
  }));
  vi.spyOn(restartHealthProbe, "confirmGatewayReachable").mockResolvedValue({
    reachable: true,
    gatewayVersion: "2026.9.5",
    gatewayBuildId: "doctor-fixture-build",
    activatedPluginErrors: [],
    unavailablePlugins: [],
    channelProbeErrors: [],
  });
});
afterEach(() => {
  try {
    closeOpenClawStateDatabaseForTest();
  } finally {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  }
});

type StoppedUnitState =
  | "retained"
  | "slow-loadunit-admission"
  | "ownership-refused-wrapped"
  | "launchd-owned"
  | "runtime-timeout-changed-command"
  | "runtime-timeout-changed-manager"
  | "inspection-competing"
  | "lifecycle-contended"
  | "gateway-lifecycle-contended"
  | "legacy-gateway-lifecycle-contended";
type Continuation =
  | "own"
  | "own-child"
  | "foreign"
  | "unknown-adopter"
  | "terminal-dead-before-restart";
type LegacyCatalog = "exact" | "conflict-on-recheck" | "different-state";

async function runDoctorFinishForStoppedUnit(
  scenario: StoppedUnitState,
  continuation?: Continuation,
  legacyCatalog?: LegacyCatalog,
  custody:
    | "owned"
    | "copied"
    | "copied-release"
    | "consumed"
    | "released-during-inspection" = "owned",
): Promise<{
  finishError: unknown;
  restartCalls: number;
  startCalls: number;
  logs: string[];
  takeoverSteps: number;
  runStatus: string | undefined;
  unauthorizedRestarts: number;
}> {
  const home = tempDirs.make("openclaw-doctor-finish-");
  return await withEnvAsync(
    {
      HOME: home,
      USERPROFILE: home,
      APPDATA: path.join(home, "AppData"),
      OPENCLAW_HOME: undefined,
      OPENCLAW_STATE_DIR: undefined,
      OPENCLAW_CONFIG_PATH: undefined,
      OPENCLAW_PROFILE: undefined,
      OPENCLAW_SUPERVISOR_MODE: undefined,
      OPENCLAW_SERVICE_REPAIR_POLICY: undefined,
      OPENCLAW_SERVICE_MARKER: undefined,
      OPENCLAW_SERVICE_KIND: undefined,
      OPENCLAW_SYSTEMD_UNIT: undefined,
      OPENCLAW_UPDATE_RUN_ID: undefined,
      OPENCLAW_UPDATE_IN_PROGRESS: undefined,
      OPENCLAW_UPDATE_PARENT_ALLOWS_GATEWAY_ACTIVATION: undefined,
    },
    async () => {
      const boundedInspection = scenario === "slow-loadunit-admission";
      if (boundedInspection) {
        openOpenClawStateDatabase();
        closeOpenClawStateDatabaseForTest();
      }
      let runId: string | undefined;
      if (continuation) {
        const driver = readUpdateRunDriver();
        if (!driver) {
          throw new Error("Current driver identity is unavailable");
        }
        const run = createUpdateRun({
          trigger: "cli",
          origin: {
            driver: continuation === "foreign" ? { ...driver, host: "other-host.invalid" } : driver,
          },
        });
        runId = run.runId;
        recordUpdateRunPhase(runId, "validating");
        if (continuation === "unknown-adopter") {
          recordUpdateRunStep(runId, { step: "driver:identity-unavailable", status: "completed" });
        }
        recordUpdateRunStep(runId, { step: "finalize:repair-continuation", status: "completed" });
        vi.stubEnv("OPENCLAW_UPDATE_RUN_ID", runId);
        vi.stubEnv("OPENCLAW_UPDATE_IN_PROGRESS", "1");
        vi.stubEnv("OPENCLAW_UPDATE_PARENT_ALLOWS_GATEWAY_ACTIVATION", "0");
      }
      let assertCatalogUnchanged = () => {};
      let assertPreStopArtifactsUnchanged = () => {};
      let releaseServingLease = () => {};
      let activateCompetingUpdate: (() => void) | undefined;
      if (legacyCatalog) {
        const lateRun =
          legacyCatalog === "conflict-on-recheck"
            ? createUpdateRun({ trigger: "cli", origin: { driver: readUpdateRunDriver() } })
            : undefined;
        if (lateRun) {
          finishUpdateRun(lateRun.runId, { status: "skipped" });
        }
        const pathname = openOpenClawStateDatabase().path;
        closeOpenClawStateDatabaseForTest();
        const db = openNodeSqliteDatabase(pathname);
        try {
          db.exec(
            "CREATE TABLE IF NOT EXISTS skill_workshop_collection_reviews (review_id TEXT NOT NULL PRIMARY KEY, owner_agent_id TEXT NOT NULL, backup_id TEXT NOT NULL, create_time INTEGER NOT NULL, kept_names_json TEXT NOT NULL, written_names_json TEXT NOT NULL, dropped_json TEXT NOT NULL) STRICT; CREATE INDEX idx_skill_workshop_collection_reviews_workspace_time ON skill_workshop_collection_reviews(review_id, create_time DESC);",
          );
          db.enableDefensive?.(false);
          db.exec("PRAGMA writable_schema = ON");
          db.prepare("UPDATE sqlite_schema SET sql = ? WHERE type = 'index' AND name = ?").run(
            `CREATE INDEX idx_skill_workshop_collection_reviews_workspace_time ON skill_workshop_collection_reviews(workspace_dir, create_time DESC, review_id DESC)`,
            "idx_skill_workshop_collection_reviews_workspace_time",
          );
          if (scenario === "gateway-lifecycle-contended") {
            const startedAt = getFileLockProcessStartTime(process.pid);
            if (startedAt === null) {
              throw new Error("Current process start identity is unavailable");
            }
            const now = Date.now();
            db.prepare(
              `INSERT INTO state_leases
                 (scope, lease_key, owner, expires_at, heartbeat_at, payload_json, created_at, updated_at)
               VALUES ('gateway-owner', 'global', 'test-gateway', ?, ?, ?, ?, ?)`,
            ).run(
              now + 60_000,
              now,
              JSON.stringify({
                owner: { pid: process.pid, host: hostname(), startedAt },
                port: gatewayPort.port,
                mode: "supervised",
                supervisor: { kind: "systemd", name: "openclaw-gateway.service" },
              }),
              now,
              now,
            );
          }
          const schema = db.prepare("PRAGMA schema_version").get() as { schema_version: number };
          db.exec(
            `PRAGMA writable_schema = OFF; PRAGMA schema_version = ${schema.schema_version + 1}`,
          );
        } finally {
          db.close();
        }
        const readArtifacts = () =>
          [pathname, `${pathname}-wal`, `${pathname}-shm`].map((file) =>
            fs.existsSync(file)
              ? {
                  hash: createHash("sha256").update(fs.readFileSync(file)).digest("hex"),
                  mtimeNs: fs.statSync(file, { bigint: true }).mtimeNs,
                }
              : undefined,
          );
        const beforeArtifacts = readArtifacts();
        let beforeCatalog = fs.readFileSync(pathname);
        if (scenario === "gateway-lifecycle-contended") {
          releaseServingLease = () => {
            const writer = openNodeSqliteDatabase(pathname);
            try {
              writer.enableDefensive?.(false);
              writer.exec("PRAGMA writable_schema = ON");
              expect(
                writer
                  .prepare(
                    "DELETE FROM state_leases WHERE scope = 'gateway-owner' AND lease_key = 'global' AND owner = 'test-gateway'",
                  )
                  .run().changes,
              ).toBe(1);
            } finally {
              writer.close();
            }
            // Only the simulated Gateway's shutdown writes; Doctor must preserve its result.
            beforeCatalog = fs.readFileSync(pathname);
          };
        }
        assertCatalogUnchanged = () =>
          expect(fs.readFileSync(pathname).equals(beforeCatalog)).toBe(true);
        assertPreStopArtifactsUnchanged = () => expect(readArtifacts()).toEqual(beforeArtifacts);
        expect(() => listUpdateRuns()).toThrow(/legacy-workshop-review-index.*doctor --fix/);
        assertPreStopArtifactsUnchanged();
        if (lateRun) {
          activateCompetingUpdate = () => {
            const writer = openNodeSqliteDatabase(pathname);
            try {
              writer.enableDefensive?.(false);
              writer.exec("PRAGMA writable_schema = ON");
              writer
                .prepare(
                  "UPDATE update_runs SET status = 'running', phase = 'validating', finished_at_ms = NULL WHERE run_id = ?",
                )
                .run(lateRun.runId);
            } finally {
              writer.close();
            }
          };
        }
      }
      mockDoctorServicePlatform("linux");
      let running = true;
      let stopObserved = false;
      let commandReads = 0;
      let inspectingRuntime = false;
      let inspectingCommand = false;
      const loadGuardDelays = [2602, 4770];
      let inspectionClock = 0;
      let otherOwner: ReturnType<typeof acquireGatewayStateOwner> | undefined;
      let releaseDuringInspection: (() => Promise<void>) | undefined;
      if (scenario === "legacy-gateway-lifecycle-contended") {
        vi.spyOn(gatewayLock, "readActiveGatewayLockIdentity").mockResolvedValue({
          pid: mocks.gatewayPid,
          createdAt: new Date().toISOString(),
          port: gatewayPort.port,
        });
      }
      const command = {
        programArguments: [
          process.execPath,
          path.join(process.cwd(), "openclaw.mjs"),
          "gateway",
          "--port",
          String(gatewayPort.port),
        ],
        environment: {
          HOME: legacyCatalog === "different-state" ? path.join(home, "other") : home,
        },
      };
      const restart = vi.fn(async () => {
        expect(fs.readdirSync(mocks.nativeRuntimeDir)).toEqual(
          expect.arrayContaining([expect.stringMatching(/^service-lifecycle-.+\.lock$/)]),
        );
        running = true;
        return { outcome: "completed" as const };
      });
      const start = vi.fn<GatewayService["start"]>(async (args) => {
        args.assertCurrent?.();
        running = true;
      });
      mocks.resolveService.mockReturnValue(
        createMockGatewayService({
          isAbsent: async () => false,
          hasInstalledDefinition: async () => true,
          isLoaded: async () => scenario === "retained" || boundedInspection,
          readCommand: async (env, opts) => {
            await releaseDuringInspection?.();
            if (stopObserved && scenario === "ownership-refused-wrapped") {
              const refusal = new ServiceOwnershipRefusalError("systemd-account-refused");
              throw new AggregateError([refusal], "Native inspection did not settle successfully");
            }
            if (stopObserved && scenario === "launchd-owned") {
              throw new ServiceInspectionError("launchd-system-owned");
            }
            if (++commandReads === 2) {
              activateCompetingUpdate?.();
            }
            if (stopObserved && scenario.startsWith("inspection-")) {
              createUpdateRun({ trigger: "cli", origin: { driver: readUpdateRunDriver() } });
              throw new ServiceInspectionError("systemd-inspection-deadline-exceeded");
            }
            if (stopObserved && scenario === "slow-loadunit-admission") {
              inspectingCommand = true;
              const binding = stoppedSystemdBinding(() => {});
              try {
                const reader = await createSystemdCommandQuery(
                  env,
                  binding.unit,
                  { ...opts, systemdReadBinding: binding },
                  () => new Error("systemd inspection deadline expired"),
                );
                await reader.query(
                  [
                    "call",
                    binding.destination,
                    "/org/freedesktop/systemd1",
                    "org.freedesktop.systemd1.Manager",
                    "LoadUnit",
                    "s",
                    binding.unit,
                  ],
                  ["o"],
                );
              } finally {
                inspectingCommand = false;
              }
            } else {
              opts?.loadForInspection?.assertCurrent();
            }
            return {
              programArguments: [
                ...command.programArguments,
                ...(stopObserved && scenario.endsWith("changed-command") ? ["--verbose"] : []),
              ],
              environment: { ...command.environment },
            };
          },
          readRuntime: async (env, opts) => {
            if (running) {
              return {
                status: "running",
                pid: mocks.gatewayPid,
                systemd: { managerUid: 2001 },
              };
            }
            if (scenario.startsWith("runtime-timeout")) {
              return {
                status: "unknown",
                inspectionReason: "systemd-inspection-deadline-exceeded",
                systemd: {
                  managerUid: scenario.endsWith("changed-manager") ? 2002 : 2001,
                },
              };
            }
            if (boundedInspection) {
              inspectingRuntime = true;
              try {
                return await readLoadedSystemdServiceRuntime(
                  env,
                  opts?.timeoutMs,
                  opts?.loadForInspection,
                  stoppedSystemdBinding(() => {}),
                );
              } finally {
                inspectingRuntime = false;
              }
            }
            opts?.loadForInspection?.assertCurrent();
            // Plain status omits UID; collected units also need authorized inspection.
            return opts?.requireLoaded
              ? { status: "stopped", systemd: { managerUid: 2001 } }
              : { status: "stopped" };
          },
          stop: vi.fn(async () => {
            assertPreStopArtifactsUnchanged();
            mocks.stops += 1;
            running = false;
            stopObserved = true;
            if (
              scenario === "gateway-lifecycle-contended" ||
              scenario === "legacy-gateway-lifecycle-contended"
            ) {
              releaseServingLease();
              otherOwner?.release();
              otherOwner = undefined;
            }
          }),
          restart,
          start,
        }),
      );
      const parentOwnsService =
        continuation === "own" || continuation?.includes("before-") === true;
      if (parentOwnsService) {
        vi.stubEnv("OPENCLAW_UPDATE_RUN_ID", undefined);
        vi.stubEnv("OPENCLAW_UPDATE_PARENT_ALLOWS_GATEWAY_ACTIVATION", undefined);
      }
      const logs: string[] = [];
      const databasePath = path.join(home, ".openclaw", "state", "openclaw.sqlite");
      otherOwner =
        scenario === "lifecycle-contended" ||
        scenario === "gateway-lifecycle-contended" ||
        scenario === "legacy-gateway-lifecycle-contended"
          ? acquireGatewayStateOwner({
              databasePath,
              ...(scenario === "lifecycle-contended"
                ? {}
                : {
                    payload: {
                      pid: process.pid,
                      createdAt: new Date().toISOString(),
                      configPath: path.join(home, ".openclaw", "openclaw.json"),
                      role: "gateway",
                    },
                  }),
            })
          : undefined;
      const maintenance = await beginDoctorMaintenance({
        root: process.cwd(),
        ...(parentOwnsService ? { runId } : {}),
        options: { repair: true },
        runtime: {
          log: (...args: Array<unknown>) => {
            logs.push(args.map((entry) => String(entry)).join(" "));
          },
          error: () => {},
          exit: () => {},
        },
      }).finally(() => {
        otherOwner?.release();
        if (!activateCompetingUpdate) {
          assertCatalogUnchanged();
          if (mocks.stops === 0) {
            assertPreStopArtifactsUnchanged();
          }
        }
      });
      expect(maintenance).toBeDefined();
      if (continuation === "own" && !legacyCatalog) {
        await maintenance?.releaseState();
        await withEnvAsync(
          {
            OPENCLAW_UPDATE_RUN_ID: runId,
            OPENCLAW_UPDATE_PARENT_ALLOWS_GATEWAY_ACTIVATION: "0",
          },
          async () => {
            const child = await beginDoctorMaintenance({
              root: process.cwd(),
              options: { repair: true },
              runtime: { log: () => {}, error: () => {}, exit: () => {} },
            });
            await child?.finish({});
          },
        );
        expect(mocks.stops).toBe(1);
        expect(restart).not.toHaveBeenCalled();
      }
      if (legacyCatalog) {
        expect(() => maintenance?.run(() => listUpdateRuns())).toThrow();
      }
      if (continuation === "terminal-dead-before-restart") {
        if (runId) {
          maintenance?.run(() => finishUpdateRun(runId, { status: "failed" }));
        }
        const inspect = updateRunDriver.inspectUpdateRunDriver;
        vi.spyOn(updateRunDriver, "inspectUpdateRunDriver").mockImplementation((driver) =>
          driver.pid === process.pid ? "dead" : inspect(driver),
        );
      }
      if (boundedInspection) {
        vi.spyOn(performance, "now").mockImplementation(() => inspectionClock);
        const prepareSnapshot = sqliteSnapshotSource.prepareSqliteReadOnlyLocationSync;
        vi.spyOn(sqliteSnapshotSource, "prepareSqliteReadOnlyLocationSync").mockImplementation(
          (pathname) => {
            const prepared = prepareSnapshot(pathname);
            if (inspectingCommand) {
              inspectionClock += loadGuardDelays.shift() ?? 0;
            }
            if (inspectingRuntime) {
              inspectionClock += 100;
            }
            return prepared;
          },
        );
      }
      let finishError: unknown;
      if (custody === "consumed") {
        await maintenance?.finish({});
      } else if (custody === "released-during-inspection") {
        releaseDuringInspection = () => maintenance!.release();
      }
      const restartsBefore = restart.mock.calls.length;
      try {
        const receiver = custody.startsWith("copied") ? { ...maintenance! } : maintenance;
        if (custody === "copied-release") {
          await receiver?.release();
        } else {
          await receiver?.finish({});
        }
      } catch (error) {
        finishError = error;
      }
      const unauthorizedRestarts = restart.mock.calls.length - restartsBefore;
      if (custody.startsWith("copied")) {
        await maintenance?.finish({});
      }
      assertCatalogUnchanged();
      const savedRun = runId && !legacyCatalog ? getUpdateRun(runId) : undefined;
      return {
        finishError,
        restartCalls: restart.mock.calls.length,
        startCalls: start.mock.calls.length,
        logs,
        takeoverSteps:
          savedRun?.steps.filter((step) => step.step === "finalize:repair-takeover").length ?? 0,
        runStatus: savedRun?.status,
        unauthorizedRestarts,
      };
    },
  );
}

it.each(["copied", "copied-release", "consumed", "released-during-inspection"] as const)(
  "refuses %s maintenance custody without another service mutation",
  async (custody) => {
    const result = await runDoctorFinishForStoppedUnit("retained", undefined, undefined, custody);
    expect(result.finishError).toMatchObject({
      message: expect.stringContaining("live maintenance owner"),
    });
    expect(result.unauthorizedRestarts).toBe(0);
    expect(result.restartCalls).toBe(custody.startsWith("released") ? 0 : 1);
  },
);

it.each([
  { scenario: "gateway-lifecycle-contended", catalog: "exact" },
  { scenario: "legacy-gateway-lifecycle-contended", catalog: "exact" },
  { scenario: "slow-loadunit-admission", catalog: undefined },
] as const)(
  "restores the unchanged Gateway after $scenario inspection (catalog: $catalog)",
  async ({ scenario, catalog }) => {
    const result = await runDoctorFinishForStoppedUnit(scenario, undefined, catalog);
    expect(result.finishError).toBeUndefined();
    expect(mocks.stops).toBe(1);
    expect(result.restartCalls).toBe(1);
    expect(result.logs).toContain("Gateway restarted and verified after Doctor repair.");
  },
);

it("refuses offline Doctor repair of a newer schema without recommending repair or changing files", async () => {
  const stateDir = tempDirs.make("openclaw-doctor-newer-schema-");
  vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
  vi.stubEnv("OPENCLAW_CONFIG_PATH", path.join(stateDir, "openclaw.json"));
  const databasePath = openOpenClawStateDatabase().path;
  await closeOpenClawStateDatabaseAsync();
  writeUnreadableNewerStateSchema(databasePath);
  const before = snapshotSourceFamily(databasePath);

  const admission = beginDoctorMaintenance({
    root: null,
    options: { repair: true, nonInteractive: true },
    runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
  });
  await expect(admission).rejects.toThrow("newer schema version");
  await expect(admission).rejects.toThrow(/restore.*backup/);
  await expect(admission).rejects.not.toThrow(/doctor --fix/);
  expect(snapshotSourceFamily(databasePath)).toEqual(before);
  expect(mocks.stops).toBe(0);
});

it.each<{
  scenario?: StoppedUnitState;
  catalog?: LegacyCatalog;
  continuation?: Continuation;
  message: string | RegExp;
}>([
  {
    scenario: "lifecycle-contended",
    message: "is undergoing offline maintenance; retry when it finishes.",
  },
  {
    catalog: "conflict-on-recheck",
    message: "remains recorded as running",
  },
  {
    catalog: "different-state",
    message: "non-default state dir or config path",
  },
  { continuation: "foreign", message: "other-host.invalid" },
  { continuation: "unknown-adopter", message: "unrecorded adopter" },
  { continuation: "own-child", message: "update parent must stop the managed Gateway" },
])(
  "refuses admission before stopping the service (%j)",
  async ({ scenario = "retained", catalog, continuation, message }) => {
    const admission = runDoctorFinishForStoppedUnit(scenario, continuation, catalog);
    await expect(admission).rejects.toThrow(message);
    expect(mocks.stops).toBe(0);
  },
);

it("continues owning-run Doctor maintenance", async () => {
  const { finishError, restartCalls, logs } = await runDoctorFinishForStoppedUnit(
    "retained",
    "own",
  );
  expect(finishError).toBeUndefined();
  expect(mocks.stops).toBe(1);
  expect(restartCalls).toBe(1);
  expect(logs).toContain("Stopped the managed Gateway for Doctor repair.");
  expect(logs).toContain("Gateway restarted and verified after Doctor repair.");
});

it("rechecks update admission after failed restoration inspection", async () => {
  const { finishError, restartCalls, startCalls } =
    await runDoctorFinishForStoppedUnit("inspection-competing");
  expect(finishError).toMatchObject({
    message: expect.stringContaining("remains recorded as running"),
  });
  expect(restartCalls).toBe(0);
  expect(startCalls).toBe(0);
});

it.each(["ownership-refused-wrapped", "launchd-owned"] as const)(
  "preserves the native ownership refusal without activation: %s",
  async (scenario) => {
    const result = await runDoctorFinishForStoppedUnit(scenario);
    expect(result.startCalls).toBe(0);
    expect(result.restartCalls).toBe(0);
    expect(result.finishError).toMatchObject({
      failureFacts: expect.arrayContaining([
        expect.objectContaining({
          code: scenario === "launchd-owned" ? "launchd-system-owned" : "systemd-account-refused",
        }),
      ]),
    });
    expect(result.logs.join("\n")).not.toContain("restoration inspection was inconclusive");
    expect(waitForGatewayHealthyRestart).not.toHaveBeenCalled();
  },
);

it.each(["runtime-timeout-changed-manager", "runtime-timeout-changed-command"] as const)(
  "refuses activation after %s during repair",
  async (scenario) => {
    const { finishError, restartCalls, startCalls } = await runDoctorFinishForStoppedUnit(scenario);
    expect(finishError).toMatchObject({
      message: expect.stringMatching(/ownership or manager identity changed/),
    });
    expect(restartCalls).toBe(0);
    expect(startCalls).toBe(0);
  },
);

it("restores the Gateway and records one takeover when the owner terminalizes and dies", async () => {
  const { finishError, restartCalls, logs, takeoverSteps, runStatus } =
    await runDoctorFinishForStoppedUnit("retained", "terminal-dead-before-restart");
  expect(finishError).toBeUndefined();
  expect(restartCalls).toBe(1);
  expect(takeoverSteps).toBe(1);
  expect(runStatus).toBe("failed");
  expect(logs).toContain("Gateway restarted and verified after Doctor repair.");
});
