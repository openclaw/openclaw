import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  OPENCLAW_AGENT_SCHEMA_VERSION,
  OPENCLAW_STATE_SCHEMA_VERSION,
} from "./openclaw-schema-versions.js";
import { OPENCLAW_STATE_SCHEMA_SQL } from "./openclaw-state-schema.js";
import { discoverDatabases, stateUpgradeRefusal } from "./state-upgrade-databases.js";

const dirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => vi.restoreAllMocks());

it("counts current SQLite agents in the trial budget when another store needs Doctor", async () => {
  const root = dirs.make("state-upgrade-budget-");
  const shared = path.join(root, "state", "openclaw.sqlite");
  const agent = path.join(root, "agents", "main", "agent", "openclaw-agent.sqlite");
  fs.mkdirSync(path.dirname(shared), { recursive: true });
  fs.mkdirSync(path.dirname(agent), { recursive: true });
  {
    using db = new DatabaseSync(shared);
    db.exec(OPENCLAW_STATE_SCHEMA_SQL);
    db.exec(`PRAGMA user_version = ${OPENCLAW_STATE_SCHEMA_VERSION - 1}`);
    using agentDb = new DatabaseSync(agent);
    agentDb.exec(`PRAGMA user_version = ${OPENCLAW_AGENT_SCHEMA_VERSION}`);
  }
  const inventory = await discoverDatabases(root, {}, { OPENCLAW_STATE_DIR: root });
  const before = fs.readFileSync(agent);
  // Size is an external filesystem fact, not a migration result. Keep real
  // discovery and a real SQLite family without allocating a TiB fixture.
  const originalStat = fs.statSync;
  vi.spyOn(fs, "statSync").mockImplementation((...args: Parameters<typeof fs.statSync>) => {
    const stat = Reflect.apply(originalStat, fs, args);
    if (args[0] === agent && stat && typeof stat.size === "number") {
      stat.size = 1024 ** 4;
    }
    return stat;
  });
  expect(stateUpgradeRefusal(inventory, root)).toMatch(/SQLite.*budget.*large-store-updates/is);
  expect(fs.readFileSync(agent)).toEqual(before);
  expect(fs.readdirSync(root).some((name) => name.startsWith(".upgrade-"))).toBe(false);
});
