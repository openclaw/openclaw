import { readOfflineStorageScope } from "../../app/boot-record.ts";
import { t } from "../../i18n/index.ts";
import type { ChatQueueItem } from "../../lib/chat/chat-types.ts";
import {
  removeOutboxPayloads,
  type OutboxPayloadFailure,
} from "../../lib/chat/outbox-payload-store.runtime.ts";
import type { StoredChatOutboxScope } from "../../lib/chat/outbox-store-scope.ts";
import { storageTargetForGateway, type ChatComposerScope } from "../../lib/chat/outbox-store.ts";
import { resolveUiConversationIdentity } from "../../lib/sessions/session-key.ts";
import { isIncognitoComposerScope } from "./composer-persistence-state.ts";

type Host = ChatComposerScope & { sessionKey?: string };
type PayloadUpdate = Pick<ChatQueueItem, "attachments" | "attachmentPayload"> & {
  attachmentStorageError?: undefined;
};
export type PayloadResult =
  | { status: "ready"; update: PayloadUpdate }
  | { status: "failed"; reason: OutboxPayloadFailure };

export function outboxPayloadError(reason: OutboxPayloadFailure): string {
  return t(
    `chat.sendErrors.outboxPayload${reason === "capacity" ? "Capacity" : reason === "missing" ? "Missing" : "Unavailable"}`,
  );
}

export function failOutboxPayload(item: ChatQueueItem, reason: OutboxPayloadFailure) {
  const awaitingDelivery =
    item.sendState !== "failed" &&
    ((item.sendAttempts ?? 0) > 0 || item.sendRequestStartedAtMs !== undefined);
  return {
    ...item,
    attachmentStorageError: reason,
    // Missing local bytes cannot settle an earlier transport attempt or release its FIFO slot.
    sendState:
      item.sendState === "held" || awaitingDelivery ? ("held" as const) : ("failed" as const),
    sendError: outboxPayloadError(reason),
  };
}

function payloadScope(host: Host, item?: ChatQueueItem) {
  return resolveUiConversationIdentity(
    host,
    item?.sessionKey ?? host.sessionKey ?? "",
    item?.agentId,
  );
}

export function captureOutboxPayloadOwner(
  host: Host,
  scope: StoredChatOutboxScope = payloadScope(host),
): () => boolean {
  const client = host.client;
  const gateway = host.settings?.gatewayUrl;
  const recoveryScope = readOfflineStorageScope(host);
  const incognito = isIncognitoComposerScope(host, scope);
  return () =>
    host.client === client &&
    host.settings?.gatewayUrl === gateway &&
    readOfflineStorageScope(host) === recoveryScope &&
    isIncognitoComposerScope(host, scope) === incognito;
}

async function preparePayload(
  host: Host,
  item: ChatQueueItem,
  purpose: "send" | "handoff",
): Promise<PayloadResult> {
  if (!item.attachments?.length && !item.attachmentPayload && !item.attachmentStorageError) {
    return { status: "ready", update: {} };
  }
  // Incognito keeps the existing tab-only inline outbox and its quota. It must
  // never acquire restart-persistent Blob ownership or hydrate a regular row.
  const scope = payloadScope(host, item);
  if (isIncognitoComposerScope(host, scope)) {
    return item.attachmentPayload
      ? { status: "failed", reason: "unavailable" }
      : { status: "ready", update: {} };
  }
  const recoveryScope = readOfflineStorageScope(host);
  if (!recoveryScope) {
    return { status: "failed", reason: "unavailable" };
  }
  const isCurrent = captureOutboxPayloadOwner(host, scope);
  const gatewayOwner = storageTargetForGateway(host.settings?.gatewayUrl).gatewayOwner;
  const capturedItem = {
    ...item,
    attachments: item.attachments?.map((attachment) => ({ ...attachment })),
    attachmentPayload: item.attachmentPayload ? { ...item.attachmentPayload } : undefined,
  };
  try {
    const { prepareCapturedOutboxPayload } = await import("./outbox-payloads.runtime.ts");
    return await prepareCapturedOutboxPayload(
      capturedItem,
      purpose,
      gatewayOwner,
      recoveryScope,
      isCurrent,
    );
  } catch {
    return { status: "failed", reason: "unavailable" };
  }
}

// Preview and drain share reads/copies so a cloned tab cannot create competing refs.
// Check admission per caller; only equivalent bundle identities and metadata may join.
// Share attachment updates, never the first caller's delivery state or captured destination.
const pendingPayloads = new Map<string, Promise<PayloadResult>>();
export async function prepareOutboxPayload(
  host: Host,
  item: ChatQueueItem,
  purpose: "send" | "handoff" = "send",
): Promise<PayloadResult> {
  const reference = item.attachmentPayload;
  const scope = payloadScope(host, item);
  if (!reference || isIncognitoComposerScope(host, scope) || !readOfflineStorageScope(host)) {
    return preparePayload(host, item, purpose);
  }
  const key = JSON.stringify([
    item.id,
    reference.key,
    reference.tabId,
    reference.recoveryScope,
    scope,
    host.settings?.gatewayUrl,
    readOfflineStorageScope(host),
    purpose,
    item.attachments?.map(({ mimeType, fileName, sizeBytes, origin }) => [
      mimeType,
      fileName,
      sizeBytes,
      origin,
    ]),
  ]);
  const isCurrent = captureOutboxPayloadOwner(host, scope);
  let pending = pendingPayloads.get(key);
  if (!pending) {
    pending = preparePayload(host, item, purpose).finally(() => pendingPayloads.delete(key));
    pendingPayloads.set(key, pending);
  }
  const result = await pending;
  if (!isCurrent()) {
    return { status: "failed", reason: "unavailable" };
  }
  return result;
}

export function retireOutboxPayload(item: Pick<ChatQueueItem, "attachmentPayload">): void {
  if (item.attachmentPayload) {
    void removeOutboxPayloads([item.attachmentPayload]);
  }
}
