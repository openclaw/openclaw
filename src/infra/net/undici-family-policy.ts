// Undici address-family policy helpers centralize IPv4/IPv6 defaults for
// global dispatchers, with WSL2 forced off Node's auto-selection path.
import * as net from "node:net";
import { isWSL2Sync } from "../wsl.js";

// Node abandons a non-final Happy Eyeballs attempt when this timer expires, even
// if the kernel handshake already completed while the event loop was stalled.
// The abandoned IPv4 socket plus an immediate IPv6 failure becomes
// UND_ERR_CONNECT_TIMEOUT. 300 ms is inside normal Gateway stalls. One second
// stays inside RFC 8305 and still starts the next address when the first does
// not answer. A stall longer than this budget can still lose the race.
const AUTO_SELECT_FAMILY_ATTEMPT_TIMEOUT_MS = 1_000;

/** Resolves the process default autoSelectFamily policy, with WSL2 forced to IPv4. */
export function resolveUndiciAutoSelectFamily(): boolean | undefined {
  const systemDefault = net.getDefaultAutoSelectFamily();
  // WSL2 has unstable IPv6 connectivity; disable autoSelectFamily to force
  // IPv4 connections and avoid fetch failures when reaching Windows-host services.
  if (systemDefault && isWSL2Sync()) {
    return false;
  }
  return systemDefault;
}

export function createUndiciAutoSelectFamilyConnectOptions(
  autoSelectFamily: boolean | undefined,
): { autoSelectFamily: boolean; autoSelectFamilyAttemptTimeout: number } | undefined {
  if (autoSelectFamily === undefined) {
    return undefined;
  }
  return {
    autoSelectFamily,
    autoSelectFamilyAttemptTimeout: AUTO_SELECT_FAMILY_ATTEMPT_TIMEOUT_MS,
  };
}

/** Returns shared undici connect options for dispatchers that do not override them. */
export function resolveUndiciAutoSelectFamilyConnectOptions():
  | { autoSelectFamily: boolean; autoSelectFamilyAttemptTimeout: number }
  | undefined {
  return createUndiciAutoSelectFamilyConnectOptions(resolveUndiciAutoSelectFamily());
}

/** Temporarily applies an undici family decision around synchronous setup code. */
export function withTemporaryUndiciAutoSelectFamily<T>(
  autoSelectFamily: boolean | undefined,
  run: () => T,
): T {
  if (autoSelectFamily === undefined) {
    return run();
  }

  const previous = net.getDefaultAutoSelectFamily();
  net.setDefaultAutoSelectFamily(autoSelectFamily);

  try {
    return run();
  } finally {
    net.setDefaultAutoSelectFamily(previous);
  }
}
