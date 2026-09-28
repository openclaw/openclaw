// The running Gateway keeps the Node path it was launched with.
// A Homebrew upgrade can delete that Cellar binary while the process stays up.

import { accessSync, constants } from "node:fs";
import { sanitizeTerminalText } from "../../packages/terminal-core/src/safe-text.js";

export type ChildRuntimeViability = {
  execPath: string;
  available: boolean;
};

function errnoCode(error: unknown): string | undefined {
  if (!(error instanceof Error) || !("code" in error)) {
    return undefined;
  }
  const code = error.code;
  return typeof code === "string" ? code : undefined;
}

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
    const code = errnoCode(error);
    // Only a removed path matches the Homebrew Cellar failure. Other access
    // errors are not this diagnostic.
    if (code === "ENOENT" || code === "ENOTDIR") {
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
