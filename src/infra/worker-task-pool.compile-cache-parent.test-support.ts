import assert from "node:assert/strict";
import { getCompileCacheDir } from "node:module";
import path from "node:path";
import { SHARE_ENV, type WorkerOptions } from "node:worker_threads";
import { enableOpenClawCompileCache } from "../../node-compile-cache.mjs";
import { closeDefaultRetainedNativeWorkerSource } from "./worker-native-lifecycle.js";
import { createOwnedWorkerTaskPool } from "./worker-task-pool.js";

type CacheState = {
  directory: string | null;
  cache: string | null;
  disable: string | null;
  explicit: string | null;
};

const mode = process.env.OPENCLAW_CACHE_FIXTURE_MODE;
const home = process.env.HOME;
assert.ok(home);
if (mode === "foreign") {
  // Node returns ALREADY_ENABLED for another owner; that leaf is not our base.
  enableOpenClawCompileCache({ directory: path.join(home, "other-owner") });
}
const before = { ...process.env };
const parentDirectory = getCompileCacheDir();
assert.equal(process.env.NODE_OPTIONS, undefined);
assert.equal(process.env.NODE_COMPILE_CACHE, mode === "cache-empty" ? "" : undefined);
assert.equal(Boolean(parentDirectory), mode === "foreign");

async function run(
  retainedTransport: boolean,
  workerOptions?: WorkerOptions,
  prepareWorker?: () => { options: WorkerOptions },
  input: { sharedValue?: string } = {},
): Promise<CacheState> {
  const pool = createOwnedWorkerTaskPool<{ sharedValue?: string }, CacheState>(
    {
      workerUrl: new URL(
        "./worker-task-pool.compile-cache-worker.test-support.js",
        import.meta.url,
      ),
      maxWorkers: 1,
      workerOptions,
      prepareWorker,
    },
    retainedTransport ? { retainedTransport: true } : undefined,
  );
  try {
    return await pool.run(input, {});
  } finally {
    await pool.close();
    assert.equal(pool.getSnapshot().workers, 0);
  }
}

try {
  // The retained transport's SHARE_ENV carrier cannot inherit the launcher's
  // isolate-private cache owner. Both task transports need the owned base.
  const defaults = [];
  for (const retained of [false, true]) {
    defaults.push(await run(retained));
  }
  for (const [index, result] of defaults.entries()) {
    if (mode === "owned") {
      assert.ok(result.cache, "transport " + index + ": launcher cache base was not handed off");
      assert.ok(result.directory);
      assert.equal(
        path.dirname(result.directory),
        result.cache,
        "handoff must be a base, not a leaf",
      );
      assert.equal(path.basename(path.dirname(result.cache)), "2026.9.6");
      assert.equal(path.basename(path.dirname(path.dirname(result.cache))), "openclaw");
    } else {
      assert.equal(result.directory, null);
      assert.equal(result.cache, mode === "cache-empty" ? "" : null);
    }
    assert.equal(result.disable, process.env.NODE_DISABLE_COMPILE_CACHE ?? null);
  }
  assert.deepEqual(defaults[0], defaults[1]);

  if (mode === "owned") {
    for (const retained of [false, true]) {
      const explicit = { ...process.env, OPENCLAW_CACHE_FIXTURE_EXPLICIT: "caller" };
      const original = { ...explicit };
      // Prepared options override pool defaults before host cache selection.
      const result = await run(
        retained,
        { env: { ...process.env, NODE_COMPILE_CACHE: path.join(home, "unused") } },
        () => ({ options: { env: explicit } }),
      );
      assert.deepEqual(result, { directory: null, cache: null, disable: null, explicit: "caller" });
      assert.deepEqual(explicit, original, "caller env object must not be modified");

      const shared = await run(retained, { env: SHARE_ENV }, undefined, { sharedValue: "shared" });
      assert.equal(shared.directory, null, "literal SHARE_ENV must not be replaced");
      assert.equal(shared.cache, null);
      assert.equal(process.env.OPENCLAW_CACHE_FIXTURE_SHARED, "shared");
      delete process.env.OPENCLAW_CACHE_FIXTURE_SHARED;
    }
  }
  assert.deepEqual({ ...process.env }, before, "worker creation must not mutate parent env");
  assert.equal(getCompileCacheDir(), parentDirectory, "Gateway main must remain uncached");
  process.on("exit", () => assert.equal(getCompileCacheDir(), parentDirectory));
  process.stdout.write("worker-cache:verified");
} finally {
  await closeDefaultRetainedNativeWorkerSource();
}
