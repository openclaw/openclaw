import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { buildAgentDatabaseByCopy } from "./openclaw-agent-db-swap.js";
import { OPENCLAW_AGENT_SCHEMA_VERSION } from "./openclaw-schema-versions.js";
import { OPENCLAW_STATE_SCHEMA_VERSION } from "./openclaw-state-db-contract.js";
import { buildStateDatabaseByCopy } from "./openclaw-state-db-swap.js";
import { buildSqliteWithFoldIns, type SqliteSwapTarget } from "./sqlite-copy-swap.js";
import { applyPlan, copyTree, diffTree } from "./state-upgrade-tree.js";

const corpusDir = fileURLToPath(
  new URL("../../test/fixtures/state-corpus-populated/", import.meta.url),
);
const releases = fs
  .readdirSync(corpusDir)
  .filter((name) => fs.statSync(path.join(corpusDir, name)).isDirectory())
  .toSorted();

// Columns the fallback may leave behind because their data lives on elsewhere.
// A schema change that drops or renames another column holding user data fails
// below until it gets a map entry or a reason here.
const RETIRED_COLUMNS: Record<string, string> = {
  "current_conversation_bindings.target_agent_id": "derived from the session key (v15)",
  "current_conversation_bindings.target_session_id": "derived from the session key (v15)",
};

// Tables this build keeps outside the rebuilt database. Every other table a release
// wrote must exist in the rebuilt schema, or its rows would only survive as set-aside data.
const MOVED_TABLES: Record<string, string> = {
  device_identities: "client credential store (v29); the fallback keeps the chain-created store",
};

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function tempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-swap-"));
  dirs.push(dir);
  return dir;
}

function hash(file: string) {
  return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function droppedUserColumns(source: string, report: { droppedColumns: string[] }) {
  const db = new DatabaseSync(source, { readOnly: true });
  try {
    return report.droppedColumns.filter((entry) => {
      const [table, column] = entry.split(".");
      const row = db
        .prepare(`SELECT count(*) AS n FROM "${table}" WHERE "${column}" IS NOT NULL`)
        .get() as { n: number };
      return row.n > 0 && !RETIRED_COLUMNS[entry];
    });
  } finally {
    db.close();
  }
}

describe.each(releases)("generic rebuild of %s", (release) => {
  const stateDir = path.join(corpusDir, release, "state");
  const databases = [
    { file: path.join(stateDir, "state", "openclaw.sqlite"), agentId: undefined },
    ...fs
      .readdirSync(path.join(stateDir, "agents"))
      .map((agentId) => ({
        file: path.join(stateDir, "agents", agentId, "agent", "openclaw-agent.sqlite"),
        agentId: agentId as string | undefined,
      }))
      .filter(({ file }) => fs.existsSync(file)),
  ];

  it.each(databases.map((entry) => [path.relative(stateDir, entry.file), entry] as const))(
    "%s keeps every row and leaves the source unchanged",
    (_name, { file, agentId }) => {
      // The source is opened read-only; a writable copy keeps its WAL out of the fixture.
      const source = path.join(tempDir(), "source.sqlite");
      fs.copyFileSync(file, source);
      for (const suffix of ["-wal", "-shm"]) {
        if (fs.existsSync(`${file}${suffix}`)) {
          fs.copyFileSync(`${file}${suffix}`, `${source}${suffix}`);
        }
      }
      const before = hash(source);
      const out = path.join(tempDir(), "next.sqlite");
      const { report } = agentId
        ? buildAgentDatabaseByCopy(agentId, source, out, tempDir())
        : buildStateDatabaseByCopy(source, out, tempDir());
      expect(hash(source)).toBe(before);
      expect(report.conservationMismatches).toEqual([]);
      for (const table of report.tables) {
        expect(table.copied + table.setAside, table.table).toBe(table.source);
      }
      expect(droppedUserColumns(source, report)).toEqual([]);
      expect(
        report.setAside
          .filter((row) => row.reason === "table removed" && !MOVED_TABLES[row.table])
          .map((row) => row.table),
      ).toEqual([]);
      const built = new DatabaseSync(out, { readOnly: true });
      try {
        expect(built.prepare("PRAGMA user_version").get()).toEqual({
          user_version: agentId ? OPENCLAW_AGENT_SCHEMA_VERSION : OPENCLAW_STATE_SCHEMA_VERSION,
        });
      } finally {
        built.close();
      }
    },
  );
});

describe("generic rebuild data rules", () => {
  function build(sourceSql: string, targetSql: string, map: SqliteSwapTarget["map"] = {}) {
    const dir = tempDir();
    const source = path.join(dir, "source.sqlite");
    const db = new DatabaseSync(source);
    db.exec(sourceSql);
    db.close();
    const out = path.join(dir, "next.sqlite");
    const { report } = buildSqliteWithFoldIns(
      {
        label: "test",
        version: 2,
        createSchema: (target) => target.exec(targetSql),
        stamp: () => {},
        map,
      },
      [],
      source,
      out,
      dir,
    );
    const built = new DatabaseSync(out, { readOnly: true });
    try {
      return { report, rows: built.prepare("SELECT * FROM t ORDER BY id").all() };
    } finally {
      built.close();
    }
  }

  it("decodes BLOB text, replaces invalid bytes and casts to the declared type", () => {
    const { rows, report } = build(
      `CREATE TABLE t (id TEXT PRIMARY KEY, body TEXT, n TEXT);
       INSERT INTO t VALUES ('a', CAST('caf\u00e9' AS BLOB), '42'), ('b', x'ff61', '7');`,
      "CREATE TABLE t (id TEXT PRIMARY KEY, body TEXT NOT NULL, n INTEGER NOT NULL, added TEXT NOT NULL DEFAULT 'x') STRICT;",
    );
    expect(report.setAside).toEqual([]);
    expect(rows).toEqual([
      { id: "a", body: "caf\u00e9", n: 42, added: "x" },
      { id: "b", body: "\ufffda", n: 7, added: "x" },
    ]);
  });

  it("keeps the newest row on a key collision and sets the other aside", () => {
    const { rows, report } = build(
      `CREATE TABLE t (id TEXT, updated_at INTEGER);
       INSERT INTO t VALUES ('a', 1), ('a', 3), ('a', 2);`,
      "CREATE TABLE t (id TEXT PRIMARY KEY, updated_at INTEGER NOT NULL) STRICT;",
    );
    expect(rows).toEqual([{ id: "a", updated_at: 3 }]);
    expect(report.setAside.map((row) => row.row.updated_at)).toEqual(["1", "2"]);
    expect(report.tables).toEqual([expect.objectContaining({ source: 3, copied: 1, setAside: 2 })]);
  });

  it("restores the displaced row when the newer row also collides on another key", () => {
    const { rows, report } = build(
      `CREATE TABLE t (id TEXT, email TEXT, updated_at INTEGER);
       INSERT INTO t VALUES ('a', 'x', 1), ('b', 'y', 2), (CAST('a' AS BLOB), CAST('y' AS BLOB), 3);`,
      "CREATE TABLE t (id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, updated_at INTEGER NOT NULL) STRICT;",
    );
    expect(rows).toEqual([
      { id: "a", email: "x", updated_at: 1 },
      { id: "b", email: "y", updated_at: 2 },
    ]);
    expect(report.setAside.map((row) => row.row.updated_at)).toEqual(["3"]);
    expect(report.conservationMismatches).toEqual([]);
  });

  it("sets aside orphans of a WITHOUT ROWID child and publishes a clean foreign_key_check", () => {
    const dir = tempDir();
    const source = path.join(dir, "source.sqlite");
    const db = new DatabaseSync(source);
    db.exec(`CREATE TABLE p (id TEXT); CREATE TABLE c (k TEXT, f TEXT, v TEXT);
      INSERT INTO p VALUES ('kept'), (NULL);
      INSERT INTO c VALUES ('kept', 'a', '1'), ('gone', 'a', '2'), ('gone', 'b', '3');`);
    db.close();
    const out = path.join(dir, "next.sqlite");
    const { report } = buildSqliteWithFoldIns(
      {
        label: "test",
        version: 2,
        createSchema: (target) =>
          target.exec(`CREATE TABLE p (id TEXT PRIMARY KEY NOT NULL) STRICT;
            CREATE TABLE c (k TEXT NOT NULL, f TEXT NOT NULL, v TEXT NOT NULL, PRIMARY KEY (k, f),
              FOREIGN KEY (k) REFERENCES p(id) ON DELETE CASCADE) STRICT, WITHOUT ROWID;`),
        stamp: () => {},
        map: {},
      },
      [],
      source,
      out,
      dir,
    );
    const built = new DatabaseSync(out, { readOnly: true });
    try {
      expect(built.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
      expect(built.prepare("SELECT k, f FROM c").all()).toEqual([{ k: "kept", f: "a" }]);
    } finally {
      built.close();
    }
    expect(
      report.setAside
        .filter((row) => row.table === "c")
        .map((row) => `${String(row.row.k)}:${String(row.row.f)}`)
        .toSorted(),
    ).toEqual(["gone:a", "gone:b"]);
    expect(report.tables.find((entry) => entry.table === "c")).toEqual(
      expect.objectContaining({ source: 3, copied: 1, setAside: 2 }),
    );
    expect(report.conservationMismatches).toEqual([]);
  });

  it("derives session reference predicates for a pre-v26 agent database", () => {
    const dir = tempDir();
    const source = path.join(dir, "agent.sqlite");
    fs.copyFileSync(
      path.join(
        corpusDir,
        "2026.8.35",
        "state",
        "agents",
        "main",
        "agent",
        "openclaw-agent.sqlite",
      ),
      source,
    );
    const db = new DatabaseSync(source);
    db.prepare(
      "INSERT INTO session_nodes (session_key, current_session_id, entry_json, updated_at) VALUES (?, ?, ?, ?)",
    ).run(
      "agent:main:refs",
      "current",
      JSON.stringify({ sessionId: "current", previousSessionId: "previous", updatedAt: 1 }),
      1,
    );
    db.close();
    const out = path.join(dir, "next.sqlite");
    buildAgentDatabaseByCopy("main", source, out, dir);
    const built = new DatabaseSync(out, { readOnly: true });
    try {
      expect(
        built
          .prepare("SELECT has_optional_references FROM session_nodes WHERE session_key = ?")
          .get("agent:main:refs"),
      ).toEqual({ has_optional_references: 1 });
    } finally {
      built.close();
    }
  });

  it("sets constraint-violating rows and removed tables aside instead of failing", () => {
    const { rows, report } = build(
      `CREATE TABLE t (id TEXT, n TEXT); CREATE TABLE gone (v TEXT);
       INSERT INTO t VALUES ('a', 'x'), ('b', NULL), ('c', '1'); INSERT INTO gone VALUES ('keep me');`,
      "CREATE TABLE t (id TEXT PRIMARY KEY, n INTEGER NOT NULL CHECK (n > 0)) STRICT;",
    );
    expect(rows).toEqual([{ id: "c", n: 1 }]);
    expect(
      report.setAside.map((row) => `${row.table}:${String(row.row.id ?? row.row.v)}`).toSorted(),
    ).toEqual(["gone:keep me", "t:a", "t:b"]);
    expect(report.conservationMismatches).toEqual([]);
  });

  it("carries the released Claw rows into Templates through the map", () => {
    const dir = tempDir();
    const source = path.join(dir, "claw.sqlite");
    const db = new DatabaseSync(source);
    db.exec(`CREATE TABLE claw_mcp_server_refs (agent_id TEXT, name TEXT, schema_version TEXT,
      config_digest TEXT, relationship TEXT, origin TEXT, independent_owner INTEGER, status TEXT,
      error TEXT, created_at_ms INTEGER, updated_at_ms INTEGER);
      INSERT INTO claw_mcp_server_refs VALUES ('main', 'files', 'openclaw.clawMcpServerRef.v1', 'd', 'managed', 'claw-introduced', 0, 'installed', NULL, 1, 2);`);
    db.close();
    const out = path.join(dir, "next.sqlite");
    const { report } = buildStateDatabaseByCopy(source, out, dir);
    const built = new DatabaseSync(out, { readOnly: true });
    try {
      expect(
        built.prepare("SELECT name, origin, schema_version FROM template_mcp_server_refs").all(),
      ).toEqual([
        {
          name: "files",
          origin: "template-introduced",
          schema_version: "openclaw.templateMcpServerRef.v1",
        },
      ]);
    } finally {
      built.close();
    }
    expect(report.setAside).toEqual([]);
  });

  it("reports a dropped or renamed user-data column without a map entry", () => {
    const sql = `CREATE TABLE t (id TEXT PRIMARY KEY, title TEXT); INSERT INTO t VALUES ('a', 'kept');`;
    const renamed = "CREATE TABLE t (id TEXT PRIMARY KEY, name TEXT) STRICT;";
    const dir = tempDir();
    const unmapped = build(sql, renamed);
    const source = path.join(dir, "probe.sqlite");
    const db = new DatabaseSync(source);
    db.exec(sql);
    db.close();
    expect(droppedUserColumns(source, unmapped.report)).toEqual(["t.title"]);
    const mapped = build(sql, renamed, { columns: { "t.title": "name" } });
    expect(mapped.rows).toEqual([{ id: "a", name: "kept" }]);
    expect(droppedUserColumns(source, mapped.report)).toEqual([]);
  });
});

describe("copyTree and diffTree", () => {
  it("clones closed databases and moves only what the upgrade wrote", () => {
    const root = tempDir();
    const live = path.join(root, "live");
    fs.mkdirSync(path.join(live, "backups"), { recursive: true });
    const closed = path.join(live, "backups", "old.sqlite");
    const db = new DatabaseSync(closed);
    db.exec("CREATE TABLE t (v TEXT); INSERT INTO t VALUES ('kept');");
    db.close();
    for (const name of ["edited.json", "deleted.json", "untouched.json"]) {
      fs.writeFileSync(path.join(live, name), name);
    }
    // Plugin installs link node_modules/openclaw to the whole OpenClaw package.
    const pkg = path.join(root, "openclaw-package");
    fs.mkdirSync(pkg);
    fs.writeFileSync(path.join(pkg, "index.js"), "");
    fs.mkdirSync(path.join(live, "plugin", "node_modules"), { recursive: true });
    fs.symlinkSync(pkg, path.join(live, "plugin", "node_modules", "openclaw"));
    const shadow = path.join(root, "shadow");
    const baseline = new Map<string, string | undefined>();
    copyTree(live, shadow, () => false, baseline);
    // A closed database is cloned byte for byte; VACUUM INTO would rewrite it.
    expect(hash(path.join(shadow, "backups", "old.sqlite"))).toBe(hash(closed));
    expect(
      fs.lstatSync(path.join(shadow, "plugin", "node_modules", "openclaw")).isSymbolicLink(),
    ).toBe(true);

    fs.writeFileSync(path.join(shadow, "edited.json"), "upgraded");
    fs.rmSync(path.join(shadow, "deleted.json"));
    fs.writeFileSync(path.join(shadow, "added.json"), "new");
    // Written live after the copy: the swap must not revert or remove it.
    fs.writeFileSync(path.join(live, "untouched.json"), "live write during the upgrade");
    fs.writeFileSync(path.join(live, "late.log"), "late");

    const ops = diffTree(live, shadow, baseline).map(
      (op) => `${op.kind}:${path.relative(live, op.live)}`,
    );
    expect(ops.toSorted()).toEqual([
      "add:added.json",
      "remove:deleted.json",
      "replace:edited.json",
    ]);
  });
});

describe("applyPlan", () => {
  it("creates new live directories with the shadow's mode, not the umask", () => {
    const root = tempDir();
    const shadowFile = path.join(root, "shadow", "client", "credentials.sqlite");
    fs.mkdirSync(path.dirname(shadowFile), { recursive: true });
    // 0750 differs from what both the 022 and 077 umasks produce.
    fs.chmodSync(path.dirname(shadowFile), 0o750);
    fs.writeFileSync(shadowFile, "x");
    const live = path.join(root, "live", "client", "credentials.sqlite");
    fs.mkdirSync(path.join(root, "live"));
    applyPlan({ appVersion: "test", ops: [{ kind: "add", live, next: shadowFile }] });
    expect(fs.statSync(path.dirname(live)).mode & 0o777).toBe(0o750);
  });
});
