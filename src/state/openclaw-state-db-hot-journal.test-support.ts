import { execFileSync } from "node:child_process";
import { resolveRuntimeWorkerArgv } from "../infra/runtime-worker-url.js";

export function runHotRollbackJournalRecoveryProbe(params: {
  moduleUrl: string;
  rootDir: string;
}): {
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
} {
  const probeSource = `
    import { spawn } from "node:child_process";
    import { createHash } from "node:crypto";
    import fs from "node:fs";
    import path from "node:path";
    import { DatabaseSync } from "node:sqlite";
    import { pathToFileURL } from "node:url";

    const moduleUrl = ${JSON.stringify(params.moduleUrl)};
    const databasePath = path.join(${JSON.stringify(params.rootDir)}, "hot-journal.sqlite");
    const readyPath = path.join(${JSON.stringify(params.rootDir)}, "writer-ready");
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
      import fs from "node:fs";
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
      fs.writeFileSync(process.env.OPENCLAW_HOT_JOURNAL_READY_PATH, "ready");
      // Keep the transaction-owning connection live until the parent kills this process.
      setInterval(() => {
        void database.isOpen;
      }, 1_000);
    \`;
    const writer = spawn(
      process.execPath,
      ["--input-type=module", "-e", writerSource],
      {
        env: {
          ...process.env,
          OPENCLAW_HOT_JOURNAL_DATABASE_PATH: databasePath,
          OPENCLAW_HOT_JOURNAL_READY_PATH: readyPath,
        },
        stdio: ["ignore", "ignore", "pipe"],
      },
    );
    let writerStderr = "";
    writer.stderr.on("data", (chunk) => {
      writerStderr += chunk;
    });
    const writerClosed = new Promise((resolve, reject) => {
      writer.once("error", reject);
      writer.once("close", (code, signal) => resolve({ code, signal }));
    });

    try {
      const deadline = Date.now() + 15_000;
      while (!fs.existsSync(readyPath)) {
        if (writer.exitCode !== null || writer.signalCode !== null) {
          throw new Error(\`writer exited before creating a hot journal: \${writerStderr}\`);
        }
        if (Date.now() >= deadline) {
          throw new Error("timed out waiting for hot rollback journal writer");
        }
        await new Promise((resolve) => setTimeout(resolve, 2));
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
      const outcome = await writerClosed;
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
        await writerClosed;
      }
      closeOpenClawStateDatabaseForTest();
    }
  `;
  const output = execFileSync(
    process.execPath,
    [
      ...resolveRuntimeWorkerArgv(new URL(params.moduleUrl)).slice(0, -1),
      "--input-type=module",
      "-e",
      probeSource,
    ],
    { encoding: "utf8", timeout: 30_000 },
  );
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
