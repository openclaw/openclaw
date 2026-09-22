import type { ChatAttachment, ChatQueueItem, HumanMention } from "../../lib/chat/chat-types.ts";
import type { StoredChatOutboxScope } from "../../lib/chat/outbox-store.ts";
import { visibleSessionMatches } from "../../lib/sessions/index.ts";
import {
  getChatAttachmentDataUrl,
  releaseChatAttachmentPayloads,
  releaseDisplacedChatAttachmentPayloads,
} from "./attachment-payload-store.ts";
import {
  captureChatComposerMemoryFallbackOwnership,
  clearChatComposerMemoryFallback,
  ownsChatComposerMemoryFallback,
  retainChatComposerMemoryFallback,
  type ChatComposerMemoryFallbackOwnership,
} from "./chat-composer-memory-fallback.ts";
import { excludeComposerAttachments, removeQueuedMessageWithoutReleasing } from "./chat-queue.ts";
import type { ChatComposerRecoveryOwner, ChatHost } from "./chat-send-contract.ts";
import type { ChatPageHost } from "./chat-state-host.ts";
import { chatAttachmentDraftSignature } from "./durable-composer-persistence.ts";
import { resetChatInputHistoryNavigation } from "./input-history.ts";

export function chatSubmitKey(
  host: ChatHost,
  kind: "detached" | "local" | "message" | "queued-edit" | "goal",
  message: string,
  attachments: ChatAttachment[],
  mentions?: readonly HumanMention[],
): string {
  return JSON.stringify([
    kind,
    host.sessionKey,
    chatAttachmentDraftSignature(message.trim(), attachments, undefined, mentions),
  ]);
}

export function clearSubmittedComposerState(
  host: ChatHost,
  submittedDraft: string,
  submittedAttachments: ChatAttachment[],
  submittedMentions: readonly HumanMention[] | undefined,
  preserveAnnotations = false,
) {
  if (
    chatAttachmentDraftSignature(
      host.chatMessage,
      host.chatAttachments,
      undefined,
      host.chatMentions,
    ) !==
    chatAttachmentDraftSignature(submittedDraft, submittedAttachments, undefined, submittedMentions)
  ) {
    return {};
  }
  host.chatMessage = "";
  host.chatMentions = [];
  host.chatAttachments = preserveAnnotations
    ? host.chatAttachments.filter(
        (attachment) => attachment.browserAnnotation || attachment.selectionAnnotation,
      )
    : [];
  resetChatInputHistoryNavigation(host);
  return {
    previousAttachments: submittedAttachments,
    previousDraft: submittedDraft,
    previousMentions: submittedMentions,
  };
}

export function snapshotChatAttachments(attachments: readonly ChatAttachment[]): ChatAttachment[] {
  return attachments.map((attachment) => {
    const dataUrl = getChatAttachmentDataUrl(attachment);
    return { ...attachment, ...(dataUrl ? { dataUrl } : {}) };
  });
}

export type ChatCommandComposerRecovery = {
  client: ChatHost["client"];
  clientGeneration: number | undefined;
  owner?: ChatComposerRecoveryOwner;
  composer?: {
    attachments: ChatAttachment[];
    draft: string;
    mentions?: readonly HumanMention[];
    fallbackOwnership?: ChatComposerMemoryFallbackOwnership;
  };
  connectionEpoch: ChatHost["connectionEpoch"];
  scope: StoredChatOutboxScope;
};

function chatCommandRecoveryHost(host: ChatHost): ChatPageHost | undefined {
  return "chatComposerFallbackByScope" in host &&
    typeof host.chatComposerFallbackByScope === "object" &&
    host.chatComposerFallbackByScope !== null
    ? (host as ChatPageHost)
    : undefined;
}

export function captureChatCommandComposerRecovery(
  host: ChatHost,
  scope: StoredChatOutboxScope,
  composer?: { draft: string; mentions?: readonly HumanMention[]; attachments: ChatAttachment[] },
): ChatCommandComposerRecovery {
  const fallbackHost = chatCommandRecoveryHost(host);
  return {
    client: host.client,
    clientGeneration: host.client?.connectionGeneration,
    owner: host.captureComposerRecoveryOwner?.(),
    ...(composer
      ? {
          composer: {
            ...composer,
            ...(fallbackHost
              ? {
                  fallbackOwnership: captureChatComposerMemoryFallbackOwnership(
                    fallbackHost,
                    scope,
                    {
                      message: composer.draft,
                      mentions: composer.mentions,
                      attachments: composer.attachments,
                    },
                  ),
                }
              : {}),
          },
        }
      : {}),
    connectionEpoch: host.connectionEpoch,
    scope,
  };
}

export function submittedCommandConnectionIsCurrent(
  host: ChatHost,
  recovery: ChatCommandComposerRecovery,
): boolean {
  return (
    host.client === recovery.client &&
    host.connectionEpoch === recovery.connectionEpoch &&
    host.client?.connectionGeneration === recovery.clientGeneration
  );
}

export function submittedCommandScopeIsVisible(
  host: ChatHost,
  recovery: ChatCommandComposerRecovery,
): boolean {
  return (
    submittedCommandConnectionIsCurrent(host, recovery) &&
    visibleSessionMatches(host, recovery.scope.sessionKey, recovery.scope.agentId)
  );
}

export function clearOwnedCommandComposerFallback(
  host: ChatHost,
  recovery: ChatCommandComposerRecovery,
): boolean {
  const ownership = recovery.composer?.fallbackOwnership;
  const owner = recovery.owner ? recovery.owner.resolveOwner() : host;
  if (
    !owner ||
    !submittedCommandConnectionIsCurrent(host, recovery) ||
    owner.client !== recovery.client
  ) {
    return false;
  }
  const fallbackHost = chatCommandRecoveryHost(owner);
  return fallbackHost ? clearChatComposerMemoryFallback(fallbackHost, ownership) : false;
}

export function commandComposerFallbackRetainsAttachments(
  host: ChatHost,
  recovery: ChatCommandComposerRecovery,
): boolean {
  const ownership = recovery.composer?.fallbackOwnership;
  const owner = recovery.owner ? recovery.owner.resolveOwner() : host;
  const fallbackHost = owner && chatCommandRecoveryHost(owner);
  return Boolean(
    ownership && fallbackHost && ownsChatComposerMemoryFallback(fallbackHost, ownership),
  );
}

export function releaseCommandComposerAttachments(
  host: ChatHost,
  recovery: ChatCommandComposerRecovery,
  attachments: readonly ChatAttachment[] | undefined,
): void {
  const owner = recovery.owner?.resolveOwner();
  const retained: ChatAttachment[][] = [];
  for (const candidate of owner && owner !== host ? [host, owner] : [host]) {
    retained.push(candidate.chatAttachments);
    for (const fallback of Object.values(
      chatCommandRecoveryHost(candidate)?.chatComposerFallbackByScope ?? {},
    )) {
      retained.push(fallback.attachments);
    }
  }
  const stagedIds = recovery.owner?.retainedAttachmentIds(attachments ?? []);
  releaseDisplacedChatAttachmentPayloads(
    attachments?.filter((attachment) => !stagedIds?.has(attachment.id)) ?? [],
    retained,
  );
}

function composerRetainsSubmittedAnnotations(
  host: ChatHost,
  submittedAttachments?: readonly ChatAttachment[],
): boolean {
  const retained = submittedAttachments?.filter(
    (attachment) => attachment.browserAnnotation || attachment.selectionAnnotation,
  );
  return Boolean(
    retained?.length &&
    retained.length === host.chatAttachments.length &&
    retained.every(
      (attachment, index) =>
        attachment.id === host.chatAttachments[index]?.id &&
        attachment.browserAnnotation === host.chatAttachments[index]?.browserAnnotation &&
        attachment.selectionAnnotation === host.chatAttachments[index]?.selectionAnnotation,
    ),
  );
}

export function restoreFailedCommandComposer(
  host: ChatHost,
  recovery: ChatCommandComposerRecovery,
): boolean {
  const composer = recovery.composer;
  if (!composer) {
    return true;
  }
  if (!submittedCommandConnectionIsCurrent(host, recovery)) {
    return (
      composer.attachments.length === 0 || commandComposerFallbackRetainsAttachments(host, recovery)
    );
  }
  const owner = recovery.owner ? recovery.owner.resolveOwner() : host;
  if (!owner) {
    return false;
  }
  if (owner.client !== recovery.client) {
    return (
      composer.attachments.length === 0 || commandComposerFallbackRetainsAttachments(host, recovery)
    );
  }
  const fallbackHost = chatCommandRecoveryHost(owner);
  if (
    owner.canRestoreComposer?.() === false ||
    !visibleSessionMatches(owner, recovery.scope.sessionKey, recovery.scope.agentId)
  ) {
    if (!fallbackHost) {
      return composer.attachments.length === 0;
    }
    const ownership = retainChatComposerMemoryFallback(fallbackHost, recovery.scope, {
      message: composer.draft,
      mentions: composer.mentions,
      attachments: composer.attachments,
    });
    composer.fallbackOwnership = ownership;
    return composer.attachments.length === 0 || ownership !== undefined;
  }
  if (
    owner.chatAttachments.length > 0 &&
    !composerRetainsSubmittedAnnotations(owner, composer.attachments)
  ) {
    clearOwnedCommandComposerFallback(host, recovery);
    return composer.attachments.length === 0;
  }
  const restorePlan = strictComposerRestore(owner, {
    previousAttachments: composer.attachments,
    previousDraft: composer.draft,
    previousMentions: composer.mentions,
  });
  if (restorePlan.draft) {
    owner.chatMessage = composer.draft;
    owner.chatMentions = composer.mentions ?? [];
  }
  if (restorePlan.attachments) {
    owner.chatAttachments = composer.attachments;
  }
  const retained = composer.attachments.length === 0 || restorePlan.attachments;
  if (!restorePlan.complete) {
    clearOwnedCommandComposerFallback(host, recovery);
  }
  if (owner !== host) {
    owner.requestUpdate?.();
  }
  return retained;
}

type PendingComposerSnapshot = {
  previousAttachments?: ChatAttachment[];
  previousDraft?: string;
  previousMentions?: readonly HumanMention[];
};

function strictComposerRestore(host: ChatHost, snapshot: PendingComposerSnapshot) {
  // An attachment-only edit is still a newer draft. Restoring old text beside it
  // would combine sends; annotations retained by this exact command are not edits.
  const composerBlank =
    !host.chatMessage.trim() &&
    (host.chatAttachments.length === 0 ||
      composerRetainsSubmittedAnnotations(host, snapshot.previousAttachments));
  const attachments = Boolean(snapshot.previousAttachments?.length && composerBlank);
  const draft = snapshot.previousDraft != null && composerBlank;
  return {
    attachments,
    draft,
    complete:
      (!snapshot.previousDraft?.trim() || draft) &&
      (!snapshot.previousAttachments?.length || attachments),
  };
}

export function cancelChatDelivery(
  host: ChatHost,
  item: ChatQueueItem,
  snapshot: PendingComposerSnapshot,
): boolean {
  const plan = strictComposerRestore(host, snapshot);
  const removed = removeQueuedMessageWithoutReleasing(host, item.id);
  if (!removed) {
    return false;
  }
  if (plan.draft) {
    host.chatMessage = snapshot.previousDraft ?? "";
    host.chatMentions = snapshot.previousMentions ?? [];
  }
  if (plan.attachments) {
    host.chatAttachments = snapshot.previousAttachments ?? [];
  }
  if (!plan.attachments) {
    releaseChatAttachmentPayloads(excludeComposerAttachments(host, removed.attachments));
  }
  return true;
}

export function restoreRejectedChatDelivery(
  host: ChatHost,
  item: ChatQueueItem,
  snapshot: PendingComposerSnapshot = {},
): boolean {
  const plan = strictComposerRestore(host, snapshot);
  // A detached or relinquished pane can finish delivery, but no longer owns its
  // composer. Keep the outbox row until that owner can accept the whole draft.
  return (
    host.canRestoreComposer?.() === true &&
    visibleSessionMatches(host, item.sessionKey ?? host.sessionKey, item.agentId) &&
    (snapshot.previousDraft !== undefined || snapshot.previousAttachments !== undefined) &&
    plan.complete &&
    cancelChatDelivery(host, item, snapshot)
  );
}
