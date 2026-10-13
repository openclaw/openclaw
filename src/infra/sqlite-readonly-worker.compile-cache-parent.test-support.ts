import assert from "node:assert/strict";
import fs from "node:fs";
import { getCompileCacheDir } from "node:module";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import { enableOpenClawCompileCache } from "../entry.compile-cache.js";
import { prepareSqliteReadOnlyLocationSync } from "./sqlite-snapshot-source.js";

const [root] = process.argv.slice(2);
assert.ok(root, "SQLite compile-cache fixture requires its temporary directory");
const installRoot = path.join(root, "installed");
fs.mkdirSync(installRoot);
fs.writeFileSync(path.join(installRoot, "package.json"), '{"version":"2026.9.6"}');
assert.equal(getCompileCacheDir(), undefined);
const beforeEnable = { ...process.env };
enableOpenClawCompileCache({
  installRoot,
  env: { ...process.env, NODE_COMPILE_CACHE: path.join(root, "native-cache") },
});
assert.deepEqual({ ...process.env }, beforeEnable);
const activeDirectory = getCompileCacheDir();
assert.ok(activeDirectory);
const stagingRoot = path.join(root, "staging");
fs.mkdirSync(stagingRoot);
process.env.XDG_CACHE_HOME = stagingRoot;
// Observe the native child before its real entrypoint, without replacing its transport.
const probes = path.join(root, "probes");
fs.mkdirSync(probes);
const probe = path.join(root, "probe.mjs");
fs.writeFileSync(
  probe,
  `import fs from "node:fs";
   import path from "node:path";
   import { getCompileCacheDir } from "node:module";
   fs.writeFileSync(path.join(${JSON.stringify(probes)}, process.pid + ".json"), JSON.stringify({
     directory: getCompileCacheDir() ?? null,
     disable: process.env.NODE_DISABLE_COMPILE_CACHE ?? null,
   }));`,
);
process.env.NODE_OPTIONS = "--import=" + pathToFileURL(probe).href;
const callEnv = { ...process.env };
const source = path.join(root, "source.sqlite");
const database = new DatabaseSync(source);
try {
  database.exec("CREATE TABLE padding (data BLOB)");
  database.prepare("INSERT INTO padding VALUES (zeroblob(?))").run(0);
} finally {
  database.close();
}
const before = fs.readFileSync(source);
const prepared = prepareSqliteReadOnlyLocationSync(source);
try {
  assert.deepEqual(fs.readFileSync(prepared.location), before);
  const snapshot = new DatabaseSync(prepared.location, { readOnly: true });
  try {
    assert.deepEqual(
      snapshot
        .prepare("SELECT data FROM padding")
        .all()
        .map((row) => Object.entries(row)),
      [[["data", new Uint8Array(0)]]],
    );
    assert.equal(
      snapshot.prepare("SELECT sql FROM sqlite_schema WHERE name = 'padding'").get()?.sql,
      "CREATE TABLE padding (data BLOB)",
    );
    assert.equal(snapshot.prepare("PRAGMA user_version").get()?.user_version, 0);
    assert.equal(snapshot.prepare("PRAGMA integrity_check").get()?.integrity_check, "ok");
  } finally {
    snapshot.close();
  }
} finally {
  assert.equal(await prepared.cleanupAsync(), true);
}
assert.equal(fs.existsSync(prepared.location), false);
assert.deepEqual(fs.readFileSync(source), before);
assert.deepEqual(fs.readdirSync(path.join(stagingRoot, "openclaw")), []);
assert.deepEqual({ ...process.env }, callEnv);
const observed = fs
  .readdirSync(probes)
  .map((name): unknown => JSON.parse(fs.readFileSync(path.join(probes, name), "utf8")));
assert.ok(observed.length > 0, "real read-only children must execute");
for (const child of observed) {
  assert.ok(child && typeof child === "object" && "directory" in child && "disable" in child);
  assert.equal(child.disable, null);
  assert.equal(
    child.directory,
    activeDirectory,
    "readonly parent/child native directory must match exactly",
  );
}
assert.ok(
  fs
    .readdirSync(activeDirectory, { recursive: true, withFileTypes: true })
    .some((entry) => entry.isFile()),
);
process.stdout.write("readonly-cache:verified");
