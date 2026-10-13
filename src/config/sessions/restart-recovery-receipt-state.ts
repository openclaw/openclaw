import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import {
  hasRestartRecoverySourceClaim,
  hasRestartRecoveryTerminalRun,
} from "./restart-recovery-state.js";
import type { SessionEntry } from "./types.js";

export type RestartRecoveryTerminalDeliveryClaim = {
  sessionId: string;
  sourceTurnId: string;
  toolCallId: string;
};

export type RestartRecoveryTerminalDeliveryDisposition =
  | "startable"
  | "already-delivered"
  | "delivery-ambiguous"
  | "stale"
  | "not-applicable";

export function hasActiveRestartRecoveryDeliveryClaim(
  entry: SessionEntry,
  scope: Pick<RestartRecoveryTerminalDeliveryClaim, "sessionId" | "sourceTurnId">,
): boolean {
  return (
    entry.sessionId === scope.sessionId && hasRestartRecoverySourceClaim(entry, scope.sourceTurnId)
  );
}

export function hasExactRestartRecoveryDeliveryClaim(
  entry: SessionEntry,
  scope: RestartRecoveryTerminalDeliveryClaim,
): boolean {
  return (
    hasActiveRestartRecoveryDeliveryClaim(entry, scope) &&
    entry.restartRecoveryDeliveryToolCallId === scope.toolCallId
  );
}

/** Terminal sends and steering share the same source-ownership decision. */
export function resolveRestartRecoveryTerminalDeliveryDisposition(
  entry: SessionEntry | null | undefined,
  scope: Pick<RestartRecoveryTerminalDeliveryClaim, "sessionId" | "sourceTurnId">,
): RestartRecoveryTerminalDeliveryDisposition {
  if (entry) {
    if (
      entry.sessionId === scope.sessionId &&
      hasRestartRecoveryTerminalRun(entry, scope.sourceTurnId)
    ) {
      return "already-delivered";
    }
    if (
      entry.sessionId === scope.sessionId &&
      normalizeOptionalString(entry.restartRecoveryDeliveryRunId) === undefined &&
      normalizeOptionalString(entry.restartRecoveryDeliverySourceRunId) === undefined &&
      entry.restartRecoveryDeliveryReceiptState === undefined &&
      normalizeOptionalString(entry.restartRecoveryDeliveryToolCallId) === undefined
    ) {
      return "not-applicable";
    }
  }
  if (!entry || !hasActiveRestartRecoveryDeliveryClaim(entry, scope)) {
    return "stale";
  }
  if (entry.restartRecoveryDeliveryReceiptState || entry.restartRecoveryDeliveryToolCallId) {
    return entry.restartRecoveryDeliveryReceiptState === "delivered-terminal"
      ? "already-delivered"
      : "delivery-ambiguous";
  }
  return "startable";
}

/** Provider confirmation and proven no-send may change only the exact pending claim. */
export function projectRestartRecoveryDeliverySettlement(
  entry: SessionEntry,
  scope: RestartRecoveryTerminalDeliveryClaim,
  outcome: "confirmed" | "not-sent",
  updatedAt: number,
): Partial<SessionEntry> | null {
  if (
    !hasExactRestartRecoveryDeliveryClaim(entry, scope) ||
    entry.restartRecoveryDeliveryReceiptState !== "terminal-pending"
  ) {
    return null;
  }
  return outcome === "confirmed"
    ? { restartRecoveryDeliveryReceiptState: "delivered-terminal", updatedAt }
    : {
        restartRecoveryDeliveryReceiptState: undefined,
        restartRecoveryDeliveryToolCallId: undefined,
        updatedAt,
      };
}
