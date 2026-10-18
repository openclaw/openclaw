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
  "services real snapshot production and cleanup without a caller event-loop turn (preserveSourceArtifacts=%s)",
  (preserveSourceArtifacts) => {
    const root = directories.make("sqlite-retained-source-");
    const source = path.join(root, "source.sqlite");
    const cache = path.join(root, "cache");
    fs.mkdirSync(cache);
    const seeded = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `import { DatabaseSync } from 'node:sqlite';
         const database = new DatabaseSync(${JSON.stringify(source)});
         try {
           database.exec("CREATE TABLE probe(value TEXT); INSERT INTO probe VALUES('preserved');");
         } finally {
           database.close();
         }`,
      ],
      { encoding: "utf8", timeout: 30_000 },
    );
    expect(seeded.error, seeded.stderr).toBeUndefined();
    expect(seeded.status, seeded.stderr).toBe(0);
    const original = fs.readFileSync(source);
    const sourceFiles = fs.readdirSync(root).filter((name) => name.startsWith("source.sqlite"));
    const sourceUrl = resolveRuntimeWorkerUrl(sqliteSnapshotStagingEntrypoints.source);
    const cleanupUrl = resolveRuntimeWorkerUrl(sqliteSnapshotStagingEntrypoints.cleanup);
    const nodeArguments = [
      ...resolveRuntimeWorkerArgv(sourceUrl).slice(0, -1),
      "--input-type=module",
      "-e",
    ];
    const script = `
      import assert from 'node:assert/strict';
      import fs from 'node:fs';
      import { spawnSync } from 'node:child_process';
      import { createRequire, syncBuiltinESMExports } from 'node:module';
      import { startSqliteReadOnlyLocationAsync } from ${JSON.stringify(sourceUrl.href)};
      import { cleanupSnapshotOperations } from ${JSON.stringify(cleanupUrl.href)};
      const sqlite = createRequire(import.meta.url)('node:sqlite');
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
      let services = 0;
      function serviceToCompletion(operation) {
        const deadline = performance.now() + 10_000;
        for (;;) {
          operation.service();
          services++;
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
      let operation;
      let prepared;
      let proof;
      const failures = [];
      let cleanupJoined = false;
      try {
        operation = startSqliteReadOnlyLocationAsync(${JSON.stringify(source)}, {
          preserveSourceArtifacts: ${JSON.stringify(preserveSourceArtifacts)},
          signal: controller.signal,
        });
        prepared = serviceToCompletion(operation);
        assert.equal(microtaskRan, false);
        assert.equal(timerRan, false);
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
        assert.equal(fs.existsSync(prepared.cleanupRoot), false);
        assert.equal(microtaskRan, false);
        assert.equal(timerRan, false);
        assert.equal(nativeConstructions, 0);
        proof = { row, microtaskRan, timerRan, nativeConstructions, services,
          location: prepared.location, directory: prepared.cleanupRoot, removed: true };
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
          await cleanupSnapshotOperations();
          cleanupJoined = !prepared || !fs.existsSync(prepared.cleanupRoot);
        } catch (error) {
          failures.push(error);
        }
        sqlite.DatabaseSync = originalConstructor;
        syncBuiltinESMExports();
      }
      process.stdout.write(JSON.stringify({ proof, cleanupJoined,
        errors: failures.map(error => error instanceof Error ? error.stack : String(error)) }));
      if (failures.length || !cleanupJoined) process.exitCode = 1;
    `;
    unsettledDrivers.add(root);
    const result = spawnSync(process.execPath, [...nodeArguments, script], {
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
    expect(result.error, result.stderr).toBeUndefined();
    expect(result.signal, result.stderr).toBeNull();
    expect(result.status, `${result.stderr}\n${result.stdout}`).toBe(0);
    expect(receipt).toMatchObject({
      cleanupJoined: true,
      errors: [],
      proof: {
        row: { value: "preserved" },
        microtaskRan: false,
        timerRan: false,
        nativeConstructions: 0,
        removed: true,
      },
    });
    expect(fs.existsSync(receipt.proof.directory)).toBe(false);
    expect(fs.readFileSync(source)).toEqual(original);
    expect(fs.readdirSync(root).filter((name) => name.startsWith("source.sqlite"))).toEqual(
      sourceFiles,
    );
  },
);
