import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { setLoggerOverride } from "../logging/logger.js";
import { testApi } from "../logging/logger.test-support.js";
import { requireNodeSqlite } from "./node-sqlite.js";
import { resolveRuntimeWorkerArgv, resolveRuntimeWorkerUrl } from "./runtime-worker-url.js";
import { prepareSqliteReadOnlyLocationSyncInProcess } from "./sqlite-readonly-location.js";
import { reclaimAbandonedSqliteSnapshots } from "./sqlite-snapshot-staging.js";
import { storageProcessTestEntrypoints } from "./storage-process-runtime.test-support.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const snapshotModule = resolveRuntimeWorkerUrl(
  storageProcessTestEntrypoints.sqliteReadOnlyLocation,
);
afterEach(() => {
  setLoggerOverride(null);
  vi.unstubAllEnvs();
});

it.skipIf(process.platform === "win32").each([
  { signal: "SIGTERM", relocated: false },
  { signal: "SIGKILL", relocated: false },
  { signal: "SIGTERM", relocated: true },
])(
  "reclaims a $signal-interrupted copy during idle cleanup (Doctor layout: $relocated)",
  async ({ signal, relocated }) => {
    const root = tempDirs.make("sqlite-interrupted-owner-");
    const cache = path.join(root, "cache");
    const source = path.join(root, "source.sqlite");
    const log = path.join(root, "cleanup.log");
    fs.mkdirSync(cache);
    fs.writeFileSync(log, "");
    setLoggerOverride({ level: "warn", file: log });
    const database = new (requireNodeSqlite().DatabaseSync)(source);
    database.exec("CREATE TABLE probe(value BLOB); INSERT INTO probe VALUES(zeroblob(2097152));");
    database.close();
    const before = fs.readFileSync(source);
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
    const retainedBytes = fs
      .readdirSync(abandoned[0]!, { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile() && !entry.name.startsWith("owner.sqlite"))
      .reduce(
        (bytes, entry) => bytes + fs.statSync(path.join(entry.parentPath, entry.name)).size,
        0,
      );
    expect(retainedBytes).toBeGreaterThan(0);
    const aged = new Date(Date.now() - 16 * 60_000);
    for (const directory of abandoned) {
      for (const entry of fs.readdirSync(directory, { recursive: true, withFileTypes: true })) {
        fs.utimesSync(path.join(entry.parentPath, entry.name), aged, aged);
      }
      fs.utimesSync(directory, aged, aged);
    }
    const prepared = prepareSqliteReadOnlyLocationSyncInProcess(source, cache);
    try {
      // Inspection no longer reclaims inline; the idle owner performs that work.
      expect(abandoned.every((directory) => fs.existsSync(directory))).toBe(true);
      for (const _ of reclaimAbandonedSqliteSnapshots(cache)) {
        // Drain the same bounded reclamation pass used by the idle worker.
      }
      expect(abandoned.every((directory) => !fs.existsSync(directory))).toBe(true);
      const reader = new (requireNodeSqlite().DatabaseSync)(prepared.location, { readOnly: true });
      try {
        expect(reader.prepare("SELECT length(value) AS bytes FROM probe").get()).toEqual({
          bytes: 2097152,
        });
      } finally {
        reader.close();
      }
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
    const root = tempDirs.make("sqlite-reclaim-artifacts-");
    const source = path.join(root, "source.sqlite");
    const cache = path.join(root, "cache");
    fs.mkdirSync(cache);
    const sqlite = requireNodeSqlite();
    const database = new sqlite.DatabaseSync(source);
    database.exec("CREATE TABLE probe(value TEXT); INSERT INTO probe VALUES('preserved');");
    database.close();
    const before = fs.readFileSync(source);
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
    const prepared = prepareSqliteReadOnlyLocationSyncInProcess(source, cache);
    prepared.cleanup();
    for (const _ of reclaimAbandonedSqliteSnapshots(cache)) {
      // Unknown entries must remain untouched even during explicit reclamation.
    }
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
