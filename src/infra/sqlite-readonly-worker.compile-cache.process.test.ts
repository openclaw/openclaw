import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { runNodeScript } from "../../test/helpers/run-node-script.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

describe.each(["sync", "async", "scoped"] as const)("SQLite child compile cache (%s)", (mode) => {
  it.each([
    { label: "active programmatic cache", active: true, cache: undefined, disable: undefined },
    { label: "explicit cache", active: true, cache: "explicit", disable: undefined },
    { label: "empty explicit cache", active: true, cache: "", disable: undefined },
    { label: "disabled cache", active: true, cache: undefined, disable: "1" },
    { label: "empty disable policy", active: true, cache: undefined, disable: "" },
    { label: "unavailable cache", active: false, cache: undefined, disable: undefined },
  ] as const)("preserves $label through the real worker", async (testCase) => {
    const root = tempDirs.make("openclaw-sqlite-child-cache-");
    const script = path.join(root, "parent.mjs");
    const ownerUrl = pathToFileURL(path.resolve("src/entry.compile-cache.ts")).href;
    const snapshotUrl = pathToFileURL(path.resolve("src/infra/sqlite-snapshot-source.ts")).href;
    const workerUrl = pathToFileURL(path.resolve("src/infra/sqlite-readonly-worker.ts")).href;
    fs.writeFileSync(
      script,
      `import assert from "node:assert/strict";
       import fs from "node:fs";
       import path from "node:path";
       import { pathToFileURL } from "node:url";
       import { getCompileCacheDir } from "node:module";
       import { DatabaseSync } from "node:sqlite";
       import { enableOpenClawCompileCache } from ${JSON.stringify(ownerUrl)};
       import { prepareSqliteReadOnlyLocation, prepareSqliteReadOnlyLocationSync } from ${JSON.stringify(snapshotUrl)};
       import { withSqliteReadOnlyWorkerScope } from ${JSON.stringify(workerUrl)};
       const root = ${JSON.stringify(root)};
       const mode = ${JSON.stringify(mode)};
       const testCase = ${JSON.stringify(testCase)};
       const installRoot = path.join(root, "installed");
       fs.mkdirSync(installRoot);
       fs.writeFileSync(path.join(installRoot, "package.json"), '{"version":"2026.9.6"}');
       assert.equal(getCompileCacheDir(), undefined);
       const beforeEnable = { ...process.env };
       if (testCase.active) enableOpenClawCompileCache({ installRoot });
       assert.deepEqual({ ...process.env }, beforeEnable);
       const activeDirectory = getCompileCacheDir();
       assert.equal(Boolean(activeDirectory), testCase.active);
       const explicitDirectory = path.join(root, "explicit");
       fs.mkdirSync(explicitDirectory);
       const inheritedCache = testCase.cache === "explicit" ? explicitDirectory : testCase.cache;
       if (inheritedCache !== undefined) process.env.NODE_COMPILE_CACHE = inheritedCache;
       if (testCase.disable !== undefined) process.env.NODE_DISABLE_COMPILE_CACHE = testCase.disable;
       const stagingRoot = path.join(root, "staging");
       fs.mkdirSync(stagingRoot);
       process.env.XDG_CACHE_HOME = stagingRoot;
       // Observe the native child before its real entrypoint, without replacing its transport.
       const probes = path.join(root, "probes");
       fs.mkdirSync(probes);
       const probe = path.join(root, "probe.mjs");
       fs.writeFileSync(probe, 'import fs from "node:fs"; import path from "node:path"; import { getCompileCacheDir } from "node:module"; fs.writeFileSync(path.join(' + JSON.stringify(probes) + ', process.pid + ".json"), JSON.stringify({ directory: getCompileCacheDir() ?? null, cache: process.env.NODE_COMPILE_CACHE ?? null, disable: process.env.NODE_DISABLE_COMPILE_CACHE ?? null }));');
       process.env.NODE_OPTIONS = "--import=" + pathToFileURL(probe).href;
       const callEnv = { ...process.env };
       const source = path.join(root, "source.sqlite");
       const database = new DatabaseSync(source);
       try {
         database.exec("CREATE TABLE padding (data BLOB)");
         database.prepare("INSERT INTO padding VALUES (zeroblob(?))").run(0);
       } finally { database.close(); }
       const before = fs.readFileSync(source);
       const prepared = mode === "sync"
         ? prepareSqliteReadOnlyLocationSync(source)
         : mode === "scoped"
           ? await withSqliteReadOnlyWorkerScope(() => prepareSqliteReadOnlyLocation(source, { preserveSourceArtifacts: true }))
           : await prepareSqliteReadOnlyLocation(source);
       try {
         if (mode === "sync") assert.deepEqual(fs.readFileSync(prepared.location), before);
         const snapshot = new DatabaseSync(prepared.location, { readOnly: true });
         try {
           assert.deepEqual(snapshot.prepare("SELECT data FROM padding").all().map(row => ({ ...row })), [{ data: new Uint8Array(0) }]);
           assert.equal(snapshot.prepare("SELECT sql FROM sqlite_schema WHERE name = 'padding'").get().sql, "CREATE TABLE padding (data BLOB)");
           assert.equal(snapshot.prepare("PRAGMA user_version").get().user_version, 0);
           assert.equal(snapshot.prepare("PRAGMA integrity_check").get().integrity_check, "ok");
         } finally { snapshot.close(); }
       } finally { assert.equal(await prepared.cleanupAsync(), true); }
       assert.equal(fs.existsSync(prepared.location), false);
       assert.deepEqual(fs.readFileSync(source), before);
       assert.deepEqual(fs.readdirSync(path.join(stagingRoot, "openclaw")), []);
       assert.deepEqual({ ...process.env }, callEnv);
       const observed = fs.readdirSync(probes).map(name => JSON.parse(fs.readFileSync(path.join(probes, name), "utf8")));
       assert.ok(observed.length > 0, "real read-only children must execute");
       for (const child of observed) {
         assert.equal(child.disable, testCase.disable ?? null);
         if (testCase.active && inheritedCache === undefined && testCase.disable === undefined) {
           assert.equal(child.directory, activeDirectory, "readonly parent/child native directory must match exactly");
         } else if (testCase.cache === "explicit") {
           assert.equal(child.cache, explicitDirectory);
           assert.ok(child.directory);
         } else { assert.equal(child.directory, null); }
       }
       const hasCacheFiles = directory => Boolean(directory) && fs.readdirSync(directory, { recursive: true, withFileTypes: true }).some(entry => entry.isFile());
       assert.equal(hasCacheFiles(activeDirectory), testCase.active && inheritedCache === undefined && testCase.disable === undefined);
       assert.equal(hasCacheFiles(explicitDirectory), testCase.cache === "explicit");
       process.stdout.write("readonly-cache:verified");`,
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
      { requireProcessTreeExit: process.platform !== "win32", maxBuffer: 1024 * 1024 },
    );
    expect(result.error, result.stderr).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe("readonly-cache:verified");
  });
});
