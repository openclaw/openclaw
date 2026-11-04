import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { createMemo, lazy, Show, untrack } from "solid-js";
import { Icon } from "../../../components/solid/icon.tsx";
import { registerChatMessageMetadataEnglish } from "../../../i18n/locales/en-chat-message-metadata.ts";
import type { ChatReplyTarget } from "../../../lib/chat/chat-types.ts";
import { t } from "../../../lib/reactive/i18n.ts";
import { projectPresentation } from "../../../lib/reactive/presentation.ts";
import { isChatRunWorking } from "../chat-run-working.ts";
import { projectProgressCardRuntime } from "../chat-subagent-wait.ts";
import { persistedMessageEntryId } from "../chat-thread-items.ts";
import { ChatAuthorAvatar } from "./chat-author-avatar.ts";
import type { ChatComposerProps } from "./chat-composer-types.ts";
import { ChatLazyBoundary } from "./chat-lazy-boundary.tsx";
import { resolveMessageReplyLine } from "./chat-reply-attribution.ts";
import { createReplyPreviewResolver } from "./chat-reply-preview.ts";

registerChatMessageMetadataEnglish();

const ChatQueue = lazy(() => import("./chat-composer-queue.tsx"), {
  export: "renderChatQueueSolid",
});
const SessionProgressCard = lazy(
  () => import("../../../components/session-progress-card-solid.tsx"),
  {
    export: "SessionProgressCard",
  },
);

export function ComposerQueue(view: { composer: ChatComposerProps; showAbortableUi: boolean }) {
  const canAct = () =>
    view.composer.connected && view.composer.canSend && !view.composer.submitDisabledReason;
  return (
    <Show
      when={
        view.composer.queue.length ||
        view.composer.displayQueue?.length ||
        view.composer.queuedEdit?.source
      }
    >
      <ChatLazyBoundary>
        <ChatQueue
          queue={view.composer.queue}
          displayQueue={view.composer.displayQueue}
          connected={view.composer.connected}
          offline={view.composer.offline}
          canAbort={view.showAbortableUi}
          canRemoveServerQueued={canAct()}
          onQueueRetry={canAct() ? view.composer.onQueueRetry : undefined}
          onQueueSteer={canAct() ? view.composer.onQueueSteer : undefined}
          onQueueMove={view.composer.onQueueMove}
          queuedEdit={view.composer.queuedEdit}
          onQueueRemove={view.composer.onQueueRemove}
        />
      </ChatLazyBoundary>
    </Show>
  );
}

export function ComposerInputScope(props: { children: import("@solidjs/web").JSX.Element }) {
  // This scope retains one native input subtree, including its focus and undo history.
  const initialChildren = untrack(() => props.children);
  return initialChildren;
}

export function ComposerProgress(view: { composer: ChatComposerProps; shown: boolean }) {
  const visibility = createMemo(() =>
    projectPresentation(view.composer.progressCardVisibility ?? true),
  );
  const presented = () => visibility().read();
  return (
    <Show
      when={presented() && Boolean(view.composer.progressCard)}
      fallback={
        presented() && view.composer.progressCardInitialLoading ? (
          <div
            class="agent-chat__progress-float agent-chat__progress-float--loading"
            hidden={!view.shown}
            aria-hidden="true"
          />
        ) : undefined
      }
    >
      <div class="agent-chat__progress-float" hidden={!view.shown}>
        <ChatLazyBoundary>
          <SessionProgressCard
            card={view.composer.progressCard}
            placement="composer"
            onDismiss={view.composer.onDismissProgressCard}
            sessionStatus={view.composer.selectedSession?.status}
            startedAt={view.composer.selectedSession?.startedAt}
            endedAt={view.composer.selectedSession?.endedAt}
            hasActiveRun={isChatRunWorking(view.composer)}
            runtime={projectProgressCardRuntime(
              view.composer.selectedSession,
              view.composer,
              view.composer.progressCard!.updatedAt,
              view.composer.connected,
            )}
            collapseComposerByDefault={view.composer.collapseTaskProgress}
            composerDisclosureContext={{
              presented: view.shown,
              gatewayScope: view.composer.gatewayScope,
              sessionIdentity: view.composer.progressCardIdentity,
              cardLifetime: view.composer.progressCardLifetime,
              readingHistory: view.composer.readingHistory,
              getTranscriptElement: view.composer.getTranscriptElement,
              onManipulate: view.composer.onProgressManipulate,
            }}
            refreshAction={
              view.composer.connected && view.composer.canSend
                ? view.composer.progressCardRefresh
                : undefined
            }
            onClearSaved={view.composer.onClearSavedProgressCard}
          />
        </ChatLazyBoundary>
      </div>
    </Show>
  );
}

/** The pending reply, naming its author like the sent reply line will. */
export function ComposerReplyPreview(view: {
  composer: ChatComposerProps;
  target: ChatReplyTarget;
}) {
  const line = createMemo(() => {
    const { composer, target } = view;
    const id = target.sourceMessageId ?? "";
    // The thread's own author projection names a loaded original.
    const message = composer.messages.findLast((entry) => persistedMessageEntryId(entry) === id);
    const senderLabel = target.senderLabel ?? "";
    const loaded = new Map(message ? [[id, { message, messageId: id, senderLabel }]] : []);
    const replyTarget = { kind: "id" as const, id };
    return resolveMessageReplyLine(
      {
        role: "user",
        content: [],
        timestamp: 0,
        replyTarget,
        replyPreview: { text: "", senderLabel },
      },
      createReplyPreviewResolver(loaded, composer),
      composer.userId,
      false,
    );
  });
  const named = () => line().state === "named";
  return (
    <div class="chat-reply-preview composer-context-strip">
      <span class="chat-reply-preview__label composer-context-strip__label">
        <span class="chat-reply-preview__icon composer-context-strip__icon">
          <Icon name="messageSquare" />
        </span>
        <span class="composer-context-strip__label-text">{t("chat.messages.replyingToLabel")}</span>
        <span class="chat-reply-attribution__person">
          <Show when={named()}>
            <ChatAuthorAvatar
              sender={line().sender}
              agentAvatar={line().agentAvatar}
              mediaReadAllowed={view.composer.mediaReadAllowed}
              hideTooltip
            />
          </Show>
          <span class="chat-reply-attribution__name">
            {named() ? line().name : t("chat.messages.message")}
          </span>
        </span>
      </span>
      <span class="chat-reply-preview__text composer-context-strip__text">
        {truncateUtf16Safe(view.target.text, 120)}
        {view.target.text.length > 120 ? "..." : ""}
      </span>
      <button
        type="button"
        class="chat-reply-preview__dismiss composer-context-strip__dismiss"
        onClick={() => view.composer.onClearReply?.()}
        aria-label={t("chat.composer.cancelReply")}
        title={t("chat.composer.cancelReply")}
      >
        <Icon name="x" />
      </button>
    </div>
  );
}
