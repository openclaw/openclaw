import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { resolveRuntimeWorkerArgv, resolveRuntimeWorkerUrl } from "./runtime-worker-url.js";
import { sqliteSnapshotStagingEntrypoints } from "./sqlite-snapshot-staging-runtime.test-support.js";

const unsettledDrivers = new Set<string>();
const directories = useAutoCleanupTempDirTracker((cleanup) => {
  afterEach(() => {
    if (unsettledDrivers.size > 0) {
      throw new Error(
        `Snapshot driver did not acknowledge cleanup; retained fixtures: ${[...directories.dirs].join(", ")}`,
      );
    }
    cleanup();
  });
});

it.each([true, false])(
  "services snapshots without yielding (preserveSourceArtifacts=%s)",
  (preserveSourceArtifacts) => {
    const root = directories.make("sqlite-retained-source-");
    const source = path.join(root, "source.sqlite");
    const cache = path.join(root, "cache");
    fs.mkdirSync(cache);
    const sourceUrl = resolveRuntimeWorkerUrl(sqliteSnapshotStagingEntrypoints.source);
    const cleanupUrl = resolveRuntimeWorkerUrl(sqliteSnapshotStagingEntrypoints.cleanup);
    const script = `
      import assert from 'node:assert/strict';
      import fs from 'node:fs';
      import { spawnSync } from 'node:child_process';
      import { createRequire, syncBuiltinESMExports } from 'node:module';
      import { startSqliteReadOnlyLocationAsync } from ${JSON.stringify(sourceUrl.href)};
      import { cleanupSnapshotOperations } from ${JSON.stringify(cleanupUrl.href)};
      const sqlite = createRequire(import.meta.url)('node:sqlite');
      const source = ${JSON.stringify(source)};
      const seed = new sqlite.DatabaseSync(source);
      try {
        seed.exec("CREATE TABLE probe(value TEXT); INSERT INTO probe VALUES('preserved');");
      } finally { seed.close(); }
      const original = fs.readFileSync(source);
      const sourceFiles = () => fs.readdirSync(${JSON.stringify(root)}).filter(name => name.startsWith('source.sqlite'));
      const originalFiles = sourceFiles();
      const originalConstructor = sqlite.DatabaseSync;
      let nativeConstructions = 0;
      sqlite.DatabaseSync = new Proxy(originalConstructor, {
        construct() {
          nativeConstructions++;
          throw new Error('SQLite construction reached the initiating snapshot realm');
        },
      });
      syncBuiltinESMExports();
      const controller = new AbortController();
      const barrier = new Int32Array(new SharedArrayBuffer(4));
      function serviceToCompletion(operation) {
        const deadline = performance.now() + 10_000;
        for (;;) {
          operation.service();
          const outcome = operation.read();
          if (outcome.status === 'rejected') throw outcome.error;
          if (outcome.status === 'fulfilled') return outcome.value;
          if (performance.now() >= deadline) throw new Error('Retained snapshot servicing did not settle');
          Atomics.wait(barrier, 0, 0, 2);
        }
      }
      let microtaskRan = false;
      let timerRan = false;
      queueMicrotask(() => { microtaskRan = true; });
      const timer = setTimeout(() => { timerRan = true; }, 0);
      let operation, joined, prepared, joinedSource;
      const failures = [];
      let cleanupJoined = false;
      try {
        const start = () => startSqliteReadOnlyLocationAsync(source, {
          preserveSourceArtifacts: ${JSON.stringify(preserveSourceArtifacts)},
          signal: controller.signal,
        });
        operation = start();
        joined = start();
        prepared = serviceToCompletion(operation);
        joinedSource = serviceToCompletion(joined);
        assert.equal(joinedSource.location, prepared.location);
        assert.equal(joinedSource.privateFamily, prepared.privateFamily);
        assert.equal(Boolean(prepared.privateFamily), ${JSON.stringify(preserveSourceArtifacts)});
        assert.deepEqual([microtaskRan, timerRan], [false, false]);
        assert.equal(fs.existsSync(prepared.location), true);
        const reader = spawnSync(process.execPath, ['--input-type=module', '-e',
          "import { DatabaseSync } from 'node:sqlite';" +
          "const database = new DatabaseSync(process.argv[1], { readOnly: true });" +
          "try { process.stdout.write(JSON.stringify(database.prepare('SELECT value FROM probe').get())); }" +
          "finally { database.close(); }",
          prepared.location,
        ], { encoding: 'utf8', timeout: 30_000 });
        assert.equal(reader.error, undefined, reader.stderr);
        assert.equal(reader.status, 0, reader.stderr);
        const row = JSON.parse(reader.stdout);
        assert.deepEqual(row, { value: 'preserved' });
        assert.equal(serviceToCompletion(prepared.startCleanup()), true);
        assert.equal(fs.existsSync(prepared.cleanupRoot), true);
        assert.equal(serviceToCompletion(joinedSource.startCleanup()), true);
        assert.equal(fs.existsSync(prepared.cleanupRoot), false);
        assert.deepEqual([microtaskRan, timerRan, nativeConstructions], [false, false, 0]);
      } catch (error) {
        failures.push(error);
      } finally {
        clearTimeout(timer);
        controller.abort(new Error('Retained snapshot fixture stopped'));
        if (operation) {
          try {
            prepared ??= await operation.result;
          } catch (error) {
            if (!failures.includes(error)) failures.push(error);
          }
        }
        try {
          if (prepared) assert.equal(await prepared.cleanupAsync(), true);
          if (joinedSource) assert.equal(await joinedSource.cleanupAsync(), true);
          await operation?.startClose().result;
          await joined?.startClose().result;
          await cleanupSnapshotOperations();
          cleanupJoined = !prepared || !fs.existsSync(prepared.cleanupRoot);
          assert.deepEqual(fs.readFileSync(source), original);
          assert.deepEqual(sourceFiles(), originalFiles);
        } catch (error) {
          failures.push(error);
        }
        sqlite.DatabaseSync = originalConstructor;
        syncBuiltinESMExports();
      }
      process.stdout.write(JSON.stringify({ cleanupJoined,
        errors: failures.map(error => error instanceof Error ? error.stack : String(error)) }));
      if (failures.length || !cleanupJoined) process.exitCode = 1;
    `;
    unsettledDrivers.add(root);
    const args = [
      ...resolveRuntimeWorkerArgv(sourceUrl).slice(0, -1),
      "--input-type=module",
      "-e",
      script,
    ];
    const result = spawnSync(process.execPath, args, {
      encoding: "utf8",
      timeout: 30_000,
      env: { ...process.env, XDG_CACHE_HOME: cache },
    });
    const receipt = result.stdout.trim() ? JSON.parse(result.stdout) : undefined;
    const driverSettled =
      !result.error &&
      result.signal === null &&
      receipt?.cleanupJoined === true &&
      receipt.errors.length === 0;
    if (driverSettled) {
      unsettledDrivers.delete(root);
    }
    expect(
      [result.error, result.signal, result.status],
      `${result.stderr}\n${result.stdout}`,
    ).toEqual([undefined, null, 0]);
    // The child asserts the row, cleanup, idle event loop and zero native constructions.
    expect(receipt).toEqual({ cleanupJoined: true, errors: [] });
  },
);
