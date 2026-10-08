// The running Gateway keeps the Node path it was launched with.
// A Homebrew upgrade can delete that Cellar binary while the process stays up.

import { accessSync, constants } from "node:fs";
import { sanitizeTerminalText } from "../../packages/terminal-core/src/safe-text.js";
import { hasErrnoCode } from "./errno.js";

export type ChildRuntimeViability = {
  execPath: string;
  available: boolean;
};

function accessExecutable(execPath: string): void {
  accessSync(execPath, constants.X_OK);
}

/** Reports whether this process can still spawn children with its own Node binary. */
export function readChildRuntimeViability(params?: {
  execPath?: string;
  access?: (execPath: string) => void;
}): ChildRuntimeViability {
  const execPath = params?.execPath ?? process.execPath;
  const access = params?.access ?? accessExecutable;
  try {
    access(execPath);
    return { execPath, available: true };
  } catch (error) {
    // Only a removed path matches the Homebrew Cellar failure. Other access
    // errors are not this diagnostic.
    if (
      error instanceof Error &&
      (hasErrnoCode(error, "ENOENT") || hasErrnoCode(error, "ENOTDIR"))
    ) {
      return { execPath, available: false };
    }
    return { execPath, available: true };
  }
}

/** Operator text for a Gateway whose retained Node binary is gone. */
export function formatMissingChildRuntimeWarning(
  viability: ChildRuntimeViability,
): string | undefined {
  if (viability.available) {
    return undefined;
  }
  const execPath = sanitizeTerminalText(viability.execPath);
  return `Gateway runtime is stale after Node upgrade: child workers are using ${execPath}, which no longer exists. Restart the Gateway.`;
}

/** Do not mislabel missing commands or working directories as a removed Node runtime. */
export function formatChildRuntimeSpawnWarning(error: unknown): string | undefined {
  if (
    error instanceof Error &&
    hasErrnoCode(error, "ENOENT") &&
    "path" in error &&
    error.path === process.execPath
  ) {
    return formatMissingChildRuntimeWarning(readChildRuntimeViability());
  }
  return undefined;
}
