import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { replaceSessionEntry } from "../config/sessions/session-accessor.js";
import { resolveSqliteTargetFromSessionStorePath } from "../config/sessions/session-sqlite-target.js";
import type { SessionEntry } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { deleteSessionGroup } from "../gateway/session-groups.js";
import { runSqliteImmediateTransactionSync } from "../infra/sqlite-transaction.js";
import { createUpdateRun } from "../infra/update-run-ledger.js";
import { closeOpenClawAgentDatabasesForTest } from "../state/openclaw-agent-db.js";
import { resolveOpenClawAgentSqlitePath } from "../state/openclaw-agent-db.paths.js";
import { ensureSessionGroupsSchema } from "../state/openclaw-agent-session-groups-schema.js";
import {
  CONTENT_VERSION_KEY,
  readStateSchemaContentVersion,
} from "../state/openclaw-state-db-schema-version.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
  repairOpenClawStateDatabaseSchema,
} from "../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { UpdateSchemaRefusalError } from "../state/openclaw-update-schema-refusal.js";
import { beginDoctorMaintenance } from "./doctor-maintenance.js";
import { migrateDoctorSessionGroups } from "./doctor-session-groups.js";
import { runDoctorSessionSqlite } from "./doctor-session-sqlite.js";
import { guardUpdateDoctorSchemaUpgrade } from "./doctor-update-schema-guard.js";

describe("Doctor session-group cutover", () => {
  let root: string;
  let env: NodeJS.ProcessEnv;
  let cfg: OpenClawConfig;
  const runtime = { log: vi.fn(), error: vi.fn(), exit: vi.fn() };
  const seeds: Array<{ agentId: string; key: string; entry: SessionEntry }> = [
    {
      agentId: "main",
      key: "agent:main:dashboard:shared",
      entry: { sessionId: "shared-id", category: "Shared", pinnedAt: 123, updatedAt: 456 },
    },
    {
      agentId: "research",
      key: "agent:research:dashboard:shared",
      entry: { sessionId: "shared-id", category: "Shared", pinnedAt: 789, updatedAt: 999 },
    },
    {
      agentId: "research",
      key: "agent:research:dashboard:orphan",
      entry: { sessionId: "research-orphan", category: "Orphan", updatedAt: 555 },
    },
    {
      agentId: "main",
      key: "agent:main:dashboard:zulu",
      entry: { sessionId: "main-zulu", category: "Zulu", updatedAt: 234 },
    },
    {
      agentId: "main",
      key: "agent:main:dashboard:unicode",
      entry: { sessionId: "main-unicode", category: "Éclair", updatedAt: 345 },
    },
  ];
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "openclaw-group-cutover-"));
    vi.stubEnv("OPENCLAW_STATE_DIR", root);
    vi.stubEnv("OPENCLAW_CONFIG_PATH", path.join(root, "openclaw.json"));
    vi.stubEnv("OPENCLAW_SERVICE_REPAIR_POLICY", "external");
    vi.stubEnv("OPENCLAW_UPDATE_IN_PROGRESS", undefined);
    env = { ...process.env };
    cfg = {
      agents: {
        ownership: "explicit",
        defaults: { systemAgent: { agentId: "main" } },
        entries: { main: {}, research: {} },
      },
    };
    fs.writeFileSync(env.OPENCLAW_CONFIG_PATH!, JSON.stringify(cfg));
  });
  afterEach(() => {
    closeHandles();
    vi.unstubAllEnvs();
    fs.rmSync(root, { recursive: true, force: true });
  });
  function closeHandles() {
    closeOpenClawAgentDatabasesForTest();
    closeOpenClawStateDatabaseForTest();
  }
  function database<T>(pathname: string, run: (db: DatabaseSync) => T): T {
    const db = new DatabaseSync(pathname);
    try {
      return run(db);
    } finally {
      db.close();
    }
  }
  function shared<T>(run: (db: DatabaseSync) => T): T {
    return database(resolveOpenClawStateSqlitePath(env), run);
  }
  function agent<T>(agentId: string, run: (db: DatabaseSync) => T): T {
    return database(resolveOpenClawAgentSqlitePath({ agentId, env }), run);
  }
  function groups(agentId: string) {
    return agent(agentId, (db) =>
      db
        .prepare(
          "SELECT name, position, created_at, cwd, worktree FROM session_groups ORDER BY position, name",
        )
        .all(),
    );
  }
  function order(agentId: string) {
    return agent(agentId, (db) =>
      JSON.parse(
        String(
          db.prepare("SELECT section_order_json FROM session_group_state WHERE singleton = 1").get()
            ?.section_order_json,
        ),
      ),
    );
  }
  function globalSnapshot() {
    return shared((db) => ({
      version: readStateSchemaContentVersion(db),
      groups: db.prepare("SELECT * FROM session_groups ORDER BY position, name").all(),
      order: db
        .prepare(
          "SELECT value_json FROM config_machine_state WHERE state_key = 'sidebar.sectionOrder'",
        )
        .get(),
    }));
  }
  async function prepare(
    layout: "canonical" | "shared-sqlite" | "pre-defaults" = "canonical",
    categorized = true,
  ) {
    const sharedStore = path.join(root, "session-data", "sessions.sqlite");
    if (layout === "shared-sqlite") {
      cfg.session = { store: sharedStore };
    }
    fs.writeFileSync(env.OPENCLAW_CONFIG_PATH!, JSON.stringify(cfg));
    const paths = new Set<string>();
    for (const seed of seeds) {
      const storePath =
        layout === "shared-sqlite"
          ? sharedStore
          : path.join(root, "agents", seed.agentId, "sessions", "sessions.json");
      await replaceSessionEntry(
        { agentId: seed.agentId, storePath, sessionKey: seed.key },
        categorized ? seed.entry : { ...seed.entry, category: undefined },
      );
      paths.add(
        resolveSqliteTargetFromSessionStorePath(storePath, { agentId: seed.agentId, env }).path,
      );
    }
    closeHandles();
    shared((db) => {
      // This is a named historical fixture, never a runtime downgrade operation.
      db.exec(`CREATE TABLE session_groups (
        name TEXT NOT NULL PRIMARY KEY, position INTEGER NOT NULL, created_at INTEGER NOT NULL,
        cwd TEXT, worktree INTEGER
      ) STRICT;
      INSERT INTO session_groups VALUES
        ('Shared', 0, 100, '/synthetic/shared', 1),
        ('Empty', 1, 101, '/synthetic/prepared', 0),
        ('Zulu', 2, 102, NULL, NULL),
        ('Éclair', 2, 103, NULL, NULL);
      PRAGMA user_version = 16;
      UPDATE schema_meta SET schema_version = 16 WHERE meta_key = 'primary';`);
      if (layout === "pre-defaults") {
        db.exec(
          "ALTER TABLE session_groups DROP COLUMN cwd; ALTER TABLE session_groups DROP COLUMN worktree;",
        );
      }
      db.prepare(
        "INSERT INTO config_machine_state(state_key,value_json,updated_at_ms) VALUES(?,?,1) ON CONFLICT(state_key) DO UPDATE SET value_json=excluded.value_json",
      ).run(CONTENT_VERSION_KEY, "16");
      db.prepare(
        "INSERT INTO config_machine_state(state_key,value_json,updated_at_ms) VALUES(?,?,1) ON CONFLICT(state_key) DO UPDATE SET value_json=excluded.value_json",
      ).run(
        "sidebar.sectionOrder",
        JSON.stringify([
          "category:Empty",
          "category:Shared",
          "work",
          "category:Zulu",
          "category:Éclair",
        ]),
      );
    });
    return [...paths];
  }
  function sessionBytes(paths: string[]) {
    return paths.map((pathname) =>
      database(pathname, (db) =>
        db.prepare("SELECT session_key, entry_json FROM session_nodes ORDER BY session_key").all(),
      ),
    );
  }
  async function migrate() {
    const maintenance = await beginDoctorMaintenance({
      options: { repair: true, nonInteractive: true },
      root: null,
      runtime,
    });
    try {
      await migrateDoctorSessionGroups(cfg, env);
    } finally {
      await maintenance?.release();
    }
  }

  it.each(["new", "overwrite", "already-imported", "legacy-fixed-store"] as const)(
    "plans %s JSON membership using the normal import winner",
    async (mode) => {
      await prepare("canonical", false);
      shared((db) =>
        db
          .prepare("INSERT INTO session_groups VALUES ('Legacy', 4, 123, '/synthetic/legacy', 1)")
          .run(),
      );
      const storePath =
        mode === "legacy-fixed-store"
          ? path.join(root, "sessions", "sessions.json")
          : path.join(root, "agents", "research", "sessions", "sessions.json");
      if (mode === "legacy-fixed-store") {
        cfg.session = { store: storePath };
        cfg.agents!.defaults!.sessionStore = { agentId: "research" };
        fs.mkdirSync(path.dirname(storePath), { recursive: true });
      }
      const sessionKey =
        mode === "legacy-fixed-store"
          ? "global"
          : mode === "new"
            ? "agent:research:dashboard:json-only"
            : "agent:research:dashboard:shared";
      const source = JSON.stringify({
        [sessionKey]: {
          sessionId: mode === "new" ? "json-only" : "shared-id",
          updatedAt: 100,
          category: "Legacy",
          ...(mode === "already-imported"
            ? { sessionFile: path.join(path.dirname(storePath), "missing.jsonl") }
            : {}),
        },
      });
      fs.mkdirSync(path.dirname(storePath), { recursive: true });
      fs.writeFileSync(storePath, source);
      await migrate();
      const owner = mode === "already-imported" ? "main" : "research";
      expect(groups(owner)).toContainEqual({
        name: "Legacy",
        position: 4,
        created_at: 123,
        cwd: "/synthetic/legacy",
        worktree: 1,
      });
      expect(
        groups(owner === "main" ? "research" : "main").some((group) => group.name === "Legacy"),
      ).toBe(false);
      expect(fs.readFileSync(storePath, "utf8")).toBe(source);
      const imported = await runDoctorSessionSqlite({ cfg, env, mode: "import", allAgents: true });
      expect(imported.totals.importedEntries).toBe(mode === "already-imported" ? 0 : 1);
      const importedTarget = imported.targets.find(
        (target) =>
          target.storePath === storePath &&
          target.agentId === "research" &&
          (mode === "already-imported" ? target.validatedEntries > 0 : target.importedEntries > 0),
      );
      expect(importedTarget).toBeDefined();
      const category = database(
        importedTarget!.sqlitePath,
        (db) =>
          JSON.parse(
            String(
              db
                .prepare("SELECT entry_json FROM session_nodes WHERE session_key = ?")
                .get(sessionKey)?.entry_json,
            ),
          ).category,
      );
      expect(category).toBe(mode === "already-imported" ? undefined : "Legacy");
    },
  );

  it.each(["invalid", "directory"] as const)(
    "refuses a %s legacy JSON source before retiring group state",
    async (kind) => {
      await prepare("canonical", false);
      const storePath = path.join(root, "agents", "research", "sessions", "sessions.json");
      fs.mkdirSync(path.dirname(storePath), { recursive: true });
      if (kind === "directory") {
        fs.mkdirSync(storePath);
      } else {
        fs.writeFileSync(storePath, "{broken");
      }
      const before = globalSnapshot();
      await expect(migrate()).rejects.toThrow();
      expect(globalSnapshot()).toEqual(before);
    },
  );

  it.each(["canonical", "shared-sqlite", "pre-defaults"] as const)(
    "splits shared membership with defaults and order while preserving %s sessions",
    async (layout) => {
      const paths = await prepare(layout);
      const before = sessionBytes(paths);
      await migrate();
      expect(groups("main")).toEqual([
        {
          name: "Shared",
          position: 0,
          created_at: 100,
          cwd: layout === "pre-defaults" ? null : "/synthetic/shared",
          worktree: layout === "pre-defaults" ? null : 1,
        },
        {
          name: "Empty",
          position: 1,
          created_at: 101,
          cwd: layout === "pre-defaults" ? null : "/synthetic/prepared",
          worktree: layout === "pre-defaults" ? null : 0,
        },
        { name: "Zulu", position: 2, created_at: 102, cwd: null, worktree: null },
        { name: "Éclair", position: 2, created_at: 103, cwd: null, worktree: null },
      ]);
      expect(groups("research")).toEqual([
        {
          name: "Shared",
          position: 0,
          created_at: 100,
          cwd: layout === "pre-defaults" ? null : "/synthetic/shared",
          worktree: layout === "pre-defaults" ? null : 1,
        },
        { name: "Orphan", position: 3, created_at: 0, cwd: null, worktree: null },
      ]);
      expect(order("main")).toEqual([
        "category:Empty",
        "category:Shared",
        "work",
        "category:Zulu",
        "category:Éclair",
      ]);
      expect(order("research")).toEqual(["category:Shared", "work"]);
      expect(sessionBytes(paths)).toEqual(before);
      shared((db) => {
        expect(readStateSchemaContentVersion(db)).toBe(17);
        expect(
          db.prepare("SELECT name FROM sqlite_schema WHERE name='session_groups'").get(),
        ).toBeUndefined();
        expect(
          db
            .prepare(
              "SELECT value_json FROM config_machine_state WHERE state_key='sidebar.sectionOrder'",
            )
            .get(),
        ).toBeUndefined();
      });
      // Exercise the real new owner after activation; a second Doctor must never reimport it.
      await deleteSessionGroup({ agentId: "main", cfg, name: "Empty", env });
      closeHandles();
      await migrate();
      expect(groups("main").map((row) => row.name)).not.toContain("Empty");
      expect(groups("research").map((row) => row.name)).toEqual(["Shared", "Orphan"]);
      expect(sessionBytes(paths)).toEqual(before);
    },
  );

  it.each(["unknown column", "external-content virtual table"] as const)(
    "refuses %s without changing the original shared database bytes",
    async (dependency) => {
      await prepare();
      shared((db) => {
        if (dependency === "unknown column") {
          db.exec("ALTER TABLE session_groups ADD COLUMN operator_note TEXT");
          db.prepare("UPDATE session_groups SET operator_note = ? WHERE name = ?").run(
            "preserve-me",
            "Shared",
          );
        } else {
          db.exec(`CREATE VIRTUAL TABLE group_search USING fts5(
            name, content='session_groups', content_rowid='rowid'
          )`);
        }
      });
      const before = globalSnapshot();
      const pathname = resolveOpenClawStateSqlitePath(env);
      const sourceBytes = fs.readFileSync(pathname);
      await expect(migrate()).rejects.toThrow(
        dependency === "unknown column"
          ? /column definitions differ for session_groups/
          : /SQLite virtual table group_search is unusable after session_groups retirement/,
      );
      expect(fs.readFileSync(pathname)).toEqual(sourceBytes);
      expect(globalSnapshot()).toEqual(before);
      if (dependency === "unknown column") {
        expect(groups("main")).toEqual([]);
        expect(groups("research")).toEqual([]);
      } else {
        shared((db) => {
          expect(db.prepare("SELECT name FROM group_search ORDER BY name").all()).toEqual(
            [...before.groups]
              .toSorted((a, b) => (String(a.name) < String(b.name) ? -1 : 1))
              .map(({ name }) => ({ name })),
          );
        });
      }
    },
  );

  it.each(["destination", "retirement", "cross-object trigger"] as const)(
    "retains the source when %s fails and reconciles interrupted imports on retry",
    async (failure) => {
      await prepare();
      if (failure === "destination") {
        agent("research", (db) => {
          runSqliteImmediateTransactionSync(db, () => ensureSessionGroupsSchema(db));
          db.exec(
            "CREATE TRIGGER block_group_import BEFORE INSERT ON session_groups BEGIN SELECT RAISE(ABORT, 'fixture import blocked'); END;",
          );
        });
      } else if (failure === "retirement") {
        shared((db) =>
          db.exec(
            "CREATE TRIGGER retained_dependency AFTER UPDATE ON session_groups BEGIN SELECT 1; END;",
          ),
        );
      } else {
        shared((db) =>
          db.exec(`
          CREATE TABLE extension_group_usage (id INTEGER PRIMARY KEY);
          CREATE TRIGGER retained_dependency AFTER INSERT ON extension_group_usage
          BEGIN SELECT count(*) FROM session_groups; END;
        `),
        );
      }
      const before = globalSnapshot();
      await expect(migrate()).rejects.toThrow();
      expect(globalSnapshot()).toEqual(before);
      if (failure === "cross-object trigger") {
        shared((db) => {
          expect(() => db.exec("INSERT INTO extension_group_usage VALUES (1)")).not.toThrow();
          expect(db.prepare("SELECT id FROM extension_group_usage").all()).toEqual([{ id: 1 }]);
        });
      }
      // Source shape refusals precede writes; later failures retain a retryable import.
      if (failure === "retirement") {
        expect(groups("main")).toEqual([]);
      } else {
        expect(groups("main").map((row) => row.name)).toContain("Empty");
      }
      if (failure === "destination") {
        agent("research", (db) => db.exec("DROP TRIGGER block_group_import"));
      } else {
        shared((db) => db.exec("DROP TRIGGER retained_dependency"));
      }
      // Simulate a valid old-runtime edit while no Doctor is running.
      shared((db) => db.prepare("DELETE FROM session_groups WHERE name = ?").run("Empty"));
      await migrate();
      expect(groups("main").map((row) => row.name)).not.toContain("Empty");
      expect(groups("research").map((row) => row.name)).toEqual(["Shared", "Orphan"]);
      shared((db) => expect(readStateSchemaContentVersion(db)).toBe(17));
    },
  );

  it("preserves non-category section order for agents without any custom groups", async () => {
    await prepare("canonical", false);
    delete cfg.agents!.defaults;
    fs.writeFileSync(env.OPENCLAW_CONFIG_PATH!, JSON.stringify(cfg));
    const expected = ["catalog:coding", "work", "ungrouped"];
    shared((db) => {
      db.exec("DELETE FROM session_groups");
      db.prepare(
        "UPDATE config_machine_state SET value_json=? WHERE state_key='sidebar.sectionOrder'",
      ).run(JSON.stringify(expected));
    });
    await migrate();
    for (const agentId of ["main", "research"]) {
      expect(groups(agentId)).toEqual([]);
      expect(order(agentId)).toEqual(expected);
    }
  });

  it("imports the legacy section table when machine state exists without its order row", async () => {
    await prepare();
    shared((db) => {
      db.exec(
        "DELETE FROM config_machine_state WHERE state_key='sidebar.sectionOrder'; CREATE TABLE sidebar_sections(section_id TEXT PRIMARY KEY, position INTEGER NOT NULL) STRICT;",
      );
      const insert = db.prepare("INSERT INTO sidebar_sections VALUES(?,?)");
      insert.run("work", 0);
      insert.run("category:Shared", 1);
      insert.run("ungrouped", 2);
    });
    await migrate();
    expect(order("main")).toEqual(["work", "category:Shared", "ungrouped"]);
    expect(order("research")).toEqual(["work", "category:Shared", "ungrouped"]);
  });

  it("does not require an ambient owner when every legacy group has members", async () => {
    await prepare();
    delete cfg.agents!.defaults;
    fs.writeFileSync(env.OPENCLAW_CONFIG_PATH!, JSON.stringify(cfg));
    shared((db) => db.prepare("DELETE FROM session_groups WHERE name=?").run("Empty"));
    await migrate();
    expect(groups("main").map((row) => row.name)).toEqual(["Shared", "Zulu", "Éclair"]);
    expect(groups("research").map((row) => row.name)).toEqual(["Shared", "Orphan"]);
  });

  it("requires Doctor for v16 and never interprets a missing required catalog as an empty one", async () => {
    await prepare();
    const before = globalSnapshot();
    expect(() => openOpenClawStateDatabase({ env })).toThrow(/doctor --fix/);
    expect(repairOpenClawStateDatabaseSchema({ env }).warnings.join("\n")).toMatch(/doctor --fix/);
    expect(globalSnapshot()).toEqual(before);
    shared((db) => db.exec("DROP TABLE session_groups"));
    await expect(migrate()).rejects.toThrow(/session_groups.*missing|missing.*session_groups/);
    shared((db) => expect(readStateSchemaContentVersion(db)).toBe(16));
  });

  it("does not treat a versioned source without either session table as an empty agent", async () => {
    await prepare();
    const before = globalSnapshot();
    const sourcePath = resolveOpenClawAgentSqlitePath({ agentId: "research", env });
    const replacement = `${sourcePath}.fixture`;
    agent("research", (source) => {
      database(replacement, (broken) => {
        const sql = source
          .prepare("SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = 'schema_meta'")
          .get();
        broken.exec(String(sql?.sql));
        const meta = source.prepare("SELECT * FROM schema_meta").get()!;
        const columns = Object.keys(meta)
          .map((key) => `"${key.replaceAll('"', '""')}"`)
          .join(", ");
        broken
          .prepare(
            `INSERT INTO schema_meta (${columns}) VALUES (${Object.keys(meta)
              .map(() => "?")
              .join(", ")})`,
          )
          .run(...Object.values(meta));
        broken.exec("PRAGMA user_version = 19");
      });
    });
    fs.renameSync(replacement, sourcePath);
    await expect(migrate()).rejects.toThrow(/session table.*missing/);
    expect(globalSnapshot()).toEqual(before);
  });

  it("copies groups from the local source before v9 reanchors a copied registry", async () => {
    await prepare();
    const localPath = resolveOpenClawAgentSqlitePath({ agentId: "main", env });
    const oldPath = path.join(`${root}-old`, "agents", "main", "agent", "openclaw-agent.sqlite");
    shared((db) => {
      db.prepare("UPDATE agent_databases SET path = ? WHERE agent_id = 'main'").run(oldPath);
      db.exec(
        "PRAGMA user_version = 8; UPDATE schema_meta SET schema_version = 8 WHERE meta_key = 'primary'",
      );
      db.prepare("UPDATE config_machine_state SET value_json = '8' WHERE state_key = ?").run(
        CONTENT_VERSION_KEY,
      );
    });
    await migrate();
    expect(groups("main").map((row) => row.name)).toEqual(["Shared", "Empty", "Zulu", "Éclair"]);
    expect(groups("research").map((row) => row.name)).toEqual(["Shared", "Orphan"]);
    shared((db) => {
      expect(readStateSchemaContentVersion(db)).toBe(17);
      expect(db.prepare("SELECT path FROM agent_databases WHERE agent_id = 'main'").get()).toEqual({
        path: path.relative(root, localPath),
      });
    });
  });

  it("migrates deferred schema16 content after its older updater publication deadline clears", async () => {
    openOpenClawStateDatabase({ env });
    const run = createUpdateRun({ trigger: "cli", before: { version: "2026.9.2" } }, { env });
    const paths = await prepare();
    const before = sessionBytes(paths);
    const finishedAt = Date.now() - 6 * 60_000;
    shared((db) => {
      db.prepare(
        "UPDATE update_runs SET status='succeeded', phase='finished', finished_at_ms=?, updated_at_ms=? WHERE run_id=?",
      ).run(finishedAt, finishedAt, run.runId);
      db.exec(
        "PRAGMA user_version = 15; UPDATE schema_meta SET schema_version = 15 WHERE meta_key='primary'",
      );
      expect(readStateSchemaContentVersion(db)).toBe(16);
    });
    await migrate();
    shared((db) => {
      expect(db.prepare("PRAGMA user_version").get()).toEqual({ user_version: 17 });
      expect(
        db.prepare("SELECT schema_version FROM schema_meta WHERE meta_key='primary'").get(),
      ).toEqual({ schema_version: 17 });
    });
    expect(groups("main").map((row) => row.name)).toEqual(["Shared", "Empty", "Zulu", "Éclair"]);
    expect(groups("research").map((row) => row.name)).toEqual(["Shared", "Orphan"]);
    expect(sessionBytes(paths)).toEqual(before);
  });

  it("refuses the unfenced old updater despite available publication-deferral metadata", async () => {
    // Seed the real driver ledger while the current shared owner is still usable.
    openOpenClawStateDatabase({ env });
    createUpdateRun({ trigger: "cli", before: { version: "2026.9.2" } }, { env });
    await prepare();
    const before = globalSnapshot();
    vi.stubEnv("OPENCLAW_UPDATE_IN_PROGRESS", "1");
    await expect(guardUpdateDoctorSchemaUpgrade({ runtime })).rejects.toBeInstanceOf(
      UpdateSchemaRefusalError,
    );
    expect(globalSnapshot()).toEqual(before);
  });
});
