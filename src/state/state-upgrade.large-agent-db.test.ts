import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { migrateLegacyMediaPersistence } from "../infra/state-migrations.media-persistence.js";
import { OPENCLAW_AGENT_SCHEMA_SQL } from "./openclaw-agent-schema.js";
import {
  OPENCLAW_AGENT_SCHEMA_VERSION,
  OPENCLAW_STATE_SCHEMA_VERSION,
} from "./openclaw-schema-versions.js";
import { closeOpenClawStateDatabaseAsync } from "./openclaw-state-db-cache.js";
import { OPENCLAW_STATE_SCHEMA_SQL } from "./openclaw-state-schema.js";
import { upgradeStateDirectory } from "./state-upgrade.js";

const dirs: string[] = [];
afterEach(async () => {
  await closeOpenClawStateDatabaseAsync();
  for (const dir of dirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("startup copy ownership", () => {
  it("preserves registrations for large current agent databases omitted from the shadow", async () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-upgrade-registry-"));
    dirs.push(stateDir);
    const agentPath = path.join(stateDir, "agents/main/agent/openclaw-agent.sqlite");
    fs.mkdirSync(path.dirname(agentPath), { recursive: true });
    {
      using agent = new DatabaseSync(agentPath);
      agent.exec(OPENCLAW_AGENT_SCHEMA_SQL);
      agent.exec(`PRAGMA user_version = ${OPENCLAW_AGENT_SCHEMA_VERSION}`);
      agent
        .prepare("INSERT INTO schema_meta VALUES ('primary', 'agent', ?, 'main', 'test', 1, 1)")
        .run(OPENCLAW_AGENT_SCHEMA_VERSION);
    }
    fs.truncateSync(agentPath, 64 * 1024 * 1024 + 1);
    const statePath = path.join(stateDir, "state/openclaw.sqlite");
    fs.mkdirSync(path.dirname(statePath), { recursive: true });
    {
      using state = new DatabaseSync(statePath);
      state.exec(OPENCLAW_STATE_SCHEMA_SQL);
      // Only the shared version stamp is behind; the agent database is already current.
      state.exec(`PRAGMA user_version = ${OPENCLAW_STATE_SCHEMA_VERSION - 1}`);
      state
        .prepare("INSERT INTO schema_meta VALUES ('primary', 'global', ?, NULL, 'test', 1, 1)")
        .run(OPENCLAW_STATE_SCHEMA_VERSION - 1);
      state
        .prepare("INSERT INTO agent_databases VALUES ('main', ?, ?, 1, ?)")
        .run(
          "agents/main/agent/openclaw-agent.sqlite",
          OPENCLAW_AGENT_SCHEMA_VERSION,
          fs.statSync(agentPath).size,
        );
    }
    fs.writeFileSync(path.join(stateDir, "openclaw.json"), "{}");
    const readRegistry = () => {
      using state = new DatabaseSync(statePath, { readOnly: true });
      return state.prepare("SELECT * FROM agent_databases ORDER BY agent_id, path").all();
    };
    const registrations = readRegistry();
    const log = { info: vi.fn(), warn: vi.fn() };
    const result = await upgradeStateDirectory({
      env: {
        OPENCLAW_STATE_DIR: stateDir,
        OPENCLAW_CONFIG_PATH: path.join(stateDir, "openclaw.json"),
      },
      log,
      runChain: async ({ stateDir: shadow }) => {
        expect(fs.existsSync(path.join(shadow, "agents/main/agent/openclaw-agent.sqlite"))).toBe(
          false,
        );
        {
          using state = new DatabaseSync(path.join(shadow, "state/openclaw.sqlite"));
          state.exec(`PRAGMA user_version = ${OPENCLAW_STATE_SCHEMA_VERSION}`);
          state
            .prepare("UPDATE schema_meta SET schema_version = ? WHERE meta_key = 'primary'")
            .run(OPENCLAW_STATE_SCHEMA_VERSION);
        }
        const migration = await migrateLegacyMediaPersistence({
          env: { OPENCLAW_STATE_DIR: shadow },
        });
        // The real Doctor subprocess releases its handles before the shadow is checkpointed.
        await closeOpenClawStateDatabaseAsync();
        expect(migration.warnings, JSON.stringify(migration)).toContain(
          `Skipped missing registered agent database ${path.join(shadow, "agents/main/agent/openclaw-agent.sqlite")}.`,
        );
        return migration;
      },
    });
    expect(readRegistry()).toEqual(registrations);
    expect(result, JSON.stringify({ result, warnings: log.warn.mock.calls })).toMatchObject({
      status: "upgraded",
      mode: "chain",
      conservationMismatches: [],
      pinned: false,
    });
    expect(fs.statSync(agentPath).size).toBe(64 * 1024 * 1024 + 1);
    using state = new DatabaseSync(statePath, { readOnly: true });
    const report = state
      .prepare("SELECT payload_json FROM diagnostic_events WHERE scope = 'upgrade.report'")
      .get();
    expect(JSON.parse(String(report?.payload_json))).toMatchObject({
      conservationMismatches: [],
      pinned: false,
    });
  });
});
