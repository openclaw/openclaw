// Undici address-family policy helpers centralize IPv4/IPv6 defaults for
// global dispatchers, with WSL2 forced off Node's auto-selection path.
import * as net from "node:net";
import { isWSL2Sync } from "../wsl.js";

const AUTO_SELECT_FAMILY_ATTEMPT_TIMEOUT_MS = 300;

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

/** Converts an autoSelectFamily decision into the undici connect option shape. */
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
