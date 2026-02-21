import { logDebug } from "../logger.js";
import { formatBonjourError } from "./bonjour-errors.js";

export function ignoreCiaoCancellationRejection(reason: unknown): boolean {
  const message = formatBonjourError(reason).toUpperCase();
  // Ignore ciao cancellation rejections (normal cleanup)
  if (message.includes("CIAO ANNOUNCEMENT CANCELLED")) {
    logDebug(`bonjour: ignoring unhandled ciao rejection: ${formatBonjourError(reason)}`);
    return true;
  }
  // Ignore socket errors from mDNS announcements (non-fatal, can happen due to network issues)
  if (message.includes("ANNOUNCEMENT FAILED") && message.includes("SOCKET ERRORS")) {
    logDebug(`bonjour: ignoring mDNS socket error: ${formatBonjourError(reason)}`);
    return true;
  }
  return false;
}
