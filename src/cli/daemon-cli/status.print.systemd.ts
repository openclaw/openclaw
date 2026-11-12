import { terminalText } from "../../../packages/terminal-core/src/safe-text.js";
import { formatCliCommand } from "../command-format.js";
import type { DaemonStatus } from "./status.gather.js";

// Prints the dueling-scope (user + system systemd units) diagnostics. A failed
// installation probe is surfaced rather than swallowed so the operator-visible
// status is not silently incomplete.
export function printDuelingScopesWarnings(
  status: DaemonStatus,
  printWarning: (message: string) => void,
): void {
  if (status.gateway?.duelingScopesWarning) {
    printWarning(terminalText`${status.gateway.duelingScopesWarning}`);
  }
  const reason = status.gateway?.duelingScopesWarningError;
  if (reason) {
    // The probe error often ends its own sentence, so only add the separator
    // when it is missing instead of printing a doubled period.
    const detail = reason.endsWith(".") ? reason : `${reason}.`;
    printWarning(
      terminalText`Could not inspect the systemd gateway installation: ${detail} The dueling-scope diagnosis was NOT checked; run ${formatCliCommand("openclaw doctor")} for the full check.`,
    );
  }
}
