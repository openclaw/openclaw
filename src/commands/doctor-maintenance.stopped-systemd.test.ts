import "../flows/doctor-health.test-support.js";
import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createMockGatewayService } from "../daemon/service.test-helpers.js";
import * as systemdExec from "../daemon/systemd-exec.js";
import { buildSystemdUnit } from "../daemon/systemd-unit.js";
import { runDoctorHealthFlow } from "../flows/doctor-health.js";
import { requireNodeSqlite } from "../infra/node-sqlite.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";

const { mocks } = await import("../flows/doctor-health.test-support.js");
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

it.each(["current-policy", "short-timeout", "removed-system-unit"] as const)(
  "migrates legacy audit state with an inactive Gateway: %s",
  async (scenario) => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const databasePath = state.statePath("state", "openclaw.sqlite");
      fs.mkdirSync(path.dirname(databasePath), { recursive: true });
      const { DatabaseSync } = requireNodeSqlite();
      // Historical v1 schema: source_id was unique and agent/run IDs were required.
      const legacy = new DatabaseSync(databasePath);
      legacy.exec(`
        PRAGMA user_version = 1;
        CREATE TABLE schema_meta (
          meta_key TEXT NOT NULL PRIMARY KEY, role TEXT NOT NULL,
          schema_version INTEGER NOT NULL, agent_id TEXT, app_version TEXT,
          created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
        );
        INSERT INTO schema_meta VALUES ('primary', 'global', 1, NULL, NULL, 10, 10);
        CREATE TABLE audit_events (
          sequence INTEGER PRIMARY KEY AUTOINCREMENT, event_id TEXT NOT NULL UNIQUE,
          source_id TEXT NOT NULL UNIQUE, source_sequence INTEGER NOT NULL,
          occurred_at INTEGER NOT NULL, kind TEXT NOT NULL, action TEXT NOT NULL,
          status TEXT NOT NULL, error_code TEXT, actor_type TEXT NOT NULL,
          actor_id TEXT NOT NULL, agent_id TEXT NOT NULL, session_key TEXT,
          session_id TEXT, run_id TEXT NOT NULL, tool_call_id TEXT, tool_name TEXT
        );
        INSERT INTO audit_events
          (event_id, source_id, source_sequence, occurred_at, kind, action, status,
           actor_type, actor_id, agent_id, run_id)
          VALUES ('retained-event', 'source', 1, 100, 'agent_run', 'started', 'ok',
                  'agent', 'main', 'main', 'old-run');
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
      mocks.runContributions.mockReset();
      // Schema preparation belongs to beginDoctorMaintenance and runs before contributions.
      mocks.runContributions.mockImplementation(async () => {});
      vi.spyOn(systemdExec, "execSystemctl").mockResolvedValue({
        code: 0,
        stdout: "not-found",
        stderr: "",
        termination: "exit",
      });
      vi.spyOn(systemdExec, "execSystemctlUser").mockResolvedValue({
        code: 0,
        stderr: "",
        termination: "exit",
        stdout: `LoadState=loaded\nAfter=network-online.target\nWants=network-online.target\nRestartUSec=5s\nKillMode=mixed\nTimeoutStopUSec=${scenario === "short-timeout" ? 30 : 330}s\n`,
      });
      const runtime = { log: vi.fn(), error: vi.fn(), exit: vi.fn() };
      try {
        await runDoctorHealthFlow(runtime, { repair: true, nonInteractive: true });
        const output = [...runtime.log.mock.calls, ...runtime.error.mock.calls].flat().join("\n");
        expect(runtime.exit, output).not.toHaveBeenCalled();
        expect(output.includes("Gateway service inspection is unavailable")).toBe(removed);
        expect(mocks.outro).toHaveBeenCalledWith("Doctor complete.");
        const migrated = new DatabaseSync(databasePath, { readOnly: true });
        try {
          expect(migrated.prepare("SELECT event_id FROM audit_events").all()).toEqual([
            { event_id: "retained-event" },
          ]);
          expect(migrated.prepare("PRAGMA user_version").get()).not.toEqual({ user_version: 1 });
          expect(migrated.prepare("PRAGMA integrity_check").get()).toEqual({
            integrity_check: "ok",
          });
        } finally {
          migrated.close();
        }
        const backupPrefix = "Saved pre-migration SQLite backup: ";
        const backupLine = runtime.log.mock.calls
          .flat()
          .find((line) => String(line).startsWith(backupPrefix));
        expect(backupLine).toBeTypeOf("string");
        const backup = new DatabaseSync(String(backupLine).slice(backupPrefix.length), {
          readOnly: true,
        });
        try {
          expect(backup.prepare("PRAGMA user_version").get()).toEqual({ user_version: 1 });
          expect(backup.prepare("SELECT event_id FROM audit_events").all()).toEqual([
            { event_id: "retained-event" },
          ]);
        } finally {
          backup.close();
        }
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
