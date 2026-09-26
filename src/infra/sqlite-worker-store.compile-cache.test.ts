import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runNodeScript } from "../../test/helpers/run-node-script.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { resolveTestNodeExecPath } from "../test-utils/node-process.js";
import { resolveRuntimeWorkerArgv, resolveRuntimeWorkerUrl } from "./runtime-worker-url.js";
import { sqliteWorkerStoreCompileCacheParentEntrypoint } from "./sqlite-worker-store.compile-cache-runtime.test-support.js";

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
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      HOME: root,
    };
    delete env.NODE_COMPILE_CACHE;
    delete env.NODE_DISABLE_COMPILE_CACHE;
    delete env.NODE_OPTIONS;
    const result = await runNodeScript(
      [
        ...resolveRuntimeWorkerArgv(
          resolveRuntimeWorkerUrl(sqliteWorkerStoreCompileCacheParentEntrypoint),
          resolveTestNodeExecPath(),
        ),
        root,
        testCase.owner,
        testCase.cache ?? "unset",
        testCase.disable ?? "unset",
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
  });
});
