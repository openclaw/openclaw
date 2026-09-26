import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { loadSessionEntry, replaceSessionEntry } from "../config/sessions/session-accessor.js";
import { runGatewayStartupMaintenance } from "../gateway/server-startup-plugins.js";
import { requireNodeSqlite } from "../infra/node-sqlite.js";
import { flushLogger, resetLogger, setLoggerOverride } from "../logging/logger.js";
import { OPENCLAW_AGENT_SCHEMA_VERSION } from "./openclaw-agent-db-contract.js";
import {
  closeOpenClawAgentDatabasesAsync,
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
} from "./openclaw-agent-db.js";
import { assertOpenClawDatabasesReady } from "./openclaw-database-preflight.js";
import { closeOpenClawStateDatabaseForTest } from "./openclaw-state-db.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const repairMessage = "Rebuilt canonical agent SQLite indexes";
const siblingIndexes = [
  "archived_at",
  "current_session_id",
  "entry_valid_pending",
  "last_interaction_at",
  "parent_session_key",
  "spawned_by",
  "status",
  "updated_at",
].map((suffix) => `idx_agent_session_nodes_${suffix}`);

afterEach(async () => {
  await closeOpenClawAgentDatabasesAsync();
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
  await flushLogger();
  setLoggerOverride(null);
  resetLogger();
  vi.unstubAllEnvs();
});

async function createFixture(ids: string[], damage: "missing" | "drifted" | "missing table") {
  const stateDir = fs.realpathSync.native(tempDirs.make("startup-index-"));
  const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
  const logPath = path.join(stateDir, "startup.log");
  const configPath = path.join(stateDir, "openclaw.json");
  const config = {
    agents: {
      ownership: "explicit" as const,
      entries: Object.fromEntries(ids.map((id) => [id, {}] as const)),
    },
  };
  vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
  vi.stubEnv("OPENCLAW_CONFIG_PATH", configPath);
  vi.stubEnv("OPENCLAW_LOG_LEVEL", "warn");
  fs.writeFileSync(
    configPath,
    JSON.stringify({ ...config, logging: { level: "warn", file: logPath } }),
  );
  setLoggerOverride({ level: "warn", file: logPath, consoleLevel: "silent" });
  const agents = [];
  for (const agentId of ids) {
    const agentPath = openOpenClawAgentDatabase({ agentId, env }).path;
    const session = { agentId, env, sessionKey: `agent:${agentId}:retained` };
    await replaceSessionEntry(session, { sessionId: `${agentId}-history`, updatedAt: 1 });
    agents.push({ agentId, path: agentPath, session, entry: loadSessionEntry(session) });
  }
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
  const { DatabaseSync } = requireNodeSqlite();
  for (const agent of agents) {
    const writer = new DatabaseSync(agent.path);
    writer.exec("DROP INDEX idx_agent_session_nodes_active;");
    writer.exec("UPDATE schema_meta SET app_version = '2026.9.1';");
    expect(writer.prepare("PRAGMA user_version").get()?.user_version).toBe(
      OPENCLAW_AGENT_SCHEMA_VERSION,
    );
    expect(writer.prepare("SELECT schema_version FROM schema_meta").get()?.schema_version).toBe(
      OPENCLAW_AGENT_SCHEMA_VERSION,
    );
    expect(writer.prepare("SELECT app_version FROM schema_meta").get()?.app_version).toBe(
      "2026.9.1",
    );
    expect(
      writer
        .prepare("SELECT name FROM sqlite_schema WHERE type='index'")
        .all()
        .map((row) => row.name),
    ).toEqual(expect.arrayContaining(siblingIndexes));
    // Keep the current schema's later optional label index; only _active is missing.
    expect(
      writer
        .prepare("SELECT name FROM sqlite_schema WHERE name='idx_agent_session_nodes_label'")
        .get(),
    ).toBeDefined();
    expect(
      writer
        .prepare("SELECT name FROM sqlite_schema WHERE name='idx_agent_session_nodes_active'")
        .get(),
    ).toBeUndefined();
    if (damage === "drifted") {
      writer.exec("CREATE INDEX idx_agent_session_nodes_active ON session_nodes(session_key);");
    } else if (damage === "missing table") {
      writer.exec("DROP TABLE session_key_contract;");
    }
    writer.close();
  }
  return {
    env,
    config,
    agents,
    logPath,
    before: agents.map((agent) => fs.readFileSync(agent.path)),
  };
}

it.each(["missing", "drifted"] as const)(
  "repairs every agent's %s index in one startup",
  async (damage) => {
    const { env, config, agents, logPath, before } = await createFixture(
      ["memes", "main", "friends"],
      damage,
    );
    const runStartup = () =>
      runGatewayStartupMaintenance({
        cfgAtStart: config,
        startupRuntimeConfig: config,
        minimalTestGateway: false,
        log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
      });
    await expect(
      assertOpenClawDatabasesReady({ env, operation: "gateway-startup", config }),
    ).resolves.toBeUndefined();
    expect(agents.map((agent) => fs.readFileSync(agent.path))).toEqual(before);
    await runStartup();
    for (const agent of agents) {
      const reader = new (requireNodeSqlite().DatabaseSync)(agent.path, { readOnly: true });
      try {
        expect(
          reader
            .prepare("SELECT sql FROM sqlite_schema WHERE name='idx_agent_session_nodes_active'")
            .get()?.sql,
        ).toMatch(/WHERE archived_at IS NULL/i);
        expect(reader.prepare("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
      } finally {
        reader.close();
      }
      expect(loadSessionEntry(agent.session)).toEqual(agent.entry);
    }
    await flushLogger();
    const repairs = () =>
      fs
        .readFileSync(logPath, "utf8")
        .trim()
        .split("\n")
        .map((line): { message?: string; "1"?: unknown } => JSON.parse(line))
        .filter((record) => record.message?.startsWith(repairMessage));
    const ordered = agents.toSorted((a, b) => a.agentId.localeCompare(b.agentId));
    expect(repairs().toSorted((a, b) => (a.message ?? "").localeCompare(b.message ?? ""))).toEqual(
      ordered.map((agent) =>
        expect.objectContaining({
          message: `${repairMessage} for ${agent.agentId} (${agent.path}): idx_agent_session_nodes_active`,
          "1": expect.objectContaining({
            agentId: agent.agentId,
            path: agent.path,
            indexes: ["idx_agent_session_nodes_active"],
            elapsedMs: expect.any(Number),
          }),
        }),
      ),
    );
    await expect(
      assertOpenClawDatabasesReady({ env, operation: "gateway-restart", config }),
    ).resolves.toBeUndefined();
    await runStartup();
    await flushLogger();
    expect(repairs()).toHaveLength(3);
  },
);

it("reports every refused database and its missing indexes without mutating any agent", async () => {
  const { env, config, agents, before } = await createFixture(
    ["work", "memes", "main", "friends"],
    "missing table",
  );
  const message = await assertOpenClawDatabasesReady({
    env,
    operation: "gateway-startup",
    config,
  }).then(
    () => "",
    (error: unknown) => String(error),
  );
  const rows = message.split("\n").filter((line) => line.startsWith("agent "));
  expect(rows).toEqual(
    agents
      .toSorted((a, b) => a.agentId.localeCompare(b.agentId))
      .map((agent) => expect.stringContaining(`agent ${agent.agentId} ${agent.path}:`)),
  );
  for (const row of rows) {
    expect(row).toContain("missing table session_key_contract");
    expect(row).toContain("missing or drifted index idx_agent_session_nodes_active");
    expect(row).toContain("openclaw doctor --fix");
  }
  expect(agents.map((agent) => fs.readFileSync(agent.path))).toEqual(before);
});
