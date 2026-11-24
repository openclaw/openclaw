import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { readBackupEngine } from "../infra/database-engine/physical-store.js";
import * as backup from "../snapshot/database-backup.js";
import { createTrialPending, resolvePrefix } from "../update/store.js";
import {
  OPENCLAW_AGENT_SCHEMA_VERSION,
  OPENCLAW_STATE_SCHEMA_VERSION,
} from "./openclaw-schema-versions.js";
import { closeOpenClawStateDatabaseAsync } from "./openclaw-state-db.js";
import { OPENCLAW_STATE_SCHEMA_SQL } from "./openclaw-state-schema.js";
import { preflightStateUpgrade } from "./state-upgrade-databases.js";
import { upgradeStateDirectory } from "./state-upgrade.js";

const dirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(async () => {
  await closeOpenClawStateDatabaseAsync();
  vi.restoreAllMocks();
});

it.each([
  { gib: 6, trial: true, canCreate: true },
  { gib: 7, trial: true, canCreate: true },
  { gib: 7, trial: false, canCreate: false },
  { gib: 7, trial: true, canCreate: false },
])("upgrades $gib GiB (trial: $trial, CREATE: $canCreate)", async ({ gib, trial, canCreate }) => {
  const root = dirs.make("state-upgrade-pg-size-");
  const statePath = path.join(root, "state", "openclaw.sqlite");
  const agentPath = path.join(root, "agents", "main", "agent", "openclaw-agent.sqlite");
  const configPath = path.join(root, "openclaw.json");
  for (const file of [statePath, agentPath]) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
  }
  fs.writeFileSync(configPath, "{}");
  {
    using state = new DatabaseSync(statePath);
    state.exec(OPENCLAW_STATE_SCHEMA_SQL);
    state.exec(`PRAGMA user_version = ${OPENCLAW_STATE_SCHEMA_VERSION - 1}`);
    using agent = new DatabaseSync(agentPath);
    agent.exec(
      "CREATE TABLE openclaw_engine_anchor (store_id TEXT NOT NULL, engine TEXT NOT NULL, schema TEXT NOT NULL)",
    );
    agent.exec(
      "INSERT INTO openclaw_engine_anchor VALUES ('synthetic-store', 'postgres', 'original_agent')",
    );
  }
  const original = fs.readFileSync(statePath);
  // Fixed external database facts avoid allocating multi-GiB PostgreSQL fixtures.
  vi.spyOn(backup, "inspectPostgresUpgrade").mockResolvedValue({
    engine: "postgres",
    storeId: "synthetic-store",
    namespace: "original_agent",
    family: "agent",
    version: OPENCLAW_AGENT_SCHEMA_VERSION - 1,
    physicalBytes: gib * 1024 ** 3,
    retainedAgentIds: [],
    registeredAgentDatabases: [],
  });
  vi.spyOn(backup, "preflightPostgresUpgrade").mockImplementation(async () => {
    if (!canCreate) {
      throw new Error("PostgreSQL protected copy requires database CREATE privilege");
    }
  });
  vi.spyOn(backup, "clonePostgresUpgrade").mockImplementation(async (source, anchor) => {
    fs.copyFileSync(source, anchor);
    using db = new DatabaseSync(anchor);
    db.exec("UPDATE openclaw_engine_anchor SET schema = 'private_agent'");
    return { namespace: "private_agent" };
  });
  vi.spyOn(backup, "validatePostgresUpgrade").mockResolvedValue(undefined);
  const env = { OPENCLAW_STATE_DIR: root, OPENCLAW_CONFIG_PATH: configPath };
  if (trial && !canCreate) {
    await expect(preflightStateUpgrade(env, {})).rejects.toThrow(/CREATE privilege/);
    expect(fs.readFileSync(statePath)).toEqual(original);
    expect(readBackupEngine(agentPath)).toMatchObject({ namespace: "original_agent" });
    expect(fs.readdirSync(root).some((name) => name.startsWith(".upgrade-"))).toBe(false);
    return;
  }
  if (trial) {
    await preflightStateUpgrade(env, {});
    await createTrialPending(
      {
        runId: "synthetic-size-trial",
        target: root,
        previous: root,
        version: "synthetic",
      },
      resolvePrefix(env),
    );
  }
  const log = { info: vi.fn(), warn: vi.fn() };
  const result = await upgradeStateDirectory({
    env,
    log,
    runChain: async ({ stateDir }) => {
      expect(stateDir).not.toBe(root);
      expect(fs.readFileSync(statePath)).toEqual(original);
      expect(readBackupEngine(path.join(stateDir, path.relative(root, agentPath)))).toMatchObject({
        namespace: trial ? "private_agent" : "original_agent",
      });
      using state = new DatabaseSync(path.join(stateDir, "state", "openclaw.sqlite"));
      state.exec(`PRAGMA user_version = ${OPENCLAW_STATE_SCHEMA_VERSION}`);
      return { warnings: [] };
    },
  });
  expect(result).toMatchObject({ status: "upgraded", mode: "chain", pinned: false });
  expect(readBackupEngine(agentPath)).toMatchObject({
    namespace: trial ? "private_agent" : "original_agent",
  });
  using state = new DatabaseSync(statePath, { readOnly: true });
  expect(state.prepare("PRAGMA user_version").get()).toEqual({
    user_version: OPENCLAW_STATE_SCHEMA_VERSION,
  });
  const previous = fs
    .readdirSync(path.dirname(statePath))
    .find((name) => name.startsWith("openclaw.sqlite.pre-"));
  expect(previous).toBeDefined();
  expect(fs.readFileSync(path.join(path.dirname(statePath), previous!))).toEqual(original);
  const report = state
    .prepare("SELECT payload_json FROM diagnostic_events WHERE scope = 'upgrade.report'")
    .get();
  expect(result).toMatchObject({ warnings: [] });
  expect(JSON.parse(String(report?.payload_json))).toMatchObject({ warnings: [] });
});
