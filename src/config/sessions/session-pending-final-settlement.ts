import { isDeepStrictEqual } from "node:util";
import { normalizeDeliveryContext } from "../../utils/delivery-context.shared.js";
import { mergeRestartRecoveryTerminalDeliveryEvidence } from "./restart-recovery-state.js";
import type { SessionActorDeliveryEvidence } from "./session-actor-delivery-evidence.types.js";
import { projectSessionEntryPatch } from "./session-entry-patch-operation.js";
import type { InternalSessionEntry } from "./types.js";

type PendingFinalDelivery = NonNullable<InternalSessionEntry["pendingFinalDelivery"]>;
type PendingFinalDeliveryState = NonNullable<PendingFinalDelivery["deliveries"]>[number]["state"];

export type PendingFinalDeliverySettlementInput = {
  sessionId: string;
  intentId: string;
  deliveryId: string;
  state: PendingFinalDeliveryState;
  expectedStates?: readonly ("prepared" | "queued" | "unknown")[];
  /** Only the settled delivery owner may clear custody; pre-ACK receipts omit this. */
  cleanup?: {
    sessionKey: string;
    recoveryRunId?: string;
    now: number;
    preserveActivity?: boolean;
  };
};

/** Harness claims are host-validated; ordinary sources belong to the persisted final intent. */
export function projectPendingFinalDeliverySettlement(
  entry: InternalSessionEntry,
  input: PendingFinalDeliverySettlementInput,
  evidence?: SessionActorDeliveryEvidence,
): {
  patch: Partial<InternalSessionEntry> | null;
  state: PendingFinalDeliveryState | "stale";
  wakeRecovery: boolean;
} {
  const settlement = projectPendingFinalDeliveryState(entry, input, evidence);
  if (!input.cleanup) {
    return settlement;
  }
  const settledEntry = settlement.patch ? { ...entry, ...settlement.patch } : entry;
  const cleaned = projectSessionEntryPatch({
    existing: settledEntry,
    writeBase: settledEntry,
    sessionKey: input.cleanup.sessionKey,
    preserveActivity: input.cleanup.preserveActivity,
    operation: {
      kind: "pending-final-clear",
      sessionId: input.sessionId,
      intentId: input.intentId,
      recoveryRunId: input.cleanup.recoveryRunId,
      now: input.cleanup.now,
    },
  });
  return { ...settlement, patch: cleaned ?? settlement.patch };
}

function projectPendingFinalDeliveryState(
  entry: InternalSessionEntry,
  input: PendingFinalDeliverySettlementInput,
  evidence: Parameters<typeof projectPendingFinalDeliverySettlement>[2],
): ReturnType<typeof projectPendingFinalDeliverySettlement> {
  const pending = entry.pendingFinalDelivery;
  const deliveries = pending?.deliveries;
  const index = deliveries?.findIndex(({ id }) => id === input.deliveryId) ?? -1;
  if (
    entry.sessionId !== input.sessionId ||
    pending?.intentId !== input.intentId ||
    !deliveries ||
    index < 0
  ) {
    return { patch: null, state: "stale", wakeRecovery: false };
  }
  const current = deliveries[index]!.state;
  if (input.expectedStates && !input.expectedStates.some((expected) => expected === current)) {
    return { patch: null, state: "stale", wakeRecovery: false };
  }
  const terminal =
    current === "delivered" ||
    current === "suppressed" ||
    (current === "unknown" && input.state === "unknown");
  const settled = terminal ? current : input.state;
  const existingNotice = entry.pendingDeliveryNotice;
  const owedNotice =
    settled === "unknown" &&
    pending.context &&
    pending.intentId &&
    existingNotice?.intentId !== pending.intentId &&
    (!existingNotice || existingNotice.createdAt <= pending.createdAt)
      ? {
          pendingDeliveryNotice: {
            createdAt: pending.createdAt,
            context: pending.context,
            intentId: pending.intentId,
            state: "owed" as const,
          },
        }
      : undefined;
  const result = evidence?.result;
  const platformMessageId = result?.platformMessageId?.trim();
  const context = pending.context;
  const sourceRunId = pending.sourceRunId ?? evidence?.claim?.sourceRunId;
  const validResult =
    result &&
    platformMessageId &&
    (result.resultCount === undefined ||
      (Number.isSafeInteger(result.resultCount) && result.resultCount > 0)) &&
    result.channel === context?.channel &&
    context?.to &&
    (!result.target || result.target.id === context.to) &&
    (!result.verifiedContext ||
      isDeepStrictEqual(
        normalizeDeliveryContext(result.verifiedContext),
        normalizeDeliveryContext(context),
      ));
  const receipt = terminal
    ? deliveries[index]!.receipt
    : settled === "delivered" && sourceRunId && validResult
      ? { platformMessageId, resultCount: result.resultCount ?? 1 }
      : undefined;
  const updatedDeliveries = deliveries.with(index, {
    id: input.deliveryId,
    state: settled,
    ...(receipt ? { receipt } : {}),
  });
  const finalReceipt = updatedDeliveries[index]!.receipt;
  // Commit the original source receipt before queue ACK, even if run cleanup
  // already retired its active claim. Never borrow the current requester source.
  const terminalEvidence =
    sourceRunId &&
    (!evidence?.claim || evidence.claim.sourceRunId === sourceRunId) &&
    finalReceipt &&
    context &&
    settled === "delivered" &&
    updatedDeliveries.every((delivery) => delivery.state === "delivered" && delivery.receipt)
      ? mergeRestartRecoveryTerminalDeliveryEvidence(
          entry.restartRecoveryTerminalDeliveryEvidence,
          [
            {
              runId: sourceRunId,
              ...(evidence?.claim ? { harnessCompletion: evidence.claim } : {}),
              deliveryContext: context,
              captured: true,
              payloads: [{ visible: true }],
              deliveryStatus: {
                status: "sent",
                resultCount: updatedDeliveries.reduce(
                  (count, delivery) => count + (delivery.receipt?.resultCount ?? 0),
                  0,
                ),
              },
              durableFinalReceipt: {
                intentId: input.intentId,
                deliveryId: input.deliveryId,
                platformMessageId: finalReceipt.platformMessageId,
              },
            },
          ],
        )
      : undefined;
  const clearsNotice =
    existingNotice?.state !== "acknowledged" &&
    !updatedDeliveries.some((delivery) => delivery.state === "unknown") &&
    settled !== "queued" &&
    settled !== "unknown" &&
    existingNotice?.intentId === pending.intentId;
  // One resolved sibling cannot erase another's ambiguity or owe an acknowledged notice again.
  if (settled === current && !owedNotice && !clearsNotice && !terminalEvidence) {
    return { patch: null, state: settled, wakeRecovery: false };
  }
  return {
    state: settled,
    wakeRecovery: settled !== "queued" && entry.abortedLastRun === true,
    patch: {
      ...(entry.mainRestartRecovery
        ? {
            mainRestartRecovery: {
              ...entry.mainRestartRecovery,
              revision: entry.mainRestartRecovery.revision + 1,
            },
          }
        : {}),
      pendingFinalDelivery: { ...pending, deliveries: updatedDeliveries },
      ...(clearsNotice ? { pendingDeliveryNotice: undefined } : owedNotice),
      ...(terminalEvidence ? { restartRecoveryTerminalDeliveryEvidence: terminalEvidence } : {}),
    },
  };
}
