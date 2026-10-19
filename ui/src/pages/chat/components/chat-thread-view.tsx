import { Show, createMemo, onCleanup, onSettled } from "solid-js";
import { handleMarkdownCodeBlockClick } from "../../../components/markdown-code-blocks.ts";
import {
  linkReaderPrefetchRef as createLinkReaderPrefetchRef,
  markdownBlocksRef as createMarkdownBlocksRef,
} from "../../../components/markdown-element-refs-solid.ts";
import {
  markdownFileLinkFromEvent,
  markdownFileLinkFromKeyboardEvent,
} from "../../../components/markdown-file-links.ts";
import {
  markdownSessionLinkFromEvent,
  markdownSessionLinkFromKeyboardEvent,
} from "../../../components/markdown-session-links.ts";
import { handleMarkdownTableInteraction } from "../../../components/markdown-tables.ts";
import { LoadingState } from "../../../components/solid/loading-state.tsx";
import { PanelLoadingSkeleton } from "../../../components/solid/panel-loading-skeleton.tsx";
import {
  anchorFromNavigationEvent,
  shouldHandleNavigationClick,
} from "../../../lib/navigation-click.ts";
import { elementRef } from "../../../lib/reactive/element-ref.ts";
import { t } from "../../../lib/reactive/i18n.ts";
import { listen } from "../../../lib/reactive/listener.ts";
import { createParkedProjection } from "../../../lib/reactive/parked-projection.ts";
import { projectOwner, projectSource } from "../../../lib/reactive/projection.ts";
import {
  getExpandedToolCards,
  getExpandedUserMessages,
  getExpansionStateVersion,
  subscribeExpansionState,
} from "../chat-thread.ts";
import { ChatCommentPins } from "./chat-comment-pins.tsx";
import { CHAT_HISTORY_BOUNDARY_HEIGHT_PX, ChatHistoryBoundary } from "./chat-history-boundary.tsx";
import { ChatPositionRail } from "./chat-position-rail-solid.tsx";
import {
  getTranscriptState,
  handleTranscriptContextMenu,
  handleTranscriptPointerUp,
  registerTranscriptElement,
  type ChatThreadProps,
} from "./chat-thread-interactions.ts";
import type { ChatTranscript } from "./chat-transcript-controller.ts";
import { projectChatTranscript } from "./chat-transcript-projection.ts";
import { resolveAssistantDisplayAvatar } from "./chat-welcome.ts";
import { ChatWelcome } from "./chat-welcome.tsx";

const EMPTY_ENTRY_KEYS: ReadonlyMap<string, string> = new Map();

function navigateCronRunLink(event: Event, props: ChatThreadProps): boolean {
  const anchor = anchorFromNavigationEvent(event);
  if (!props.onNavigate || !anchor?.hasAttribute("data-cron-run-link")) {
    return false;
  }
  event.preventDefault();
  props.onNavigate("cron", { search: anchor.search });
  return true;
}

export function ChatThread(input: {
  props: ChatThreadProps;
  transcript: ChatTranscript;
  bindViewport?: (element: HTMLDivElement) => () => void;
}) {
  let root: HTMLDivElement | undefined;
  const historyIntent = (event: Event) => input.props.onHistoryIntent?.(event);
  let stopHistory: (() => void)[] = [];
  let releaseViewport: (() => void) | undefined;
  // Retained transcript roots can settle before refs; bind native input at the ref.
  onCleanup(() => {
    stopHistory.forEach((stop) => stop());
    releaseViewport?.();
  });
  const paneId = createMemo(() => input.props.paneId);
  onSettled(() => root && registerTranscriptElement(paneId(), root));
  const search = createMemo(() =>
    projectOwner(getTranscriptState(paneId()).search, (owner) => owner.snapshot, Object.is),
  );
  const presentation = createMemo(
    () =>
      input.transcript.renderSession(input.props.sessionKey, (session) => ({
        session,
        maps: [
          getExpandedToolCards(input.props.sessionKey),
          getExpandedUserMessages(input.props.sessionKey),
          session.expandedAssistantMessages,
        ],
      })),
    {
      // Session caches can replace maps while the retained pane stays mounted.
      equals: (previous, next) =>
        previous.session === next.session &&
        previous.maps.every((value, index) => value === next.maps[index]),
    },
  );
  const expansions = createMemo(() =>
    presentation().maps.map((values) =>
      projectSource(values, {
        read: getExpansionStateVersion,
        subscribe: subscribeExpansionState,
        equality: Object.is,
      }),
    ),
  );
  const expansionVersions = createParkedProjection(
    () => expansions().map((expansion) => expansion.read()),
    () => {
      const visible = input.props.transcriptVisible ?? true;
      return typeof visible === "object" ? visible.isPresented() : visible;
    },
  );
  const current = createMemo(() => {
    const searchState = search().read();
    const { session } = presentation();
    const projection = projectChatTranscript(input.props, session, searchState);
    expansionVersions();
    // Empty shells establish the baseline for first-submission animation.
    if (projection.isEmpty || projection.showLoadingSkeleton) {
      session.entryAnimations.sync(
        EMPTY_ENTRY_KEYS,
        input.props.announceTranscript !== false && !projection.searchOpen && !input.props.loading,
      );
    }
    return { session, projection };
  });
  const showLoadingSkeleton = createMemo(() => current().projection.showLoadingSkeleton);
  const isEmpty = createMemo(() => current().projection.isEmpty);
  const searchOpen = createMemo(() => current().projection.searchOpen);
  const routeLoading = createMemo(() => input.props.routeLoadingSkeleton && showLoadingSkeleton());
  const commentPins = () =>
    input.props.commentAttachments?.some((attachment) => attachment.selectionAnnotation);
  const prefetchRef = createLinkReaderPrefetchRef(() => [
    input.props.sessionKey,
    current().projection.showLoadingSkeleton ? false : (input.props.transcriptVisible ?? true),
    Boolean(input.props.gatewayClient?.connected),
  ]);
  const markdownRef = createMarkdownBlocksRef(() => input.props.transcriptVisible ?? true);
  const historyHeader = () =>
    input.props.historyPagination
      ? {
          props: input.props.historyPagination,
          height: CHAT_HISTORY_BOUNDARY_HEIGHT_PX,
        }
      : null;
  const historySentinel = (
    <div class="chat-history-sentinel" ref={[elementRef(input.props.onHistorySentinelRef)]} />
  );
  const sentinel = () => (input.props.historyPagination ? historySentinel : undefined);
  const contents = createMemo(() => {
    if (routeLoading()) {
      return <LoadingState />;
    }
    if (showLoadingSkeleton() || isEmpty()) {
      return (
        <div class="chat-thread-inner">
          {sentinel()}
          {isEmpty() && !showLoadingSkeleton() && input.props.historyPagination ? (
            <ChatHistoryBoundary {...input.props.historyPagination} />
          ) : undefined}
          {showLoadingSkeleton() ? (
            <PanelLoadingSkeleton variant="chat" label={t("chat.thread.loading")} />
          ) : undefined}
          {isEmpty() && !showLoadingSkeleton() && !searchOpen() ? (
            <ChatWelcome {...input.props} onModelSetup={undefined} />
          ) : undefined}
          {isEmpty() && searchOpen() ? (
            <div class="agent-chat__empty">{t("chat.thread.noMatches")}</div>
          ) : undefined}
        </div>
      );
    }
    return current().projection.renderRows(sentinel(), historyHeader());
  });
  const announcement = createMemo(() => {
    // The row owner records the accepted announcement while rendering its rows.
    contents();
    return current().session.liveAnnouncementText;
  });
  return (
    <div class="chat-thread-viewport" ref={[elementRef(input.props.onScrollPortRef)]}>
      <div
        ref={[
          (element) => {
            root = element;
            releaseViewport = input.bindViewport?.(element);
            markdownRef(element);
            prefetchRef(element);
            stopHistory = ["wheel", "touchstart", "touchmove"].map((type) =>
              listen(element, type, historyIntent, { passive: true }),
            );
          },
          elementRef(input.props.onScrollPortRef),
        ]}
        class={[
          "chat-thread",
          {
            "chat-thread--direct": current().projection.isDirectThread,
            "chat-thread--route-loading": routeLoading(),
            "chat-thread--comment-pins": commentPins(),
          },
        ]}
        role="log"
        aria-live="off"
        aria-relevant="additions"
        tabindex={0}
        onFocusIn={(event) => current().session.handleFocusIn(event)}
        onFocusOut={(event) => current().session.handleFocusOut(event)}
        onScroll={(event) => input.props.onChatScroll?.(event)}
        onKeyDown={(event) => {
          if (
            !event.defaultPrevented &&
            !event.isComposing &&
            (event.key === "Enter" || event.key === " ") &&
            navigateCronRunLink(event, input.props)
          ) {
            return;
          }
          const target = markdownFileLinkFromKeyboardEvent(event);
          if (target) {
            input.props.onOpenWorkspaceFile?.(target);
            return;
          }
          const sessionTarget = markdownSessionLinkFromKeyboardEvent(event, input.props.basePath);
          if (sessionTarget) {
            input.props.onOpenSessionLink?.(sessionTarget);
            return;
          }
          input.props.onHistoryIntent?.(event);
        }}
        onTouchEnd={(event) => input.props.onHistoryIntent?.(event)}
        onTouchCancel={(event) => input.props.onHistoryIntent?.(event)}
        onClick={(event) => {
          handleMarkdownCodeBlockClick(event);
          handleMarkdownTableInteraction(event);
          if (shouldHandleNavigationClick(event) && navigateCronRunLink(event, input.props)) {
            return;
          }
          const target = markdownFileLinkFromEvent(event);
          if (target) {
            input.props.onOpenWorkspaceFile?.(target);
            return;
          }
          const sessionTarget = markdownSessionLinkFromEvent(event, input.props.basePath);
          if (sessionTarget && shouldHandleNavigationClick(event)) {
            event.preventDefault();
            input.props.onOpenSessionLink?.(sessionTarget);
          }
        }}
        onContextMenu={(event) =>
          handleTranscriptContextMenu(
            event,
            input.props,
            presentation().session.messageElements.elements.values(),
          )
        }
        onPointerUp={(event) =>
          handleTranscriptPointerUp(
            event,
            input.props,
            presentation().session.messageElements.elements.values(),
          )
        }
      >
        <span
          ref={[elementRef(input.props.onTranscriptAnnouncementRef)]}
          class="chat-transcript-announcement sr-only"
          role="status"
          aria-live={input.props.announceTranscript !== false ? "polite" : "off"}
          aria-atomic="true"
        >
          {announcement()}
        </span>
        <ChatPositionRail
          positions={current().projection.positionIndex}
          transcript={current().session}
          assistant={{
            ...resolveAssistantDisplayAvatar(input.props),
            name: input.props.assistantName,
          }}
        />
        {contents()}
        <Show when={commentPins() ? getTranscriptState(paneId()) : undefined} keyed>
          {(threadState) => (
            <ChatCommentPins
              threadState={threadState}
              transcript={current().session}
              attachments={input.props.commentAttachments}
              sessionKey={input.props.sessionKey}
              disabled={input.props.commentsDisabled ?? false}
            />
          )}
        </Show>
      </div>
    </div>
  );
}
