import fs from "node:fs";
import { formatCliCommand } from "../cli/command-format.js";
import { quoteCliArg, quotePowerShellArg } from "../cli/quote-cli-arg.js";
import { collectNestedErrorCandidates } from "./error-graph-internal.js";
import {
  formatSqliteReadOnlyInspectionFailure,
  isSqliteCorruptionError,
  sqliteErrorCode,
} from "./sqlite-error-diagnostics.js";
import { resolveSqliteDatabaseFilePaths } from "./sqlite-files.js";
import { isTerminalSqliteIntegrityError } from "./sqlite-integrity.js";
import { planSqliteRecoveryMoves } from "./sqlite-recovery-files.js";

export function formatAgentDatabaseCorruptionRepairHint(
  agentId: string,
  error: unknown,
): string | undefined {
  // A failed private snapshot does not prove that the serving database is damaged.
  if (formatSqliteReadOnlyInspectionFailure(error).includes("creating its private snapshot:")) {
    return undefined;
  }
  const corrupt = collectNestedErrorCandidates(error).some(
    (candidate) =>
      isSqliteCorruptionError(candidate) ||
      ["SQLITE_CORRUPT", "SQLITE_NOTADB"].includes(sqliteErrorCode(candidate) ?? "") ||
      (candidate instanceof Error && isTerminalSqliteIntegrityError(candidate)),
  );
  if (!corrupt) {
    return undefined;
  }
  const command = formatCliCommand(
    `openclaw doctor --session-sqlite recover --session-sqlite-agent ${quoteCliArg(agentId)}`,
  );
  return `Stop the Gateway, back up this database and its SQLite sidecars, then run "${command}" against the same state/config. Recovery repairs supported index corruption or preserves damaged files with a .corrupt-<timestamp> suffix. Restore a verified backup if you need the previous sessions, then restart the Gateway.`;
}

export function formatAgentDatabaseOwnershipRepairHint(pathname: string): string {
  const moves = planSqliteRecoveryMoves(
    resolveSqliteDatabaseFilePaths(pathname).filter((file) =>
      fs.lstatSync(file, { throwIfNoEntry: false }),
    ),
  );
  // The recovery owner moves journals first and the main database last.
  moves.sort((a, b) => Number(a.sourcePath === pathname) - Number(b.sourcePath === pathname));
  const action = moves
    .map(({ sourcePath, destinationPath }) =>
      process.platform === "win32"
        ? `Move-Item -LiteralPath ${quotePowerShellArg(sourcePath)} -Destination ${quotePowerShellArg(destinationPath)} -ErrorAction Stop`
        : `mv -n -- ${quoteCliArg(sourcePath)} ${quoteCliArg(destinationPath)}`,
    )
    .join(process.platform === "win32" ? "; " : " && ");
  return `Preserve and inspect this database before accepting a fresh agent. With all OpenClaw processes stopped, the explicit quarantine move is${process.platform === "win32" ? " (PowerShell)" : ""}:\n${action}\nThen run openclaw doctor --fix and restart the Gateway.`;
}
