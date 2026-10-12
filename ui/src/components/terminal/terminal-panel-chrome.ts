import { t } from "../../i18n/index.ts";
import { formatUiError } from "../../lib/format-error.ts";
import {
  TerminalOpenTimeoutError,
  TerminalOpenUnusableSessionError,
} from "./terminal-connection.ts";

export function terminalOpenErrorText(error: unknown): string {
  if (error instanceof TerminalOpenTimeoutError) {
    return t("terminal.connectionTimedOut");
  }
  if (error instanceof TerminalOpenUnusableSessionError) {
    return t("terminal.unusableSession", { field: error.field });
  }
  return formatUiError(error);
}
