import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { runNodeScript } from "../../test/helpers/run-node-script.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

// Each case owns a fresh native cache lifetime. Mocking the parent getter hides
// the base-versus-leaf contract that this actual SQLite worker boundary must keep.
describe("SQLite store worker compile cache", () => {
  it.each([
    { label: "owned programmatic cache", owner: "openclaw", cache: undefined, disable: undefined },
    { label: "explicit cache", owner: "openclaw", cache: "explicit", disable: undefined },
    { label: "empty explicit cache", owner: "openclaw", cache: "", disable: undefined },
    { label: "disabled cache", owner: "openclaw", cache: undefined, disable: "1" },
    { label: "zero disable policy", owner: "openclaw", cache: undefined, disable: "0" },
    { label: "empty disable policy", owner: "openclaw", cache: undefined, disable: "" },
    { label: "disabled explicit cache", owner: "openclaw", cache: "explicit", disable: "1" },
    { label: "unavailable cache", owner: "none", cache: undefined, disable: undefined },
    {
      label: "foreign ALREADY_ENABLED cache",
      owner: "foreign",
      cache: undefined,
      disable: undefined,
    },
    { label: "failed enable", owner: "failed", cache: undefined, disable: undefined },
    { label: "source checkout", owner: "source", cache: undefined, disable: undefined },
  ] as const)("preserves $label through worker retirement", async (testCase) => {
    const root = tempDirs.make("openclaw-sqlite-store-cache-");
    const modulePath = path.join(root, "backend.mjs");
    fs.writeFileSync(
      modulePath,
      `import { getCompileCacheDir } from "node:module";
       import { DatabaseSync } from "node:sqlite";
       export function createSqliteWorkerBackend(_input, context) {
         const database = new DatabaseSync(context.databasePath);
         database.exec("CREATE TABLE IF NOT EXISTS entries (value INTEGER)");
         return {
           execute() {
             database.prepare("INSERT INTO entries (value) VALUES (?)").run(7);
             return {
               directory: getCompileCacheDir() ?? null,
               cache: process.env.NODE_COMPILE_CACHE ?? null,
               disable: process.env.NODE_DISABLE_COMPILE_CACHE ?? null,
               count: database.prepare("SELECT COUNT(*) AS count FROM entries").get().count,
             };
           },
           close() { database.close(); }
         };
       }`,
    );
    const script = path.join(root, "parent.mjs");
    const entryUrl = pathToFileURL(path.resolve("src/entry.compile-cache.ts")).href;
    const envUrl = pathToFileURL(path.resolve("src/infra/node-compile-cache-env.ts")).href;
    const storeUrl = pathToFileURL(path.resolve("src/infra/sqlite-worker-store.ts")).href;
    fs.writeFileSync(
      script,
      `import assert from "node:assert/strict";
       import fs from "node:fs";
       import path from "node:path";
       import { constants, enableCompileCache, getCompileCacheDir } from "node:module";
       import { Worker } from "node:worker_threads";
       import { once } from "node:events";
       import { enableOpenClawCompileCache } from ${JSON.stringify(entryUrl)};
       import { resolveNodeCompileCacheEnv } from ${JSON.stringify(envUrl)};
       import { openSqliteWorkerStore } from ${JSON.stringify(storeUrl)};
       const root = ${JSON.stringify(root)};
       const testCase = ${JSON.stringify(testCase)};
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
         enableOpenClawCompileCache({ installRoot });
       }
       assert.deepEqual({ ...process.env }, initialEnv, "enable must not mutate the environment");
       const parentDirectory = getCompileCacheDir() ?? null;
       const owned = testCase.owner === "openclaw";
       assert.equal(parentDirectory !== null, owned || testCase.owner === "foreign");
       const unconfigured = { FIXTURE_ONLY: "preserved" };
       const handoff = resolveNodeCompileCacheEnv(unconfigured);
       if (owned) {
         assert.ok(path.isAbsolute(handoff.NODE_COMPILE_CACHE));
         assert.deepEqual(handoff, { FIXTURE_ONLY: "preserved", NODE_COMPILE_CACHE: handoff.NODE_COMPILE_CACHE });
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
       if (cache !== undefined) process.env.NODE_COMPILE_CACHE = cache;
       if (testCase.disable !== undefined) process.env.NODE_DISABLE_COMPILE_CACHE = testCase.disable;
       const callerEnv = { ...process.env };
       let expectedDirectory = owned && cache === undefined && testCase.disable === undefined
         ? parentDirectory : null;
       if (cache !== undefined && cache !== "" && testCase.disable === undefined) {
         // Obtain the opaque native leaf from an independent authored-env control,
         // never by guessing Node's version/UID suffix or using a prefix assertion.
         const control = new Worker(
           'const { parentPort } = require("node:worker_threads"); parentPort.postMessage(require("node:module").getCompileCacheDir() ?? null);',
           { eval: true, execArgv: [], env: { NODE_COMPILE_CACHE: cache } },
         );
         const exited = once(control, "exit");
         [expectedDirectory] = await once(control, "message");
         const [exitCode] = await exited;
         assert.equal(exitCode, 0);
         assert.ok(expectedDirectory);
       }
       const directories = [];
       for (let generation = 1; generation <= 2; generation++) {
         const store = await openSqliteWorkerStore({
           moduleUrl: new URL(${JSON.stringify(pathToFileURL(modulePath).href)}),
           databasePath: path.join(root, "store.sqlite"),
           input: undefined,
         });
         try {
           const result = await store.execute({ type: "directory", input: undefined });
           assert.equal(result.directory, expectedDirectory, "parent/worker native directory must match exactly");
           assert.equal(result.cache, cache ?? (owned && testCase.disable === undefined ? handoff.NODE_COMPILE_CACHE : null));
           assert.equal(result.disable, testCase.disable ?? null);
           assert.equal(result.count, generation, "SQLite must remain usable after close/reopen");
           directories.push(result.directory);
         } finally {
           await store.close();
         }
       }
       assert.deepEqual({ ...process.env }, callerEnv, "store handoff must not mutate caller env");
       if (expectedDirectory) {
         assert.ok(fs.readdirSync(expectedDirectory, { recursive: true, withFileTypes: true }).some((entry) => entry.isFile()),
           "native worker retirement must persist its compile cache without an explicit flush");
       }
       process.stdout.write(JSON.stringify({ node: process.versions.node, parentDirectory, directories, closed: 2 }));`,
    );
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      HOME: root,
      TMP: root,
      TEMP: root,
      TMPDIR: root,
    };
    delete env.NODE_COMPILE_CACHE;
    delete env.NODE_DISABLE_COMPILE_CACHE;
    delete env.NODE_OPTIONS;
    const result = await runNodeScript(
      ["--import", import.meta.resolve("tsx"), script],
      env,
      10_000,
      {
        requireProcessTreeExit: process.platform !== "win32",
        maxBuffer: 1024 * 1024,
      },
    );
    expect(result.error, result.stderr).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    const observed = JSON.parse(result.stdout);
    expect(observed.closed).toBe(2);
    expect(observed.directories).toHaveLength(2);
  });
});
