import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runNodeScript } from "../../test/helpers/run-node-script.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { resolveRuntimeWorkerUrl } from "./runtime-worker-url.js";
import { sqliteWorkerStoreCompileCacheParentEntrypoint } from "./sqlite-worker-store.compile-cache-runtime.test-support.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

// Each case owns a fresh native cache lifetime. Mocking the parent getter hides
// the base-versus-leaf contract that this actual SQLite worker boundary must keep.
describe("SQLite store worker compile cache", () => {
  it.each([
    { label: "owned programmatic cache", owner: "openclaw" },
    { label: "foreign ALREADY_ENABLED cache", owner: "foreign" },
  ] as const)(
    "preserves $label and drains enabled bytecode before retirement",
    async (testCase) => {
      const root = tempDirs.make("openclaw-sqlite-store-cache-");
      const modulePath = path.join(root, "backend.mjs");
      fs.writeFileSync(path.join(root, "lazy.mjs"), "export const value = 7;\n");
      fs.writeFileSync(
        modulePath,
        `import { readdirSync } from "node:fs";
       import { getCompileCacheDir } from "node:module";
       import { DatabaseSync } from "node:sqlite";
       import { setImmediate as nextTurn } from "node:timers/promises";
       let lazy;
       export function createSqliteWorkerBackend(_input, context) {
         const database = new DatabaseSync(context.databasePath);
         database.exec("CREATE TABLE IF NOT EXISTS entries (value INTEGER)");
         return {
           [Symbol.for("openclaw.sqliteWorkerPrepareCommand")](type) {
             if (type === "directory" && !lazy) {
               return import("./lazy.mjs").then((loaded) => { lazy = loaded; });
             }
           },
           async prepare(command) {
             if (command.type === "cacheEntries") {
               await nextTurn();
             }
           },
           execute(command) {
             if (command.type === "cacheEntries") {
               const directory = getCompileCacheDir();
               return directory
                 ? readdirSync(directory, { withFileTypes: true }).filter((entry) => entry.isFile()).length
                 : 0;
             }
             database.prepare("INSERT INTO entries (value) VALUES (?)").run(lazy.value);
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
      const env: NodeJS.ProcessEnv = {
        ...process.env,
        HOME: root,
      };
      delete env.NODE_COMPILE_CACHE;
      delete env.NODE_DISABLE_COMPILE_CACHE;
      delete env.NODE_OPTIONS;
      const result = await runNodeScript(
        (workerArgv) => [
          ...workerArgv(resolveRuntimeWorkerUrl(sqliteWorkerStoreCompileCacheParentEntrypoint)),
          root,
          testCase.owner,
          "unset",
          "unset",
        ],
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
    },
  );
});
