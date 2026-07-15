import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { loadSessionEntry, updateSessionEntry } from "./session-accessor.js";
import type { SessionEntry } from "./types.js";

export type RestartRecoveryTerminalDeliveryScope = {
  sessionId: string;
  sessionKey: string;
  sourceTurnId: string;
  storePath: string;
  toolCallId: string;
};

function hasActiveClaim(
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

function hasExactDeliveryClaim(
  entry: SessionEntry | null | undefined,
  scope: RestartRecoveryTerminalDeliveryScope,
): entry is SessionEntry {
  return (
    hasActiveClaim(entry, scope) && entry.restartRecoveryDeliveryToolCallId === scope.toolCallId
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
      if (
        !hasActiveClaim(entry, scope) ||
        entry.restartRecoveryDeliveryReceiptState ||
        entry.restartRecoveryDeliveryToolCallId
      ) {
        return null;
      }
      started = true;
      return {
        restartRecoveryDeliveryReceiptState: "terminal-pending",
        restartRecoveryDeliveryToolCallId: scope.toolCallId,
        updatedAt: Date.now(),
      };
    },
    { skipMaintenance: true, takeCacheOwnership: true },
  );
  if (
    started &&
    hasExactDeliveryClaim(updated, scope) &&
    updated.restartRecoveryDeliveryReceiptState === "terminal-pending"
  ) {
    return "started";
  }
  const current = loadCurrent(scope);
  if (!hasActiveClaim(current, scope)) {
    return "stale";
  }
  if (current.restartRecoveryDeliveryReceiptState || current.restartRecoveryDeliveryToolCallId) {
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
        !hasExactDeliveryClaim(entry, scope) ||
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
    hasExactDeliveryClaim(updated, scope) &&
    updated.restartRecoveryDeliveryReceiptState === "delivered-terminal"
  ) {
    return "recorded";
  }
  const current = loadCurrent(scope);
  if (!hasActiveClaim(current, scope)) {
    return "stale";
  }
  if (
    hasExactDeliveryClaim(current, scope) &&
    current.restartRecoveryDeliveryReceiptState === "delivered-terminal"
  ) {
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
        !hasExactDeliveryClaim(entry, scope) ||
        entry.restartRecoveryDeliveryReceiptState !== "terminal-pending"
      ) {
        return null;
      }
      return {
        restartRecoveryDeliveryReceiptState: undefined,
        restartRecoveryDeliveryToolCallId: undefined,
        updatedAt: Date.now(),
      };
    },
    { skipMaintenance: true, takeCacheOwnership: true },
  );
  if (
    hasActiveClaim(updated, scope) &&
    !updated.restartRecoveryDeliveryReceiptState &&
    !updated.restartRecoveryDeliveryToolCallId
  ) {
    return "cleared";
  }
  const current = loadCurrent(scope);
  if (!hasActiveClaim(current, scope)) {
    return "stale";
  }
  if (!current.restartRecoveryDeliveryReceiptState && !current.restartRecoveryDeliveryToolCallId) {
    return "cleared";
  }
  if (
    hasExactDeliveryClaim(current, scope) &&
    current.restartRecoveryDeliveryReceiptState === "delivered-terminal"
  ) {
    return "stale";
  }
  throw new Error("failed to clear terminal delivery intent");
}
