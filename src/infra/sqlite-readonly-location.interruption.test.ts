import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { setLoggerOverride } from "../logging/logger.js";
import { testApi } from "../logging/logger.test-support.js";
import { listDirectoryTreeStrictSync } from "./directory-walk.js";
import { requireNodeSqlite } from "./node-sqlite.js";
import { resolveRuntimeWorkerArgv, resolveRuntimeWorkerUrl } from "./runtime-worker-url.js";
import { prepareSqliteReadOnlyLocationSyncInProcess as prepareSnapshot } from "./sqlite-readonly-location.js";
import { reclaimAbandonedSqliteSnapshots } from "./sqlite-snapshot-staging.js";
import { storageProcessTestEntrypoints } from "./storage-process-runtime.test-support.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const snapshotModule = resolveRuntimeWorkerUrl(
  storageProcessTestEntrypoints.sqliteReadOnlyLocation,
);
afterEach(() => setLoggerOverride(null));

function fixture(sql: string) {
  const root = tempDirs.make("sqlite-reclamation-");
  const source = path.join(root, "source.sqlite");
  const cache = path.join(root, "cache");
  fs.mkdirSync(cache);
  {
    using database = new (requireNodeSqlite().DatabaseSync)(source);
    database.exec(sql);
  }
  return { root, source, cache, before: fs.readFileSync(source) };
}
const entries = (directory: string) =>
  listDirectoryTreeStrictSync(directory).map((walkEntry) => walkEntry.dirent);
const entryPath = (entry: fs.Dirent) => path.join(entry.parentPath, entry.name);

it.skipIf(process.platform === "win32").each([
  { signal: "SIGKILL", relocated: false },
  { signal: "SIGTERM", relocated: true },
])(
  "reclaims a $signal-interrupted copy during idle cleanup (Doctor layout: $relocated)",
  async ({ signal, relocated }) => {
    const { root, source, cache, before } = fixture(
      "CREATE TABLE probe(value BLOB); INSERT INTO probe VALUES(zeroblob(2097152));",
    );
    const log = path.join(root, "cleanup.log");
    fs.writeFileSync(log, "");
    setLoggerOverride({ level: "warn", file: log });
    const result = spawnSync(
      process.execPath,
      [
        ...resolveRuntimeWorkerArgv(snapshotModule).slice(0, -1),
        "--input-type=module",
        "-e",
        `import fs from 'node:fs'; import path from 'node:path';
         import { prepareSqliteReadOnlyLocationSyncInProcess } from ${JSON.stringify(snapshotModule.href)};
         const write = fs.writeSync;
         fs.writeSync = (...args) => {
           const bytes = write(...args);
           if (!${JSON.stringify(relocated)}) process.kill(process.pid, ${JSON.stringify(signal)});
           return bytes;
         };
         const prepared = prepareSqliteReadOnlyLocationSyncInProcess(${JSON.stringify(source)}, ${JSON.stringify(cache)});
         const relocated = path.join(path.dirname(prepared.location), 'openclaw-state/state/openclaw.sqlite');
         fs.mkdirSync(path.dirname(relocated), { recursive: true });
         fs.renameSync(prepared.location, relocated);
         process.kill(process.pid, ${JSON.stringify(signal)});`,
      ],
      { encoding: "utf8", timeout: 30_000 },
    );
    expect(result.error, result.stderr).toBeUndefined();
    expect(result.signal, result.stderr).toBe(signal);
    const abandoned = fs.readdirSync(cache).map((entry) => path.join(cache, entry));
    expect(abandoned).toHaveLength(1);
    const retainedBytes = entries(abandoned[0]!)
      .filter((entry) => entry.isFile() && !entry.name.startsWith("owner.sqlite"))
      .reduce((bytes, entry) => bytes + fs.statSync(entryPath(entry)).size, 0);
    expect(retainedBytes).toBeGreaterThan(0);
    const aged = new Date(Date.now() - 16 * 60_000);
    for (const directory of abandoned) {
      for (const entry of entries(directory)) {
        fs.utimesSync(entryPath(entry), aged, aged);
      }
      fs.utimesSync(directory, aged, aged);
    }
    const prepared = prepareSnapshot(source, cache);
    try {
      // Inspection no longer reclaims inline; the idle owner performs that work.
      expect(abandoned.every((directory) => fs.existsSync(directory))).toBe(true);
      Array.from(reclaimAbandonedSqliteSnapshots(cache));
      expect(abandoned.every((directory) => !fs.existsSync(directory))).toBe(true);
      using reader = new (requireNodeSqlite().DatabaseSync)(prepared.location, { readOnly: true });
      expect(reader.prepare("SELECT length(value) AS bytes FROM probe").get()).toEqual({
        bytes: 2097152,
      });
    } finally {
      prepared.cleanup();
    }
    expect(fs.readdirSync(cache)).toEqual([]);
    expect(fs.readFileSync(source)).toEqual(before);
    await testApi.flushFileLogQueueForTests();
    expect(fs.readFileSync(log, "utf8")).toContain(`Reclaimed ${retainedBytes} bytes`);
  },
);

it.skipIf(process.platform === "win32")(
  "preserves unknown files and symlinks before opening reclamation tokens",
  () => {
    const { source, cache, before } = fixture(
      "CREATE TABLE probe(value TEXT); INSERT INTO probe VALUES('preserved');",
    );
    const sqlite = requireNodeSqlite();
    const artifacts = ["operator.txt", "database.sqlite", "owner.sqlite", "owner.sqlite-journal"];
    const directories = artifacts.map((artifact, index) => {
      const directory = path.join(cache, `openclaw-sqlite-readonly-v2-Case0${index}`);
      fs.mkdirSync(directory);
      if (artifact !== "owner.sqlite") {
        new sqlite.DatabaseSync(path.join(directory, "owner.sqlite")).close();
      }
      if (artifact === "operator.txt") {
        fs.writeFileSync(path.join(directory, artifact), "retain");
      } else {
        fs.symlinkSync(source, path.join(directory, artifact));
      }
      return directory;
    });
    const prepared = prepareSnapshot(source, cache);
    prepared.cleanup();
    Array.from(reclaimAbandonedSqliteSnapshots(cache));
    expect(fs.readdirSync(cache).toSorted()).toEqual(
      directories.map((directory) => path.basename(directory)).toSorted(),
    );
    for (const [index, artifact] of artifacts.entries()) {
      const location = path.join(directories[index]!, artifact);
      expect(fs.lstatSync(location).isSymbolicLink()).toBe(artifact !== "operator.txt");
    }
    expect(fs.readFileSync(source)).toEqual(before);
  },
);
