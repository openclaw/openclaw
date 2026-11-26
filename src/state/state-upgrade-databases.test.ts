import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import * as sqliteSource from "../infra/sqlite-snapshot-source.js";
import { withArtifactPreservingStateReads } from "./artifact-preserving-state-reads.js";
import {
  AGENT_MEMBER_ACCESS_SCHEMA_VERSION,
  OPENCLAW_AGENT_SCHEMA_VERSION,
  OPENCLAW_STATE_SCHEMA_VERSION,
} from "./openclaw-schema-versions.js";
import { OPENCLAW_STATE_SCHEMA_SQL } from "./openclaw-state-schema.js";
import { discoverDatabases, preflightStateUpgrade } from "./state-upgrade-databases.js";

const dirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => vi.restoreAllMocks());

it.each(["external", "logs", "tmp", "npm", "node_modules", "git-install", "deep", "symlink"])(
  "refuses an uncovered %s store only when its reader floor rises",
  async (layout) => {
    const root = dirs.make("state-boundary-");
    const outside = dirs.make("state-boundary-external-");
    const agentId = ["external", "deep", "symlink"].includes(layout) ? "main" : layout;
    const file =
      layout === "external"
        ? path.join(outside, "openclaw-agent.sqlite")
        : path.join(
            root,
            "agents",
            agentId,
            "agent",
            ...(layout === "deep" ? ["a", "b"] : []),
            "openclaw-agent.sqlite",
          );
    fs.mkdirSync(path.dirname(file), { recursive: true });
    if (layout === "symlink") {
      fs.rmdirSync(path.dirname(file));
      fs.symlinkSync(outside, path.dirname(file), "junction");
    }
    {
      using db = new DatabaseSync(file);
      db.exec(`PRAGMA user_version = ${OPENCLAW_AGENT_SCHEMA_VERSION}`);
    }
    const shared = path.join(root, "state", "openclaw.sqlite");
    fs.mkdirSync(path.dirname(shared), { recursive: true });
    const env = { OPENCLAW_STATE_DIR: root };
    {
      using db = new DatabaseSync(shared);
      db.exec(OPENCLAW_STATE_SCHEMA_SQL);
      db.exec(`PRAGMA user_version = ${OPENCLAW_STATE_SCHEMA_VERSION}`);
      db.prepare("INSERT INTO agent_databases VALUES (?, ?, ?, 1, 0)").run(
        agentId,
        file,
        OPENCLAW_AGENT_SCHEMA_VERSION,
      );
    }
    await preflightStateUpgrade(env, {});
    {
      using db = new DatabaseSync(shared);
      db.exec(`PRAGMA user_version = ${OPENCLAW_STATE_SCHEMA_VERSION - 1}`);
    }
    // Upgrading shared state does not copy or restrict an unchanged agent store.
    await preflightStateUpgrade(env, {});
    {
      using db = new DatabaseSync(file);
      db.exec(`PRAGMA user_version = ${OPENCLAW_AGENT_SCHEMA_VERSION - 1}`);
    }
    // The derived nullable-column steps since v43 retain the agent's existing floor.
    await preflightStateUpgrade(env, {});
    {
      using db = new DatabaseSync(file);
      db.exec(`PRAGMA user_version = ${AGENT_MEMBER_ACCESS_SCHEMA_VERSION - 1}`);
    }
    await preflightStateUpgrade(env, {});
    {
      using db = new DatabaseSync(file);
      db.exec(`PRAGMA user_version = ${AGENT_MEMBER_ACCESS_SCHEMA_VERSION - 2}`);
    }
    const before = fs.readFileSync(file);
    await expect(preflightStateUpgrade(env, {})).rejects.toThrow(/cannot restore.*Move.*retry/is);
    expect(fs.readFileSync(file)).toEqual(before);
    expect(fs.readdirSync(root).some((name) => name.startsWith(".upgrade-"))).toBe(false);
  },
);

it.each(["closed", "empty-wal", "live"])(
  "inventories a %s WAL database without changing source artifacts",
  async (mode) => {
    const root = dirs.make("state-boundary-wal-");
    const file = path.join(root, "agents", "main", "agent", "openclaw-agent.sqlite");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const writer = new DatabaseSync(file);
    try {
      writer.exec("PRAGMA journal_mode = WAL");
      writer.exec(`PRAGMA user_version = ${OPENCLAW_AGENT_SCHEMA_VERSION - 1}`);
      if (mode !== "live") {
        writer.close();
        if (mode === "empty-wal") {
          fs.writeFileSync(`${file}-wal`, "");
        }
      }
      const artifacts = () =>
        Object.fromEntries(
          fs.readdirSync(path.dirname(file)).map((name) => [
            name,
            createHash("sha256")
              .update(fs.readFileSync(path.join(path.dirname(file), name)))
              .digest("hex"),
          ]),
        );
      const before = artifacts();
      const { targets } = await withArtifactPreservingStateReads(() =>
        discoverDatabases(root, {}, { OPENCLAW_STATE_DIR: root }),
      );
      expect(targets).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            kind: "agent",
            path: file,
            version: OPENCLAW_AGENT_SCHEMA_VERSION - 1,
          }),
        ]),
      );
      expect(artifacts()).toEqual(before);
    } finally {
      if (mode === "live") {
        writer.close();
      }
    }
  },
);

it("inspects current stores on ordinary boot without allocating a private whole-file image", async () => {
  const root = dirs.make("state-boundary-current-");
  const file = path.join(root, "agents", "main", "agent", "openclaw-agent.sqlite");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  {
    using db = new DatabaseSync(file);
    db.exec(`PRAGMA user_version = ${OPENCLAW_AGENT_SCHEMA_VERSION}`);
  }
  const prepare = vi.spyOn(sqliteSource, "prepareSqliteReadOnlyLocation");
  const { targets } = await discoverDatabases(root, {}, { OPENCLAW_STATE_DIR: root });
  expect(targets).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ path: file, version: OPENCLAW_AGENT_SCHEMA_VERSION }),
    ]),
  );
  expect(prepare).not.toHaveBeenCalled();
});

it("does not refuse an unrelated upgrade for a missing unconfigured retained registration", async () => {
  const root = dirs.make("state-boundary-missing-");
  const outside = dirs.make("state-boundary-missing-external-");
  const shared = path.join(root, "state", "openclaw.sqlite");
  fs.mkdirSync(path.dirname(shared), { recursive: true });
  {
    using db = new DatabaseSync(shared);
    db.exec(OPENCLAW_STATE_SCHEMA_SQL);
    db.exec(`PRAGMA user_version = ${OPENCLAW_STATE_SCHEMA_VERSION - 1}`);
    db.prepare("INSERT INTO agent_databases VALUES ('archive', ?, ?, 1, 0)").run(
      path.join(outside, "missing.sqlite"),
      OPENCLAW_AGENT_SCHEMA_VERSION,
    );
  }
  await preflightStateUpgrade({ OPENCLAW_STATE_DIR: root }, {});
});

it("refuses a missing database with unresolved journal data instead of bootstrapping over it", async () => {
  const root = dirs.make("state-boundary-orphan-");
  const file = path.join(root, "agents", "main", "agent", "openclaw-agent.sqlite");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(`${file}-journal`, "retained journal bytes");
  await expect(preflightStateUpgrade({ OPENCLAW_STATE_DIR: root }, {})).rejects.toThrow(
    /incomplete.*Preserve.*restore/is,
  );
  expect(fs.readFileSync(`${file}-journal`, "utf8")).toBe("retained journal bytes");
});

it.each(["missing", "zero-byte", "uninitialized", "current-state"] as const)(
  "omits %s fresh catalogs from a schema-only upgrade inventory",
  async (layout) => {
    const root = dirs.make("state-boundary-fresh-");
    const shared = path.join(root, "state", "openclaw.sqlite");
    const agent = path.join(root, "agents", "main", "agent", "openclaw-agent.sqlite");
    fs.mkdirSync(path.dirname(agent), { recursive: true });
    {
      using database = new DatabaseSync(agent);
      database.exec(`PRAGMA user_version = ${OPENCLAW_AGENT_SCHEMA_VERSION - 1}`);
    }
    if (layout !== "missing") {
      fs.mkdirSync(path.dirname(shared), { recursive: true });
      if (layout === "zero-byte") {
        fs.writeFileSync(shared, "");
      } else {
        using database = new DatabaseSync(shared);
        database.exec(
          layout === "current-state"
            ? `${OPENCLAW_STATE_SCHEMA_SQL}; PRAGMA user_version = ${OPENCLAW_STATE_SCHEMA_VERSION}`
            : "CREATE TABLE unrelated (value TEXT)",
        );
      }
    }
    const { targets } = await discoverDatabases(
      root,
      { agents: { entries: { main: {}, pending: {} } } },
      { OPENCLAW_STATE_DIR: root },
    );
    expect(targets).toEqual([
      ...(layout === "current-state"
        ? [expect.objectContaining({ path: shared, version: OPENCLAW_STATE_SCHEMA_VERSION })]
        : []),
      expect.objectContaining({
        path: agent,
        version: OPENCLAW_AGENT_SCHEMA_VERSION - 1,
      }),
    ]);
    expect(
      fs.existsSync(path.join(root, "agents", "pending", "agent", "openclaw-agent.sqlite")),
    ).toBe(false);
  },
);

it.each([
  "auth-json",
  "auth-rows-19",
  "auth-rows-24",
  "auth-rows-27",
  "session-index",
  "indexless-transcript",
  "filesystem",
])("retains prospective fresh catalogs when a %s source exists", async (source) => {
  const root = dirs.make("state-boundary-legacy-source-");
  const agentDir = path.join(root, "agents", "main", "agent");
  const sessionsDir = path.join(root, "agents", "main", "sessions");
  fs.mkdirSync(agentDir, { recursive: true });
  if (source.startsWith("auth-rows-")) {
    using database = new DatabaseSync(path.join(agentDir, "openclaw-agent.sqlite"));
    database.exec(`
      PRAGMA user_version = ${Number(source.slice("auth-rows-".length))};
      CREATE TABLE auth_profile_store (
        store_key TEXT PRIMARY KEY,
        store_json TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
      INSERT INTO auth_profile_store VALUES (
        'primary',
        '{"version":1,"profiles":{"synthetic":{"type":"api_key","provider":"openai","key":"synthetic"}}}',
        1
      );
    `);
  } else if (source === "auth-json") {
    fs.writeFileSync(path.join(agentDir, "auth-profiles.json"), '{"version":1,"profiles":{}}');
  } else if (source === "filesystem") {
    fs.writeFileSync(path.join(root, "node.json"), '{"version":1,"nodeId":"synthetic"}');
  } else {
    fs.mkdirSync(sessionsDir, { recursive: true });
    fs.writeFileSync(
      path.join(sessionsDir, source === "session-index" ? "sessions.json" : "orphan.jsonl"),
      source === "session-index" ? "{}" : '{"type":"session","id":"synthetic"}\n',
    );
  }
  const { targets } = await discoverDatabases(
    root,
    { agents: { entries: { main: {}, pending: {} } } },
    { OPENCLAW_STATE_DIR: root },
  );
  expect(targets).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        kind: "state",
        path: path.join(root, "state", "openclaw.sqlite"),
        version: 0,
      }),
      expect.objectContaining({
        kind: "agent",
        path: path.join(root, "agents", "pending", "agent", "openclaw-agent.sqlite"),
        version: 0,
      }),
    ]),
  );
  expect(fs.existsSync(path.join(root, "state", "openclaw.sqlite"))).toBe(false);
});

it.each(["legacy-main", "state-db"])(
  "uses %s auth ownership rather than agent-file presence for fresh catalogs",
  async (location) => {
    const root = dirs.make("state-boundary-auth-owner-");
    const shared = path.join(root, "state", "openclaw.sqlite");
    const agent = path.join(root, "agents", "main", "agent", "openclaw-agent.sqlite");
    fs.mkdirSync(path.dirname(shared), { recursive: true });
    fs.mkdirSync(path.dirname(agent), { recursive: true });
    {
      using database = new DatabaseSync(shared);
      database.exec(OPENCLAW_STATE_SCHEMA_SQL);
      database.exec(`PRAGMA user_version = ${OPENCLAW_STATE_SCHEMA_VERSION}`);
      database
        .prepare("INSERT INTO config_machine_state VALUES ('auth.sharedStore', ?, 1)")
        .run(JSON.stringify({ location }));
    }
    {
      using database = new DatabaseSync(agent);
      database.exec(`
        PRAGMA user_version = 27;
        CREATE TABLE auth_profile_state (
          state_key TEXT PRIMARY KEY,
          state_json TEXT NOT NULL,
          updated_at INTEGER NOT NULL
        );
        INSERT INTO auth_profile_state VALUES ('primary', '{"version":1}', 1);
      `);
    }
    const { targets } = await discoverDatabases(
      root,
      { agents: { entries: { main: {}, pending: {} } } },
      { OPENCLAW_STATE_DIR: root },
    );
    expect(targets.some((target) => target.version === 0)).toBe(location === "legacy-main");
  },
);
