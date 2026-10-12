import fs from "node:fs";
import { formatCliCommand } from "../cli/command-format.js";
import { quoteCliArg, quotePowerShellArg } from "../cli/quote-cli-arg.js";
import { resolveSqliteDatabaseFilePaths } from "./sqlite-files.js";
import { planSqliteRecoveryMoves } from "./sqlite-recovery-files.js";

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

/** Migrations cannot repair proven file damage; session SQLite recovery owns that repair. */
export function formatAgentDatabaseCorruptionRepairHint(agentId: string): string {
  const recover = formatCliCommand(
    `openclaw doctor --session-sqlite recover --session-sqlite-agent ${agentId}`,
  );
  return `This agent database is damaged. Stop the Gateway, run ${recover} to repair it or set its files aside with a .corrupt-<timestamp> suffix, and restart.`;
}
