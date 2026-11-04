import assert from "node:assert/strict";
import fs from "node:fs";
import { constants, enableCompileCache, getCompileCacheDir } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { enableOpenClawCompileCache } from "../entry.compile-cache.js";
import { resolveNodeCompileCacheEnv } from "./node-compile-cache-env.js";
import { openSqliteWorkerStore, type SqliteWorkerStore } from "./sqlite-worker-store.js";

type CacheState = {
  directory: string | null;
  cache: string | null;
  disable: string | null;
  count: number;
};
type CacheOperations = {
  cacheEntries: { input: undefined; output: number };
  directory: { input: undefined; output: CacheState };
};

const [root, owner] = process.argv.slice(2);
assert.ok(root, "SQLite store compile-cache fixture requires its temporary directory");
assert.ok(owner === "openclaw" || owner === "foreign");
const installRoot = path.join(root, "installed");
fs.mkdirSync(installRoot);
fs.writeFileSync(path.join(installRoot, "package.json"), '{"version":"2026.9.6"}');
assert.equal(getCompileCacheDir(), undefined, "fixture must start without a native cache");
process.env.NODE_COMPILE_CACHE = path.join(root, "native-cache");
const initialEnv = { ...process.env };
if (owner === "foreign") {
  // Negative control: a direct Node enable is NOT OpenClaw ownership.
  const enabled = enableCompileCache(path.join(root, "foreign"));
  assert.equal(enabled.status, constants.compileCacheStatus.ENABLED);
}
enableOpenClawCompileCache({ currentFile: path.join(installRoot, "dist/entry.js"), installRoot });
assert.deepEqual({ ...process.env }, initialEnv, "enable must not mutate the environment");
delete process.env.NODE_COMPILE_CACHE;
const parentDirectory = getCompileCacheDir() ?? null;
const owned = owner === "openclaw";
assert.ok(parentDirectory);
const unconfigured: NodeJS.ProcessEnv = { FIXTURE_ONLY: "preserved" };
const handoff = resolveNodeCompileCacheEnv(unconfigured);
if (owned) {
  assert.ok(handoff.NODE_COMPILE_CACHE);
  assert.ok(path.isAbsolute(handoff.NODE_COMPILE_CACHE));
  assert.deepEqual(handoff, {
    FIXTURE_ONLY: "preserved",
    NODE_COMPILE_CACHE: handoff.NODE_COMPILE_CACHE,
  });
  assert.deepEqual(unconfigured, { FIXTURE_ONLY: "preserved" });
  // A later enable attempt must not replace the first owner's input.
  const otherRoot = path.join(root, "other-install");
  fs.mkdirSync(otherRoot);
  enableOpenClawCompileCache({
    currentFile: path.join(otherRoot, "dist", "entry.js"),
    installRoot: otherRoot,
  });
  assert.equal(resolveNodeCompileCacheEnv({}).NODE_COMPILE_CACHE, handoff.NODE_COMPILE_CACHE);
  assert.equal(getCompileCacheDir(), parentDirectory);
} else {
  assert.strictEqual(handoff, unconfigured, "foreign enable must not invent a base");
}
const callerEnv = { ...process.env };
const expectedDirectory = owned ? parentDirectory : null;
const directories = [];
for (let generation = 1; generation <= 2; generation++) {
  const store: SqliteWorkerStore<CacheOperations> = await openSqliteWorkerStore<CacheOperations>({
    moduleUrl: pathToFileURL(path.join(root, "backend.mjs")),
    databasePath: path.join(root, "store.sqlite"),
    input: undefined,
  });
  try {
    const startupEntries = await store.execute({ type: "cacheEntries", input: undefined });
    if (expectedDirectory) {
      assert.ok(startupEntries > 0, "startup bytecode must persist before worker retirement");
    } else {
      assert.equal(startupEntries, 0);
    }
    const result = await store.execute({ type: "directory", input: undefined });
    assert.deepEqual(result, {
      directory: expectedDirectory,
      cache: owned ? handoff.NODE_COMPILE_CACHE : null,
      disable: null,
      count: generation,
    });
    const preparedEntries = await store.execute({ type: "cacheEntries", input: undefined });
    if (expectedDirectory && generation === 1) {
      assert.ok(
        preparedEntries > startupEntries,
        "new operation bytecode must persist before worker retirement",
      );
    } else if (!expectedDirectory) {
      assert.equal(preparedEntries, 0);
    }
    directories.push(result.directory);
  } finally {
    await store.close();
  }
}
assert.deepEqual({ ...process.env }, callerEnv, "store handoff must not mutate caller env");
process.stdout.write(
  JSON.stringify({ node: process.versions.node, parentDirectory, directories, closed: 2 }),
);
