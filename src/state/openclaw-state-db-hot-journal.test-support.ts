import { spawn } from "node:child_process";
import { withinTest } from "../../test/helpers/promise.js";
import { resolveRuntimeWorkerArgv } from "../infra/runtime-worker-url.js";

/** The generated owner reaps its children before the outer native close can settle. */
async function runStateDatabaseProcessProbe(params: {
  moduleUrl: string;
  source: string;
  signal: AbortSignal;
  verifyCleanup: (cleanup: () => Promise<void>) => Promise<void>;
}): Promise<string> {
  params.signal.throwIfAborted();
  const source = `
    const probeAbort = new AbortController();
    const probeStopped = new Promise((_, reject) => {
      const stop = () => {
        const error = new Error("State database probe canceled");
        probeAbort.abort(error);
        reject(error);
      };
      process.once("message", stop);
      process.once("disconnect", stop);
    });
    void probeStopped.catch(() => {});
    ${params.source}
    process.disconnect();
  `;
  const child = spawn(
    process.execPath,
    [
      ...resolveRuntimeWorkerArgv(new URL(params.moduleUrl)).slice(0, -1),
      "--input-type=module",
      "-e",
      source,
    ],
    { stdio: ["ignore", "pipe", "pipe", "ipc"] },
  );
  let stdout = "";
  let stderr = "";
  let launchError: Error | undefined;
  child.once("error", (error) => {
    launchError = error;
  });
  const closed = new Promise<number | null>((resolve) => {
    child.once("close", (code) => resolve(code));
  });
  try {
    const output = child.stdout;
    const errors = child.stderr;
    if (!output || !errors) {
      throw new Error("State database probe requires piped stdout and stderr");
    }
    output.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    errors.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    const code = await withinTest(closed, params.signal);
    if (launchError) {
      throw launchError;
    }
    if (code !== 0) {
      throw new Error(`State database probe exited with ${child.signalCode ?? code}: ${stderr}`);
    }
    return stdout;
  } finally {
    await params.verifyCleanup(async () => {
      if (child.connected) {
        child.send("stop", () => {});
      }
      await closed;
    });
  }
}

export async function runHotRollbackJournalRecoveryProbe(params: {
  moduleUrl: string;
  rootDir: string;
  signal: AbortSignal;
  verifyCleanup: (cleanup: () => Promise<void>) => Promise<void>;
}): Promise<{
  committedRowsAfterRecovery: number;
  immutableDirtyRowsBeforeKill: number;
  integrity: string;
  journalBytesBeforeReadOnly: number;
  journalExistsAfterReadOnly: boolean;
  journalExistsAfterRecovery: boolean;
  journalShaAfterReadOnly: string;
  journalShaBeforeReadOnly: string;
  readOnly: {
    error: string | null;
    opened: boolean;
    uncommittedRows: number | null;
  };
}> {
  const probeSource = `
    import { spawn } from "node:child_process";
    import { once } from "node:events";
    import { createHash } from "node:crypto";
    import fs from "node:fs";
    import path from "node:path";
    import { DatabaseSync } from "node:sqlite";
    import { pathToFileURL } from "node:url";

    const moduleUrl = ${JSON.stringify(params.moduleUrl)};
    const databasePath = path.join(${JSON.stringify(params.rootDir)}, "hot-journal.sqlite");
    const rowCount = 256;
    const {
      closeOpenClawStateDatabaseForTest,
      openExistingOpenClawStateDatabaseReadOnly,
      openOpenClawStateDatabase,
    } = await import(moduleUrl);

    const initial = openOpenClawStateDatabase({ path: databasePath });
    initial.db.exec(\`
      CREATE TABLE hot_journal_probe (
        id INTEGER PRIMARY KEY,
        value TEXT NOT NULL,
        payload BLOB NOT NULL
      );
      WITH RECURSIVE rows(id) AS (
        SELECT 1
        UNION ALL
        SELECT id + 1 FROM rows WHERE id < \${rowCount}
      )
      INSERT INTO hot_journal_probe (id, value, payload)
      SELECT id, 'committed', zeroblob(8192) FROM rows;
    \`);
    closeOpenClawStateDatabaseForTest();

    const rollbackMode = new DatabaseSync(databasePath);
    rollbackMode.exec("PRAGMA journal_mode = DELETE;");
    rollbackMode.close();

    const writerSource = \`
      import { DatabaseSync } from "node:sqlite";

      const database = new DatabaseSync(process.env.OPENCLAW_HOT_JOURNAL_DATABASE_PATH);
      database.exec(
        "PRAGMA journal_mode = DELETE; " +
        "PRAGMA synchronous = FULL; " +
        "PRAGMA cache_size = 2; " +
        "PRAGMA cache_spill = ON; " +
        "BEGIN IMMEDIATE; " +
        "UPDATE hot_journal_probe SET value = 'uncommitted';",
      );
      process.send("ready");
      // Keep the transaction-owning connection live until the parent kills this process.
      setInterval(() => {
        void database.isOpen;
      }, 1_000);
    \`;
    probeAbort.signal.throwIfAborted();
    const writer = spawn(
      process.execPath,
      ["--input-type=module", "-e", writerSource],
      {
        env: {
          ...process.env,
          OPENCLAW_HOT_JOURNAL_DATABASE_PATH: databasePath,
        },
        stdio: ["ignore", "ignore", "pipe", "ipc"],
      },
    );
    const writerReady = once(writer, "message");
    let writerStderr = "";
    writer.stderr.on("data", (chunk) => {
      writerStderr += chunk;
    });
    const writerClosed = new Promise((resolve) => {
      writer.once("close", (code, signal) => resolve({ code, signal }));
    });

    try {
      const [ready] = await Promise.race([
        writerReady,
        writerClosed.then(() => {
          throw new Error(\`writer exited before creating a hot journal: \${writerStderr}\`);
        }),
        probeStopped,
      ]);
      if (ready !== "ready") {
        throw new Error("hot rollback journal writer sent an invalid ready receipt");
      }
      const journalPath = \`\${databasePath}-journal\`;
      if (!fs.existsSync(journalPath) || fs.statSync(journalPath).size === 0) {
        throw new Error("writer did not leave a rollback journal");
      }
      const immutable = new DatabaseSync(
        \`\${pathToFileURL(databasePath).href}?mode=ro&immutable=1\`,
        { readOnly: true },
      );
      const immutableDirty = immutable
        .prepare("SELECT COUNT(*) AS count FROM hot_journal_probe WHERE value = 'uncommitted'")
        .get();
      immutable.close();
      const immutableDirtyRowsBeforeKill = Number(immutableDirty?.count ?? 0);
      if (immutableDirtyRowsBeforeKill === 0) {
        throw new Error("writer did not spill uncommitted pages into the main database");
      }
      writer.kill("SIGKILL");
      // Cancellation must reach final cleanup if the primary kill did not close the writer.
      const outcome = await Promise.race([writerClosed, probeStopped]);
      if (outcome.signal !== "SIGKILL") {
        throw new Error(\`writer was not killed: \${JSON.stringify(outcome)} \${writerStderr}\`);
      }

      const hashJournal = () =>
        createHash("sha256").update(fs.readFileSync(journalPath)).digest("hex");
      const journalBytesBeforeReadOnly = fs.statSync(journalPath).size;
      const journalShaBeforeReadOnly = hashJournal();
      let readOnly;
      try {
        const database = await openExistingOpenClawStateDatabaseReadOnly({ path: databasePath });
        const readOnlyRow = database?.db
          .prepare("SELECT COUNT(*) AS count FROM hot_journal_probe WHERE value = 'uncommitted'")
          .get();
        database?.walMaintenance.close();
        readOnly = {
          error: null,
          opened: true,
          uncommittedRows: Number(readOnlyRow?.count ?? 0),
        };
      } catch (error) {
        readOnly = {
          error: error instanceof Error ? error.message : String(error),
          opened: false,
          uncommittedRows: null,
        };
      }
      const journalExistsAfterReadOnly = fs.existsSync(journalPath);
      const journalShaAfterReadOnly = hashJournal();
      const reopened = openOpenClawStateDatabase({ path: databasePath });
      const row = reopened.db
        .prepare("SELECT COUNT(*) AS count FROM hot_journal_probe WHERE value = 'committed'")
        .get();
      const integrity = reopened.db.prepare("PRAGMA integrity_check").get();
      closeOpenClawStateDatabaseForTest();
      console.log(JSON.stringify({
        committedRowsAfterRecovery: Number(row?.count ?? 0),
        immutableDirtyRowsBeforeKill,
        integrity: integrity?.integrity_check,
        journalBytesBeforeReadOnly,
        journalExistsAfterReadOnly,
        journalExistsAfterRecovery: fs.existsSync(journalPath),
        journalShaAfterReadOnly,
        journalShaBeforeReadOnly,
        readOnly,
      }));
    } finally {
      if (writer.exitCode === null && writer.signalCode === null) {
        writer.kill("SIGKILL");
      }
      await writerClosed;
      closeOpenClawStateDatabaseForTest();
    }
  `;
  const output = await runStateDatabaseProcessProbe({
    moduleUrl: params.moduleUrl,
    source: probeSource,
    signal: params.signal,
    verifyCleanup: params.verifyCleanup,
  });
  const resultLine = output.trim().split("\n").at(-1);
  if (!resultLine) {
    throw new Error("hot rollback journal recovery probe produced no result");
  }
  return JSON.parse(resultLine) as {
    committedRowsAfterRecovery: number;
    immutableDirtyRowsBeforeKill: number;
    integrity: string;
    journalBytesBeforeReadOnly: number;
    journalExistsAfterReadOnly: boolean;
    journalExistsAfterRecovery: boolean;
    journalShaAfterReadOnly: string;
    journalShaBeforeReadOnly: string;
    readOnly: {
      error: string | null;
      opened: boolean;
      uncommittedRows: number | null;
    };
  };
}

export async function runConcurrentSchemaProbe(params: {
  mode: "fresh" | "upgrade";
  moduleUrl: string;
  rootDir: string;
  signal: AbortSignal;
  verifyCleanup: (cleanup: () => Promise<void>) => Promise<void>;
}): Promise<string[]> {
  const workerSource = `
    import { once } from "node:events";

    const {
      closeOpenClawStateDatabaseForTest,
      openOpenClawStateDatabase,
    } = await import(process.env.OPENCLAW_SCHEMA_TEST_MODULE_URL);
    const databasePath = process.env.OPENCLAW_SCHEMA_TEST_DATABASE_PATH;
    const started = once(process, "message");
    process.send("ready");
    const [start] = await started;
    if (start !== "start") throw new Error("schema probe received an invalid start");
    process.send("entering");
    try {
      const database = openOpenClawStateDatabase({ path: databasePath });
      const integrity = database.db.prepare("PRAGMA integrity_check").get();
      if (integrity?.integrity_check !== "ok") {
        throw new Error("state database integrity check failed");
      }
      const retired = once(process, "message");
      process.send("opened");
      const [retire] = await retired;
      if (retire !== "retire") throw new Error("schema probe received an invalid retirement");
    } catch (error) {
      try {
        closeOpenClawStateDatabaseForTest();
      } catch (cleanupError) {
        throw new AggregateError([error, cleanupError], "schema probe and worker cleanup failed");
      }
      throw error;
    }
    closeOpenClawStateDatabaseForTest();
    process.disconnect();
  `;
  const orchestratorSource = `
    import assert from "node:assert/strict";
    import { spawn } from "node:child_process";
    import path from "node:path";
    import { DatabaseSync } from "node:sqlite";

    const moduleUrl = ${JSON.stringify(params.moduleUrl)};
    const rootDir = ${JSON.stringify(params.rootDir)};
    const mode = ${JSON.stringify(params.mode)};
    const workerSource = ${JSON.stringify(workerSource)};
    const workerExecArgv = ${JSON.stringify(resolveRuntimeWorkerArgv(new URL(params.moduleUrl)).slice(0, -1))};
    const workerCount = 2;
    const roundCount = 1;
    const databasePaths = [];

    function observeChild(child) {
      const entered = {};
      const events = Object.fromEntries(["ready", "entering", "opened"].map((name) => [
        name,
        new Promise((resolve) => { entered[name] = resolve; }),
      ]));
      child.on("message", (name) => entered[name]?.());
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk) => {
        stdout += chunk;
      });
      child.stderr.on("data", (chunk) => {
        stderr += chunk;
      });
      const outcome = new Promise((resolve) => {
        let error;
        child.once("error", (failure) => { error = String(failure); });
        child.once("close", (code, signal) => resolve({ code, signal, error, stderr, stdout }));
      });
      return { events, outcome };
    }

    async function waitForEvents(observers, event, label, round) {
      await Promise.all(observers.map(({ events, outcome }, index) => Promise.race([
        events[event],
        outcome.then(() => {
          throw new Error(\`round \${round} worker \${index} exited before \${label}\`);
        }),
        probeStopped,
      ])));
    }

    for (let round = 0; round < roundCount; round += 1) {
      const databasePath = path.join(rootDir, \`concurrent-\${mode}-\${round}.sqlite\`);

      if (mode === "upgrade") {
        const {
          closeOpenClawStateDatabaseForTest,
          openOpenClawStateDatabase,
        } = await import(moduleUrl);
        openOpenClawStateDatabase({ path: databasePath });
        closeOpenClawStateDatabaseForTest();

        const legacy = new DatabaseSync(databasePath);
        legacy.exec(\`
          DROP TABLE worker_environment_credentials;
          ALTER TABLE gateway_boot_lifecycle DROP COLUMN startup_reason;
          ALTER TABLE official_external_plugin_catalog_snapshots DROP COLUMN trust_mode;
          ALTER TABLE official_external_plugin_catalog_snapshots DROP COLUMN trust_key_id;
          ALTER TABLE official_external_plugin_catalog_snapshots DROP COLUMN trust_signature_count;
          ALTER TABLE official_external_plugin_catalog_snapshots DROP COLUMN trust_threshold;
          ALTER TABLE official_external_plugin_catalog_snapshots DROP COLUMN trust_verified_at;
          ALTER TABLE worker_environments DROP COLUMN bootstrap_bundle_hash;
          ALTER TABLE worker_environments DROP COLUMN bootstrap_openclaw_version;
          ALTER TABLE worker_environments DROP COLUMN bootstrap_protocol_features_json;
          ALTER TABLE worker_environments DROP COLUMN bootstrap_install_kind;
          ALTER TABLE worker_environments DROP COLUMN owner_epoch;
          ALTER TABLE worker_environments DROP COLUMN teardown_terminal_state;
          ALTER TABLE worker_environments DROP COLUMN ssh_host_key;
          DROP INDEX idx_worker_session_placements_environment; PRAGMA user_version = 1;
          UPDATE schema_meta
             SET schema_version = 1,
                 updated_at = 1
           WHERE meta_key = 'primary';
        \`);
        legacy.close();
      }

      probeAbort.signal.throwIfAborted();
      const workers = Array.from({ length: workerCount }, () => {
        return spawn(
          process.execPath,
          [...workerExecArgv, "--input-type=module", "-e", workerSource],
          {
            env: {
              ...process.env,
              OPENCLAW_SCHEMA_TEST_DATABASE_PATH: databasePath,
              OPENCLAW_SCHEMA_TEST_MODULE_URL: moduleUrl,
            },
            stdio: ["ignore", "pipe", "pipe", "ipc"],
          },
        );
      });
      const observers = workers.map(observeChild);
      const outcomes = observers.map(({ outcome }) => outcome);
      let roundError;
      let results;
      try {
        await waitForEvents(observers, "ready", "ready markers", round);
        workers.forEach((worker) => worker.send("start"));
        await waitForEvents(observers, "entering", "entering markers", round);
        await waitForEvents(observers, "opened", "successful open markers", round);
        // Keep both real connections live through successful admission, then join each close.
        for (const [index, worker] of workers.entries()) {
          assert.equal(worker.exitCode, null, \`round \${round} worker \${index} exited before retirement\`);
          assert.equal(worker.signalCode, null, \`round \${round} worker \${index} signaled before retirement\`);
          worker.send("retire");
          const result = await Promise.race([outcomes[index], probeStopped]);
          if (result.error || result.code !== 0) {
            throw new Error(\`round \${round} worker \${index} retirement failed: \${JSON.stringify(result)}\`);
          }
        }
      } catch (error) {
        roundError = error;
      } finally {
        if (roundError) {
          for (const worker of workers) {
            if (worker.exitCode === null && worker.signalCode === null) {
              worker.kill();
            }
          }
        }
        results = await Promise.all(outcomes);
      }
      if (roundError) {
        throw new Error(
          \`round \${round} probe failed: \${String(roundError)}; workers: \${JSON.stringify(results)}\`,
          { cause: roundError },
        );
      }
      const failures = results.filter((result) => result.error || result.code !== 0);
      if (failures.length > 0) {
        throw new Error(\`round \${round} worker failures: \${JSON.stringify(failures)}\`);
      }
      databasePaths.push(databasePath);
    }

    console.log(JSON.stringify(databasePaths));
  `;
  const output = await runStateDatabaseProcessProbe({
    moduleUrl: params.moduleUrl,
    source: orchestratorSource,
    signal: params.signal,
    verifyCleanup: params.verifyCleanup,
  });
  const resultLine = output.trim().split("\n").at(-1);
  if (!resultLine) {
    throw new Error(`concurrent schema ${params.mode} probe produced no result`);
  }
  return JSON.parse(resultLine) as string[];
}
