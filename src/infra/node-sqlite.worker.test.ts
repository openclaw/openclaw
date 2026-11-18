import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { runNodeScript } from "../../test/helpers/run-node-script.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { sqliteDatabaseSealSchemaFor } from "../state/openclaw-database-seal-schema.js";
import { resolveRuntimeWorkerUrl } from "./runtime-worker-url.js";
import { writeSqliteCleanCloseSeal } from "./sqlite-clean-close-seal.js";
import { readDatabaseIdentityBirthtime } from "./sqlite-worker-identity.js";
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

const sealDirectories = useAutoCleanupTempDirTracker(afterEach);
it.for([
  ["valid", false],
  ["late-malformed", false],
  ["valid", true],
  ["late-malformed", true],
] as const)(
  "prepares a cold owned descriptor with a %s seal after runtime initialization (canceled retry: %s)",
  async ([mode, retry], { signal }) => {
    const location = path.join(sealDirectories.make("sqlite-owned-seal-"), "owner.sqlite");
    fs.writeFileSync(location, "", { mode: 0o600 });
    const file = fs.statSync(location, { bigint: true });
    const schema = sqliteDatabaseSealSchemaFor("other");
    expect(schema).toBeDefined();
    if (!schema) {
      throw new Error("The test runtime did not provide a seal identity");
    }
    const verifiedAt = Date.now();
    expect(
      writeSqliteCleanCloseSeal(location, schema.schemaIdentity, file, {
        verifiedAt,
        facts: JSON.stringify([
          ["sqlite.full-verification", false, verifiedAt],
          ["sqlite-schema", true, { tableSql: { sealType: "map", entries: [] } }],
        ]),
        identity: mode === "valid" ? schema.identity : { ...schema.identity, runtime: 0 },
      }),
    ).toBe(true);
    const expectedIdentity = {
      key: `file:${file.dev}:${file.ino}`,
      birthtime: readDatabaseIdentityBirthtime(file),
    };
    const admissionUrl = resolveRuntimeWorkerUrl(
      storageProcessTestEntrypoints.sqliteDatabaseAdmission,
    );
    const runtimeUrl = resolveRuntimeWorkerUrl(
      storageProcessTestEntrypoints.sqliteRuntimeInitialize,
    );
    const result = await runNodeScript(
      (workerArgv) => [
        ...workerArgv(admissionUrl).slice(0, -1),
        "--input-type=module",
        "-e",
        `
          import fs from "node:fs";
          import { syncBuiltinESMExports } from "node:module";
          import { DatabaseSync } from "node:sqlite";
          const admission = await import(${JSON.stringify(admissionUrl.href)});
          const { initializeSqliteRuntime } = await import(${JSON.stringify(runtimeUrl.href)});
          await initializeSqliteRuntime();
          const location = ${JSON.stringify(location)};
          const expectedIdentity = ${JSON.stringify(expectedIdentity)};
          const filesystem = {};
          let observing = false;
          let nativeProbes = 0;
          const prepare = DatabaseSync.prototype.prepare;
          DatabaseSync.prototype.prepare = function (sql) {
            if (observing && sql.includes("sqlite_version()")) nativeProbes++;
            return prepare.call(this, sql);
          };
          const originals = Object.getOwnPropertyDescriptors(fs);
          for (const [name, original] of Object.entries(fs)) {
            if (!name.endsWith("Sync") || typeof original !== "function") continue;
            const measured = (...args) => {
              if (observing) filesystem[name] = (filesystem[name] ?? 0) + 1;
              return Reflect.apply(original, fs, args);
            };
            Object.defineProperties(measured, Object.getOwnPropertyDescriptors(original));
            Object.defineProperty(fs, name, { ...originals[name], value: measured });
          }
          const native = fs.realpathSync.native;
          Object.defineProperty(fs.realpathSync, "native", {
            ...Object.getOwnPropertyDescriptor(fs.realpathSync, "native"),
            value: (...args) => {
              if (observing) filesystem["realpathSync.native"] = (filesystem["realpathSync.native"] ?? 0) + 1;
              return Reflect.apply(native, fs.realpathSync, args);
            },
          });
          syncBuiltinESMExports();
          let canceled = false;
          let unpublished;
          observing = true;
          try {
            if (${JSON.stringify(retry)}) {
              let entered;
              let resume;
              const reading = new Promise((resolve) => { entered = resolve; });
              const held = new Promise((resolve) => { resume = resolve; });
              const readFile = fs.promises.readFile;
              const refusal = new Error("original preparation retired");
              let live = true;
              const params = {
                location,
                expectedIdentity,
                assertCurrent() { if (!live) throw refusal; },
              };
              fs.promises.readFile = async function (...args) {
                const value = await Reflect.apply(readFile, this, args);
                if (args[0] === location + ".seal") {
                  entered();
                  await held;
                }
                return value;
              };
              try {
                const first = admission.prepareSqliteDatabaseAdmissionAsync(params).catch((error) => {
                  if (error !== refusal) throw error;
                  canceled = true;
                });
                await Promise.race([reading, first]);
                live = false;
                resume();
                await first;
                unpublished = admission.captureSqliteDatabaseAdmissions(undefined, { location }).length;
              } finally {
                resume();
                fs.promises.readFile = readFile;
              }
              live = true;
              await admission.prepareSqliteDatabaseAdmissionAsync(params);
            } else {
              await admission.prepareOwnedSqliteDatabaseAdmission({ location, expectedIdentity, assertCurrent() {} });
            }
          } finally {
            observing = false;
            Object.defineProperties(fs, originals);
            syncBuiltinESMExports();
          }
          const record = admission.captureSqliteDatabaseAdmissions(undefined, { location })[0];
          const accepted = record?.facts.has("sqlite.full-verification") ?? false;
          const refusal = record?.cleanCloseRefusal;
          admission.retireSqliteDatabaseAdmissionForPath(location);
          console.log(JSON.stringify({ filesystem, nativeProbes, accepted, refusal, canceled, unpublished }));
        `,
      ],
      { ...process.env, NODE_OPTIONS: "" },
      undefined,
      // Gateway startup admits the runtime before serving; descriptor and seal remain cold.
      { signal, executable: process.execPath },
    );
    expect(result.error, result.stderr).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    const observed = JSON.parse(result.stdout);
    expect(observed.canceled).toBe(retry);
    if (retry) {
      expect(observed.unpublished).toBe(0);
    }
    expect(observed.accepted).toBe(mode === "valid");
    if (mode === "late-malformed") {
      expect(observed.refusal).toBe("malformed-proof");
    }
    expect(observed.filesystem).toEqual({});
    expect(observed.nativeProbes).toBe(0);
  },
);
