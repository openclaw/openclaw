import fs from "node:fs";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { getEnvironmentData, setEnvironmentData } from "node:worker_threads";

const key = "openclaw.test.readinessNativeReads";
const { entry, source, counts: buffer } = getEnvironmentData(key);
setEnvironmentData(key, undefined);
const counts = new Int32Array(buffer);
if (process.versions.bun) {
  const { ensureSqliteLibrarySelected } = await import("../../infra/bun-sqlite-library.ts");
  ensureSqliteLibrarySelected();
}
const sqlite = createRequire(import.meta.url)("node:sqlite");
// Call through at the native I/O boundary; qualification and SQL remain production-owned.
sqlite.DatabaseSync = new Proxy(sqlite.DatabaseSync, {
  construct(target, args, newTarget) {
    const database = Reflect.construct(target, args, newTarget);
    Atomics.add(counts, 0, 1);
    if (database.location() === source) {
      Atomics.add(counts, 1, 1);
    }
    return database;
  },
});
const stat = fs.statSync;
fs.statSync = function (...args) {
  if (args[0] === source) {
    Atomics.add(counts, 2, 1);
  }
  return Reflect.apply(stat, fs, args);
};
const realpath = fs.realpathSync.native;
fs.realpathSync.native = function (...args) {
  if (args[0] === source) {
    Atomics.add(counts, 3, 1);
  }
  return Reflect.apply(realpath, fs.realpathSync, args);
};
syncBuiltinESMExports();
await import(entry);
