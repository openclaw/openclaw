import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { signalExitCode } from "../../scripts/lib/managed-child-process.mts";
import { createManagedHandoffTestBinding } from "../../test/helpers/managed-handoff-isolation.js";
import { runNodeScript } from "../../test/helpers/run-node-script.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { setLoggerOverride } from "../logging/logger.js";
import { testApi } from "../logging/logger.test-support.js";
import { requireNodeSqlite } from "./node-sqlite.js";
import { resolveRuntimeWorkerArgv, resolveRuntimeWorkerUrl } from "./runtime-worker-url.js";
import { prepareSqliteReadOnlyLocationSyncInProcess } from "./sqlite-readonly-location.js";
import { reclaimAbandonedSqliteSnapshots } from "./sqlite-snapshot-staging.js";
import { storageProcessTestEntrypoints } from "./storage-process-runtime.test-support.js";
import { captureResourceOwnedNativeProcessExit } from "./vitest-resource-ownership.js";

const tempDirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(async () => {
    try {
      await testApi.flushFileLogQueueForTests();
    } finally {
      setLoggerOverride(null);
      cleanup();
    }
  }),
);
const snapshotModule = resolveRuntimeWorkerUrl(
  storageProcessTestEntrypoints.sqliteReadOnlyLocation,
);

it.skipIf(process.platform === "win32").for([
  { signal: "SIGTERM", relocated: false },
  { signal: "SIGKILL", relocated: false },
  { signal: "SIGTERM", relocated: true },
] as const)(
  "reclaims a $signal-interrupted copy during idle cleanup (Doctor layout: $relocated)",
  async ({ signal, relocated }, { signal: testSignal }) => {
    const root = tempDirs.make("sqlite-interrupted-owner-");
    const binding = createManagedHandoffTestBinding(root);
    const interrupted = path.join(root, "copy-boundary.json");
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
    let exitSignal: NodeJS.Signals | null = null;
    let settleNativeExit: (() => Promise<void>) | undefined;
    const result = await runNodeScript(
      [
        binding.nodeOption,
        ...resolveRuntimeWorkerArgv(snapshotModule).slice(0, -1),
        "--input-type=module",
        "-e",
        `import fs from 'node:fs'; import path from 'node:path';
         import { prepareSqliteReadOnlyLocationSyncInProcess } from ${JSON.stringify(snapshotModule.href)};
         const open = fs.openSync;
         let snapshotDescriptor;
         let snapshotPath;
         fs.openSync = (...args) => {
           const descriptor = open(...args);
           if (path.basename(String(args[0])) === 'first' && path.dirname(path.dirname(String(args[0]))) === ${JSON.stringify(cache)} && args[1] === 'wx') {
             snapshotDescriptor = descriptor;
             snapshotPath = String(args[0]);
           }
           return descriptor;
         };
         const write = fs.writeSync;
         fs.writeSync = (...args) => {
           const bytes = write(...args);
           if (!${JSON.stringify(relocated)} && args[0] === snapshotDescriptor && bytes > 0) {
             fs.writeFileSync(${JSON.stringify(interrupted)}, JSON.stringify({ snapshotPath, bytes }));
             process.kill(process.pid, ${JSON.stringify(signal)});
           }
           return bytes;
         };
         const prepared = prepareSqliteReadOnlyLocationSyncInProcess(${JSON.stringify(source)}, ${JSON.stringify(cache)});
         if (!${JSON.stringify(relocated)}) throw new Error('fixture did not interrupt the initial snapshot copy');
         const relocated = path.join(path.dirname(prepared.location), 'openclaw-state/state/openclaw.sqlite');
         fs.mkdirSync(path.dirname(relocated), { recursive: true });
         fs.renameSync(prepared.location, relocated);
         process.kill(process.pid, ${JSON.stringify(signal)});`,
      ],
      process.env,
      30_000,
      {
        signal: testSignal,
        requireProcessTreeExit: true,
        onReady(child) {
          settleNativeExit = captureResourceOwnedNativeProcessExit(child);
          child.once("exit", (_code, value) => {
            exitSignal = value;
          });
        },
      },
    );
    await settleNativeExit?.();
    binding.assertPath();
    expect(result.error, result.stderr).toBeUndefined();
    expect(exitSignal, result.stderr).toBe(signal);
    expect(result.status, result.stderr).toBe(signalExitCode(signal));
    const abandoned = fs.readdirSync(cache).map((entry) => path.join(cache, entry));
    expect(abandoned).toHaveLength(1);
    if (!relocated) {
      const boundary = JSON.parse(fs.readFileSync(interrupted, "utf8"));
      expect(boundary.snapshotPath).toBe(path.join(abandoned[0]!, "first"));
      expect(boundary.bytes).toBeGreaterThan(0);
      expect(fs.statSync(boundary.snapshotPath).size).toBe(boundary.bytes);
      expect(boundary.bytes).toBeLessThan(before.length);
    }
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
