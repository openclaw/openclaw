import "../flows/doctor-health.test-support.js";
import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createMockGatewayService } from "../daemon/service.test-helpers.js";
import * as systemdExec from "../daemon/systemd-exec.js";
import { buildSystemdUnit } from "../daemon/systemd-unit.js";
import { runDoctorHealthFlow } from "../flows/doctor-health.js";
import { requireNodeSqlite } from "../infra/node-sqlite.js";
import { createLegacyAuditLedger } from "../infra/state-migrations.legacy-audit.test-support.js";
import { readUpdateRunDriver } from "../infra/update-run-driver.js";
import { createUpdateRun } from "../infra/update-run-ledger.js";
import { closeOpenClawAgentDatabasesAsync } from "../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseAsync } from "../state/openclaw-state-db.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import * as storeFiles from "../test-utils/store-snapshot.test-support.js";
import type { DoctorMaintenancePendingCheck } from "./doctor-maintenance-pending.js";

const { mocks } = await import("../flows/doctor-health.test-support.js");
const pending = vi.hoisted(() => ({
  root: undefined as string | undefined,
  decisions: [] as { step: string; sidecarsBefore: string[]; changed: string[] }[],
}));
// Each step's pending check must only read. When a test sets `pending.root`, every check
// meets its stores as a stopped Gateway leaves them: all connections closed, and the empty
// sidecars Doctor's own earlier read-only opens left removed, as a writable close would.
vi.mock("./doctor-maintenance-pending.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./doctor-maintenance-pending.js")>();
  return {
    ...actual,
    traceDoctorMaintenancePending: async (step: string, check?: DoctorMaintenancePendingCheck) => {
      const root = pending.root;
      if (!check || !root) {
        return actual.traceDoctorMaintenancePending(step, check);
      }
      await closeOpenClawAgentDatabasesAsync();
      await closeOpenClawStateDatabaseAsync();
      storeFiles.removeEmptySqliteSidecars(root);
      const sidecarsBefore = storeFiles.listSqliteSidecars(root);
      const before = storeFiles.snapshotStoreFiles(root);
      const work = await actual.traceDoctorMaintenancePending(step, check);
      const changed = storeFiles.changedStoreFiles(before, storeFiles.snapshotStoreFiles(root));
      pending.decisions.push({ step, sidecarsBefore, changed });
      return work;
    },
  };
});
afterEach(() => {
  pending.root = undefined;
  pending.decisions = [];
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

type Scenario = "current-policy" | "short-timeout" | "removed-system-unit";

async function prepareInactiveSystemdGateway(
  state: { stateDir: string; home: string; path: (...parts: string[]) => string },
  scenario: Scenario,
) {
  const databasePath = await createLegacyAuditLedger(state.stateDir);
  const { DatabaseSync } = requireNodeSqlite();
  // Historical v1 schema: source_id was unique and agent/run IDs were required.
  const legacy = new DatabaseSync(databasePath);
  legacy.exec(`
    CREATE TABLE schema_meta (
      meta_key TEXT NOT NULL PRIMARY KEY, role TEXT NOT NULL,
      schema_version INTEGER NOT NULL, agent_id TEXT, app_version TEXT,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
    INSERT INTO schema_meta VALUES ('primary', 'global', 1, NULL, NULL, 10, 10);
  `);
  legacy.close();
  const removed = scenario === "removed-system-unit";
  const sourcePath = state.path(".config", "systemd", "user", "openclaw-gateway.service");
  const command = {
    programArguments: [process.execPath, path.join(process.cwd(), "openclaw.mjs"), "gateway"],
    environment: {
      HOME: state.home,
      PATH: "/usr/bin:/bin",
      OPENCLAW_SERVICE_MARKER: "openclaw",
      OPENCLAW_SERVICE_KIND: "gateway",
    },
    sourcePath,
    definitionPaths: [sourcePath],
  };
  if (!removed) {
    fs.mkdirSync(path.dirname(sourcePath), { recursive: true });
    fs.writeFileSync(
      sourcePath,
      buildSystemdUnit(command).replace(
        "TimeoutStopSec=330",
        `TimeoutStopSec=${scenario === "short-timeout" ? 30 : 330}`,
      ),
    );
  }
  const service = createMockGatewayService({
    isLoaded: async () => !removed,
    isAbsent: async () => removed,
    readCommand: async () => (removed ? null : command),
    readRuntime: async () => ({
      status: "stopped",
      state: "inactive",
      subState: "dead",
      systemd: { managerUid: process.geteuid?.() ?? 2001 },
    }),
    readDefinitionMutationCapability: async () => ({ kind: "sealed", reason: "system-owned" }),
  });
  mocks.service.mockReturnValue(service);
  mocks.servicePlatform = "linux";
  mocks.config.mockReturnValue({});
  mocks.outro.mockClear();
  mocks.packageRoot.mockReturnValue(process.cwd());
  // Schema preparation belongs to beginDoctorMaintenance and runs before contributions.
  mocks.runContributions.mockReset().mockResolvedValue(undefined);
  const exited = {
    code: 0,
    stderr: "",
    termination: "exit" as const,
  };
  vi.spyOn(systemdExec, "execSystemctl").mockResolvedValue({ ...exited, stdout: "not-found" });
  vi.spyOn(systemdExec, "execSystemctlUser").mockResolvedValue({
    ...exited,
    stdout: `LoadState=loaded\nAfter=network-online.target\nWants=network-online.target\nRestartUSec=5s\nKillMode=mixed\nTimeoutStopUSec=${scenario === "short-timeout" ? 30 : 330}s\n`,
  });
  return { databasePath, removed, service };
}

it.each(["current-policy", "short-timeout", "removed-system-unit"] as const)(
  "migrates legacy audit state with an inactive Gateway: %s",
  async (scenario) => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const { DatabaseSync } = requireNodeSqlite();
      const { databasePath, removed, service } = await prepareInactiveSystemdGateway(
        state,
        scenario,
      );
      const runtime = { log: vi.fn(), error: vi.fn(), exit: vi.fn() };
      try {
        await runDoctorHealthFlow(runtime, { repair: true, nonInteractive: true });
        const output = [...runtime.log.mock.calls, ...runtime.error.mock.calls].flat().join("\n");
        expect(runtime.exit, output).not.toHaveBeenCalled();
        expect(output.includes("Gateway service inspection is unavailable")).toBe(removed);
        expect(mocks.outro).toHaveBeenCalledWith("Doctor complete.");
        const assertEvent = (database: InstanceType<typeof DatabaseSync>) => {
          expect(database.prepare("SELECT event_id FROM audit_events").all()).toEqual([
            { event_id: "event-before-v2" },
          ]);
        };
        {
          using migrated = new DatabaseSync(databasePath, { readOnly: true });
          assertEvent(migrated);
          expect(migrated.prepare("PRAGMA user_version").get()).not.toEqual({ user_version: 1 });
          expect(migrated.prepare("PRAGMA integrity_check").get()).toEqual({
            integrity_check: "ok",
          });
        }
        const backupPrefix = "Saved pre-migration SQLite backup: ";
        const backupLine = runtime.log.mock.calls
          .flat()
          .find((line) => String(line).startsWith(backupPrefix));
        expect(backupLine).toBeTypeOf("string");
        using backup = new DatabaseSync(String(backupLine).slice(backupPrefix.length), {
          readOnly: true,
        });
        expect(backup.prepare("PRAGMA user_version").get()).toEqual({ user_version: 1 });
        assertEvent(backup);
        if (scenario === "short-timeout") {
          expect(output).toMatch(/effective.*30000ms.*330s/);
        }
        expect(service.stop).not.toHaveBeenCalled();
      } finally {
        mocks.servicePlatform = undefined;
      }
    });
  },
);

// An updater stops the Gateway, releases the service lock, then replaces the live
// tree. Its ledger row is the only fence against a Doctor run from another shell.
it("leaves state and the stopped Gateway alone while an update run is active", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const { DatabaseSync } = requireNodeSqlite();
    const { databasePath, service } = await prepareInactiveSystemdGateway(state, "current-policy");
    const active = createUpdateRun({ trigger: "cli", origin: { driver: readUpdateRunDriver() } });
    const runtime = { log: vi.fn(), error: vi.fn(), exit: vi.fn() };
    try {
      const failure = await runDoctorHealthFlow(runtime, {
        repair: true,
        nonInteractive: true,
      }).then(
        () => undefined,
        (error: unknown) => error,
      );
      const output = [...runtime.log.mock.calls, ...runtime.error.mock.calls].flat().join("\n");
      expect(String(failure), output).toContain(active.runId);
      using unchanged = new DatabaseSync(databasePath, { readOnly: true });
      expect(unchanged.prepare("PRAGMA user_version").get()).toEqual({ user_version: 1 });
      expect(service.start).not.toHaveBeenCalled();
      expect(service.restart).not.toHaveBeenCalled();
      expect(service.install).not.toHaveBeenCalled();
    } finally {
      mocks.servicePlatform = undefined;
    }
  });
});

// Recovery path: a run whose driver exited mid-swap must not block repair forever.
it("repairs state beside the stopped Gateway when the recorded update driver is dead", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const { DatabaseSync } = requireNodeSqlite();
    const { databasePath } = await prepareInactiveSystemdGateway(state, "current-policy");
    const live = readUpdateRunDriver();
    expect(live).toBeDefined();
    // A different start identity for this PID proves the recorded driver exited.
    const dead = { ...live!, startIdentity: String(Number(live!.startIdentity) + 1) };
    createUpdateRun({ trigger: "cli", origin: { driver: dead } });
    const runtime = { log: vi.fn(), error: vi.fn(), exit: vi.fn() };
    try {
      await runDoctorHealthFlow(runtime, { repair: true, nonInteractive: true });
      const output = [...runtime.log.mock.calls, ...runtime.error.mock.calls].flat().join("\n");
      expect(runtime.exit, output).not.toHaveBeenCalled();
      expect(mocks.outro).toHaveBeenCalledWith("Doctor complete.");
      using migrated = new DatabaseSync(databasePath, { readOnly: true });
      expect(migrated.prepare("PRAGMA user_version").get()).not.toEqual({ user_version: 1 });
    } finally {
      mocks.servicePlatform = undefined;
    }
  });
});

it("decides every step's pending check without creating or changing a file", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    // A legacy state database no connection holds, so its schema and backup steps have work.
    await prepareInactiveSystemdGateway(state, "current-policy");
    pending.root = state.stateDir;
    const runtime = { log: vi.fn(), error: vi.fn(), exit: vi.fn() };
    try {
      await runDoctorHealthFlow(runtime, { repair: true, nonInteractive: true });
      expect(mocks.outro).toHaveBeenCalledWith("Doctor complete.");
      expect(pending.decisions.map(({ step }) => step)).toEqual(
        expect.arrayContaining([
          "state-database-repair",
          "database-migrations",
          "state-schema",
          "runtime-checks",
          "external-config",
          "maintenance-ready",
          "boot-lifecycle",
        ]),
      );
      expect(pending.decisions.filter((decision) => decision.sidecarsBefore.length > 0)).toEqual(
        [],
      );
      expect(pending.decisions.filter((decision) => decision.changed.length > 0)).toEqual([]);
    } finally {
      mocks.servicePlatform = undefined;
    }
  });
});
