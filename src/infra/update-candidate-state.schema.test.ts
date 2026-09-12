import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { openNodeSqliteDatabase } from "./node-sqlite.js";
import { runtimeProcessEntrypoints } from "./runtime-process-entrypoints.js";
import { sqliteWorkerPreloadEnv } from "./sqlite-worker-preload.test-support.js";
import {
  readUpdateStateSchemaVersions,
  updateStateSchemaVersionsMatch,
} from "./update-candidate-state.js";

const dirs = useAutoCleanupTempDirTracker(afterEach);

it.each(["malformed", "nonregular-wal"])(
  "refuses an indeterminate agent family: %s",
  async (kind) => {
    const stateDir = fs.realpathSync(dirs.make("update-schema-invalid-"));
    const file = path.join(stateDir, "agents", "main", "agent", "openclaw-agent.sqlite");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    if (kind === "malformed") {
      fs.writeFileSync(file, "not a SQLite database");
    } else {
      const db = openNodeSqliteDatabase(file);
      db.exec("PRAGMA journal_mode=WAL; PRAGMA user_version=3;");
      db.close();
      fs.mkdirSync(`${file}-wal`);
    }
    const before = fs.readFileSync(file);
    await expect(readUpdateStateSchemaVersions({ stateDir, config: {} })).rejects.toThrow(
      /State schema inspection failed/,
    );
    expect(fs.readFileSync(file)).toEqual(before);
    if (kind === "nonregular-wal") {
      expect(fs.statSync(`${file}-wal`).isDirectory()).toBe(true);
      expect(fs.existsSync(`${file}-shm`)).toBe(false);
    }
  },
);

it.skipIf(process.platform === "win32")(
  "refuses source replacement during pinned header inspection",
  async () => {
    const stateDir = fs.realpathSync(dirs.make("update-schema-identity-"));
    const file = path.join(stateDir, "agents", "main", "agent", "openclaw-agent.sqlite");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const db = openNodeSqliteDatabase(file);
    db.exec("PRAGMA user_version=3;");
    db.close();
    const preload = path.join(stateDir, "replace-source.cjs");
    // Replace the pathname while the canonical owner still holds its original
    // descriptor. A numeric result from that retired inode must not be published.
    fs.writeFileSync(
      preload,
      `
      const fs = require('node:fs');
      const source = ${JSON.stringify(file)};
      const open = fs.openSync, read = fs.readSync;
      let descriptor, replaced = false;
      fs.openSync = function(file, ...args) {
        const fd = open.call(this, file, ...args);
        if (String(file) === source) descriptor = fd;
        return fd;
      };
      fs.readSync = function(fd, ...args) {
        const count = read.call(this, fd, ...args);
        if (fd === descriptor && !replaced) {
          replaced = true;
          fs.renameSync(source, source + '.retired');
          fs.copyFileSync(source + '.retired', source);
        }
        return count;
      };
    `,
    );
    await expect(
      readUpdateStateSchemaVersions({
        stateDir,
        config: {},
        env: { ...process.env, ...sqliteWorkerPreloadEnv(preload) },
      }),
    ).rejects.toThrow(/SQLite source changed/);
    expect(fs.readFileSync(file)).toEqual(fs.readFileSync(`${file}.retired`));
  },
);

it("discovers an agent registered after directory enumeration in the shared snapshot", async () => {
  const stateDir = fs.realpathSync(dirs.make("update-schema-new-agent-"));
  const sharedPath = path.join(stateDir, "state", "openclaw.sqlite");
  const agentPath = path.join(stateDir, "agents", "late", "agent", "openclaw-agent.sqlite");
  fs.mkdirSync(path.dirname(sharedPath), { recursive: true });
  fs.mkdirSync(path.join(stateDir, "agents"));
  const shared = openNodeSqliteDatabase(sharedPath);
  shared.exec("PRAGMA user_version=7; CREATE TABLE agent_databases(path TEXT);");
  shared.close();
  const before = await readUpdateStateSchemaVersions({ stateDir, config: {} });
  const preload = path.join(stateDir, "late-registration.cjs");
  // Insert after enumeration returns its old directory list. Only discovery
  // from the subsequently captured shared generation can find this new store.
  fs.writeFileSync(
    preload,
    `
    const fs = require('node:fs'), path = require('node:path');
    const { DatabaseSync } = require('node:sqlite');
    const agents = ${JSON.stringify(path.join(stateDir, "agents"))};
    const agent = ${JSON.stringify(agentPath)}, shared = ${JSON.stringify(sharedPath)};
    const readdir = fs.promises.readdir;
    fs.promises.readdir = async function(directory, ...args) {
      const entries = await readdir.call(this, directory, ...args);
      if (String(directory) === agents) {
        fs.mkdirSync(path.dirname(agent), {recursive:true});
        const db = new DatabaseSync(agent);
        try { db.exec('PRAGMA user_version=3'); } finally { db.close(); }
        const registry = new DatabaseSync(shared);
        try { registry.prepare('INSERT INTO agent_databases VALUES (?)').run(agent); }
        finally { registry.close(); }
      }
      return entries;
    };
  `,
  );
  const after = await readUpdateStateSchemaVersions({
    stateDir,
    config: {},
    env: { ...process.env, ...sqliteWorkerPreloadEnv(preload) },
  });
  expect(before.some((entry) => entry.path === agentPath)).toBe(false);
  expect(after).toContainEqual({ path: agentPath, userVersion: 3 });
  expect(
    updateStateSchemaVersionsMatch(before, after, {
      sharedPath,
      candidateSchemaVersions: { state: 7, agent: 3 },
    }),
  ).toBe(true);
});

it("fences WAL schema migration without copying a large registered agent payload", async () => {
  const root = fs.realpathSync(dirs.make("update-schema-payload-"));
  const stateDir = path.join(root, "state-owner");
  const sharedPath = path.join(stateDir, "state", "openclaw.sqlite");
  const agentPath = path.join(root, "external-agent.sqlite");
  const preload = path.join(root, "bounded-source-reads.cjs");
  const copiedShared = path.join(root, "shared-copied");
  const cache = path.join(root, "cache");
  fs.mkdirSync(path.dirname(sharedPath), { recursive: true });
  fs.mkdirSync(cache);
  const shared = openNodeSqliteDatabase(sharedPath);
  shared.exec(`
    PRAGMA user_version=15;
    CREATE TABLE config_machine_state(state_key TEXT PRIMARY KEY, value_json TEXT);
    INSERT INTO config_machine_state VALUES('state.schema.contentVersion','16');
    CREATE TABLE agent_databases(path TEXT);
  `);
  shared.prepare("INSERT INTO agent_databases VALUES (?)").run(agentPath);
  shared.close();
  const writer = openNodeSqliteDatabase(agentPath);
  writer.exec(`
    PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0;
    CREATE TABLE payload(data BLOB); INSERT INTO payload VALUES(zeroblob(67108864));
    CREATE TABLE schema_meta(meta_key TEXT PRIMARY KEY, app_version TEXT);
    INSERT INTO schema_meta VALUES('primary','baseline');
    PRAGMA user_version=3; PRAGMA wal_checkpoint(TRUNCATE);
  `);
  expect(fs.statSync(agentPath).size).toBeGreaterThan(64 * 1024 * 1024);
  // Constrain the actual child's filesystem copy path, which differs from
  // SQLite backup. Metadata reads remain real, including native WAL handling.
  fs.writeFileSync(
    preload,
    `
    const fs = require('node:fs');
    const source = ${JSON.stringify(agentPath)}, shared = ${JSON.stringify(sharedPath)};
    const marker = ${JSON.stringify(copiedShared)};
    const open = fs.openSync, read = fs.readSync, close = fs.closeSync;
    const sources = new Map();
    fs.openSync = function(file, ...args) {
      const fd = open.call(this, file, ...args);
      if (String(file) === source || String(file) === shared) sources.set(fd, String(file));
      return fd;
    };
    fs.readSync = function(fd, buffer, offset, length, position) {
      if (sources.get(fd) === source && length > 4096) throw new Error('agent payload copy forbidden');
      if (sources.get(fd) === shared && length > 4096) fs.writeFileSync(marker, 'copied');
      return read.call(this, fd, buffer, offset, length, position);
    };
    fs.closeSync = function(fd) { sources.delete(fd); return close.call(this, fd); };
    require('node:sqlite').backup = async () => { throw new Error('agent backup forbidden'); };
  `,
  );
  const env = { ...process.env, ...sqliteWorkerPreloadEnv(preload), XDG_CACHE_HOME: cache };
  const inspect = () => readUpdateStateSchemaVersions({ stateDir, config: {}, env });
  try {
    // Only WAL records the committed candidate version; the main header stays at 3.
    writer.exec("BEGIN IMMEDIATE; PRAGMA user_version=4; COMMIT;");
    const baseline = await inspect();
    expect(baseline).toContainEqual({ path: agentPath, userVersion: 4 });
    expect(baseline).toContainEqual({ path: sharedPath, userVersion: 15, contentVersion: 16 });
    expect(baseline).toContainEqual({
      path: path.join(stateDir, "agents", "main", "agent", "openclaw-agent.sqlite"),
      userVersion: null,
    });
    expect(fs.readFileSync(copiedShared, "utf8")).toBe("copied");
    const comparison = { sharedPath, candidateSchemaVersions: { state: 16, agent: 5 } };
    expect(updateStateSchemaVersionsMatch(baseline, await inspect(), comparison)).toBe(true);
    writer.exec("BEGIN IMMEDIATE; PRAGMA user_version=5; COMMIT;");
    const migrated = await inspect();
    expect(migrated).toContainEqual({ path: agentPath, userVersion: 5 });
    expect(updateStateSchemaVersionsMatch(baseline, migrated, comparison)).toBe(false);
    expect(
      fs.existsSync(path.join(cache, "openclaw"))
        ? fs.readdirSync(path.join(cache, "openclaw"))
        : [],
    ).toEqual([]);
  } finally {
    writer.close();
  }
});

async function writeInstalledCandidateWorkers(packageRoot: string, legacy: boolean): Promise<void> {
  const directory = path.join(packageRoot, "dist/infra");
  await fs.promises.mkdir(directory, { recursive: true });
  await fs.promises.writeFile(path.join(packageRoot, "package.json"), '{"type":"module"}');
  // These fixtures implement the released command shapes, not updater-relative imports.
  await fs.promises.writeFile(
    path.join(directory, "update-candidate-state.worker.js"),
    `
    import fs from "node:fs";
    import path from "node:path";
    import { DatabaseSync } from "node:sqlite";
    let input = "";
    for await (const chunk of process.stdin) input += chunk;
    const parsed = JSON.parse(input);
    if (parsed.mode !== "versions" && (${legacy} || parsed.mode !== "discover")) {
      throw new Error("Unknown update state inspection mode");
    }
    const report = process.env.CANDIDATE_SNAPSHOT_REPORT;
    if (${legacy} && report && fs.existsSync(report)) {
      if (fs.existsSync(JSON.parse(fs.readFileSync(report, "utf8")).location)) {
        throw new Error("Discovery snapshot overlaps legacy versions inspection");
      }
    }
    const file = path.join(parsed.stateDir, "state", "openclaw.sqlite");
    const db = new DatabaseSync(file, { readOnly: true });
    let files;
    let sharedVersion;
    try {
      files = [file, ...db.prepare("SELECT path FROM agent_databases ORDER BY path").all().map(row => row.path)];
      sharedVersion = { path: file, userVersion: db.prepare("PRAGMA user_version").get().user_version };
    } finally { db.close(); }
    const versions = files.map(file => {
      const db = new DatabaseSync(file, { readOnly: true });
      try { return { path: file, userVersion: db.prepare("PRAGMA user_version").get().user_version }; }
      finally { db.close(); }
    });
    console.log(JSON.stringify(parsed.mode === "discover"
      ? { files: files.map(file => [file, { spellings: [file] }]), sharedVersion }
      : versions));
  `,
  );
  await fs.promises.writeFile(
    path.join(directory, "sqlite-readonly-location.worker.js"),
    `
    import fs from "node:fs";
    import path from "node:path";
    if (process.argv[2] !== "--openclaw-sqlite-readonly-child" || process.argv[3] !== "sync") {
      throw new Error("Unexpected SQLite snapshot worker protocol");
    }
    const directory = fs.mkdtempSync(path.join(process.argv[5], "legacy-copy-"));
    const location = path.join(directory, "database.sqlite");
    fs.copyFileSync(process.argv[4], location);
    fs.writeFileSync(process.env.CANDIDATE_SNAPSHOT_REPORT, JSON.stringify({ location, pid: process.pid }));
    console.log(JSON.stringify({ ok: true, location }));
  `,
  );
}

it.each(
  (["modern", "legacy"] as const).flatMap((protocol) =>
    (["removed", "replaced"] as const).map((activation) => ({ protocol, activation })),
  ),
)(
  "inspects with the installed $protocol candidate after the old package is $activation",
  async ({ protocol, activation }) => {
    const root = fs.realpathSync(dirs.make("candidate-installed-"));
    const stateDir = path.join(root, "state-owner");
    const shared = path.join(stateDir, "state", "openclaw.sqlite");
    const external = path.join(root, "registered.sqlite");
    fs.mkdirSync(path.dirname(shared), { recursive: true });
    const agent = openNodeSqliteDatabase(external);
    agent.exec("PRAGMA user_version = 7;");
    agent.close();
    const db = openNodeSqliteDatabase(shared);
    db.exec("PRAGMA user_version = 3; CREATE TABLE agent_databases (path TEXT);");
    db.prepare("INSERT INTO agent_databases VALUES (?)").run(external);
    db.close();
    const sourceBytes = fs.readFileSync(shared);
    const previousRoot = path.join(root, "previous-package");
    const candidateRoot =
      activation === "replaced" ? previousRoot : path.join(root, "candidate-package");
    await writeInstalledCandidateWorkers(previousRoot, false);
    const entrypoints = [
      runtimeProcessEntrypoints.updateCandidateState,
      runtimeProcessEntrypoints.sqliteReadOnly,
    ];
    const originalUrls = entrypoints.map((entry) => entry.currentModuleUrl);
    for (const entry of entrypoints) {
      Object.assign(entry, {
        currentModuleUrl: pathToFileURL(path.join(previousRoot, "dist/old-updater.js")).href,
      });
    }
    try {
      const before = await readUpdateStateSchemaVersions({ stateDir, config: {} });
      expect(before).toEqual([
        { path: shared, userVersion: 3 },
        { path: external, userVersion: 7 },
      ]);
      if (activation === "removed") {
        await fs.promises.rm(previousRoot, { recursive: true });
      }
      await writeInstalledCandidateWorkers(candidateRoot, protocol === "legacy");
      const selectedNodeMarker = path.join(root, "selected-node-ran");
      let nodeRunner = process.execPath;
      if (process.platform !== "win32") {
        nodeRunner = path.join(root, "selected-node");
        const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
        await fs.promises.writeFile(
          nodeRunner,
          `#!/bin/sh\nprintf selected > ${quote(selectedNodeMarker)}\nexec ${quote(process.execPath)} "$@"\n`,
          { mode: 0o755 },
        );
      }
      const report = path.join(root, "snapshot.json");
      const after = await readUpdateStateSchemaVersions({
        stateDir,
        config: {},
        root: candidateRoot,
        nodeRunner,
        env: { ...process.env, CANDIDATE_SNAPSHOT_REPORT: report },
      });
      expect(after).toEqual(before);
      expect(fs.readFileSync(shared)).toEqual(sourceBytes);
      if (protocol === "legacy") {
        const snapshot = JSON.parse(fs.readFileSync(report, "utf8")) as {
          location: string;
          pid: number;
        };
        expect(() => fs.statSync(path.dirname(snapshot.location))).toThrow();
        expect(() => process.kill(snapshot.pid, 0)).toThrow();
      }
      if (process.platform !== "win32") {
        expect(fs.readFileSync(selectedNodeMarker, "utf8")).toBe("selected");
      }
    } finally {
      entrypoints.forEach((entry, index) =>
        Object.assign(entry, { currentModuleUrl: originalUrls[index] }),
      );
    }
  },
);
