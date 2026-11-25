import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { bindFreshClientCredentialStore } from "../infra/client-credential-migration.js";
import { openClientCredentialCustody } from "../infra/client-credential-store.js";
import { readBackupEngine } from "../infra/database-engine/physical-store.js";
import { runSqliteImmediateTransactionSync } from "../infra/sqlite-transaction.js";
import * as backup from "../snapshot/database-backup.js";
import { createTrialPending, resolvePrefix, writeTrial } from "../update/store.js";
import {
  OPENCLAW_AGENT_SCHEMA_VERSION,
  OPENCLAW_STATE_SCHEMA_VERSION,
} from "./openclaw-schema-versions.js";
import { closeOpenClawStateDatabaseAsync } from "./openclaw-state-db.js";
import { getOpenClawStatePredecessorSchema } from "./openclaw-state-schema-runtime.js";
import { upgradeStateDirectory } from "./state-upgrade.js";

const dirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(async () => {
  await closeOpenClawStateDatabaseAsync();
  vi.restoreAllMocks();
});

it.each([
  { gib: 7, trial: true },
  { gib: 7, trial: false },
])(
  "leaves a current $gib GiB PostgreSQL store in place (trial: $trial)",
  async ({ gib, trial }) => {
    const root = dirs.make("state-upgrade-pg-size-");
    const statePath = path.join(root, "state", "openclaw.sqlite");
    const agentPath = path.join(root, "agents", "main", "agent", "openclaw-agent.sqlite");
    const configPath = path.join(root, "openclaw.json");
    const env = { OPENCLAW_STATE_DIR: root, OPENCLAW_CONFIG_PATH: configPath };
    openClientCredentialCustody(env, { createIfMissing: true })?.close();
    for (const file of [statePath, agentPath]) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
    }
    fs.writeFileSync(configPath, "{}");
    {
      using state = new DatabaseSync(statePath);
      state.exec(getOpenClawStatePredecessorSchema(41));
      state.exec(`PRAGMA user_version = 41;
        INSERT INTO schema_meta (meta_key, role, schema_version, created_at, updated_at)
          VALUES ('primary', 'global', 41, 1, 1);
        INSERT INTO config_machine_state VALUES ('state.schema.contentVersion', '41', 1);`);
      runSqliteImmediateTransactionSync(state, () =>
        bindFreshClientCredentialStore(state, { path: statePath, env }),
      );
      using agent = new DatabaseSync(agentPath);
      agent.exec(
        "CREATE TABLE openclaw_engine_anchor (store_id TEXT NOT NULL, engine TEXT NOT NULL, schema TEXT NOT NULL)",
      );
      agent.exec(
        "INSERT INTO openclaw_engine_anchor VALUES ('synthetic-store', 'postgres', 'original_agent')",
      );
    }
    const originalAgent = fs.readFileSync(agentPath);
    const originalAgentInode = fs.statSync(agentPath).ino;
    const originalInode = fs.statSync(statePath).ino;
    // Fixed external database facts avoid allocating multi-GiB PostgreSQL fixtures.
    vi.spyOn(backup, "inspectPostgresUpgrade").mockResolvedValue({
      engine: "postgres",
      storeId: "synthetic-store",
      namespace: "original_agent",
      family: "agent",
      version: OPENCLAW_AGENT_SCHEMA_VERSION,
      minReader: OPENCLAW_AGENT_SCHEMA_VERSION,
      physicalBytes: gib * 1024 ** 3,
      retainedAgentIds: [],
      registeredAgentDatabases: [],
    });
    vi.spyOn(backup, "preflightPostgresUpgrade").mockRejectedValue(
      new Error("PostgreSQL protected copy requires database CREATE privilege"),
    );
    vi.spyOn(backup, "clonePostgresUpgrade").mockRejectedValue(
      new Error("Current PostgreSQL stores must not be cloned"),
    );
    if (trial) {
      const target = path.join(resolvePrefix(env), "releases", "candidate", "openclaw");
      fs.mkdirSync(target, { recursive: true });
      const pending = await createTrialPending(
        {
          runId: "synthetic-size-trial",
          target,
          previous: root,
          version: "synthetic",
        },
        resolvePrefix(env),
      );
      await writeTrial({ ...pending, phase: "trial" }, resolvePrefix(env));
    }
    const log = { info: vi.fn(), warn: vi.fn() };
    const result = await upgradeStateDirectory({
      env,
      log,
    });
    expect(result).toEqual({ status: "upgraded" });
    expect(readBackupEngine(agentPath)).toMatchObject({ namespace: "original_agent" });
    expect(fs.readFileSync(agentPath)).toEqual(originalAgent);
    expect(fs.statSync(agentPath).ino).toBe(originalAgentInode);
    expect(fs.statSync(statePath).ino).toBe(originalInode);
    expect(fs.readdirSync(root).some((name) => name.startsWith(".upgrade-"))).toBe(false);
    expect(
      fs.readdirSync(path.dirname(agentPath)).filter((name) => name.includes(".pre-")),
    ).toEqual([]);
    using state = new DatabaseSync(statePath, { readOnly: true });
    expect(state.prepare("PRAGMA user_version").get()).toEqual({
      user_version: OPENCLAW_STATE_SCHEMA_VERSION,
    });
    if (!trial) {
      expect(
        fs.readdirSync(path.dirname(statePath)).filter((name) => name.includes(".pre-")),
      ).toEqual([]);
    }
  },
);
