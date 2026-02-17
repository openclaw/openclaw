import { logDebug, logWarn } from "../logger.js";
import { formatBonjourError } from "./bonjour-errors.js";

/**
 * Checks if a rejection is from ciao's mDNS server hitting an assertion
 * when a network interface loses (or gains) its IP address.
 *
 * This happens normally when WiFi disconnects, VPN toggles, or the machine
 * wakes from sleep. The ciao library treats it as an "illegal state" via
 * assert.fail(), but it's actually a recoverable condition — the watchdog
 * in bonjour.ts will re-advertise when the network returns.
 *
 * Upstream bug: https://github.com/homebridge/ciao MDNSServer.ts:695
 * The assertion assumes network interfaces never transition between
 * defined ↔ undefined, but they do on any real network.
 */
function isCiaoNetworkInterfaceAssertion(reason: unknown): boolean {
  if (!reason || typeof reason !== "object") {
    return false;
  }

  const err = reason as { name?: string; code?: string; message?: string; stack?: string };

  // Must be an AssertionError (from Node's assert module)
  const isAssertion = err.name === "AssertionError" || err.code === "ERR_ASSERTION";
  if (!isAssertion) {
    return false;
  }

  // Verify it's from ciao's MDNSServer (not an unrelated assertion)
  const message = (err.message ?? "").toUpperCase();
  const stack = (err.stack ?? "").toUpperCase();

  const isCiaoOrigin =
    stack.includes("MDNSSERVER") ||
    stack.includes("CIAO") ||
    message.includes("ADDRESS CHANGE FROM DEFINED") ||
    message.includes("ADDRESS CHANGED FROM UNDEFINED") ||
    message.includes("REACHED ILLEGAL STATE");

  return isCiaoOrigin;
}

export function ignoreCiaoCancellationRejection(reason: unknown): boolean {
  const message = formatBonjourError(reason).toUpperCase();

  if (message.includes("CIAO ANNOUNCEMENT CANCELLED")) {
    logDebug(`bonjour: ignoring unhandled ciao rejection: ${formatBonjourError(reason)}`);
    return true;
  }

  if (isCiaoNetworkInterfaceAssertion(reason)) {
    logWarn(
      `bonjour: network interface change detected (ciao assertion suppressed): ${formatBonjourError(reason)}. ` +
        "The mDNS watchdog will re-advertise when the network returns.",
    );
    return true;
  }

  return false;
}
