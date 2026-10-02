import type { WorkerOptions } from "node:worker_threads";

type CleanupDeleteFault = { databasePath: string; sessionId: string; message: string };
let fault: CleanupDeleteFault | undefined;

export function setCleanupDeleteFault(value: CleanupDeleteFault | undefined): void {
  fault = value;
}

export function withCleanupDeleteFault(
  options: WorkerOptions | undefined,
): WorkerOptions | undefined {
  if (!fault) {
    return options;
  }
  const quote = (value: string) => `'${value.replaceAll("'", "''")}'`;
  const trigger = `CREATE TEMP TRIGGER IF NOT EXISTS fail_cleanup_session_window_delete
    BEFORE DELETE ON main.session_windows WHEN OLD.session_id = ${quote(fault.sessionId)}
    BEGIN SELECT RAISE(ABORT, ${quote(fault.message)}); END;`;
  // Install on the deleting connection after admission, preserving the canonical main schema.
  const preload = `
    import { realpathSync } from "node:fs";
    import { DatabaseSync } from "node:sqlite";
    const prepare = DatabaseSync.prototype.prepare;
    DatabaseSync.prototype.prepare = function(sql) {
      if (sql.startsWith('delete from "session_windows"') &&
          realpathSync(this.location()) === realpathSync(${JSON.stringify(fault.databasePath)})) {
        this.exec(${JSON.stringify(trigger)});
      }
      return prepare.call(this, sql);
    };
  `;
  return {
    ...options,
    execArgv: [
      ...(options?.execArgv ?? []),
      "--import",
      `data:text/javascript,${encodeURIComponent(preload)}`,
    ],
  };
}
