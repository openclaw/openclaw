import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";
import { runDoctorSessionSqlite } from "../../src/commands/doctor-session-sqlite.js";
import type { OpenClawConfig } from "../../src/config/types.openclaw.js";
import { migrateLegacyAcpSessionMetadata } from "../../src/infra/state-migrations.session-store.js";
import { EMPTY_LEGACY_SESSION_SURFACES } from "../../src/plugins/legacy-session-surfaces.types.js";
import { closeOpenClawAgentDatabasesAsync } from "../../src/state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseAsync } from "../../src/state/openclaw-state-db.js";
import { resolveTestNodeExecPath } from "../../src/test-utils/node-process.js";
import { withOpenClawTestState } from "../../src/test-utils/openclaw-test-state.js";

const assertionsPath = "scripts/e2e/lib/upgrade-survivor/assertions.mjs";
const groupKey = "agent:main:slack:channel:cupgrade";

it("observes migrated ACP metadata through the survivor command and rejects lost model or identity", async () => {
  await withOpenClawTestState({ prefix: "openclaw-survivor-acp-" }, async (state) => {
    const cfg: OpenClawConfig = { agents: { entries: { main: {} } } };
    await state.writeConfig(cfg);
    const env = {
      ...state.env,
      OPENCLAW_TEST_WORKSPACE_DIR: state.workspaceDir,
      OPENCLAW_UPGRADE_SURVIVOR_SCENARIO: "acpx-openclaw-tools-bridge",
      OPENCLAW_UPGRADE_SURVIVOR_MISSING_LOAD_PATH_SEEDED: "",
    };
    const run = (command: string) =>
      spawnSync(resolveTestNodeExecPath(), [assertionsPath, command], { env, encoding: "utf8" });
    const seeded = run("seed");
    expect(seeded.status, seeded.stderr).toBe(0);
    const legacyStore = path.join(state.sessionsDir("main"), "sessions.json");
    const legacyGroup = JSON.parse(readFileSync(legacyStore, "utf8"))[groupKey];
    expect(legacyGroup.acp.runtimeOptions.model).toBe("gpt-5.5");

    const migrated = await migrateLegacyAcpSessionMetadata({
      cfg,
      env: state.env,
      pluginSessionStoreAgentIds: [],
      legacySessionSurfaces: EMPTY_LEGACY_SESSION_SURFACES,
    });
    expect(migrated.warnings).toEqual([]);
    const imported = await runDoctorSessionSqlite({
      cfg,
      env: state.env,
      allAgents: true,
      mode: "import",
    });
    expect(imported.targets.flatMap((target) => target.issues)).toEqual([]);
    // Hand the isolated offline artifact to the same dependency-free observer used by release CI.
    await closeOpenClawAgentDatabasesAsync();
    await closeOpenClawStateDatabaseAsync();
    const db = new DatabaseSync(state.statePath("state", "openclaw.sqlite"));
    try {
      const original = db.prepare("SELECT * FROM acp_sessions").get();
      expect(original?.runtime_options_json).toBe(
        JSON.stringify({ model: "gpt-5.5", runtimeMode: "plan", thinking: "low" }),
      );
      const agentDb = new DatabaseSync(
        state.statePath("agents", "main", "agent", "openclaw-agent.sqlite"),
        { readOnly: true },
      );
      try {
        const row = agentDb
          .prepare("SELECT entry_json FROM session_nodes WHERE session_key = ?")
          .get(groupKey);
        expect(JSON.parse(String(row?.entry_json)).acp).toBeUndefined();
      } finally {
        agentDb.close();
      }
      const survived = run("assert-state");
      expect(survived.status, survived.stderr).toBe(0);

      for (const [column, value] of [
        [
          "runtime_options_json",
          JSON.stringify({ model: "changed", runtimeMode: "plan", thinking: "low" }),
        ],
        ["identity_json", JSON.stringify({ state: "resolved", acpxRecordId: "wrong-record" })],
        ["session_id", "another-session"],
        ["session_key", "agent:main:slack:channel:cupgrade"],
      ] as const) {
        db.prepare("UPDATE acp_sessions SET " + column + " = ?").run(value);
        const damaged = run("assert-state");
        expect(damaged.status, column + ": " + damaged.stderr).toBe(1);
        expect(damaged.stderr).toMatch(/saved ACP|ACP session binding/);
        db.prepare("UPDATE acp_sessions SET " + column + " = ?").run(original?.[column] ?? null);
      }
      db.exec("DELETE FROM acp_sessions");
      const missing = run("assert-state");
      expect(missing.status, missing.stderr).toBe(1);
      expect(missing.stderr).toContain("saved ACP session or model selection changed");
    } finally {
      db.close();
    }
  });
});
