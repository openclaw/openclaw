import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { expect, it } from "vitest";
import { resolveRuntimeWorkerArgv, resolveRuntimeWorkerUrl } from "./runtime-worker-url.js";
import { useSqliteTempDirs } from "./sqlite-shard-lifecycle.test-support.js";
import { sqliteSnapshotStagingEntrypoints } from "./sqlite-snapshot-staging-runtime.test-support.js";

const unsettledDrivers = new Set<string>();
const directories = useSqliteTempDirs(() => {
  if (unsettledDrivers.size > 0) {
    throw new Error(
      `Snapshot cleanup unacknowledged; retained: ${[...directories.dirs].join(", ")}`,
    );
  }
});

it.each([true, false])("services snapshots without yielding (preserve=%s)", (preserve) => {
  const root = directories.make("sqlite-retained-source-");
  const source = path.join(root, "source.sqlite");
  const cache = path.join(root, "cache");
  fs.mkdirSync(cache);
  const sourceUrl = resolveRuntimeWorkerUrl(sqliteSnapshotStagingEntrypoints.source);
  const cleanupUrl = resolveRuntimeWorkerUrl(sqliteSnapshotStagingEntrypoints.cleanup);
  const sqliteUrl = resolveRuntimeWorkerUrl({
    ...sqliteSnapshotStagingEntrypoints.source,
    sourceWorkerName: "node-sqlite",
    distWorkerPath: "infra/node-sqlite.js",
  });
  const script = `
      import assert from 'node:assert/strict';
      import fs from 'node:fs';
      import { spawnSync } from 'node:child_process';
      import { syncBuiltinESMExports } from 'node:module';
      import { requireNodeSqlite } from ${JSON.stringify(sqliteUrl.href)};
      import { startSqliteReadOnlyLocationAsync } from ${JSON.stringify(sourceUrl.href)};
      import { cleanupSnapshotOperations } from ${JSON.stringify(cleanupUrl.href)};
      const sqlite = requireNodeSqlite();
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
      const idle = { microtask: false, timer: false };
      queueMicrotask(() => { idle.microtask = true; });
      const timer = setTimeout(() => { idle.timer = true; }, 0);
      let operation, joined, prepared, joinedSource;
      const failures = [];
      let cleanupJoined = false;
      try {
        const start = () => startSqliteReadOnlyLocationAsync(source, {
          preserveSourceArtifacts: ${JSON.stringify(preserve)},
          signal: controller.signal,
        });
        operation = start();
        joined = start();
        prepared = serviceToCompletion(operation);
        joinedSource = serviceToCompletion(joined);
        assert.deepEqual([joinedSource.location === prepared.location, joinedSource.privateFamily === prepared.privateFamily], [true, true]);
        assert.equal(Boolean(prepared.privateFamily), ${JSON.stringify(preserve)});
        assert.deepEqual([idle.microtask, idle.timer], [false, false]);
        assert.equal(fs.existsSync(prepared.location), true);
        const reader = spawnSync(process.execPath, [...${JSON.stringify(resolveRuntimeWorkerArgv(sqliteUrl).slice(0, -1))}, '--input-type=module', '-e',
          ${JSON.stringify(`import { requireNodeSqlite } from ${JSON.stringify(sqliteUrl.href)}; const { DatabaseSync } = requireNodeSqlite();`)} +
          "const database = new DatabaseSync(process.argv[1], { readOnly: true });" +
          "try { process.stdout.write(JSON.stringify(database.prepare('SELECT value FROM probe').get())); }" +
          "finally { database.close(); }",
          prepared.location,
        ], { encoding: 'utf8', timeout: 30_000 });
        assert.deepEqual([reader.error, reader.status], [undefined, 0], reader.stderr);
        assert.deepEqual(JSON.parse(reader.stdout), { value: 'preserved' });
        assert.deepEqual([serviceToCompletion(prepared.startCleanup()), fs.existsSync(prepared.cleanupRoot)], [true, true]);
        assert.deepEqual([serviceToCompletion(joinedSource.startCleanup()), fs.existsSync(prepared.cleanupRoot)], [true, false]);
        assert.deepEqual([idle.microtask, idle.timer, nativeConstructions], [false, false, 0]);
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
          for (const copy of [prepared, joinedSource]) if (copy) assert.equal(await copy.cleanupAsync(), true);
          for (const request of [operation, joined]) await request?.startClose().result;
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
  expect(receipt).toEqual({ cleanupJoined: true, errors: [] });
});
