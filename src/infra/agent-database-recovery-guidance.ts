import { formatCliCommand } from "../cli/command-format.js";
import { quoteCliArg } from "../cli/quote-cli-arg.js";
import { collectNestedErrorCandidates } from "./error-graph-internal.js";
import {
  formatSqliteReadOnlyInspectionFailure,
  isSqliteCorruptionError,
  sqliteErrorCode,
} from "./sqlite-error-diagnostics.js";
import { isTerminalSqliteIntegrityError } from "./sqlite-integrity.js";

/** Only proven damage should direct an operator to explicit offline recovery. */
export function formatAgentDatabaseCorruptionRepairHint(
  agentId: string,
  error: unknown,
): string | undefined {
  // A failed private snapshot does not establish damage to the serving file.
  if (
    formatSqliteReadOnlyInspectionFailure(error).includes(
      "failed while creating its private snapshot:",
    )
  ) {
    return undefined;
  }
  const corrupt = collectNestedErrorCandidates(error).some((candidate) => {
    const code = sqliteErrorCode(candidate);
    return (
      isSqliteCorruptionError(candidate) ||
      code === "SQLITE_CORRUPT" ||
      code === "SQLITE_NOTADB" ||
      (candidate instanceof Error && isTerminalSqliteIntegrityError(candidate))
    );
  });
  if (!corrupt) {
    return undefined;
  }
  const command = formatCliCommand(
    `openclaw doctor --session-sqlite recover --session-sqlite-agent ${quoteCliArg(agentId)}`,
  );
  return `Offline recovery: "${command}". Stop the Gateway and preserve a backup of this database and its SQLite sidecars before running recovery against the same state/config. Recovery can repair supported index corruption in place or preserve the damaged file set with a .corrupt-<timestamp> suffix before preparing a fresh database. Restore a verified backup if you need the previous sessions, then restart the Gateway.`;
}
