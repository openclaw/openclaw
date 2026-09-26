import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { chatQueueOrderKey, isMovableChatQueueItem } from "../../lib/chat/chat-queue-order.ts";
import type { ChatAttachment, ChatQueueItem, HumanMention } from "../../lib/chat/chat-types.ts";
import { updateHumanMentions } from "../../lib/chat/human-mentions.ts";
import { sameQueuedDeliveryVersion } from "../../lib/chat/outbox-store-codec.ts";
import { storageTargetForGateway } from "../../lib/chat/outbox-store.ts";
import { resolveUiConversationIdentity } from "../../lib/sessions/session-key.ts";
import {
  getChatAttachmentDataUrl,
  releaseDisplacedChatAttachmentPayloads,
} from "./attachment-payload-store.ts";
import { chatOutboxOwner } from "./chat-outbox-owner.ts";
import {
  anyChatOutboxPaneMatches,
  readQueuedMessageById,
  type ChatQueueScopedSessionHost,
} from "./chat-queue.ts";
import { storedChatOutboxScopeKey } from "./composer-persistence.ts";

/** The queued row retains its position and payloads while this token owns the draft. */
export type QueuedMessageEdit = {
  readonly agentId?: string;
  readonly gatewayOwner: string;
  readonly recoveryScope?: string;
  attachments: readonly ChatAttachment[];
  draftText: string;
  mentions?: readonly HumanMention[];
  id: string;
  orderKey: number;
  revision: number;
  replyToId?: string;
  readonly sessionKey: string;
  source: ChatQueueItem;
  sourceWasDurable: boolean;
};

type QueuedMessageEditHost = ChatQueueScopedSessionHost & {
  client?: Pick<GatewayBrowserClient, "recoveryScope" | "recoveryScopeReady"> | null;
  connected?: boolean;
  chatQueuedEdit?: QueuedMessageEdit | null;
};

function currentQueuedMessageEditOwner(host: QueuedMessageEditHost) {
  // Recovery resolves after hello. While offline, the client retains its last
  // authenticated scope; a replacement client must establish its own scope.
  if (host.connected && host.client && !host.client.recoveryScopeReady) {
    return null;
  }
  return {
    ...resolveUiConversationIdentity(host, host.sessionKey),
    gatewayOwner: storageTargetForGateway(host.settings?.gatewayUrl).gatewayOwner,
    recoveryScope: host.client?.recoveryScope?.trim() || undefined,
  };
}

/** Closed outcomes so the page owns the operator-visible wording. */
type QueuedMessageEditResult = "started" | "unavailable";

export const QUEUED_MESSAGE_EDIT_CONFLICT_ERROR =
  "A queued message is being edited in another pane. Finish or cancel that edit before editing it here.";
export const QUEUED_MESSAGE_REMOVAL_CONFLICT_ERROR =
  "A queued message is being edited in another pane. Finish or cancel that edit before removing it.";
export const QUEUED_MESSAGE_REORDER_CONFLICT_ERROR =
  "A queued message is being edited in another pane. Finish or cancel that edit before reordering it.";
export const QUEUED_MESSAGE_RETRY_CONFLICT_ERROR =
  "A queued message is being edited in another pane. Finish or cancel that edit before retrying it.";
export const QUEUED_MESSAGE_STEER_CONFLICT_ERROR =
  "A queued message is being edited in another pane. Finish or cancel that edit before steering it.";

/** Captured destinations and recovery owners never follow live alias/default changes. */
export function activeQueuedMessageEdit(host: QueuedMessageEditHost): QueuedMessageEdit | null {
  const edit = host.chatQueuedEdit;
  const owner = currentQueuedMessageEditOwner(host);
  if (
    !edit ||
    !owner ||
    edit.gatewayOwner !== owner.gatewayOwner ||
    edit.recoveryScope !== owner.recoveryScope ||
    storedChatOutboxScopeKey(edit) !== storedChatOutboxScopeKey(owner)
  ) {
    return null;
  }
  // Custody outlives a source-version conflict. Admission checks the captured
  // version; reading/rendering the correction must never discard unsaved text.
  return edit;
}

/** Every pane must observe the edit hold because any pane can drain the shared outbox. */
export function isQueuedMessageBeingEdited(
  host: ChatQueueScopedSessionHost & Pick<QueuedMessageEditHost, "chatQueuedEdit">,
  id: string,
): boolean {
  // Credentials fence edit actions, but a pane still on the captured conversation
  // holds its source against a peer drain until the correction is released.
  const gatewayOwner = storageTargetForGateway(host.settings?.gatewayUrl).gatewayOwner;
  return anyChatOutboxPaneMatches(
    host,
    (pane) =>
      pane.chatQueuedEdit?.id === id &&
      pane.chatQueuedEdit.gatewayOwner === gatewayOwner &&
      storedChatOutboxScopeKey(pane.chatQueuedEdit) ===
        storedChatOutboxScopeKey(resolveUiConversationIdentity(pane, pane.sessionKey)),
  );
}

export function beginQueuedMessageEdit(
  host: QueuedMessageEditHost,
  id: string,
): QueuedMessageEditResult {
  const owner = currentQueuedMessageEditOwner(host);
  const item = readQueuedMessageById(host, id);
  // Local slash commands take a different enqueue path that cannot carry a
  // resumed position, so they keep the discard-and-retype flow for now.
  if (
    !owner ||
    !item ||
    !isMovableChatQueueItem(item) ||
    Boolean(item.attachmentStorageError) ||
    Boolean(item.attachments?.some((attachment) => !getChatAttachmentDataUrl(attachment))) ||
    item.localCommandName ||
    activeQueuedMessageEdit(host) ||
    isQueuedMessageBeingEdited(host, id)
  ) {
    return "unavailable";
  }
  // Keep the queued row held while its correction stays separate from the main composer.
  host.chatQueuedEdit = {
    ...owner,
    attachments: item.attachments ?? [],
    draftText: item.text,
    mentions: item.mentions,
    id,
    orderKey: chatQueueOrderKey(item),
    revision: 0,
    ...(item.replyToId ? { replyToId: item.replyToId } : {}),
    source: { ...item },
    sourceWasDurable: chatOutboxOwner(host).durable(host, id) !== undefined,
  };
  return "started";
}

export function updateQueuedMessageEdit(
  host: QueuedMessageEditHost,
  draftText: string,
  mentions?: readonly HumanMention[],
): boolean {
  const edit = activeQueuedMessageEdit(host);
  if (!edit) {
    return false;
  }
  edit.mentions = mentions ?? updateHumanMentions(edit.draftText, draftText, edit.mentions);
  edit.draftText = draftText;
  edit.revision += 1;
  return true;
}

export function cancelQueuedMessageEdit(host: QueuedMessageEditHost): boolean {
  const edit = activeQueuedMessageEdit(host);
  if (!edit) {
    return false;
  }
  // The durable row still owns its payloads; cancellation releases no attachments.
  host.chatQueuedEdit = null;
  return true;
}

/** Retire the projection only after durable replacement, or while the source is still volatile. */
export function retireEditedQueuedMessageSource(
  host: QueuedMessageEditHost,
  admittedDurably: boolean,
  nextAttachments: readonly ChatAttachment[] = [],
  editOverride?: QueuedMessageEdit,
): void {
  const edit = editOverride ?? activeQueuedMessageEdit(host);
  if (editOverride && host.chatQueuedEdit !== edit) {
    return;
  }
  if (!edit) {
    return;
  }
  if (!admittedDurably) {
    const source = readQueuedMessageById(host, edit.id);
    if (
      edit.sourceWasDurable ||
      chatOutboxOwner(host).durable(host, edit.id) !== undefined ||
      !source ||
      !sameQueuedDeliveryVersion(source, edit.source)
    ) {
      return;
    }
  }
  host.chatQueuedEdit = null;
  chatOutboxOwner(host).remove(host, edit.id);
  // Read payloads from the token: durable admission already retired the stored row.
  releaseDisplacedChatAttachmentPayloads(edit.attachments, [nextAttachments]);
}
