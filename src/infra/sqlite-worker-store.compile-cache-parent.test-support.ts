import assert from "node:assert/strict";
import { once } from "node:events";
import fs from "node:fs";
import { constants, enableCompileCache, getCompileCacheDir } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";
import { enableOpenClawCompileCache } from "../entry.compile-cache.js";
import { resolveNodeCompileCacheEnv } from "./node-compile-cache-env.js";
import { openSqliteWorkerStore, type SqliteWorkerStore } from "./sqlite-worker-store.js";

type CacheOperations = {
  directory: {
    input: undefined;
    output: {
      directory: string | null;
      cache: string | null;
      disable: string | null;
      count: number;
    };
  };
};

const [root, owner, cachePolicy, disablePolicy] = process.argv.slice(2);
assert.ok(root, "SQLite store compile-cache fixture requires its temporary directory");
assert.ok(
  owner === "openclaw" ||
    owner === "none" ||
    owner === "foreign" ||
    owner === "failed" ||
    owner === "source",
);
assert.ok(cachePolicy === "unset" || cachePolicy === "explicit" || cachePolicy === "");
assert.ok(
  disablePolicy === "unset" ||
    disablePolicy === "1" ||
    disablePolicy === "0" ||
    disablePolicy === "",
);
const testCase = {
  owner,
  cache: cachePolicy === "unset" ? undefined : cachePolicy,
  disable: disablePolicy === "unset" ? undefined : disablePolicy,
};
const installRoot = path.join(root, "installed");
fs.mkdirSync(installRoot);
fs.writeFileSync(path.join(installRoot, "package.json"), '{"version":"2026.9.6"}');
assert.equal(getCompileCacheDir(), undefined, "fixture must start without a native cache");
const initialEnv = { ...process.env };
if (testCase.owner === "source") {
  fs.writeFileSync(path.join(installRoot, ".git"), "gitdir: fixture");
}
if (testCase.owner === "foreign") {
  // Negative control: a direct Node enable is NOT OpenClaw ownership.
  const enabled = enableCompileCache(path.join(root, "foreign"));
  assert.equal(enabled.status, constants.compileCacheStatus.ENABLED);
}
if (testCase.owner === "failed") {
  const blocked = path.join(root, "not-a-directory");
  fs.writeFileSync(blocked, "fixture");
  enableOpenClawCompileCache({ installRoot, env: { NODE_COMPILE_CACHE: blocked } });
} else if (testCase.owner !== "none") {
  // Positive control goes through the real OpenClaw entry enable owner.
  enableOpenClawCompileCache({
    installRoot,
    env: { ...process.env, NODE_COMPILE_CACHE: path.join(root, "native-cache") },
  });
}
assert.deepEqual({ ...process.env }, initialEnv, "enable must not mutate the environment");
const parentDirectory = getCompileCacheDir() ?? null;
const owned = testCase.owner === "openclaw";
assert.equal(parentDirectory !== null, owned || testCase.owner === "foreign");
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
  enableOpenClawCompileCache({ installRoot: otherRoot });
  assert.equal(resolveNodeCompileCacheEnv({}).NODE_COMPILE_CACHE, handoff.NODE_COMPILE_CACHE);
  assert.equal(getCompileCacheDir(), parentDirectory);
} else {
  assert.strictEqual(handoff, unconfigured, "unknown or failed enable must not invent a base");
}
const cache = testCase.cache === "explicit" ? path.join(root, "explicit") : testCase.cache;
// Mutate only this disposable test process to exercise caller overrides
// after a known owner exists; production owners must never do this.
if (cache !== undefined) {
  process.env.NODE_COMPILE_CACHE = cache;
}
if (testCase.disable !== undefined) {
  process.env.NODE_DISABLE_COMPILE_CACHE = testCase.disable;
}
const callerEnv = { ...process.env };
let expectedDirectory =
  owned && cache === undefined && testCase.disable === undefined ? parentDirectory : null;
if (cache !== undefined && cache !== "" && testCase.disable === undefined) {
  // Obtain the opaque native leaf from an independent authored-env control,
  // never by guessing Node's version/UID suffix or using a prefix assertion.
  const control = new Worker(
    'const { parentPort } = require("node:worker_threads"); parentPort.postMessage(require("node:module").getCompileCacheDir() ?? null);',
    { eval: true, execArgv: [], env: { NODE_COMPILE_CACHE: cache } },
  );
  const exited = once(control, "exit");
  const [directory]: unknown[] = await once(control, "message");
  const [exitCode] = await exited;
  assert.equal(exitCode, 0);
  assert.ok(typeof directory === "string" && directory.length > 0);
  expectedDirectory = directory;
}
const directories = [];
for (let generation = 1; generation <= 2; generation++) {
  const store: SqliteWorkerStore<CacheOperations> = await openSqliteWorkerStore<CacheOperations>({
    moduleUrl: pathToFileURL(path.join(root, "backend.mjs")),
    databasePath: path.join(root, "store.sqlite"),
    input: undefined,
  });
  try {
    const result: CacheOperations["directory"]["output"] = await store.execute({
      type: "directory",
      input: undefined,
    });
    assert.equal(
      result.directory,
      expectedDirectory,
      "parent/worker native directory must match exactly",
    );
    assert.equal(
      result.cache,
      cache ?? (owned && testCase.disable === undefined ? handoff.NODE_COMPILE_CACHE : null),
    );
    assert.equal(result.disable, testCase.disable ?? null);
    assert.equal(result.count, generation, "SQLite must remain usable after close/reopen");
    directories.push(result.directory);
  } finally {
    await store.close();
  }
}
assert.deepEqual({ ...process.env }, callerEnv, "store handoff must not mutate caller env");
if (expectedDirectory) {
  assert.ok(
    fs
      .readdirSync(expectedDirectory, { recursive: true, withFileTypes: true })
      .some((entry) => entry.isFile()),
    "native worker retirement must persist its compile cache without an explicit flush",
  );
}
process.stdout.write(
  JSON.stringify({ node: process.versions.node, parentDirectory, directories, closed: 2 }),
);
