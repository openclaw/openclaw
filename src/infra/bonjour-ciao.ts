import { logDebug } from "../logger.js";
import { formatBonjourError } from "./bonjour-errors.js";

const CIAO_CANCELLATION_MESSAGE_RE = /^CIAO (?:ANNOUNCEMENT|PROBING) CANCELLED\b/u;

export function ignoreCiaoCancellationRejection(reason: unknown): boolean {
  const message = formatBonjourError(reason).toUpperCase();
  if (!CIAO_CANCELLATION_MESSAGE_RE.test(message)) {
    return false;
  }
  logDebug(`bonjour: ignoring unhandled ciao rejection: ${formatBonjourError(reason)}`);
  return true;
}
