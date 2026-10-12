import { mergeRestartRecoveryTerminalDeliveryEvidence } from "./restart-recovery-state.js";
import type { HarnessCompletionRecovery } from "./restart-recovery-types.js";
import type { InternalSessionEntry } from "./types.js";

type PendingFinalDelivery = NonNullable<InternalSessionEntry["pendingFinalDelivery"]>;
type PendingFinalDeliveryState = NonNullable<PendingFinalDelivery["deliveries"]>[number]["state"];

export type PendingFinalDeliverySettlementInput = {
  sessionId: string;
  intentId: string;
  deliveryId: string;
  state: PendingFinalDeliveryState;
  expectedStates?: readonly ("prepared" | "queued" | "unknown")[];
};

/** Harness evidence reaches this reducer only after the host validates its live claim. */
export function projectPendingFinalDeliverySettlement(
  entry: InternalSessionEntry,
  input: PendingFinalDeliverySettlementInput,
  evidence?: {
    claim: HarnessCompletionRecovery;
    result?: { channel: string; target?: { id: string }; platformMessageId?: string };
  },
): {
  patch: Partial<InternalSessionEntry> | null;
  state: PendingFinalDeliveryState | "stale";
  wakeRecovery: boolean;
} {
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
    (current === "queued" || current === "unknown") &&
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
  const updatedDeliveries = deliveries.with(index, { id: input.deliveryId, state: settled });
  const result = evidence?.result;
  const platformMessageId = result?.platformMessageId;
  const context = pending.context;
  // The exact claim receipt commits with delivery completion before queue acknowledgment.
  const terminalEvidence =
    evidence &&
    result &&
    platformMessageId &&
    result.channel === context?.channel &&
    context?.to &&
    (!result.target || result.target.id === context.to) &&
    settled === "delivered" &&
    updatedDeliveries.every((delivery) => delivery.state === "delivered")
      ? mergeRestartRecoveryTerminalDeliveryEvidence(
          entry.restartRecoveryTerminalDeliveryEvidence,
          [
            {
              runId: evidence.claim.sourceRunId,
              harnessCompletion: evidence.claim,
              deliveryContext: context,
              captured: true,
              payloads: [{ visible: true }],
              deliveryStatus: { status: "sent", resultCount: 1 },
              durableFinalReceipt: {
                intentId: input.intentId,
                deliveryId: input.deliveryId,
                platformMessageId,
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
