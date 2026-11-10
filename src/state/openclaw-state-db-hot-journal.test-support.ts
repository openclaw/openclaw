import { spawn } from "node:child_process";
import { withinTest } from "../../test/helpers/promise.js";
import { resolveRuntimeWorkerArgv } from "../infra/runtime-worker-url.js";

type HotJournalResult = {
  committedRowsAfterRecovery: number;
  immutableDirtyRowsBeforeKill: number;
  integrity: string;
  journalBytesBeforeReadOnly: number;
  journalExistsAfterReadOnly: boolean;
  journalExistsAfterRecovery: boolean;
  journalShaAfterReadOnly: string;
  journalShaBeforeReadOnly: string;
  readOnly: { error: string | null; opened: boolean; uncommittedRows: number | null };
};

export async function runHotRollbackJournalRecoveryProbe(params: {
  moduleUrl: string;
  rootDir: string;
  signal: AbortSignal;
  verifyCleanup: (cleanup: () => Promise<void>) => Promise<void>;
}): Promise<HotJournalResult> {
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
    import { spawn } from "node:child_process";
    import { once } from "node:events";
    import { createHash } from "node:crypto";
    import fs from "node:fs";
    import path from "node:path";
    import { DatabaseSync } from "node:sqlite";
    import { pathToFileURL } from "node:url";

    const databasePath = path.join(${JSON.stringify(params.rootDir)}, "hot-journal.sqlite");
    const countRows = (db, value) => Number(db.prepare(
      "SELECT COUNT(*) AS count FROM hot_journal_probe WHERE value = ?").get(value)?.count ?? 0);
    const {
      closeOpenClawStateDatabaseForTest,
      openExistingOpenClawStateDatabaseReadOnly,
      openOpenClawStateDatabase,
    } = await import(${JSON.stringify(params.moduleUrl)});

    const initial = openOpenClawStateDatabase({ path: databasePath });
    initial.db.exec(\`
      CREATE TABLE hot_journal_probe (id INTEGER PRIMARY KEY, value TEXT NOT NULL, payload BLOB NOT NULL);
      WITH RECURSIVE rows(id) AS (
        SELECT 1 UNION ALL SELECT id + 1 FROM rows WHERE id < 256
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
      database.exec("PRAGMA journal_mode = DELETE; PRAGMA synchronous = FULL; " +
        "PRAGMA cache_size = 2; PRAGMA cache_spill = ON; BEGIN IMMEDIATE; " +
        "UPDATE hot_journal_probe SET value = 'uncommitted';");
      process.send("ready");
      // Keep the transaction-owning connection live until the parent kills this process.
      setInterval(() => void database.isOpen, 1_000);
    \`;
    probeAbort.signal.throwIfAborted();
    const writer = spawn(process.execPath, ["--input-type=module", "-e", writerSource], {
        env: { ...process.env, OPENCLAW_HOT_JOURNAL_DATABASE_PATH: databasePath },
        stdio: ["ignore", "ignore", "pipe", "ipc"],
      });
    const writerReady = once(writer, "message");
    let writerStderr = "";
    writer.stderr.on("data", (chunk) => { writerStderr += chunk; });
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
      const immutableUri = \`\${pathToFileURL(databasePath).href}?mode=ro&immutable=1\`;
      const immutable = new DatabaseSync(immutableUri, { readOnly: true });
      const result = { immutableDirtyRowsBeforeKill: countRows(immutable, "uncommitted") };
      immutable.close();
      if (result.immutableDirtyRowsBeforeKill === 0) {
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
      result.journalBytesBeforeReadOnly = fs.statSync(journalPath).size;
      result.journalShaBeforeReadOnly = hashJournal();
      try {
        const database = await openExistingOpenClawStateDatabaseReadOnly({ path: databasePath });
        const uncommittedRows = database ? countRows(database.db, "uncommitted") : 0;
        database?.walMaintenance.close();
        result.readOnly = { error: null, opened: true, uncommittedRows };
      } catch (error) {
        result.readOnly = {
          error: error instanceof Error ? error.message : String(error),
          opened: false, uncommittedRows: null,
        };
      }
      result.journalExistsAfterReadOnly = fs.existsSync(journalPath);
      result.journalShaAfterReadOnly = hashJournal();
      const reopened = openOpenClawStateDatabase({ path: databasePath });
      result.committedRowsAfterRecovery = countRows(reopened.db, "committed");
      result.integrity = reopened.db.prepare("PRAGMA integrity_check").get()?.integrity_check;
      closeOpenClawStateDatabaseForTest();
      result.journalExistsAfterRecovery = fs.existsSync(journalPath);
      console.log(JSON.stringify(result));
    } finally {
      if (writer.exitCode === null && writer.signalCode === null) {
        writer.kill("SIGKILL");
      }
      await writerClosed;
      closeOpenClawStateDatabaseForTest();
    }
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
    const { stdout: output, stderr: errors } = child;
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
  } finally {
    await params.verifyCleanup(async () => {
      if (child.connected) {
        child.send("stop", () => {});
      }
      await closed;
    });
  }

  const resultLine = stdout.trim().split("\n").at(-1);
  if (!resultLine) {
    throw new Error("hot rollback journal recovery probe produced no result");
  }
  return JSON.parse(resultLine) as HotJournalResult;
}
