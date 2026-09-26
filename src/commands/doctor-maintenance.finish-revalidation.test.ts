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
import { openNodeSqliteDatabase } from "../infra/node-sqlite.js";
import * as packageJson from "../infra/package-json.js";
import * as portsInspect from "../infra/ports-inspect.js";
import { tryAcquireExclusiveSqliteCoordinator } from "../infra/sqlite-coordinator.js";
import * as sqliteSnapshotSource from "../infra/sqlite-snapshot-source.js";
import { acquireGatewayLifecycleCoordinator } from "../infra/state-database-coordinator.js";
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
import { OPENCLAW_STATE_SCHEMA_VERSION } from "../state/openclaw-state-db-contract.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { withEnvAsync } from "../test-utils/env.js";
import { acquireTestPortBlock, type TestPortClaim } from "../test-utils/port-claims.js";
import { mockProcessPlatform } from "../test-utils/vitest-spies.js";
import { beginDoctorMaintenance } from "./doctor-maintenance.js";
import {
  stoppedSystemdBinding,
  useDoctorMaintenanceRuntimeDirectory,
} from "./doctor-maintenance.test-support.js";

const mocks = vi.hoisted(() => ({
  resolveService: vi.fn<() => GatewayService>(),
  gatewayPid: process.pid + 100_000,
  coordinatorRuntimeDir: "",
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
  waitForGatewayHealthyRestart: vi.fn(async () => ({ healthy: true })),
}));

// Windows hosts cannot enforce the mocked Linux mode bits; retain real SQLite locking.
vi.mock("../infra/sqlite-coordinator.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../infra/sqlite-coordinator.js")>();
  const nodeFs = await import("node:fs");
  return {
    ...actual,
    ensurePrivateSqliteCoordinatorDirectory: (directoryPath: string) => {
      nodeFs.mkdirSync(directoryPath, { recursive: true });
    },
  };
});

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
useDoctorMaintenanceRuntimeDirectory(() => {
  mocks.coordinatorRuntimeDir = tempDirs.make("openclaw-doctor-finish-runtime-");
  return mocks.coordinatorRuntimeDir;
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
  closeOpenClawStateDatabaseForTest();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

type StoppedUnitState =
  | "retained"
  | "unloaded"
  | "changed-manager"
  | "changed-command"
  | "restart-failed"
  | "slow-admission"
  | "slow-loadunit-admission"
  | "inspection-unavailable"
  | "inspection-error"
  | "ownership-refused"
  | "ownership-refused-wrapped"
  | "runtime-ownership-refused"
  | "launchd-owned"
  | "inspection-timeout"
  | "runtime-timeout"
  | "runtime-timeout-changed-command"
  | "runtime-timeout-changed-manager"
  | "inspection-competing"
  | "inspection-start-failed"
  | "competing-during-inspection"
  | "lifecycle-contended"
  | "gateway-lifecycle-contended"
  | "legacy-gateway-lifecycle-contended";
type Continuation =
  | "own"
  | "own-child"
  | "manual"
  | "competing"
  | "foreign"
  | "unknown-adopter"
  | "unrecorded"
  | "unrecorded-parked"
  | "parked"
  | "normal-update-parked"
  | "lost-before-stop"
  | "lost-before-restart"
  | "dead-before-restart"
  | "terminal-dead-before-restart";
type LegacyCatalog =
  | "exact"
  | "unknown"
  | "future-version"
  | "future-content"
  | "conflict-on-recheck"
  | "different-state";

async function runDoctorFinishForStoppedUnit(
  scenario: StoppedUnitState,
  continuation?: Continuation,
  legacyCatalog?: LegacyCatalog,
  custody:
    | "owned"
    | "copied"
    | "copied-release"
    | "consumed"
    | "released"
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
      const boundedInspection =
        scenario === "slow-admission" ||
        scenario === "slow-loadunit-admission" ||
        scenario === "competing-during-inspection";
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
        if (
          continuation !== "manual" &&
          continuation !== "normal-update-parked" &&
          continuation !== "unrecorded" &&
          continuation !== "unrecorded-parked"
        ) {
          recordUpdateRunStep(runId, { step: "finalize:repair-continuation", status: "completed" });
        }
        if (continuation !== "manual") {
          vi.stubEnv(
            "OPENCLAW_UPDATE_RUN_ID",
            continuation === "unrecorded-parked" ? undefined : runId,
          );
          vi.stubEnv("OPENCLAW_UPDATE_IN_PROGRESS", "1");
          vi.stubEnv("OPENCLAW_UPDATE_PARENT_ALLOWS_GATEWAY_ACTIVATION", "0");
        }
        if (continuation === "competing") {
          const competingDriver = { ...driver, pid: process.pid + 100_000, startIdentity: "1" };
          createUpdateRun({ trigger: "cli", origin: { driver: competingDriver } });
          const inspect = updateRunDriver.inspectUpdateRunDriver;
          vi.spyOn(updateRunDriver, "inspectUpdateRunDriver").mockImplementation((candidate) =>
            candidate.pid === competingDriver.pid ? "alive" : inspect(candidate),
          );
        }
      }
      let assertCatalogUnchanged = () => {};
      let assertPreStopArtifactsUnchanged = () => {};
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
            "CREATE INDEX idx_skill_workshop_collection_reviews_workspace_time ON skill_workshop_collection_reviews(review_id, create_time DESC);",
          );
          if (legacyCatalog === "future-version") {
            db.exec(`PRAGMA user_version = ${OPENCLAW_STATE_SCHEMA_VERSION + 1}`);
          }
          if (legacyCatalog === "future-content") {
            db.prepare(
              "INSERT INTO config_machine_state (state_key, value_json, updated_at_ms) VALUES ('state.schema.contentVersion', ?, 1)",
            ).run(String(OPENCLAW_STATE_SCHEMA_VERSION + 1));
          }
          db.enableDefensive?.(false);
          db.exec("PRAGMA writable_schema = ON");
          db.prepare("UPDATE sqlite_schema SET sql = ? WHERE type = 'index' AND name = ?").run(
            `CREATE INDEX idx_skill_workshop_collection_reviews_workspace_time ON skill_workshop_collection_reviews(${legacyCatalog === "unknown" ? "unexpected_column" : "workspace_dir"}, create_time DESC, review_id DESC)`,
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
              ? createHash("sha256").update(fs.readFileSync(file)).digest("hex")
              : undefined,
          );
        const beforeArtifacts = readArtifacts();
        const beforeCatalog = fs.readFileSync(pathname);
        assertCatalogUnchanged = () =>
          expect(fs.readFileSync(pathname).equals(beforeCatalog)).toBe(true);
        assertPreStopArtifactsUnchanged = () => expect(readArtifacts()).toEqual(beforeArtifacts);
        expect(() => listUpdateRuns()).toThrow(
          legacyCatalog === "future-version"
            ? /uses newer schema version/
            : /legacy-workshop-review-index.*doctor --fix/,
        );
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
      mockProcessPlatform("linux");
      let running =
        continuation !== "parked" &&
        continuation !== "normal-update-parked" &&
        continuation !== "unrecorded-parked";
      let stopObserved = false;
      let commandReads = 0;
      let inspectingRuntime = false;
      let inspectingCommand = false;
      const loadGuardDelays = [2602, 4770];
      let inspectionClock = 0;
      let competingUpdateStarted = false;
      let otherOwner: ReturnType<typeof tryAcquireExclusiveSqliteCoordinator> | undefined;
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
        expect(fs.readdirSync(mocks.coordinatorRuntimeDir)).toEqual(
          expect.arrayContaining([expect.stringMatching(/^service-lifecycle-.+\.lock$/)]),
        );
        if (scenario === "restart-failed") {
          throw new Error("service manager rejected restart");
        }
        running = true;
        return { outcome: "completed" as const };
      });
      const start = vi.fn<GatewayService["start"]>(async (args) => {
        args.assertCurrent?.();
        if (scenario === "inspection-start-failed") {
          throw new Error("service manager rejected start");
        }
        running = true;
      });
      mocks.resolveService.mockReturnValue(
        createMockGatewayService({
          isAbsent: async () => false,
          hasInstalledDefinition: async () => true,
          isLoaded: async () => scenario === "retained" || boundedInspection,
          readCommand: async (env, opts) => {
            await releaseDuringInspection?.();
            if (stopObserved && scenario.startsWith("ownership-refused")) {
              const refusal = new ServiceOwnershipRefusalError("systemd-account-refused");
              throw scenario.endsWith("wrapped")
                ? new AggregateError([refusal], "Native inspection did not settle successfully")
                : refusal;
            }
            if (stopObserved && scenario === "launchd-owned") {
              throw new ServiceInspectionError("launchd-system-owned");
            }
            if (++commandReads === 2) {
              activateCompetingUpdate?.();
              if (continuation === "lost-before-stop" && runId) {
                createUpdateRun({ trigger: "cli", origin: { driver: readUpdateRunDriver() } });
              }
            }
            if (
              stopObserved &&
              scenario === "unloaded" &&
              opts?.requireLoaded &&
              !opts.loadForInspection
            ) {
              throw new Error("Effective systemd service command could not be inspected.");
            }
            if (stopObserved && scenario.startsWith("inspection-")) {
              if (scenario === "inspection-error") {
                throw new Error("Effective systemd service command could not be inspected.");
              }
              if (scenario === "inspection-competing") {
                createUpdateRun({ trigger: "cli", origin: { driver: readUpdateRunDriver() } });
              }
              throw new ServiceInspectionError(
                scenario === "inspection-unavailable"
                  ? "systemd-user-bus-unavailable"
                  : "systemd-inspection-deadline-exceeded",
              );
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
            if (stopObserved && scenario === "runtime-ownership-refused") {
              throw new ServiceOwnershipRefusalError("systemd-manager-changed");
            }
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
                  stoppedSystemdBinding(() => {
                    if (scenario === "competing-during-inspection" && !competingUpdateStarted) {
                      competingUpdateStarted = true;
                      createUpdateRun({
                        trigger: "cli",
                        origin: { driver: readUpdateRunDriver() },
                      });
                    }
                  }),
                );
              } finally {
                inspectingRuntime = false;
              }
            }
            opts?.loadForInspection?.assertCurrent();
            // Plain status omits UID; collected units also need authorized inspection.
            return opts?.requireLoaded &&
              (scenario !== "unloaded" || opts.loadForInspection?.managerUid === 2001)
              ? {
                  status: "stopped",
                  systemd: { managerUid: scenario === "changed-manager" ? 2002 : 2001 },
                }
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
      const coordinator =
        scenario === "lifecycle-contended" ||
        scenario === "gateway-lifecycle-contended" ||
        scenario === "legacy-gateway-lifecycle-contended"
          ? acquireGatewayLifecycleCoordinator({
              databasePath,
              runtimeDirectory: mocks.coordinatorRuntimeDir,
            })
          : undefined;
      coordinator?.release();
      otherOwner = coordinator
        ? tryAcquireExclusiveSqliteCoordinator(coordinator.path, { busyTimeoutMs: 0 })
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
      if (continuation === "lost-before-restart" && runId) {
        createUpdateRun({ trigger: "cli", origin: { driver: readUpdateRunDriver() } });
      }
      if (
        continuation === "dead-before-restart" ||
        continuation === "terminal-dead-before-restart"
      ) {
        if (continuation === "terminal-dead-before-restart" && runId) {
          finishUpdateRun(runId, { status: "failed" });
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
      } else if (custody === "released") {
        await maintenance?.release();
        await maintenance?.release();
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

it.each([
  "copied",
  "copied-release",
  "consumed",
  "released",
  "released-during-inspection",
] as const)("refuses %s maintenance custody without another service mutation", async (custody) => {
  const result = await runDoctorFinishForStoppedUnit("retained", undefined, undefined, custody);
  expect(result.finishError).toMatchObject({
    message: expect.stringContaining("live maintenance owner"),
  });
  expect(result.unauthorizedRestarts).toBe(0);
  expect(result.restartCalls).toBe(custody.startsWith("released") ? 0 : 1);
});

it("admits exact legacy catalog reads for an owned running service without repairing it", async () => {
  const result = await runDoctorFinishForStoppedUnit("retained", undefined, "exact");
  expect(result.finishError).toBeUndefined();
  expect(mocks.stops).toBe(1);
  expect(result.restartCalls).toBe(1);
});

it("admits the exact legacy catalog while a live supervised Gateway owns lifecycle", async () => {
  const result = await runDoctorFinishForStoppedUnit(
    "gateway-lifecycle-contended",
    undefined,
    "exact",
  );
  expect(result.finishError).toBeUndefined();
  expect(mocks.stops).toBe(1);
  expect(result.restartCalls).toBe(1);
});

it("admits a published legacy Gateway by its verified native process lock", async () => {
  const result = await runDoctorFinishForStoppedUnit(
    "legacy-gateway-lifecycle-contended",
    undefined,
    "exact",
  );
  expect(result.finishError).toBeUndefined();
  expect(mocks.stops).toBe(1);
  expect(result.restartCalls).toBe(1);
});

it("preserves the existing malformed continuation writer refusal before stopping the service", async () => {
  await expect(runDoctorFinishForStoppedUnit("retained", "own", "exact")).rejects.toThrow(
    "schema migration required",
  );
  expect(mocks.stops).toBe(0);
});

it("refuses a foreign lifecycle holder before stopping the service", async () => {
  await expect(runDoctorFinishForStoppedUnit("lifecycle-contended")).rejects.toThrow(
    "OpenClaw state database is busy (gateway-lifecycle)",
  );
  expect(mocks.stops).toBe(0);
});

it.each([
  { catalog: "exact", continuation: "manual", message: "remains recorded as running" },
  {
    catalog: "conflict-on-recheck",
    continuation: undefined,
    message: "remains recorded as running",
  },
  {
    catalog: "future-version",
    continuation: undefined,
    message: `uses newer schema version ${OPENCLAW_STATE_SCHEMA_VERSION + 1}`,
  },
  {
    catalog: "future-content",
    continuation: undefined,
    message: `uses newer schema version ${OPENCLAW_STATE_SCHEMA_VERSION + 1}`,
  },
  {
    catalog: "different-state",
    continuation: undefined,
    message: "non-default state dir or config path",
  },
  { catalog: "unknown", continuation: undefined, message: "schema migration required" },
] as const)(
  "refuses $catalog/$continuation before stopping the service",
  async ({ catalog, continuation, message }) => {
    await expect(runDoctorFinishForStoppedUnit("retained", continuation, catalog)).rejects.toThrow(
      message,
    );
    expect(mocks.stops).toBe(0);
  },
);

it.each(["own", "parked", "normal-update-parked", "unrecorded-parked"] as const)(
  "continues owning-run Doctor maintenance with service %s",
  async (continuation) => {
    const { finishError, restartCalls, logs } = await runDoctorFinishForStoppedUnit(
      "retained",
      continuation,
    );
    expect(finishError).toBeUndefined();
    expect(mocks.stops).toBe(continuation === "own" ? 1 : 0);
    expect(restartCalls).toBe(continuation === "own" ? 1 : 0);
    if (continuation === "own") {
      expect(logs).toContain("Stopped the managed Gateway for Doctor repair.");
      expect(logs).toContain("Gateway restarted and verified after Doctor repair.");
    }
  },
);

it.each([
  { continuation: "manual", name: "manual doctor --fix without update markers" },
  { continuation: "competing", name: "an owning continuation alongside a different live driver" },
] as const)("refuses $name while another update owns the service", async ({ continuation }) => {
  await expect(runDoctorFinishForStoppedUnit("retained", continuation)).rejects.toThrow(
    /remains recorded as running.*liveness: alive/,
  );
  expect(mocks.stops).toBe(0);
});

it.each(["foreign", "unrecorded", "unknown-adopter"] as const)(
  "preserves parent activation without an owning repair continuation (%s)",
  async (continuation) => {
    await expect(runDoctorFinishForStoppedUnit("retained", continuation)).rejects.toThrow(
      continuation === "foreign"
        ? "other-host.invalid"
        : continuation === "unknown-adopter"
          ? "unrecorded adopter"
          : "update parent must stop the managed Gateway",
    );
  },
);

it("never lets the Doctor child stop or restart its parent's running service", async () => {
  await expect(runDoctorFinishForStoppedUnit("retained", "own-child")).rejects.toThrow(
    "update parent must stop the managed Gateway",
  );
  expect(mocks.stops).toBe(0);
});

it("rechecks continuation before stopping the service", async () => {
  await expect(runDoctorFinishForStoppedUnit("retained", "lost-before-stop")).rejects.toThrow(
    "remains recorded as running",
  );
});

it("rechecks continuation before restoring the service", async () => {
  const { finishError, restartCalls } = await runDoctorFinishForStoppedUnit(
    "retained",
    "lost-before-restart",
  );
  expect(finishError).toMatchObject({
    message: expect.stringContaining("remains recorded as running"),
  });
  expect(restartCalls).toBe(0);
});

it.each(["retained", "unloaded"] as const)(
  "restarts and verifies the unchanged gateway after systemd leaves it %s",
  async (scenario) => {
    const { finishError, restartCalls, logs } = await runDoctorFinishForStoppedUnit(scenario);
    expect(finishError).toBeUndefined();
    expect(restartCalls).toBe(1);
    expect(logs.join("\n")).toContain("Gateway restarted and verified after Doctor repair.");
  },
);

it.each(["slow-admission", "slow-loadunit-admission"] as const)(
  "restores the Gateway without timing out on %s snapshots",
  async (scenario) => {
    const { finishError, restartCalls, logs } = await runDoctorFinishForStoppedUnit(scenario);
    expect(finishError).toBeUndefined();
    expect(restartCalls).toBe(1);
    expect(logs).toContain("Gateway restarted and verified after Doctor repair.");
  },
);

it.each([
  "inspection-unavailable",
  "inspection-error",
  "inspection-timeout",
  "runtime-timeout",
] as const)("starts and verifies the Gateway it stopped after %s", async (scenario) => {
  const result = await runDoctorFinishForStoppedUnit(scenario);
  expect(result.finishError).toBeUndefined();
  expect(result.startCalls).toBe(1);
  expect(result.restartCalls).toBe(0);
  expect(result.logs.join("\n")).toContain("restoration inspection was inconclusive");
  expect(waitForGatewayHealthyRestart).toHaveBeenCalledOnce();
  expect(result.logs).toContain("Gateway restarted and verified after Doctor repair.");
});

it("does not treat an inconclusive inspection as admission to a competing update", async () => {
  const result = await runDoctorFinishForStoppedUnit("inspection-competing");
  expect(result.finishError).toMatchObject({
    message: expect.stringContaining("remains recorded as running"),
  });
  expect(result.startCalls).toBe(0);
  expect(result.restartCalls).toBe(0);
});

it.each([
  "ownership-refused",
  "ownership-refused-wrapped",
  "runtime-ownership-refused",
  "launchd-owned",
] as const)("preserves the native ownership refusal without activation: %s", async (scenario) => {
  const result = await runDoctorFinishForStoppedUnit(scenario);
  expect(result.startCalls).toBe(0);
  expect(result.restartCalls).toBe(0);
  expect(result.finishError).toMatchObject({
    failureFacts: expect.arrayContaining([
      expect.objectContaining({
        code:
          scenario === "launchd-owned"
            ? "launchd-system-owned"
            : scenario === "runtime-ownership-refused"
              ? "systemd-manager-changed"
              : "systemd-account-refused",
      }),
    ]),
  });
  expect(result.logs.join("\n")).not.toContain("restoration inspection was inconclusive");
  expect(waitForGatewayHealthyRestart).not.toHaveBeenCalled();
});

it("reports both inspection and start failures without claiming recovery", async () => {
  const result = await runDoctorFinishForStoppedUnit("inspection-start-failed");
  expect(result.startCalls).toBe(1);
  expect(result.finishError).toMatchObject({
    message: expect.stringContaining("service manager rejected start"),
  });
  expect(result.logs.join("\n")).toContain("inspection deadline expired");
  expect(result.logs).not.toContain("Gateway restarted and verified after Doctor repair.");
});

it("rechecks update admission after passive native inspection before restoring the Gateway", async () => {
  const { finishError, restartCalls } = await runDoctorFinishForStoppedUnit(
    "competing-during-inspection",
  );
  expect(finishError).toMatchObject({
    message: expect.stringContaining("remains recorded as running"),
  });
  expect(restartCalls).toBe(0);
});

it.each([
  "changed-manager",
  "changed-command",
  "runtime-timeout-changed-manager",
  "runtime-timeout-changed-command",
] as const)("refuses activation after %s during repair", async (scenario) => {
  const { finishError, restartCalls, startCalls } = await runDoctorFinishForStoppedUnit(scenario);
  expect(finishError).toMatchObject({
    message: expect.stringMatching(/ownership or manager identity changed/),
  });
  expect(restartCalls).toBe(0);
  expect(startCalls).toBe(0);
});

it.each(["dead-before-restart", "terminal-dead-before-restart"] as const)(
  "restores the Gateway and records one takeover when the owner is %s",
  async (continuation) => {
    const { finishError, restartCalls, logs, takeoverSteps, runStatus } =
      await runDoctorFinishForStoppedUnit("retained", continuation);
    expect(finishError).toBeUndefined();
    expect(restartCalls).toBe(1);
    expect(takeoverSteps).toBe(1);
    expect(runStatus).toBe(continuation === "terminal-dead-before-restart" ? "failed" : "running");
    expect(logs).toContain("Gateway restarted and verified after Doctor repair.");
  },
);

it("reports a failed restoration with a next step after the owner dies", async () => {
  const { finishError, restartCalls, logs, takeoverSteps } = await runDoctorFinishForStoppedUnit(
    "restart-failed",
    "dead-before-restart",
  );
  expect(restartCalls).toBe(1);
  expect(takeoverSteps).toBe(1);
  expect(finishError).toMatchObject({
    message: expect.stringContaining("service manager rejected restart"),
  });
  expect(finishError).toMatchObject({
    message: expect.stringContaining("openclaw gateway restart"),
  });
  expect(logs).not.toContain("Gateway restarted and verified after Doctor repair.");
});
