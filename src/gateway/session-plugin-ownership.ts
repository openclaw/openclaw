// Gateway session-method helpers for plugin-runtime ownership authorization.
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import {
  ErrorCodes,
  type ErrorShape,
  errorShape,
} from "../../packages/gateway-protocol/src/index.js";
import { loadSessionEntry } from "./session-utils.js";

/** Thrown from assertCurrent to signal that a plugin-runtime caller does not
 * own the session it is trying to reset. Caught narrowly by the caller so that
 * unrelated lifecycle/storage errors are not reclassified as client input
 * errors. */
class SessionOwnerMismatchError extends Error {
  override name = "SessionOwnerMismatchError" as const;
  constructor(
    readonly pluginRuntimeOwnerId: string,
    readonly sessionKey: string,
  ) {
    super(
      `Plugin "${pluginRuntimeOwnerId}" cannot reset session "${sessionKey}" because it did not create it.`,
    );
  }
}

/** Returns an error shape if a plugin-runtime caller tries to use or take over
 * a session it does not own. Returns undefined when the caller is not a plugin
 * runtime, the entry is missing, or ownership matches. */
export function rejectPluginOwnerMismatch(
  pluginRuntimeOwnerId: string | undefined,
  entry: { pluginOwnerId?: string } | undefined,
  sessionKey: string,
  action: "use" | "takeover" | "reset" | "delete",
): { ok: false; error: ErrorShape } | undefined {
  if (!pluginRuntimeOwnerId || !entry) {
    return undefined;
  }
  const entryOwnerId = normalizeOptionalString(entry.pluginOwnerId);
  if (entryOwnerId === pluginRuntimeOwnerId) {
    return undefined;
  }
  const verb = action === "takeover" ? "take over" : action;
  return {
    ok: false,
    error: errorShape(
      ErrorCodes.INVALID_REQUEST,
      `Plugin "${pluginRuntimeOwnerId}" cannot ${verb} session "${sessionKey}" because it did not create it.`,
    ),
  };
}

/** Wraps an async operation so that a SessionOwnerMismatchError thrown from
 * an assertCurrent callback is caught and returned as an INVALID_REQUEST
 * error shape. Unrelated errors propagate normally. */
export async function runWithOwnerMismatchCatch<T>(
  fn: () => Promise<T>,
): Promise<T | { ok: false; error: ErrorShape }> {
  try {
    return await fn();
  } catch (error) {
    if (error instanceof SessionOwnerMismatchError) {
      return { ok: false, error: errorShape(ErrorCodes.INVALID_REQUEST, error.message) };
    }
    throw error;
  }
}

/** Creates an assertCurrent callback for performGatewaySessionReset that
 * re-checks plugin owner identity under the lifecycle lock. The check
 * reloads the session entry from the store to prevent TOCTOU races. */
export function createPluginOwnerAssertCurrent(
  pluginRuntimeOwnerId: string | undefined,
  sessionKey: string,
  opts?: { agentId?: string },
): () => void {
  return () => {
    if (!pluginRuntimeOwnerId) {
      return;
    }
    const currentEntry = loadSessionEntry(sessionKey, opts).entry;
    if (!currentEntry?.sessionId || pluginRuntimeOwnerId !== currentEntry.pluginOwnerId) {
      throw new SessionOwnerMismatchError(pluginRuntimeOwnerId, sessionKey);
    }
  };
}
