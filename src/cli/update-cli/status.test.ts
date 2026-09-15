import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { buildStatusUpdateRows } from "../../commands/status-update-restart.js";
import { recordDeferredPluginMigrations } from "../../infra/deferred-plugin-migrations.js";
import * as runtimeGuard from "../../infra/runtime-guard.js";
import { createRetainedUpdateRecovery } from "../../infra/update-retained-recovery.test-support.js";
import { readUpdateRunDriver } from "../../infra/update-run-driver.js";
import {
  createUpdateRun,
  findActiveUpdateRun,
  finishUpdateRun,
  getUpdateRun,
  listUpdateRuns,
  recordUpdateRunPhase,
  recordUpdateRunVerification,
} from "../../infra/update-run-ledger.js";
import { ABANDONED_UPDATE_RUN_MS } from "../../infra/update-run-timeouts.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../../state/openclaw-state-db.paths.js";
import { claimOpenClawStateOwnership } from "../../state/openclaw-state-ownership-operations.js";
import { updateStatusCommand } from "./status.js";

const runtime = vi.hoisted(() => ({
  log: vi.fn(),
  error: vi.fn(),
  writeJson: vi.fn(),
  exit: vi.fn(),
}));

const service = vi.hoisted(() => ({
  readCommand: vi.fn(),
  resolveNodeRuntimeInfo: vi.fn(),
}));
const confirmGatewayReachable = vi.hoisted(() =>
  vi.fn<typeof import("../daemon-cli/restart-health-probe.js").confirmGatewayReachable>(),
);
vi.mock("../daemon-cli/restart-health-probe.js", () => ({ confirmGatewayReachable }));

vi.mock("../../daemon/service.js", () => ({
  resolveGatewayService: () => ({ readCommand: service.readCommand }),
}));
vi.mock("../../daemon/runtime-paths.js", () => ({
  resolveNodeRuntimeInfo: service.resolveNodeRuntimeInfo,
}));
vi.mock("../../config/paths.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../config/paths.js")>()),
  isDefaultInstallIdentity: () => true,
}));

vi.mock("../../runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../runtime.js")>()),
  defaultRuntime: runtime,
}));
vi.mock("../../infra/update-check.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../infra/update-check.js")>()),
  checkUpdateStatus: async () => ({
    root: "/fixture/openclaw",
    installKind: "package",
    packageManager: "npm",
    registry: { latestVersion: "2026.9.2" },
  }),
}));
vi.mock("./shared.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./shared.js")>()),
  resolveUpdateRoot: async () => "/fixture/openclaw",
}));

const tempDirs = createTempDirTracker();

beforeEach(() => {
  vi.clearAllMocks();
  service.readCommand.mockResolvedValue(null);
  const stateDir = tempDirs.make("openclaw-update-status-");
  vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
  vi.stubEnv("OPENCLAW_CONFIG_PATH", path.join(stateDir, "openclaw.json"));
});

describe("update status Node runtime findings", () => {
  it.each(
    [true, false].flatMap((json) => [
      { json, stored: true, sqliteVersion: "3.51.2", unavailable: true },
      { json, stored: false, sqliteVersion: "3.51.2", unavailable: false },
      { json, stored: true, sqliteVersion: "3.51.3", unavailable: false },
    ]),
  )(
    "preserves diagnostics with stored=$stored SQLite $sqliteVersion (JSON: $json)",
    async ({ json, stored, sqliteVersion, unavailable }) => {
      const recorded = stored ? createUpdateRun({ trigger: "cli" }) : undefined;
      closeOpenClawStateDatabaseForTest();
      vi.resetModules();
      const sqlitePrototype: {
        prepare: (this: DatabaseSync, sql: string) => ReturnType<DatabaseSync["prepare"]>;
      } = DatabaseSync.prototype;
      const realPrepare = sqlitePrototype.prepare;
      const prepare = vi
        .spyOn(DatabaseSync.prototype, "prepare")
        .mockImplementation(function (this: DatabaseSync, sql) {
          return realPrepare.call(
            this,
            sql === "SELECT sqlite_version() AS version"
              ? `SELECT '${sqliteVersion}' AS version`
              : sql,
          );
        });
      const freshGuard = await import("../../infra/runtime-guard.js");
      vi.spyOn(freshGuard, "detectRuntime").mockResolvedValue({
        kind: "node",
        version: process.versions.node,
        execPath: "/fixture/node",
        pathEnv: "/fixture",
        hasNodeSqlite: true,
        sqliteVersion,
        sqliteProbe: {
          available: true,
          version: sqliteVersion,
          text: true,
          blob: true,
          json: true,
        },
      });
      const command = await import("./status.js");
      const ledger = await import("../../infra/update-run-ledger.js");
      if (unavailable) {
        expect(() => ledger.findActiveUpdateRun()).toThrow(
          "SQLite support is unavailable or unsafe",
        );
      }
      await expect(command.updateStatusCommand({ json })).resolves.toBeUndefined();
      if (json) {
        const result = runtime.writeJson.mock.lastCall?.[0];
        expect(result).toHaveProperty("availability");
        expect(Boolean(result?.runStatusError)).toBe(unavailable);
        if (sqliteVersion === "3.51.2") {
          expect(result?.runtimeFindings).toEqual([
            expect.objectContaining({
              severity: "error",
              message: expect.stringContaining("SQLite 3.51.2"),
              fixHint: expect.stringContaining("nvm install 26"),
            }),
          ]);
        }
        expect(result?.activeRun).toEqual(unavailable ? undefined : recorded);
        expect(result?.lastRun).toEqual(unavailable ? undefined : recorded);
        expect(result).not.toHaveProperty("abandonedRun");
      } else {
        const output = runtime.log.mock.calls.flat().join("\n");
        expect(output).toContain("OpenClaw update status");
        expect(output.includes("Update run status unavailable:")).toBe(unavailable);
        if (sqliteVersion === "3.51.2") {
          expect(output).toContain("SQLite 3.51.2");
          expect(output).toContain("nvm install 26");
        }
      }
      if (!stored) {
        expect(prepare).not.toHaveBeenCalled();
      }
      prepare.mockRestore();
      expect(recorded && ledger.getUpdateRun(recorded.runId)).toEqual(recorded);
    },
  );

  it.each(["cli", "service"])(
    "renders admitted %s runtime information without a missing hint",
    async (source) => {
      if (source === "cli") {
        vi.spyOn(runtimeGuard, "detectRuntime").mockResolvedValue({
          kind: "node",
          version: "24.15.0",
          execPath: "/fixture/node",
          pathEnv: "/fixture",
          hasNodeSqlite: true,
          sqliteVersion: "3.53.4",
          sqliteProbe: { available: true, version: "3.53.4", text: true, blob: true, json: true },
        });
      } else {
        service.readCommand.mockResolvedValue({ programArguments: ["/fixture/node", "gateway"] });
        service.resolveNodeRuntimeInfo.mockResolvedValue({
          status: "supported",
          version: "24.15.0",
          note: "Node 24.15.0: unsupported version, capability probe passed.",
        });
      }
      await updateStatusCommand({});
      expect(runtime.log).toHaveBeenCalledWith(expect.stringContaining("capability probe passed"));
      expect(runtime.log).not.toHaveBeenCalledWith(undefined);
    },
  );

  it.each([
    { version: "22.23.2", source: "cli" },
    { version: "26.0.0", source: "cli" },
    { version: "22.23.2", source: "gateway-service" },
    { version: "26.0.0", source: "gateway-service" },
  ])(
    "reports unsupported $source Node $version with recovery instructions",
    async ({ version, source }) => {
      vi.stubGlobal("process", {
        ...process,
        versions: { ...process.versions, node: source === "cli" ? version : "26.8.1" },
      });
      if (source === "cli") {
        vi.spyOn(runtimeGuard, "detectRuntime").mockResolvedValue({
          kind: "node",
          version,
          execPath: "/fixture/node",
          pathEnv: "/fixture",
          hasNodeSqlite: true,
          sqliteVersion: "3.53.4",
          sqliteProbe: { available: true, version: "3.53.4", text: false, blob: true, json: true },
        });
      }
      if (source === "gateway-service") {
        service.readCommand.mockResolvedValue({
          programArguments: ["/fixture/node", "openclaw.mjs", "gateway"],
        });
        service.resolveNodeRuntimeInfo.mockResolvedValue({
          status: "unsupported",
          version,
          sqliteVersion: "3.50.2",
          nodeSharedSqlite: false,
        });
      }

      await updateStatusCommand({ json: true });

      expect(runtime.writeJson).toHaveBeenCalledWith(
        expect.objectContaining({
          runtimeFindings: [
            expect.objectContaining({
              source,
              message: expect.stringContaining(version),
              requirement: expect.stringContaining(">=24.16.0 <25, or >=26.1.0"),
              fixHint: expect.stringContaining("https://openclaw.ai/install.sh"),
            }),
          ],
        }),
      );
      await updateStatusCommand({});
      const output = runtime.log.mock.calls.map(([line]) => String(line)).join("\n");
      expect(output).toContain(version);
      expect(output).toContain("npm");
      expect(output).toContain("nvm install 26");
    },
  );

  it("does not report a supported CLI or recorded service Node", async () => {
    vi.stubGlobal("process", { ...process, versions: { ...process.versions, node: "26.8.1" } });
    service.readCommand.mockResolvedValue({
      programArguments: ["/fixture/node", "openclaw.mjs", "gateway"],
    });
    service.resolveNodeRuntimeInfo.mockResolvedValue({
      status: "supported",
      version: "26.8.1",
      sqliteVersion: "3.53.0",
      nodeSharedSqlite: false,
    });
    await updateStatusCommand({ json: true });
    expect(runtime.writeJson.mock.lastCall?.[0].runtimeFindings ?? []).toEqual([]);
  });
});

afterEach(() => {
  closeOpenClawStateDatabaseForTest();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  tempDirs.cleanup();
});

describe("update status abandoned-run reporting", () => {
  it.each([true, false])(
    "qualifies historical recovery advice using the recorded port (responding=%s)",
    async (responding) => {
      const advice =
        "Managed gateway remains stopped. Keep the gateway stopped until the update succeeds.";
      const created = createUpdateRun({ trigger: "cli", origin: { nextAction: advice } });
      recordUpdateRunVerification(created.runId, {
        port: 19123,
        serviceRunning: false,
        versionMatch: false,
      });
      const finished = finishUpdateRun(created.runId, {
        status: "failed",
        reason: "restart-unhealthy",
        after: { version: "2026.9.4" },
      });
      confirmGatewayReachable.mockResolvedValue({
        reachable: responding,
        gatewayVersion: responding ? "2026.9.4" : null,
        gatewayBuildId: undefined,
        activatedPluginErrors: [],
        unavailablePlugins: [],
        channelProbeErrors: [],
      });

      await updateStatusCommand({});

      const output = runtime.log.mock.calls.flat().join("\n");
      expect(output).toContain("service identity unavailable");
      expect(output).not.toContain("version mismatch");
      expect(runtime.log).not.toHaveBeenCalledWith(advice);
      expect(output).toContain("Historical recovery advice:");
      expect(output).toContain(
        responding ? "supersedes saved claims" : "Current health unavailable",
      );
      expect(confirmGatewayReachable).toHaveBeenCalledWith(
        expect.objectContaining({ port: 19123 }),
      );
      expect(getUpdateRun(created.runId)).toEqual(finished);

      await updateStatusCommand({ json: true });
      expect(runtime.writeJson.mock.lastCall?.[0].lastRun).toEqual(finished);
    },
  );

  it.each([true, false])(
    "reports unreadable pending migration status without losing availability (JSON: %s)",
    async (json) => {
      recordDeferredPluginMigrations({
        pending: [
          {
            pluginId: "codex",
            reason: "The configured plugin package is missing.",
            command: "openclaw plugins install @openclaw/codex",
          },
        ],
      });
      openOpenClawStateDatabase()
        .db.prepare("UPDATE migration_runs SET report_json = ? WHERE id = ?")
        .run("not-json", "deferred-plugin-migration:codex");
      await expect(updateStatusCommand({ json })).resolves.toBeUndefined();
      if (json) {
        const result = runtime.writeJson.mock.lastCall?.[0];
        expect(result).toHaveProperty("availability");
        expect(result.migrationWarningsError).toEqual(expect.any(String));
        expect(result).not.toHaveProperty("migrationWarnings");
      } else {
        const output = runtime.log.mock.calls.flat().join("\n");
        expect(output).toContain("OpenClaw update status");
        expect(output).toContain("Pending plugin migration status unavailable:");
      }
    },
  );

  it.each([true, false])(
    "reports current migration warnings absent from historical update steps (JSON: %s)",
    async (json) => {
      const run = createUpdateRun({ trigger: "cli" });
      const history = finishUpdateRun(run.runId, { status: "succeeded" });
      const pending = {
        pluginId: "codex",
        reason: "The configured plugin package is missing.",
        command: "openclaw plugins install @openclaw/codex",
      };
      recordDeferredPluginMigrations({ pending: [pending] });
      await updateStatusCommand({ json });
      if (json) {
        expect(runtime.writeJson.mock.lastCall?.[0].migrationWarnings).toEqual([
          expect.stringContaining('Plugin "codex" state migration is pending:'),
        ]);
        expect(runtime.writeJson.mock.lastCall?.[0].migrationWarnings[0]).toContain(
          pending.command,
        );
      } else {
        const output = runtime.log.mock.calls.flat().join("\n");
        expect(output).toContain('Plugin "codex" state migration is pending:');
        expect(output).toContain(pending.command);
      }
      expect(getUpdateRun(run.runId)).toEqual(history);

      recordDeferredPluginMigrations({ pending: [], resolvedPluginIds: [pending.pluginId] });
      runtime.log.mockClear();
      runtime.writeJson.mockClear();
      await updateStatusCommand({ json });
      if (json) {
        expect(runtime.writeJson.mock.lastCall?.[0]).not.toHaveProperty("migrationWarnings");
      } else {
        expect(runtime.log.mock.calls.flat().join("\n")).not.toContain(
          'Plugin "codex" state migration is pending:',
        );
      }
      expect(getUpdateRun(run.runId)).toEqual(history);
    },
  );

  it.each([true, false])(
    "reports an activation timeout without abandonment (JSON: %s)",
    async (json) => {
      const created = createUpdateRun({ trigger: "cli" });
      recordUpdateRunPhase(created.runId, "activating");
      const finished = finishUpdateRun(created.runId, {
        status: "failed",
        reason: "update-activation-timeout",
      });

      await updateStatusCommand({ json });

      if (json) {
        expect(runtime.writeJson.mock.lastCall?.[0]).toMatchObject({ lastRun: finished });
        expect(runtime.writeJson.mock.lastCall?.[0]).not.toHaveProperty("activeRun");
        expect(runtime.writeJson.mock.lastCall?.[0]).not.toHaveProperty("abandonedRun");
      } else {
        const output = runtime.log.mock.calls.flat().join("\n");
        expect(output).toContain("update-activation-timeout");
        expect(output).toContain("openclaw doctor");
        expect(output).toContain("Wait for the owning updater and its child processes to stop");
        expect(output).toContain("openclaw update repair");
        expect(output).not.toContain("Abandoned update detected");
      }
      expect(getUpdateRun(created.runId)).toEqual(finished);
    },
  );

  it.each(["json", "text", "status"])(
    "preserves readable history when reconciliation is refused through %s",
    async (surface) => {
      const now = Date.now();
      const clock = vi.spyOn(Date, "now").mockReturnValue(now - 25 * 60 * 60_000);
      const run = createUpdateRun({ trigger: "cli" });
      clock.mockReturnValue(now);
      claimOpenClawStateOwnership("test-supervisor", {
        env: { ...process.env, OPENCLAW_SUPERVISOR_MODE: "external" },
      });
      vi.stubEnv("OPENCLAW_SUPERVISOR_MODE", "");
      if (surface === "status") {
        const rows = buildStatusUpdateRows(null);
        expect(rows).toContainEqual(
          expect.objectContaining({
            Item: "Update run",
            Value: expect.stringContaining("update in progress: requested"),
          }),
        );
        expect(rows).toContainEqual(
          expect.objectContaining({
            Item: "Update reconciliation",
            Value: expect.stringContaining("externally supervised"),
          }),
        );
      } else {
        await updateStatusCommand({ json: surface === "json" });
        if (surface === "json") {
          const result = runtime.writeJson.mock.lastCall?.[0];
          expect(result).toMatchObject({
            activeRun: run,
            lastRun: run,
            runReconciliationError: expect.stringContaining("externally supervised"),
          });
          expect(result).not.toHaveProperty("runStatusError");
        } else {
          const output = runtime.log.mock.calls.flat().join("\n");
          expect(output).toContain(run.runId);
          expect(output).toContain("Update run reconciliation failed:");
          expect(output).not.toContain("Update run status unavailable:");
        }
      }
      expect(getUpdateRun(run.runId)).toEqual(run);
    },
  );

  it("does not advertise expiry for a legacy admission reserved by recovery", async () => {
    const now = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(now - 25 * 60 * 60_000);
    const legacy = createUpdateRun({ trigger: "cli", before: { version: "2026.9.2" } });
    const from = {
      root: process.env.OPENCLAW_STATE_DIR ?? "/fixture",
      nodePath: process.execPath,
      version: "2026.9.2",
      buildId: null,
    };
    createRetainedUpdateRecovery(
      { runId: legacy.runId, from, to: { ...from, version: "2026.9.3" } },
      {},
    );
    vi.mocked(Date.now).mockReturnValue(now);
    await updateStatusCommand({ json: true });
    expect(getUpdateRun(legacy.runId)).toEqual(legacy);
    expect(runtime.writeJson.mock.lastCall?.[0]).not.toHaveProperty("abandonedRun");
    expect(runtime.writeJson.mock.lastCall?.[0]).not.toHaveProperty("advisories");
  });

  it.each(
    ["none", "succeeded-before-expiry", "succeeded-after-expiry", "active"].flatMap((laterRun) =>
      ["json", "text", "status"].map((surface) => ({ laterRun, surface })),
    ),
  )(
    "keeps expired admission history with $laterRun through $surface",
    async ({ laterRun, surface }) => {
      const now = Date.now();
      const clock = vi.spyOn(Date, "now").mockReturnValue(now - 25 * 60 * 60_000);
      const legacy = createUpdateRun({ trigger: "cli", before: { version: "2026.9.2" } });
      clock.mockReturnValue(now);
      if (laterRun === "succeeded-after-expiry" || laterRun === "active") {
        await updateStatusCommand({ json: true });
        expect(getUpdateRun(legacy.runId)?.reason).toBe("legacy-driver-expired");
        runtime.writeJson.mockClear();
      }
      let currentRunId = legacy.runId;
      if (laterRun !== "none") {
        clock.mockReturnValue(now + 1);
        currentRunId = createUpdateRun({ trigger: "cli" }).runId;
        if (laterRun !== "active") {
          finishUpdateRun(currentRunId, { status: "succeeded" });
        }
      }
      let output: string;
      if (surface === "status") {
        output = JSON.stringify(buildStatusUpdateRows(null));
      } else {
        await updateStatusCommand({ json: surface === "json" });
        output =
          surface === "json"
            ? JSON.stringify(runtime.writeJson.mock.lastCall?.[0])
            : runtime.log.mock.calls.flat().join("\n");
      }
      const expired = getUpdateRun(legacy.runId);
      expect(expired).toMatchObject({
        phase: "finished",
        status: "failed",
        reason: "legacy-driver-expired",
      });
      expect(output).toContain("treated as abandoned after 24 h");
      expect(output.includes("Historical update:")).toBe(laterRun !== "none");
      expect(output.includes("run `openclaw update` to retry.")).toBe(laterRun === "none");
      expect(findActiveUpdateRun()?.runId).toBe(laterRun === "active" ? currentRunId : undefined);
      // A later read must still surface the advisory after the terminal write.
      await updateStatusCommand({ json: true });
      const result = runtime.writeJson.mock.lastCall?.[0];
      expect((result.activeRun ?? result.lastRun)?.runId).toBe(currentRunId);
      expect(result.advisories).toEqual([
        {
          runId: legacy.runId,
          reason: "legacy-driver-expired",
          message: expect.stringContaining("treated as abandoned after 24 h"),
        },
      ]);
      expect(getUpdateRun(legacy.runId)).toEqual(expired);
    },
  );

  it.each([true, false])(
    "does not publish partial history when the latest terminal row is unreadable (JSON: %s)",
    async (json) => {
      const now = Date.now();
      vi.spyOn(Date, "now").mockReturnValue(now);
      const active = createUpdateRun({ trigger: "cli" });
      vi.mocked(Date.now).mockReturnValue(now + 1);
      const latest = createUpdateRun({ trigger: "cli" });
      finishUpdateRun(latest.runId, { status: "succeeded" });
      closeOpenClawStateDatabaseForTest();
      const database = new DatabaseSync(resolveOpenClawStateSqlitePath());
      try {
        database
          .prepare("UPDATE update_runs SET origin_json = ? WHERE run_id = ?")
          .run("not-json", latest.runId);
      } finally {
        database.close();
      }
      expect(findActiveUpdateRun()).toEqual(active);
      expect(() => listUpdateRuns({ limit: 1 })).toThrow();

      await updateStatusCommand({ json });

      if (json) {
        const result = runtime.writeJson.mock.lastCall?.[0];
        expect(result?.runStatusError).toEqual(expect.any(String));
        expect(result).toHaveProperty("availability");
        for (const field of ["activeRun", "lastRun", "staleRun", "abandonedRun"]) {
          expect(result).not.toHaveProperty(field);
        }
      } else {
        const output = runtime.log.mock.calls.flat().join("\n");
        expect(output).toContain("OpenClaw update status");
        expect(output).toContain("Update run status unavailable:");
        expect(output).not.toContain(active.runId);
      }
      expect(getUpdateRun(active.runId)).toEqual(active);
      expect(() => listUpdateRuns({ limit: 1 })).toThrow();
    },
  );

  it.each([true, false])(
    "gives explicit recovery guidance for stale identityless history (JSON: %s)",
    async (json) => {
      const now = Date.now();
      const lastActivity = now - ABANDONED_UPDATE_RUN_MS - 10;
      vi.spyOn(Date, "now").mockReturnValue(lastActivity);
      const recorded = createUpdateRun({ trigger: "control-ui", before: { version: "2026.9.2" } });
      vi.mocked(Date.now).mockReturnValue(now);

      await updateStatusCommand({ json });

      const guidance = `no activity since ${new Date(lastActivity).toISOString()}; if no update is running, run \`openclaw update repair\` or start a new \`openclaw update\``;
      expect(getUpdateRun(recorded.runId)).toEqual(recorded);
      if (json) {
        expect(runtime.writeJson).toHaveBeenCalledWith(
          expect.objectContaining({
            activeRun: recorded,
            staleRun: { runId: recorded.runId, guidance },
          }),
        );
        expect(runtime.writeJson.mock.lastCall?.[0]).not.toHaveProperty("abandonedRun");
      } else {
        const output = runtime.log.mock.calls.map(([line]) => String(line)).join("\n");
        expect(output).toContain(guidance);
        expect(output).not.toContain("update in progress:");
      }
    },
  );

  it.each([true, false])("reports abandonment read-only (JSON: %s)", async (json) => {
    const now = Date.now();
    const driver = readUpdateRunDriver();
    if (!driver) {
      throw new Error("Test process identity is unavailable");
    }
    vi.spyOn(Date, "now").mockReturnValue(now - ABANDONED_UPDATE_RUN_MS - 10);
    const created = createUpdateRun({
      trigger: "control-ui",
      before: { version: "2026.9.2" },
      // This live PID has a different start identity than the exited driver.
      origin: { driver: { ...driver, startIdentity: String(Number(driver.startIdentity) + 1) } },
    });
    const recorded = recordUpdateRunPhase(created.runId, "staging");
    vi.mocked(Date.now).mockReturnValue(now);

    await updateStatusCommand({ json });

    expect(getUpdateRun(created.runId)).toEqual(recorded);
    if (json) {
      expect(runtime.writeJson).toHaveBeenCalledWith(
        expect.objectContaining({
          activeRun: recorded,
          lastRun: recorded,
          abandonedRun: { runId: created.runId, rule: "inactive-driver-dead" },
        }),
      );
    } else {
      const output = runtime.log.mock.calls.map(([line]) => String(line)).join("\n");
      expect(output).toContain("Abandoned update detected;");
      expect(output).toContain("openclaw update repair");
      expect(output).not.toContain("update in progress:");
      expect(output).not.toContain("update failed:");
    }
  });
});
