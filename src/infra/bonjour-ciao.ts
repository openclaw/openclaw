import { logDebug, logWarn } from "../logger.js";
import { formatBonjourError } from "./bonjour-errors.js";

// ciao's MDNSServer.handleUpdatedNetworkInterfaces fires assert.fail when an
// interface's IPv4 address transitions between defined⇄undefined (e.g. WiFi
// drop, VPN toggle, sleep/wake).  These are transient network events, not bugs
// in OpenClaw — swallow them so the gateway stays alive.
const CIAO_TRANSIENT_PATTERNS = [
  "CIAO ANNOUNCEMENT CANCELLED",
  "REACHED ILLEGAL STATE! IPV4 ADDRESS CHANGE",
  "REACHED ILLEGAL STATE! IPV4 ADDRESS CHANGED",
];

export function ignoreCiaoCancellationRejection(reason: unknown): boolean {
  const message = formatBonjourError(reason).toUpperCase();
  const matched = CIAO_TRANSIENT_PATTERNS.some((pattern) => message.includes(pattern));
  if (!matched) {
    return false;
  }
  const formatted = formatBonjourError(reason);
  if (message.includes("REACHED ILLEGAL STATE")) {
    logWarn(`bonjour: suppressed ciao network-change assertion (non-fatal): ${formatted}`);
  } else {
    logDebug(`bonjour: ignoring unhandled ciao rejection: ${formatted}`);
  }
  return true;
}
