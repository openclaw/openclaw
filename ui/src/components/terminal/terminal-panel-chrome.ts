import { t } from "../../i18n/index.ts";
import { registerTerminalEnglish } from "../../i18n/locales/en-terminal.ts";
import { formatUiError } from "../../lib/format-error.ts";
import {
  TerminalOpenTimeoutError,
  TerminalOpenUnusableSessionError,
} from "./terminal-connection.ts";

registerTerminalEnglish();

export function terminalOpenErrorText(error: unknown): string {
  if (error instanceof TerminalOpenTimeoutError) {
    return t("terminal.connectionTimedOut");
  }
  if (error instanceof TerminalOpenUnusableSessionError) {
    return t("terminal.unusableSession", { field: error.field });
  }
  return formatUiError(error);
}
