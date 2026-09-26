import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import {
  hasActiveRestartRecoverySourceClaim,
  hasRestartRecoveryTerminalRun,
  normalizeRestartRecoveryTerminalRunIds,
} from "./restart-recovery-state.js";
import { loadSessionEntry, updateSessionEntry } from "./session-accessor.js";
import type { SessionEntry } from "./types.js";

export type RestartRecoveryTerminalDeliveryScope = {
  sessionId: string;
  sessionKey: string;
  sourceTurnId: string;
  storePath: string;
  toolCallId: string;
};

type RestartRecoveryTerminalDeliveryDisposition =
  | "startable"
  | "already-delivered"
  | "delivery-ambiguous"
  | "stale"
  | "not-applicable";

function hasActiveClaim(
  entry: SessionEntry,
  scope: Pick<RestartRecoveryTerminalDeliveryScope, "sessionId" | "sourceTurnId">,
): boolean {
  return (
    entry.sessionId === scope.sessionId &&
    hasActiveRestartRecoverySourceClaim(entry, scope.sourceTurnId)
  );
}

function hasExactDeliveryClaim(
  entry: SessionEntry,
  scope: RestartRecoveryTerminalDeliveryScope,
): boolean {
  return (
    hasActiveClaim(entry, scope) && entry.restartRecoveryDeliveryToolCallId === scope.toolCallId
  );
}

function hasClaimlessLiveDeliveryState(
  entry: SessionEntry,
  scope: Pick<RestartRecoveryTerminalDeliveryScope, "sessionId">,
): boolean {
  return (
    entry.sessionId === scope.sessionId &&
    normalizeOptionalString(entry.restartRecoveryDeliveryRunId) === undefined &&
    normalizeOptionalString(entry.restartRecoveryDeliverySourceRunId) === undefined &&
    entry.restartRecoveryDeliveryReceiptState === undefined &&
    normalizeOptionalString(entry.restartRecoveryDeliveryToolCallId) === undefined
  );
}

/**
 * Pure decision mirror of `beginRestartRecoveryTerminalDelivery`: the
 * disposition a terminal source-reply send on `scope.sourceTurnId` resolves
 * to against the given session entry. The send path and the steering fence
 * classify every entry through this single decision surface so they can
 * never drift apart.
 */
function resolveRestartRecoveryTerminalDeliveryDisposition(
  entry: SessionEntry | null | undefined,
  scope: Pick<RestartRecoveryTerminalDeliveryScope, "sessionId" | "sourceTurnId">,
): RestartRecoveryTerminalDeliveryDisposition {
  if (entry) {
    if (
      entry.sessionId === scope.sessionId &&
      hasRestartRecoveryTerminalRun(entry, scope.sourceTurnId)
    ) {
      // The source turn already completed a terminal send.
      return "already-delivered";
    }
    if (hasClaimlessLiveDeliveryState(entry, scope)) {
      // No durable claim was ever armed for this turn.
      return "not-applicable";
    }
  }
  if (!entry || !hasActiveClaim(entry, scope)) {
    return "stale";
  }
  if (entry.restartRecoveryDeliveryReceiptState || entry.restartRecoveryDeliveryToolCallId) {
    return entry.restartRecoveryDeliveryReceiptState === "delivered-terminal"
      ? "already-delivered"
      : "delivery-ambiguous";
  }
  return "startable";
}

/** Keep steering eligibility aligned with terminal-send ownership, using the exact active source. */
export function resolveRestartRecoverySteeringBlockReason(
  entry: SessionEntry | null | undefined,
  sessionId: string,
  sourceTurnId: string,
):
  | "terminal-pending"
  | "delivered-terminal"
  | "unresolved-terminal-tool"
  | "unknown-source-with-terminal-history"
  | "already-delivered"
  | "delivery-ambiguous"
  | "stale-claim"
  | undefined {
  if (!entry) {
    // No session entry means no persisted receipt state to fence; the send
    // path arms a fresh claim on the same entry surface.
    return undefined;
  }
  if (entry.restartRecoveryDeliveryReceiptState) {
    return entry.restartRecoveryDeliveryReceiptState;
  }
  if (entry.restartRecoveryDeliveryToolCallId) {
    return "unresolved-terminal-tool";
  }
  const normalizedSourceTurnId = normalizeOptionalString(sourceTurnId) ?? "";
  const disposition = resolveRestartRecoveryTerminalDeliveryDisposition(entry, {
    sessionId,
    sourceTurnId: normalizedSourceTurnId,
  });
  if (disposition === "not-applicable") {
    // Claimless entries are the legitimate fresh state ("not-applicable" in
    // beginRestartRecoveryTerminalDelivery); a tombstone only fail-closes the
    // fence when it records this exact source turn, not any earlier one.
    // Unknown active source ("") is ambiguous: the run's real tool-context
    // source may still be tombstoned, so any retained tombstone fail-closes
    // to queue rather than risk steering into a refused terminal send.
    // A tombstone-free unknown source stays fresh.
    if (
      normalizedSourceTurnId === "" &&
      (normalizeRestartRecoveryTerminalRunIds(entry.restartRecoveryTerminalRunIds)?.length ?? 0) > 0
    ) {
      return "unknown-source-with-terminal-history";
    }
    return hasRestartRecoveryTerminalRun(entry, normalizedSourceTurnId)
      ? "already-delivered"
      : undefined;
  }
  return disposition === "already-delivered" || disposition === "delivery-ambiguous"
    ? disposition
    : disposition === "stale"
      ? "stale-claim"
      : undefined;
}

function loadCurrent(scope: RestartRecoveryTerminalDeliveryScope): SessionEntry | undefined {
  return loadSessionEntry({
    sessionKey: scope.sessionKey,
    storePath: scope.storePath,
    readConsistency: "latest",
  });
}

/**
 * Persists ambiguity before a terminal external send is allowed to start.
 * Arms the receipt only when the full disposition is "startable", so the
 * fail-closed classification stays shared with the steering fence.
 */
export async function beginRestartRecoveryTerminalDelivery(
  scope: RestartRecoveryTerminalDeliveryScope,
): Promise<"started" | "already-delivered" | "delivery-ambiguous" | "stale" | "not-applicable"> {
  let started = false;
  const updated = await updateSessionEntry(
    { sessionKey: scope.sessionKey, storePath: scope.storePath },
    (entry) => {
      if (resolveRestartRecoveryTerminalDeliveryDisposition(entry, scope) !== "startable") {
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
    updated !== null &&
    hasExactDeliveryClaim(updated, scope) &&
    updated.restartRecoveryDeliveryReceiptState === "terminal-pending"
  ) {
    return "started";
  }
  const current = loadCurrent(scope);
  const disposition = resolveRestartRecoveryTerminalDeliveryDisposition(current, scope);
  if (disposition === "startable") {
    throw new Error("failed to persist terminal delivery intent");
  }
  return disposition;
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
    updated !== null &&
    hasExactDeliveryClaim(updated, scope) &&
    updated.restartRecoveryDeliveryReceiptState === "delivered-terminal"
  ) {
    return "recorded";
  }
  const current = loadCurrent(scope);
  if (!current || !hasActiveClaim(current, scope)) {
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
    updated !== null &&
    hasActiveClaim(updated, scope) &&
    !updated.restartRecoveryDeliveryReceiptState &&
    !updated.restartRecoveryDeliveryToolCallId
  ) {
    return "cleared";
  }
  const current = loadCurrent(scope);
  if (!current || !hasActiveClaim(current, scope)) {
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
