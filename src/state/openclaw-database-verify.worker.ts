import { formatSqliteErrorCodeSuffix } from "../infra/sqlite-error-diagnostics.js";
import { OPENCLAW_SQLITE_BUSY_TIMEOUT_MS } from "./openclaw-state-db-contract.js";

export type OpenClawDatabaseVerifyResult = {
  path: string;
  ok: boolean;
  error?: string;
  terminal?: boolean;
};

function formatVerifyError(error: unknown): string {
  const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  return `${message}${formatSqliteErrorCodeSuffix(error)}`;
}

export async function verifyOpenClawDatabase(target: {
  path: string;
  label: string;
  check: "quick" | "full";
}): Promise<OpenClawDatabaseVerifyResult> {
  const [integrity, source] = await Promise.all([
    import("../infra/sqlite-integrity.js"),
    import("../infra/sqlite-source-handle.js"),
  ]);
  const failed = (error: unknown): OpenClawDatabaseVerifyResult => ({
    path: target.path,
    ok: false,
    error: formatVerifyError(error),
    terminal: error instanceof Error && integrity.isTerminalSqliteIntegrityError(error),
  });
  let result: OpenClawDatabaseVerifyResult = { path: target.path, ok: true };
  try {
    source.withSqliteSourceReadDatabase(target.path, "source", (reader) => {
      try {
        reader.exec(`PRAGMA busy_timeout = ${OPENCLAW_SQLITE_BUSY_TIMEOUT_MS}; BEGIN;`);
        integrity.assertSqliteIntegrity(reader, target.label, { check: target.check });
        reader.exec("ROLLBACK;");
      } catch (error) {
        // Preserve the check's classification if the source reader also fails to close.
        result = failed(error);
      }
    });
  } catch (error) {
    if (result.ok) {
      result = failed(error);
    }
  }
  return result;
}

// Synchronous admission waits for native close without opening a source reader in its process.
if (process.argv[2] === "--openclaw-database-verify-sync" && process.argv[3]) {
  const pathname = process.argv[3];
  void verifyOpenClawDatabase({ path: pathname, label: pathname, check: "full" })
    .then((result) => {
      process.exitCode = result.ok ? 0 : 1;
    })
    .catch(() => {
      process.exitCode = 1;
    });
}
