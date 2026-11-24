import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as fileTransfer from "../infra/file-descriptor.js";
import * as sqliteFilesystem from "../infra/sqlite-wal-filesystem.js";
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
  vi.restoreAllMocks();
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
  it.each([
    ["agents/main/agent/codex-home/skills/._skill", "EACCES"],
    ["openclaw.json.before-upgrade", "EPERM"],
    ["openclaw.json.bak-io-error", "EIO"],
  ])("handles unreadable optional file %s during inventory (%s)", async (name, code) => {
    const root = tempDir();
    const live = path.join(root, "live");
    const unreadable = path.join(live, name);
    fs.mkdirSync(path.dirname(unreadable), { recursive: true });
    fs.writeFileSync(unreadable, "operator data");
    fs.writeFileSync(path.join(live, "openclaw.json"), "{}");
    fs.symlinkSync("missing-target", path.join(live, "dangling"));
    const originalMode = fs.statSync(unreadable).mode;
    const error = Object.assign(new Error(code), { code });
    const access = fs.accessSync;
    vi.spyOn(fs, "accessSync").mockImplementation((file, mode) => {
      if (file === unreadable) {
        throw error;
      }
      return access(file, mode);
    });
    const copies = vi.spyOn(fs, "copyFileSync");
    const shadow = path.join(root, "shadow");
    const log = { info: vi.fn(), warn: vi.fn() };
    if (code === "EIO") {
      await expect(copyTree(live, shadow, () => false, new Map(), { log })).rejects.toBe(error);
      expect(fs.existsSync(shadow)).toBe(false);
      expect(copies).not.toHaveBeenCalled();
      return;
    }
    await copyTree(live, shadow, () => false, new Map(), { log });
    expect(fs.existsSync(path.join(shadow, name))).toBe(false);
    expect(copies.mock.calls.some(([source]) => source === unreadable)).toBe(false);
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining(unreadable));
    expect(fs.readFileSync(path.join(shadow, "openclaw.json"), "utf8")).toBe("{}");
    expect(fs.readlinkSync(path.join(shadow, "dangling"))).toBe("missing-target");
    expect(fs.readFileSync(unreadable, "utf8")).toBe("operator data");
    expect(fs.statSync(unreadable).mode).toBe(originalMode);
  });

  it.each([
    { suffix: "", required: true },
    { suffix: "-wal", required: true },
    { suffix: "-journal", required: true },
    { suffix: "-wal", required: false },
  ])(
    "protects an unreadable SQLite family file $suffix (required=$required)",
    async ({ suffix, required }) => {
      const live = tempDir();
      const database = path.join(live, "required.sqlite");
      {
        using db = new DatabaseSync(database);
        db.exec("CREATE TABLE payload (value TEXT); INSERT INTO payload VALUES ('kept')");
      }
      const unreadable = database + suffix;
      if (suffix) {
        fs.writeFileSync(unreadable, "retained journal data");
      }
      const before = hash(unreadable);
      const access = fs.accessSync;
      vi.spyOn(fs, "accessSync").mockImplementation((file, mode) => {
        if (file === unreadable) {
          throw Object.assign(new Error("EACCES"), { code: "EACCES" });
        }
        return access(file, mode);
      });
      const copy = vi.spyOn(fs, "copyFileSync");
      const transfer = vi.spyOn(fileTransfer, "copyFileHandle");
      const shadow = path.join(tempDir(), "shadow");
      if (required) {
        await expect(
          copyTree(live, shadow, () => false, new Map(), { targets: [{ path: database }] }),
        ).rejects.toThrow(
          `State upgrade refused: required database file ${unreadable} is unreadable. Nothing live was changed. Run openclaw doctor --fix`,
        );
        expect(fs.existsSync(shadow)).toBe(false);
      } else {
        await copyTree(live, shadow, () => false, new Map());
        expect(fs.readdirSync(shadow)).toEqual([]);
      }
      expect(copy).not.toHaveBeenCalled();
      expect(transfer).not.toHaveBeenCalled();
      expect(hash(unreadable)).toBe(before);
    },
  );

  it.each([
    ["lost+found", "EACCES"],
    ["private-directory", "EPERM"],
  ])("skips unreadable %s without omitting required databases (%s)", async (name, code) => {
    const root = tempDir();
    const live = path.join(root, "live");
    const unreadable = path.join(live, name);
    fs.mkdirSync(unreadable, { recursive: true });
    fs.writeFileSync(path.join(live, "config.json"), "{}");
    const database = path.join(unreadable, "openclaw-agent.sqlite");
    {
      using db = new DatabaseSync(database);
      db.exec("CREATE TABLE payload (value TEXT); INSERT INTO payload VALUES ('kept')");
    }
    const before = hash(database);
    const mode = fs.statSync(unreadable).mode;
    const readdir = fs.readdirSync;
    vi.spyOn(fs, "readdirSync").mockImplementation((directory, options) => {
      if (directory === unreadable) {
        throw Object.assign(new Error(`${code}: permission denied, scandir '${unreadable}'`), {
          code,
        });
      }
      // oxlint-disable-next-line openclaw-boundaries/no-recursive-readdir -- Preserve real directory reads outside the injected permission failure.
      return readdir(directory, options);
    });
    const shadow = path.join(root, "shadow");
    const log = { info: vi.fn(), warn: vi.fn() };
    await copyTree(live, shadow, () => false, new Map(), { log });
    expect(fs.readFileSync(path.join(shadow, "config.json"), "utf8")).toBe("{}");
    expect(fs.existsSync(path.join(shadow, name))).toBe(false);
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining(unreadable));
    expect(hash(database)).toBe(before);
    expect(fs.statSync(unreadable).mode).toBe(mode);

    const requiredShadow = path.join(root, "required-shadow");
    await expect(
      copyTree(live, requiredShadow, () => false, new Map(), {
        log,
        targets: [{ path: database }],
      }),
    ).rejects.toThrow(`database ${database} is outside the copy scope`);
    expect(fs.existsSync(requiredShadow)).toBe(false);
    expect(hash(database)).toBe(before);
  });

  it.each([
    ["", "EACCES"],
    ["nested", "EIO"],
  ])("preserves fatal directory errors at %s (%s)", async (name, code) => {
    const root = tempDir();
    const live = path.join(root, "live");
    const failed = path.join(live, name);
    fs.mkdirSync(failed, { recursive: true });
    const error = Object.assign(new Error(code), { code });
    const readdir = fs.readdirSync;
    vi.spyOn(fs, "readdirSync").mockImplementation((directory, options) => {
      if (directory === failed) {
        throw error;
      }
      // oxlint-disable-next-line openclaw-boundaries/no-recursive-readdir -- Preserve real directory reads outside the injected filesystem failure.
      return readdir(directory, options);
    });
    const shadow = path.join(root, "shadow");
    await expect(copyTree(live, shadow, () => false, new Map())).rejects.toBe(error);
    expect(fs.existsSync(shadow)).toBe(false);
  });

  it("byte-copies closed databases and never replaces uncopied workspace files", async () => {
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
    const workspace = path.join(live, "workspace");
    fs.mkdirSync(workspace);
    fs.writeFileSync(path.join(workspace, "AGENTS.md"), "custom instructions");
    await copyTree(live, shadow, (file) => file === workspace, baseline);
    fs.mkdirSync(path.join(shadow, "workspace"));
    fs.writeFileSync(path.join(shadow, "workspace", "AGENTS.md"), "Doctor template");
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

    const warn = vi.fn();
    const ops = diffTree(live, shadow, baseline, warn).map(
      (op) => `${op.kind}:${path.relative(live, op.live)}`,
    );
    expect(warn).toHaveBeenCalledWith("Left uncopied live file unchanged: workspace/AGENTS.md");
    expect(ops.toSorted()).toEqual([
      "add:added.json",
      "remove:deleted.json",
      "replace:edited.json",
    ]);
  });
});

describe("SQLite byte-copy boundary", () => {
  it("copies large targets through file handles after NOCOW directory preparation", async () => {
    const root = tempDir();
    const live = path.join(root, "live");
    const shadow = path.join(root, "shadow");
    fs.mkdirSync(live);
    const source = path.join(live, "target.sqlite");
    const db = new DatabaseSync(source);
    db.exec("CREATE TABLE payload (value TEXT); INSERT INTO payload VALUES ('original')");
    db.close();
    fs.truncateSync(source, 65 * 1024 * 1024);
    vi.spyOn(sqliteFilesystem, "isSqlitePathOnBtrfs").mockReturnValue(true);
    const policy = vi
      .spyOn(sqliteFilesystem, "setSqliteDirectoryNoCow")
      .mockImplementation((dir) => {
        expect(dir).toBe(shadow);
        expect(fs.existsSync(path.join(shadow, "target.sqlite"))).toBe(false);
      });
    const transfer = vi.spyOn(fileTransfer, "copyFileHandle");
    const clone = vi.spyOn(fs, "copyFileSync");
    await copyTree(live, shadow, () => false, new Map());
    expect(policy).toHaveBeenCalledOnce();
    expect(transfer).toHaveBeenCalledOnce();
    expect(clone).not.toHaveBeenCalled();
    const target = path.join(shadow, "target.sqlite");
    expect(hash(target)).toBe(hash(source));
    expect(fs.statSync(target).ino).not.toBe(fs.statSync(source).ino);
  });

  it("still copies when the btrfs NOCOW policy cannot be applied", async () => {
    const root = tempDir();
    const live = path.join(root, "live");
    const shadow = path.join(root, "shadow");
    fs.mkdirSync(live);
    const source = path.join(live, "target.sqlite");
    const db = new DatabaseSync(source);
    db.exec("CREATE TABLE payload (value TEXT); INSERT INTO payload VALUES ('original')");
    db.close();
    vi.spyOn(sqliteFilesystem, "isSqlitePathOnBtrfs").mockReturnValue(true);
    vi.spyOn(sqliteFilesystem, "setSqliteDirectoryNoCow").mockImplementation(() => {
      throw new Error("chattr: not found");
    });
    await copyTree(live, shadow, () => false, new Map());
    expect(hash(path.join(shadow, "target.sqlite"))).toBe(hash(source));
  });

  it("recovers committed WAL frames privately without changing the source family", async () => {
    const root = tempDir();
    const live = path.join(root, "live");
    fs.mkdirSync(live);
    const source = path.join(live, "wal.sqlite");
    const db = new DatabaseSync(source);
    try {
      db.exec(
        "PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE payload (value TEXT); INSERT INTO payload VALUES ('committed WAL')",
      );
      const before = [hash(source), hash(`${source}-wal`)];
      const shadow = path.join(root, "shadow");
      await copyTree(live, shadow, () => false, new Map());
      const copied = new DatabaseSync(path.join(shadow, "wal.sqlite"), { readOnly: true });
      try {
        expect(copied.prepare("SELECT value FROM payload").get()?.value).toBe("committed WAL");
      } finally {
        copied.close();
      }
      expect([hash(source), hash(`${source}-wal`)]).toEqual(before);
    } finally {
      db.close();
    }
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
