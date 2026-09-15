import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { GatewayService } from "../daemon/service.js";
import { createMockGatewayService, mockSystemAccountHome } from "../daemon/service.test-helpers.js";
import { openNodeSqliteDatabase } from "../infra/node-sqlite.js";
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
import { OPENCLAW_STATE_SCHEMA_VERSION } from "../state/openclaw-state-db-contract.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { withEnvAsync } from "../test-utils/env.js";
import { mockProcessPlatform } from "../test-utils/vitest-spies.js";
import { beginDoctorMaintenance } from "./doctor-maintenance.js";

const mocks = vi.hoisted(() => ({
  resolveService: vi.fn<() => GatewayService>(),
  coordinatorRuntimeDir: "",
  stops: 0,
}));

vi.mock("../daemon/service.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../daemon/service.js")>()),
  resolveGatewayService: (...args: []) => mocks.resolveService(...args),
}));

vi.mock("./doctor-service-repair-policy.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./doctor-service-repair-policy.js")>()),
  shouldManageGatewayService: async () => true,
}));

vi.mock("../cli/daemon-cli/restart-health.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../cli/daemon-cli/restart-health.js")>()),
  waitForGatewayHealthyRestart: vi.fn(async () => ({ healthy: true })),
}));

// Keep coordinator files inside the isolated workspace on every host.
vi.mock("../infra/state-database-coordinator.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../infra/state-database-coordinator.js")>();
  const withIsolatedRuntimeDir = <T extends { runtimeDirectory?: string }>(params: T): T => ({
    ...params,
    runtimeDirectory: mocks.coordinatorRuntimeDir || params.runtimeDirectory,
  });
  return {
    ...actual,
    acquireGatewayLifecycleCoordinator: (
      params: Parameters<typeof actual.acquireGatewayLifecycleCoordinator>[0],
    ) => actual.acquireGatewayLifecycleCoordinator(withIsolatedRuntimeDir(params)),
    acquireGatewayMaintenanceCoordinator: (
      params: Parameters<typeof actual.acquireGatewayMaintenanceCoordinator>[0],
    ) => actual.acquireGatewayMaintenanceCoordinator(withIsolatedRuntimeDir(params)),
    acquireStateDatabaseCoordinator: (
      params: Parameters<typeof actual.acquireStateDatabaseCoordinator>[0],
    ) => actual.acquireStateDatabaseCoordinator(withIsolatedRuntimeDir(params)),
  };
});

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
beforeEach(() => {
  mockSystemAccountHome();
  mocks.stops = 0;
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
  | "restart-failed";
type Continuation =
  | "own"
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
): Promise<{
  finishError: unknown;
  restartCalls: number;
  logs: string[];
  takeoverSteps: number;
  runStatus: string | undefined;
}> {
  const home = tempDirs.make("openclaw-doctor-finish-");
  mocks.coordinatorRuntimeDir = home;
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
      const command = {
        programArguments: [
          process.execPath,
          path.join(process.cwd(), "openclaw.mjs"),
          "gateway",
          "--port",
          "18789",
        ],
        environment: {
          HOME: legacyCatalog === "different-state" ? path.join(home, "other") : home,
        },
      };
      const restart = vi.fn(async () => {
        if (scenario === "restart-failed") {
          throw new Error("service manager rejected restart");
        }
        running = true;
        return { outcome: "completed" as const };
      });
      mocks.resolveService.mockReturnValue(
        createMockGatewayService({
          isAbsent: async () => false,
          hasInstalledDefinition: async () => true,
          isLoaded: async () => scenario === "retained",
          readCommand: async (_env, opts) => {
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
            opts?.loadForInspection?.assertCurrent();
            return {
              programArguments: [
                ...command.programArguments,
                ...(stopObserved && scenario === "changed-command" ? ["--verbose"] : []),
              ],
              environment: { ...command.environment },
            };
          },
          readRuntime: async (_env, opts) => {
            if (running) {
              return { status: "running", systemd: { managerUid: 2001 } };
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
          }),
          restart,
        }),
      );
      const logs: string[] = [];
      const maintenance = await beginDoctorMaintenance({
        root: process.cwd(),
        options: { repair: true },
        runtime: {
          log: (...args: Array<unknown>) => {
            logs.push(args.map((entry) => String(entry)).join(" "));
          },
          error: () => {},
          exit: () => {},
        },
      }).finally(() => {
        if (!activateCompetingUpdate) {
          assertCatalogUnchanged();
          if (mocks.stops === 0) {
            assertPreStopArtifactsUnchanged();
          }
        }
      });
      expect(maintenance).toBeDefined();
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
      let finishError: unknown;
      try {
        await maintenance?.finish({});
      } catch (error) {
        finishError = error;
      }
      assertCatalogUnchanged();
      const savedRun = runId && !legacyCatalog ? getUpdateRun(runId) : undefined;
      return {
        finishError,
        restartCalls: restart.mock.calls.length,
        logs,
        takeoverSteps:
          savedRun?.steps.filter((step) => step.step === "finalize:repair-takeover").length ?? 0,
        runStatus: savedRun?.status,
      };
    },
  );
}

it("admits exact legacy catalog reads for an owned running service without repairing it", async () => {
  const result = await runDoctorFinishForStoppedUnit("retained", undefined, "exact");
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

it.each([
  { catalog: "exact", continuation: "manual", message: "is still in progress" },
  { catalog: "conflict-on-recheck", continuation: undefined, message: "is still in progress" },
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
    /is still in progress.*liveness: alive/,
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
          : "update parent owns Gateway activation",
    );
  },
);

it("rechecks continuation before stopping the service", async () => {
  await expect(runDoctorFinishForStoppedUnit("retained", "lost-before-stop")).rejects.toThrow(
    "is still in progress",
  );
});

it("rechecks continuation before restoring the service", async () => {
  const { finishError, restartCalls } = await runDoctorFinishForStoppedUnit(
    "retained",
    "lost-before-restart",
  );
  expect(finishError).toMatchObject({
    message: expect.stringContaining("is still in progress"),
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

it.each(["changed-manager", "changed-command"] as const)(
  "refuses activation after %s during repair",
  async (scenario) => {
    const { finishError, restartCalls } = await runDoctorFinishForStoppedUnit(scenario);
    expect(finishError).toMatchObject({
      message: expect.stringMatching(/ownership or manager identity changed/),
    });
    expect(restartCalls).toBe(0);
  },
);

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
