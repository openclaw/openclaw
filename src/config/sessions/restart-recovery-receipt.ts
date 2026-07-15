import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { loadSessionEntry, updateSessionEntry } from "./session-accessor.js";
import type { SessionEntry } from "./types.js";

export type RestartRecoveryTerminalDeliveryScope = {
  sessionId: string;
  sessionKey: string;
  sourceTurnId: string;
  storePath: string;
};

function hasExactActiveClaim(
  entry: SessionEntry | null | undefined,
  scope: RestartRecoveryTerminalDeliveryScope,
): entry is SessionEntry {
  return (
    entry?.sessionId === scope.sessionId &&
    entry.status === "running" &&
    normalizeOptionalString(entry.restartRecoveryDeliveryRunId) !== undefined &&
    normalizeOptionalString(entry.restartRecoveryDeliverySourceRunId) === scope.sourceTurnId
  );
}

function loadCurrent(scope: RestartRecoveryTerminalDeliveryScope): SessionEntry | undefined {
  return loadSessionEntry({
    sessionKey: scope.sessionKey,
    storePath: scope.storePath,
    readConsistency: "latest",
  });
}

/** Persists ambiguity before a terminal external send is allowed to start. */
export async function beginRestartRecoveryTerminalDelivery(
  scope: RestartRecoveryTerminalDeliveryScope,
): Promise<"started" | "blocked" | "stale"> {
  let started = false;
  const updated = await updateSessionEntry(
    { sessionKey: scope.sessionKey, storePath: scope.storePath },
    (entry) => {
      if (!hasExactActiveClaim(entry, scope) || entry.restartRecoveryDeliveryReceiptState) {
        return null;
      }
      started = true;
      return {
        restartRecoveryDeliveryReceiptState: "terminal-pending",
        updatedAt: Date.now(),
      };
    },
    { skipMaintenance: true, takeCacheOwnership: true },
  );
  if (
    started &&
    hasExactActiveClaim(updated, scope) &&
    updated.restartRecoveryDeliveryReceiptState === "terminal-pending"
  ) {
    return "started";
  }
  const current = loadCurrent(scope);
  if (!hasExactActiveClaim(current, scope)) {
    return "stale";
  }
  if (current.restartRecoveryDeliveryReceiptState) {
    return "blocked";
  }
  throw new Error("failed to persist terminal delivery intent");
}

/** Resolves a pre-send ambiguity only after the provider confirms delivery. */
export async function completeRestartRecoveryTerminalDelivery(
  scope: RestartRecoveryTerminalDeliveryScope,
): Promise<"recorded" | "stale"> {
  const updated = await updateSessionEntry(
    { sessionKey: scope.sessionKey, storePath: scope.storePath },
    (entry) => {
      if (
        !hasExactActiveClaim(entry, scope) ||
        entry.restartRecoveryDeliveryReceiptState !== "terminal-pending"
      ) {
        return null;
      }
      return {
        restartRecoveryDeliveryReceiptState: "delivered-terminal",
        updatedAt: Date.now(),
      };
    },
    { skipMaintenance: true, takeCacheOwnership: true },
  );
  if (
    hasExactActiveClaim(updated, scope) &&
    updated.restartRecoveryDeliveryReceiptState === "delivered-terminal"
  ) {
    return "recorded";
  }
  const current = loadCurrent(scope);
  if (!hasExactActiveClaim(current, scope)) {
    return "stale";
  }
  if (current.restartRecoveryDeliveryReceiptState === "delivered-terminal") {
    return "recorded";
  }
  throw new Error("failed to persist terminal delivery completion");
}

/** Clears the pre-send intent only when the provider proves no delivery occurred. */
export async function cancelRestartRecoveryTerminalDelivery(
  scope: RestartRecoveryTerminalDeliveryScope,
): Promise<"cleared" | "stale"> {
  const updated = await updateSessionEntry(
    { sessionKey: scope.sessionKey, storePath: scope.storePath },
    (entry) => {
      if (
        !hasExactActiveClaim(entry, scope) ||
        entry.restartRecoveryDeliveryReceiptState !== "terminal-pending"
      ) {
        return null;
      }
      return {
        restartRecoveryDeliveryReceiptState: undefined,
        updatedAt: Date.now(),
      };
    },
    { skipMaintenance: true, takeCacheOwnership: true },
  );
  if (hasExactActiveClaim(updated, scope) && !updated.restartRecoveryDeliveryReceiptState) {
    return "cleared";
  }
  const current = loadCurrent(scope);
  if (!hasExactActiveClaim(current, scope)) {
    return "stale";
  }
  if (!current.restartRecoveryDeliveryReceiptState) {
    return "cleared";
  }
  if (current.restartRecoveryDeliveryReceiptState === "delivered-terminal") {
    return "stale";
  }
  throw new Error("failed to clear terminal delivery intent");
}
