import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { loadSessionEntry, updateSessionEntry } from "./session-accessor.js";

/**
 * Makes a delivered-but-unrecorded terminal reply fail closed on restart.
 * A rotated or completed claim is already safe and must not mutate its successor.
 */
export async function markRestartRecoveryTerminalReceiptFailure(params: {
  sessionId: string;
  sessionKey: string;
  sourceTurnId: string;
  storePath: string;
}): Promise<"marked" | "stale"> {
  const updated = await updateSessionEntry(
    { sessionKey: params.sessionKey, storePath: params.storePath },
    (entry) => {
      if (
        entry.sessionId !== params.sessionId ||
        entry.status !== "running" ||
        !normalizeOptionalString(entry.restartRecoveryDeliveryRunId) ||
        normalizeOptionalString(entry.restartRecoveryDeliverySourceRunId) !== params.sourceTurnId
      ) {
        return null;
      }
      return {
        restartRecoveryDeliveryReceiptState: "unrecorded-terminal",
        updatedAt: Date.now(),
      };
    },
    { skipMaintenance: true, takeCacheOwnership: true },
  );
  if (
    updated?.sessionId === params.sessionId &&
    normalizeOptionalString(updated.restartRecoveryDeliverySourceRunId) === params.sourceTurnId &&
    updated.restartRecoveryDeliveryReceiptState === "unrecorded-terminal"
  ) {
    return "marked";
  }
  const current = loadSessionEntry({
    sessionKey: params.sessionKey,
    storePath: params.storePath,
    readConsistency: "latest",
  });
  const claimStillActive =
    current?.sessionId === params.sessionId &&
    current.status === "running" &&
    normalizeOptionalString(current.restartRecoveryDeliveryRunId) !== undefined &&
    normalizeOptionalString(current.restartRecoveryDeliverySourceRunId) === params.sourceTurnId;
  if (claimStillActive) {
    throw new Error("failed to persist fail-closed terminal reply receipt state");
  }
  return "stale";
}
