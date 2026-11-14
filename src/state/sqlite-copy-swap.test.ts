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
import { buildSqliteByCopy, type SqliteSwapTarget } from "./sqlite-copy-swap.js";

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
    const report = buildSqliteByCopy(
      {
        label: "test",
        version: 2,
        createSchema: (target) => target.exec(targetSql),
        stamp: () => {},
        map,
      },
      source,
      out,
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
