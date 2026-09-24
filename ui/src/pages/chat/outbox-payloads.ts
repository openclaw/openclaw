import { t } from "../../i18n/index.ts";
import type { ChatQueueItem } from "../../lib/chat/chat-types.ts";
import {
  outboxPayloadTab,
  observeOutboxRecoveryOwner,
  readOutboxPayload,
  removeOutboxPayloads,
  writeOutboxPayload,
  type OutboxPayloadFailure,
} from "../../lib/chat/outbox-payload-store.runtime.ts";
import {
  storageTargetForGateway,
  type ChatComposerScope,
  type StoredChatOutboxScope,
} from "../../lib/chat/outbox-store.ts";
import { resolveUiConversationIdentity } from "../../lib/sessions/session-key.ts";
import { isIncognitoComposerScope } from "./composer-persistence-state.ts";
import {
  captureDurableChatAttachments,
  readBlobAsDataUrl,
} from "./durable-composer-persistence.ts";

type Host = ChatComposerScope & { sessionKey?: string };
type PayloadUpdate = Pick<ChatQueueItem, "attachments" | "attachmentPayload"> & {
  attachmentStorageError?: undefined;
} & (
    | { sendState: "unconfirmed" | "held"; sendError: string }
    | { sendState?: never; sendError?: never }
  );
type PayloadResult =
  | { status: "ready"; update: PayloadUpdate }
  | { status: "failed"; reason: OutboxPayloadFailure };

export function outboxPayloadError(reason: OutboxPayloadFailure): string {
  return t(
    `chat.sendErrors.outboxPayload${reason === "capacity" ? "Capacity" : reason === "missing" ? "Missing" : "Unavailable"}`,
  );
}

export function failOutboxPayload(item: ChatQueueItem, reason: OutboxPayloadFailure) {
  const attempted =
    (item.sendAttempts ?? 0) > 0 ||
    item.sendRequestStartedAtMs !== undefined ||
    item.sendState === "unconfirmed";
  return {
    ...item,
    attachmentStorageError: reason,
    sendState:
      item.sendState === "held"
        ? ("held" as const)
        : attempted
          ? ("unconfirmed" as const)
          : ("failed" as const),
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
  const recoveryScope = observeOutboxRecoveryOwner(host);
  const incognito = isIncognitoComposerScope(host, scope);
  return () =>
    host.client === client &&
    host.settings?.gatewayUrl === gateway &&
    observeOutboxRecoveryOwner(host) === recoveryScope &&
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
  const recoveryScope = observeOutboxRecoveryOwner(host);
  if (!recoveryScope) {
    return { status: "failed", reason: "unavailable" };
  }
  const isCurrent = captureOutboxPayloadOwner(host, scope);
  let tabId: string;
  try {
    tabId = await outboxPayloadTab();
  } catch {
    return { status: "failed", reason: "unavailable" };
  }
  if (!isCurrent()) {
    return { status: "failed", reason: "unavailable" };
  }
  const owner = {
    tabId,
    gatewayOwner: storageTargetForGateway(host.settings?.gatewayUrl).gatewayOwner,
    recoveryScope,
    queueId: item.id,
  };
  if (item.attachmentPayload) {
    const result = await readOutboxPayload(owner, item.attachmentPayload);
    if (result.status === "failed") {
      return result;
    }
    const metadata = item.attachments ?? [];
    if (
      result.value.length !== metadata.length ||
      result.value.some((attachment, index) => {
        const expected = metadata[index]!;
        return (
          attachment.mimeType !== expected.mimeType ||
          attachment.fileName !== expected.fileName ||
          attachment.origin !== expected.origin ||
          attachment.sizeBytes !== expected.sizeBytes
        );
      })
    ) {
      return { status: "failed", reason: "missing" };
    }
    if (!isCurrent()) {
      return { status: "failed", reason: "unavailable" };
    }
    try {
      // Restore into isolated objects; no consumer sees a partially hydrated batch.
      const attachments = await Promise.all(
        result.value.map(async (attachment, index) => ({
          ...metadata[index]!,
          ...(attachment.selectionAnnotation
            ? { selectionAnnotation: attachment.selectionAnnotation }
            : {}),
          dataUrl: await readBlobAsDataUrl(attachment.blob),
        })),
      );
      if (!isCurrent()) {
        return { status: "failed", reason: "unavailable" };
      }
      const update = {
        attachments,
        attachmentPayload: item.attachmentPayload,
        attachmentStorageError: undefined,
      };
      if (purpose === "send" && item.attachmentPayload.tabId !== tabId) {
        const copy = await writeOutboxPayload(owner, result.value);
        if (copy.status === "failed") {
          return copy;
        }
        if (!isCurrent()) {
          await removeOutboxPayloads([copy.value]);
          return { status: "failed", reason: "unavailable" };
        }
        // A duplicate tab carries the same submission, never a fresh send. It
        // owns its copied bytes, but needs explicit review before retrying.
        return {
          status: "ready",
          update: {
            ...update,
            attachmentPayload: copy.value,
            sendState: item.sendState === "held" ? "held" : "unconfirmed",
            sendError: t("chat.sendErrors.outboxPayloadCopied"),
          },
        };
      }
      return { status: "ready", update };
    } catch {
      return { status: "failed", reason: "missing" };
    }
  }
  // Delivery already happened: read existing bytes, never allocate a new bundle.
  if (purpose === "handoff" || item.attachmentStorageError === "missing") {
    return { status: "failed", reason: "missing" };
  }
  const attachments = captureDurableChatAttachments(item.attachments ?? []);
  if (!attachments) {
    return { status: "failed", reason: "missing" };
  }
  const result = await writeOutboxPayload(owner, attachments);
  if (result.status === "failed") {
    return result;
  }
  if (!isCurrent()) {
    await removeOutboxPayloads([result.value]);
    return { status: "failed", reason: "unavailable" };
  }
  return {
    status: "ready",
    update: { attachmentPayload: result.value, attachmentStorageError: undefined },
  };
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
  if (!reference || isIncognitoComposerScope(host, scope) || !observeOutboxRecoveryOwner(host)) {
    return preparePayload(host, item, purpose);
  }
  const key = JSON.stringify([
    item.id,
    reference.key,
    reference.tabId,
    reference.recoveryScope,
    scope,
    host.settings?.gatewayUrl,
    host.client?.recoveryScope,
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
