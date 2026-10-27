import { applySessionEntryOperation } from "../../config/sessions/session-accessor.sqlite-entry.js";
import { settlePendingFinalDelivery } from "../../infra/outbound/delivery-completion.js";
import { resolveGlobalSingleton } from "../../shared/global-singleton.js";
import {
  getReplyPayloadMetadata,
  type ReplyPayload,
  type ReplyPayloadMetadata,
} from "../reply-payload.js";

type PendingFinalDeliveryIdentity = NonNullable<
  ReplyPayloadMetadata["pendingFinalDeliveryCompletion"]
>;

type PendingFinalDeliveryOptions = { preserveActivity?: boolean };

const terminalReceipts = resolveGlobalSingleton(
  Symbol.for("openclaw.pendingFinalDeliveryReceipts"),
  () =>
    new WeakMap<
      PendingFinalDeliveryIdentity,
      { state: "delivered" | "suppressed"; cleared: boolean }
    >(),
);

/** Channel settlement and dispatcher cleanup share the same committed receipt. */
export async function settleReplyPendingFinalDelivery(
  payload: ReplyPayload,
  state: Parameters<typeof settlePendingFinalDelivery>[1],
  expectedStates?: Parameters<typeof settlePendingFinalDelivery>[2],
): Promise<Awaited<ReturnType<typeof settlePendingFinalDelivery>> | undefined> {
  const metadata = getReplyPayloadMetadata(payload);
  const completion = metadata?.pendingFinalDeliveryCompletion;
  if (!completion) {
    return undefined;
  }
  const cleanup = metadata.pendingFinalDeliveryCleanup;
  const terminal = state === "delivered" || state === "suppressed";
  const receipt = terminalReceipts.get(completion);
  if (receipt && (!terminal || !cleanup || receipt.cleared)) {
    return { state: receipt.state };
  }
  const result = await settlePendingFinalDelivery(
    { kind: "pending-final", ...completion },
    state,
    expectedStates,
    terminal && cleanup
      ? {
          preserveActivity: cleanup.preserveActivity,
          clearAfterSettled: { recoveryRunId: completion.recoveryRunId },
        }
      : undefined,
  );
  if (result.state === "delivered" || result.state === "suppressed") {
    terminalReceipts.set(completion, {
      state: result.state,
      cleared: terminal && Boolean(cleanup),
    });
  }
  return result;
}

export async function suppressPendingFinalDelivery(
  payload: ReplyPayload | undefined,
  options: PendingFinalDeliveryOptions = {},
): Promise<void> {
  const completion = payload
    ? getReplyPayloadMetadata(payload)?.pendingFinalDeliveryCompletion
    : undefined;
  if (completion) {
    await settlePendingFinalDelivery(
      { kind: "pending-final", ...completion },
      "suppressed",
      ["prepared"],
      { ...options, clearAfterSettled: { recoveryRunId: completion.recoveryRunId } },
    );
  }
}

export async function clearPendingFinalDeliveryAfterSuccess(
  identity?: PendingFinalDeliveryIdentity,
  options: PendingFinalDeliveryOptions = {},
): Promise<void> {
  if (!identity) {
    return;
  }
  await applySessionEntryOperation(
    { agentId: identity.agentId, storePath: identity.storePath, sessionKey: identity.sessionKey },
    {
      kind: "pending-final-clear",
      sessionId: identity.sessionId,
      intentId: identity.intentId,
      recoveryRunId: identity.recoveryRunId,
      now: Date.now(),
    },
    {
      result: "none",
      skipMaintenance: true,
      takeCacheOwnership: true,
      preserveActivity: options.preserveActivity,
      workerGuard: {},
    },
  );
}
