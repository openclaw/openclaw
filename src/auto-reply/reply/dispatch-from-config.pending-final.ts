import { applySessionEntryOperation } from "../../config/sessions/session-accessor.sqlite-entry.js";
import { settlePendingFinalDelivery } from "../../infra/outbound/delivery-completion.js";
import {
  getReplyPayloadMetadata,
  type ReplyPayload,
  type ReplyPayloadMetadata,
} from "../reply-payload.js";

type PendingFinalDeliveryIdentity = NonNullable<
  ReplyPayloadMetadata["pendingFinalDeliveryCompletion"]
>;

type PendingFinalDeliveryOptions = { preserveActivity?: boolean };

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
      options,
    );
    await clearPendingFinalDeliveryAfterSuccess(completion, options);
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
      skipMaintenance: true,
      takeCacheOwnership: true,
      preserveActivity: options.preserveActivity,
      workerGuard: {},
    },
  );
}
