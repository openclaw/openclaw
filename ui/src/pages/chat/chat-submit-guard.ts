import type { ChatAttachment, ChatQueueItem } from "../../lib/chat/chat-types.ts";
import { sameQueuedDeliveryVersion } from "../../lib/chat/outbox-store-codec.ts";
import {
  storedChatOutboxScopeKey,
  type StoredChatOutboxScope,
} from "../../lib/chat/outbox-store-scope.ts";
import { visibleSessionMatches } from "../../lib/sessions/index.ts";
import { resolveUiConversationIdentity } from "../../lib/sessions/session-key.ts";
import { generateUUID } from "../../lib/uuid.ts";
import { isInitialChatHistoryUnavailable } from "./chat-history-state.ts";
import type { QueuedChatSendResult } from "./chat-outbox-drain.ts";
import { chatOutboxOwner } from "./chat-outbox-owner.ts";
import { readQueuedMessageById } from "./chat-queue.ts";
import type { ChatHost } from "./chat-send-contract.ts";
import { chatAttachmentDraftSignature } from "./durable-composer-persistence.ts";
import { hasDirectSessionRun, isChatBusy } from "./run-lifecycle.ts";

const submissionActionIds = new WeakMap<Event, string>();
type AttachmentAdmission = {
  signatures: ReadonlySet<string>;
  isCurrent(): boolean;
};
const pendingAttachmentAdmissions = new WeakMap<ChatHost, Set<AttachmentAdmission>>();

export type ChatSubmitGuard = {
  releaseAttachments(): void;
  canRetireAttachment(attachment: ChatAttachment): boolean;
};

function yieldChatSubmitToInput(): Promise<void> {
  return new Promise<void>((resolve) => {
    const channel = new MessageChannel();
    channel.port1.addEventListener(
      "message",
      () => {
        channel.port1.close();
        channel.port2.close();
        resolve();
      },
      { once: true },
    );
    channel.port1.start();
    channel.port2.postMessage(undefined);
  });
}

export async function withChatSubmitHandoff(
  host: ChatHost,
  queued: ChatQueueItem,
  options: {
    yieldToInput: boolean;
    isCurrent: () => boolean;
    allowActiveRunSend: boolean;
    pendingSettings?: Promise<boolean>;
  },
  deliver: (item: ChatQueueItem) => Promise<QueuedChatSendResult>,
): Promise<QueuedChatSendResult> {
  const yieldsToInput = options.yieldToInput && typeof MessageChannel !== "undefined";
  const startsImmediately =
    yieldsToInput &&
    options.isCurrent() &&
    host.connected &&
    host.client &&
    !host.chatLoading &&
    !isInitialChatHistoryUnavailable(host) &&
    !options.pendingSettings &&
    queued.sendState === "waiting-idle" &&
    (queued.queueMode ||
      (options.allowActiveRunSend && !queued.intent) ||
      (!isChatBusy(host) &&
        !hasDirectSessionRun(host) &&
        host.chatQueue.find((item) => item.sendState !== "failed" || item.localCommandName)?.id ===
          queued.id));
  // Admission is durable, but delivery has not made a transport attempt yet.
  // Present that handoff inline without flashing the waiting-message tray.
  const submission =
    yieldsToInput && host.connected && options.isCurrent()
      ? chatOutboxOwner(host).beginSubmission(host, queued.id, {
          inline: Boolean(startsImmediately),
          isCurrent: () => host.connected && options.isCurrent(),
        })
      : undefined;
  try {
    let current = queued;
    if (yieldsToInput) {
      // The shared outbox retains foreground custody while the browser accepts
      // input, including when terminal history settles before this task resumes.
      await yieldChatSubmitToInput();
      const pending =
        options.isCurrent() && visibleSessionMatches(host, queued.sessionKey!, queued.agentId)
          ? readQueuedMessageById(host, queued.id)
          : null;
      // Only position changes preserve the handoff; the drain owns ordering/edit holds.
      if (
        !pending ||
        !sameQueuedDeliveryVersion(queued, {
          ...pending,
          sendState: pending.sendState === "submitting" ? "waiting-idle" : pending.sendState,
          orderKey: queued.orderKey,
        })
      ) {
        return "pending";
      }
      current = pending;
    }
    return await deliver(current);
  } finally {
    submission?.release();
  }
}

export async function withChatSubmitGuard<T>(
  host: ChatHost,
  key: string,
  options: {
    action?: Event;
    attachments?: readonly ChatAttachment[];
    scope: StoredChatOutboxScope;
    isCurrent(): boolean;
  },
  run: (guard: ChatSubmitGuard) => Promise<T>,
): Promise<T | undefined> {
  let guardKey = key;
  const { action, scope } = options;
  if (action) {
    const actionId = submissionActionIds.get(action) ?? generateUUID();
    submissionActionIds.set(action, actionId);
    guardKey = `${key}\0${actionId}`;
  }
  const guards = (host.chatSubmitGuards ??= new Set<string>());
  if (guards.has(guardKey)) {
    return undefined;
  }
  guards.add(guardKey);
  const scopeKey = storedChatOutboxScopeKey(scope);
  const attachments: AttachmentAdmission = {
    signatures: new Set(
      options.attachments?.map((attachment) => chatAttachmentDraftSignature("", [attachment])),
    ),
    isCurrent: () =>
      options.isCurrent() &&
      storedChatOutboxScopeKey(resolveUiConversationIdentity(host, host.sessionKey)) === scopeKey,
  };
  let pending = pendingAttachmentAdmissions.get(host);
  if (attachments.signatures.size) {
    pending ??= new Set();
    pending.add(attachments);
    pendingAttachmentAdmissions.set(host, pending);
  }
  const releaseAttachments = () => {
    if (!pending?.delete(attachments)) {
      return;
    }
    if (!pending.size) {
      pendingAttachmentAdmissions.delete(host);
    }
  };
  try {
    return await run({
      releaseAttachments,
      canRetireAttachment: (attachment) => {
        const signature = chatAttachmentDraftSignature("", [attachment]);
        return (
          attachments.isCurrent() &&
          attachments.signatures.has(signature) &&
          ![...(pendingAttachmentAdmissions.get(host) ?? [])].some(
            (claim) => claim.isCurrent() && claim.signatures.has(signature),
          )
        );
      },
    });
  } finally {
    releaseAttachments();
    guards.delete(guardKey);
  }
}
