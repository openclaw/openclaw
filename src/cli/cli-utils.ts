import type { Command } from "commander";
import { formatErrorMessage } from "../infra/errors.js";

export { formatErrorMessage };

export type ManagerLookupResult<T> = {
  manager: T | null;
  error?: string;
};

/**
 * Calls `getManager()`, then runs `run()` with the result.
 * If the manager is not found, calls `onMissing()` and returns early without running or closing.
 * Otherwise, always calls `close()` in a `finally` block, even if `run()` throws.
 */
export async function withManager<T>(params: {
  getManager: () => Promise<ManagerLookupResult<T>>;
  onMissing: (error?: string) => void;
  run: (manager: T) => Promise<void>;
  close: (manager: T) => Promise<void>;
  onCloseError?: (err: unknown) => void;
}): Promise<void> {
  const { manager, error } = await params.getManager();
  if (!manager) {
    params.onMissing(error);
    return;
  }
  try {
    await params.run(manager);
  } finally {
    try {
      await params.close(manager);
    } catch (err) {
      params.onCloseError?.(err);
    }
  }
}

/** Runs `action()` and catches any thrown error, forwarding it to `onError` if provided, otherwise logging it and calling `runtime.exit(1)`. */
export async function runCommandWithRuntime(
  runtime: { error: (message: string) => void; exit: (code: number) => void },
  action: () => Promise<void>,
  onError?: (error: unknown) => void,
): Promise<void> {
  try {
    await action();
  } catch (err) {
    if (onError) {
      onError(err);
      return;
    }
    runtime.error(String(err));
    runtime.exit(1);
  }
}

/** Walks up the Commander command tree looking for an option named `key`, returning the first value found. Useful for reading root-level options from a deeply nested subcommand. */
export function resolveOptionFromCommand<T>(
  command: Command | undefined,
  key: string,
): T | undefined {
  let current: Command | null | undefined = command;
  while (current) {
    const opts = current.opts?.() ?? {};
    if (opts[key] !== undefined) {
      return opts[key];
    }
    current = current.parent ?? undefined;
  }
  return undefined;
}
