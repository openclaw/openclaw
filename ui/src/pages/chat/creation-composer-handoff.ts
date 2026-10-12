import { t } from "../../i18n/index.ts";
import { registerNewSessionSetupEnglish } from "../../i18n/locales/en-new-session-setup.ts";
import { chatQueueOrderKey } from "../../lib/chat/chat-queue-order.ts";
import type { ChatQueueItem } from "../../lib/chat/chat-types.ts";
import { resolveCurrentUserIdentity } from "../../lib/chat/current-user-identity.ts";
import { sameQueuedDeliveryVersion } from "../../lib/chat/outbox-store-codec.ts";
import { captureChatOutboxAdmission } from "../../lib/chat/outbox-store.ts";
import { formatUiError } from "../../lib/format-error.ts";
import { areUiSessionKeysEquivalent } from "../../lib/sessions/session-key.ts";
import { generateUUID } from "../../lib/uuid.ts";
import type { CreationComposerTransfer } from "../new-session/creation-composer.ts";
import { setChatError } from "./chat-history-state.ts";
import { chatOutboxOwner } from "./chat-outbox-owner.ts";
import { resumeStoredChatOutboxes } from "./chat-send-actions.ts";
import type { ChatHost } from "./chat-send-contract.ts";
import { formatChatQueueAdmissionError } from "./chat-send-support.ts";
import {
  captureOutboxPayloadOwner,
  outboxPayloadError,
  prepareOutboxPayload,
  retireOutboxPayload,
} from "./outbox-payloads.ts";

registerNewSessionSetupEnglish();

const stagedTransfers = new WeakMap<
  CreationComposerTransfer,
  { owner: ReturnType<typeof chatOutboxOwner>; host: ChatHost }
>();
const transferAdmissions = new WeakMap<CreationComposerTransfer, Promise<boolean>>();

export function admitCreatedComposerQueue(
  host: ChatHost,
  transfer: CreationComposerTransfer,
): Promise<boolean> {
  const previous = transferAdmissions.get(transfer);
  let complete = false;
  const admission = (
    previous
      ? previous.then(
          (settled) => settled || performCreatedComposerAdmission(host, transfer),
          () => performCreatedComposerAdmission(host, transfer),
        )
      : performCreatedComposerAdmission(host, transfer)
  )
    .then((settled) => {
      complete = settled;
      return settled;
    })
    .finally(() => {
      if (!complete && transferAdmissions.get(transfer) === admission) {
        transferAdmissions.delete(transfer);
      }
    });
  transferAdmissions.set(transfer, admission);
  return admission;
}

/** Called only after a created destination claims the draft's one-shot handoff. */
async function performCreatedComposerAdmission(
  host: ChatHost,
  transfer: CreationComposerTransfer,
): Promise<boolean> {
  if (!transfer.inputs.length) {
    transfer.complete();
    return true;
  }
  if (
    !areUiSessionKeysEquivalent(host.sessionKey, transfer.sessionKey) ||
    !transfer.isCurrent() ||
    !host.connected ||
    !host.client?.recoveryScopeReady
  ) {
    return false;
  }
  const sessionKey = transfer.sessionKey;
  const owner = chatOutboxOwner(host);
  const captured = captureChatOutboxAdmission(host, sessionKey);
  const ownsPayloads = captureOutboxPayloadOwner(host, captured.scope);
  const client = host.client;
  const current = () =>
    transfer.isCurrent() &&
    areUiSessionKeysEquivalent(host.sessionKey, sessionKey) &&
    host.connected &&
    host.client === client &&
    client.recoveryScopeReady &&
    ownsPayloads() &&
    stagedTransfers.get(transfer)?.host === host;
  const stagedOwner = stagedTransfers.get(transfer);
  if (stagedOwner && stagedOwner.owner !== owner) {
    return false;
  }
  // Install the entire ordered batch before the first asynchronous payload write.
  // Held rows are never drainable, including a reload halfway through transfer.
  if (!stagedOwner) {
    let unsubscribe = () => {};
    owner.admissions.hold(
      captured.scope,
      transfer.inputs.map((input) => input.id),
      () => {
        unsubscribe();
        transfer.complete();
      },
    );
    // Revocation retires the transient barrier, not another account’s stored input.
    unsubscribe = transfer.onInvalidate(() => {
      for (const input of transfer.inputs) {
        owner.admissions.release(input.id);
      }
    });
    const sender = resolveCurrentUserIdentity(host.hello, client?.instanceId, host.selfUser);
    const existing = owner.snapshot(host, captured.scope);
    const firstOrder =
      existing.length && !transfer.initialRejected
        ? Math.min(...existing.map(chatQueueOrderKey)) - transfer.inputs.length
        : undefined;
    transfer.inputs.forEach((input, index) =>
      owner.keep(
        host,
        captured.scope,
        {
          ...input,
          ...captured.scope,
          ...(firstOrder !== undefined ? { orderKey: firstOrder + index } : {}),
          sessionId: transfer.sessionId,
          sendRunId: generateUUID(),
          sendAttempts: 0,
          sendState: "held",
          ...(sender ? { sender } : {}),
          sendError: transfer.initialRejected ? t("newSession.followUpsPaused") : undefined,
        },
        true,
      ),
    );
    stagedTransfers.set(transfer, { owner, host });
  } else if (stagedOwner.host !== host) {
    for (const input of transfer.inputs) {
      const retained = owner.locate(stagedOwner.host, input.id);
      if (retained && !retained.durable) {
        owner.keep(host, retained.scope, retained.item, true);
        owner.change(stagedOwner.host, input.id);
      }
    }
    stagedOwner.host = host;
  }
  const staged = transfer.inputs.flatMap((input) => {
    const item = owner.locate(host, input.id)?.item;
    return item ? [item] : [];
  });
  const admitted: string[] = [];
  let failure: string | undefined;
  for (const item of staged) {
    if (!current()) {
      return false;
    }
    if (owner.locate(host, item.id)?.durable) {
      admitted.push(item.id);
      continue;
    }
    try {
      const payload = await prepareOutboxPayload(host, item);
      const retained = current() ? owner.locate(host, item.id)?.item : undefined;
      if (!current() || !retained || !sameQueuedDeliveryVersion(retained, item)) {
        if (payload.status === "ready") {
          retireOutboxPayload(payload.update);
        }
        if (!current()) {
          return false;
        }
        continue;
      }
      if (payload.status === "failed") {
        failure = outboxPayloadError(payload.reason);
        owner.change(host, item.id, (entry) => ({ ...entry, sendError: failure }), true);
        continue;
      }
      const prepared = { ...item, ...payload.update };
      const result = owner.admit(host, captured, prepared);
      if (result !== "admitted") {
        retireOutboxPayload(prepared);
        failure = formatChatQueueAdmissionError(result, false);
        owner.change(
          host,
          item.id,
          (entry) => ({ ...entry, attachmentPayload: undefined, sendError: failure }),
          true,
        );
      } else {
        admitted.push(item.id);
      }
    } catch (error) {
      failure = formatUiError(error);
      if (current()) {
        owner.change(host, item.id, (entry) => ({ ...entry, sendError: failure }), true);
      }
    }
  }
  if (!current()) {
    return false;
  }
  if (failure) {
    // Never auto-send a later follower past an input that could not enter the outbox.
    setChatError(host, failure);
  } else if (!transfer.initialRejected) {
    const updates = admitted
      .filter((id) => owner.locate(host, id))
      .map((id) => ({
        id,
        update: (item: ChatQueueItem): ChatQueueItem => ({
          ...item,
          sendState: "waiting-idle",
          sendError: undefined,
        }),
      }));
    if (updates.length && !owner.update(host, updates)) {
      setChatError(host, t("newSession.followUpsAdmissionFailed"));
    } else {
      // The normal history/run/placement gates, not create's reply, decide delivery readiness.
      void resumeStoredChatOutboxes(host);
    }
  }
  host.requestUpdate?.();
  return true;
}
