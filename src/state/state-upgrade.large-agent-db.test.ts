import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { sha256File } from "../infra/crypto-digest.js";
import { readSqliteCleanCloseSeal } from "../infra/sqlite-clean-close-seal.js";
import { OPENCLAW_AGENT_SCHEMA_SQL } from "./openclaw-agent-schema.js";
import {
  OPENCLAW_AGENT_SCHEMA_VERSION,
  OPENCLAW_STATE_SCHEMA_VERSION,
} from "./openclaw-schema-versions.js";
import { closeOpenClawStateDatabaseAsync } from "./openclaw-state-db-cache.js";
import { getOpenClawStatePredecessorSchema } from "./openclaw-state-schema-runtime.js";
import { upgradeStateDirectory } from "./state-upgrade.js";

const dirs: string[] = [];
afterEach(async () => {
  await closeOpenClawStateDatabaseAsync();
  for (const dir of dirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("startup canonical ownership", () => {
  it("leaves large current registered agent databases in place while migrating shared state", async () => {
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
      state.exec(getOpenClawStatePredecessorSchema(41));
      // The shared catalog is v41; the registered agent database is already current.
      state.exec(`PRAGMA user_version = 41;
        INSERT INTO schema_meta (meta_key, role, schema_version, created_at, updated_at)
          VALUES ('primary', 'global', 41, 1, 1);
        INSERT INTO config_machine_state VALUES ('state.schema.contentVersion', '41', 1);`);
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
      return state
        .prepare(
          "SELECT agent_id, path, schema_version, size_bytes FROM agent_databases ORDER BY agent_id, path",
        )
        .all();
    };
    const registrations = readRegistry();
    const agentIdentity = fs.statSync(agentPath);
    const agentBytes = await sha256File(agentPath);
    const stateIdentity = fs.statSync(statePath);
    const log = { info: vi.fn(), warn: vi.fn() };
    const result = await upgradeStateDirectory({
      env: {
        OPENCLAW_STATE_DIR: stateDir,
        OPENCLAW_CONFIG_PATH: path.join(stateDir, "openclaw.json"),
      },
      log,
    });
    expect(readRegistry()).toEqual(registrations);
    expect(result, JSON.stringify({ result, warnings: log.warn.mock.calls })).toEqual({
      status: "upgraded",
    });
    expect(fs.statSync(agentPath)).toMatchObject({
      dev: agentIdentity.dev,
      ino: agentIdentity.ino,
      size: 64 * 1024 * 1024 + 1,
    });
    expect(await sha256File(agentPath)).toBe(agentBytes);
    expect(fs.statSync(statePath)).toMatchObject({
      dev: stateIdentity.dev,
      ino: stateIdentity.ino,
    });
    expect(fs.readdirSync(stateDir).some((name) => name.startsWith(".upgrade-"))).toBe(false);
    expect(
      fs.readdirSync(path.dirname(agentPath)).filter((name) => name.includes(".pre-")),
    ).toEqual([]);
    // The existing clean-close owner may publish its validated seal, not an upgrade copy.
    expect(
      readSqliteCleanCloseSeal(agentPath, fs.statSync(agentPath, { bigint: true })),
    ).toBeDefined();
    using state = new DatabaseSync(statePath, { readOnly: true });
    expect(state.prepare("PRAGMA user_version").get()).toEqual({
      user_version: OPENCLAW_STATE_SCHEMA_VERSION,
    });
  });
});
