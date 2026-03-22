import { logDebug, logWarn } from "../logger.js";
import { formatBonjourError } from "./bonjour-errors.js";

const CIAO_CANCELLATION_MESSAGE_RE = /^CIAO (?:ANNOUNCEMENT|PROBING) CANCELLED\b/u;
const CIAO_INTERFACE_ASSERTION_MESSAGE_RE =
  /REACHED ILLEGAL STATE!?\s+IPV4 ADDRESS CHANGE FROM DEFINED TO UNDEFINED!?/u;

export function ignoreCiaoUnhandledRejection(reason: unknown): boolean {
  const formatted = formatBonjourError(reason);
  const message = formatted.toUpperCase();
  if (!CIAO_CANCELLATION_MESSAGE_RE.test(message)) {
    if (!CIAO_INTERFACE_ASSERTION_MESSAGE_RE.test(message)) {
      return false;
    }

    logWarn(`bonjour: suppressing ciao interface assertion: ${formatted}`);
    return true;
  }
  logDebug(`bonjour: ignoring unhandled ciao rejection: ${formatted}`);
  return true;
}
