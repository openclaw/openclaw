import { expect, it } from "vitest";
import { runNodeScript } from "../../test/helpers/run-node-script.js";
import { resolveRuntimeWorkerUrl } from "./runtime-worker-url.js";
import { storageProcessTestEntrypoints } from "./storage-process-runtime.test-support.js";

it("admits the loaded SQLite library once before sibling workers open databases", async ({
  signal,
}) => {
  const sqliteUrl = resolveRuntimeWorkerUrl(storageProcessTestEntrypoints.nodeSqlite);
  const runtimeUrl = resolveRuntimeWorkerUrl(storageProcessTestEntrypoints.sqliteRuntimeInitialize);
  const workerSource = `
    const { parentPort } = require("node:worker_threads");
    const { DatabaseSync } = require("node:sqlite");
    let probes = 0;
    const prepare = DatabaseSync.prototype.prepare;
    DatabaseSync.prototype.prepare = function (sql) {
      if (sql.includes("sqlite_version()")) probes++;
      return prepare.call(this, sql);
    };
    import(${JSON.stringify(sqliteUrl.href)}).then(({ openNodeSqliteDatabase }) => {
      const db = openNodeSqliteDatabase(":memory:");
      const row = db.prepare("SELECT 42 AS value").get();
      db.close();
      parentPort.postMessage({ probes, value: row.value });
    });
  `;
  const result = await runNodeScript(
    (workerArgv) => [
      ...workerArgv(runtimeUrl).slice(0, -1),
      "--input-type=module",
      "-e",
      `
        import { once } from "node:events";
        import { DatabaseSync } from "node:sqlite";
        import { Worker } from "node:worker_threads";
        let probes = 0;
        const prepare = DatabaseSync.prototype.prepare;
        DatabaseSync.prototype.prepare = function (sql) {
          if (sql.includes("sqlite_version()")) probes++;
          return prepare.call(this, sql);
        };
        const { initializeSqliteRuntime } = await import(${JSON.stringify(runtimeUrl.href)});
        await initializeSqliteRuntime();
        const workers = [0, 1].map(() => new Worker(${JSON.stringify(workerSource)}, {
          eval: true, execArgv: ${JSON.stringify(workerArgv(sqliteUrl).slice(0, -1))},
        }));
        const rows = await Promise.all(workers.map(async (worker) => {
          const exited = once(worker, "exit");
          const [row] = await once(worker, "message");
          await exited;
          return row;
        }));
        console.log(JSON.stringify({ probes, rows }));
      `,
    ],
    { ...process.env, NODE_OPTIONS: "" },
    undefined,
    { signal },
  );
  expect(result.error, result.stderr).toBeUndefined();
  expect(result.status, result.stderr).toBe(0);
  expect(JSON.parse(result.stdout)).toEqual({
    probes: 1,
    rows: [
      { probes: 0, value: 42 },
      { probes: 0, value: 42 },
    ],
  });
});
