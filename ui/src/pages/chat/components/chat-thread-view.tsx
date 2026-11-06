import { Loading, Show, lazy, createMemo, createSignal, onSettled, useContext } from "solid-js";
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
import type { TemplateReference } from "../../../components/template-reference-surface.tsx";
import { registerChatSessionEnglish } from "../../../i18n/locales/en-chat-session.ts";
import {
  anchorFromNavigationEvent,
  shouldHandleNavigationClick,
} from "../../../lib/navigation-click.ts";
import { elementRef } from "../../../lib/reactive/element-ref.ts";
import { registerEnglishCatalog, t } from "../../../lib/reactive/i18n.ts";
import { createParkedProjection } from "../../../lib/reactive/parked-projection.ts";
import { projectOwner, projectSource } from "../../../lib/reactive/projection.ts";
import { usePanePresentation } from "../chat-pane-presentation.ts";
import {
  getExpandedToolCards,
  getExpandedUserMessages,
  getExpansionStateVersion,
  subscribeExpansionState,
} from "../chat-thread.ts";
import { retainLinkFaviconCache } from "../link-favicon-cache.ts";
import { ChatConversationLoading } from "./chat-conversation-loading.tsx";
import { ChatConversationMobile } from "./chat-conversation-presentation.ts";
import { CHAT_HISTORY_BOUNDARY_HEIGHT_PX, ChatHistoryBoundary } from "./chat-history-boundary.tsx";
import { ChatPositionRail } from "./chat-position-rail-solid.tsx";
import { watchChatSearchHighlight } from "./chat-search-highlight.ts";
import {
  getTranscriptState,
  handleTranscriptContextMenu,
  handleTranscriptSelectionMouseDown,
  handleTranscriptPointerUp,
  registerTranscriptElement,
  type ChatThreadProps,
} from "./chat-thread-interactions.ts";
import type { ChatTranscript } from "./chat-transcript-controller.ts";
import { projectChatTranscript } from "./chat-transcript-projection.ts";
import type { TranscriptHeader } from "./chat-transcript-session.ts";
import { resolveAssistantDisplayAvatar } from "./chat-welcome.ts";
import "../../../styles/chat/selection-annotations.css";

registerEnglishCatalog(registerChatSessionEnglish);

const TemplateReferenceView = lazy(
  () => import("../../../components/template-reference-view.tsx"),
  { export: "TemplateReferenceView" },
);

// Both transcript overlays are optional; ordinary chat boot needs neither renderer.
const ChatCommentPins = lazy(() => import("./chat-comment-pins.tsx"), {
  export: "ChatCommentPins",
});

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

function openManagedArtifactLink(event: Event, props: ChatThreadProps): boolean {
  const anchor = anchorFromNavigationEvent(event);
  // Attachment-card Download keeps its already-authorized native link action.
  if (!anchor || anchor.hasAttribute("download") || !props.onOpenManagedArtifact?.(anchor.href)) {
    return false;
  }
  event.preventDefault();
  return true;
}

export function ChatThread(input: {
  props: ChatThreadProps;
  transcript: ChatTranscript;
  bindViewport?: (element: HTMLDivElement) => () => void;
  historySupplement?: TranscriptHeader;
}) {
  const mobile = useContext(ChatConversationMobile);
  // Admission stays with the transcript; all overlay lifetime work loads on intent.
  const [templateIntent, setTemplateIntent] = createSignal<TemplateReference | null>(null);
  function handleTemplateReference(event: Event) {
    const anchor = anchorFromNavigationEvent(event);
    const client = input.props.gatewayClient;
    if (
      !anchor?.matches("a.markdown-template-link") ||
      !client ||
      !input.props.applicationContext
    ) {
      return false;
    }
    if (event.type === "click") {
      event.preventDefault();
    }
    setTemplateIntent({ anchor, client, sessionKey: input.props.sessionKey, type: event.type });
    return true;
  }
  const [root, setRoot] = createSignal<HTMLDivElement>();
  let stopSelectionGesture: (() => void) | undefined;
  const paneId = createMemo(() => input.props.paneId);
  onSettled(() => {
    const element = root();
    const unregister = element && registerTranscriptElement(paneId(), element);
    const searchState = getTranscriptState(paneId()).search;
    let query = searchState.snapshot.query.trim();
    const stopSearch = searchState.subscribe(() => {
      const nextQuery = searchState.snapshot.query.trim();
      if (nextQuery && nextQuery !== query) {
        // A live reply remains below the matches; end-follow must not hide them.
        input.transcript.scrollToOffset(0);
      }
      query = nextQuery;
    });
    return () => {
      stopSearch();
      unregister?.();
    };
  });
  const isPresented = usePanePresentation(() => input.props.transcriptVisible ?? true);
  const search = createMemo(() =>
    projectOwner(getTranscriptState(paneId()).search, (owner) => owner.snapshot, Object.is),
  );
  const transcript = createMemo(() => input.transcript);
  const geometry = createMemo(() => projectOwner(transcript(), (owner) => owner));
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
  // The supplement takes the header only once the transcript has no earlier page,
  // so its controls never stack under the history boundary.
  const headerContent = (
    <Show when={input.props.historyPagination} fallback={input.historySupplement?.content}>
      {(pagination) => <ChatHistoryBoundary {...pagination()} />}
    </Show>
  );
  const historyHeader = (): TranscriptHeader | null => {
    const height = input.props.historyPagination
      ? CHAT_HISTORY_BOUNDARY_HEIGHT_PX
      : input.historySupplement?.height;
    return height === undefined ? null : { content: headerContent, height };
  };
  const historySentinel = (
    <div class="chat-history-sentinel" ref={[elementRef(input.props.onHistorySentinelRef)]} />
  );
  const sentinel = () => (input.props.historyPagination ? historySentinel : undefined);
  const contents = createMemo(() => {
    // Native range changes redraw this island without preparing the whole pane.
    geometry().read();
    if (routeLoading() && mobile()) {
      return <ChatConversationLoading route />;
    }
    if (showLoadingSkeleton() || isEmpty()) {
      return (
        <div class="chat-thread-inner">
          {sentinel()}
          {isEmpty() && !showLoadingSkeleton() ? historyHeader()?.content : undefined}
          {showLoadingSkeleton() ? (
            mobile() ? (
              <ChatConversationLoading route={false} />
            ) : routeLoading() ? (
              <LoadingState messagesOnly />
            ) : (
              <PanelLoadingSkeleton variant="chat" label={t("chat.thread.loading")} />
            )
          ) : undefined}
          {isEmpty() && !showLoadingSkeleton() && !searchOpen() ? (
            <div class="agent-chat__empty">{t("chat.thread.noMessages")}</div>
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
      <Show when={isPresented() && root()}>
        {(element) => {
          onSettled(() => {
            const initialStopSearch = watchChatSearchHighlight(
              element(),
              getTranscriptState(paneId()).search,
            );
            return () => {
              initialStopSearch();
              setTemplateIntent(null);
            };
          });
          return null;
        }}
      </Show>
      <Show when={input.props.fetchLinkFavicon} keyed>
        {(fetcher) => {
          onSettled(() => retainLinkFaviconCache(fetcher));
          return null;
        }}
      </Show>
      <div
        ref={[
          elementRef((element: HTMLDivElement) => {
            setRoot(element);
            // Retained roots can settle before refs; bind viewport custody here.
            const releaseViewport = input.bindViewport?.(element);
            return () => {
              stopSelectionGesture?.();
              releaseViewport?.();
            };
          }),
          markdownRef,
          prefetchRef,
          elementRef(input.props.onScrollPortRef),
        ]}
        class={[
          "chat-thread",
          {
            "chat-thread--direct": current().projection.isDirectThread,
            "chat-thread--route-loading": mobile() && routeLoading(),
            "chat-thread--comment-pins": commentPins(),
            "chat-thread--annotations": input.props.commentAttachments !== undefined,
          },
        ]}
        role="log"
        data-restoring={input.props.restoring ? "" : undefined}
        aria-label={t("chat.sidePanel.conversation")}
        aria-live="off"
        aria-relevant="additions"
        tabindex={0}
        onPointerOver={handleTemplateReference}
        onFocusIn={(event) => {
          handleTemplateReference(event);
          current().session.handleFocusIn(event);
        }}
        onFocusOut={(event) => {
          current().session.handleFocusOut(event);
        }}
        onKeyDown={(event) => {
          if (
            !event.defaultPrevented &&
            !event.isComposing &&
            !event.altKey &&
            !event.ctrlKey &&
            !event.metaKey &&
            !event.shiftKey &&
            (event.key === "Enter" || event.key === " ") &&
            openManagedArtifactLink(event, input.props)
          ) {
            return;
          }
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
          // Solid delegates keydown: the native observer already took over,
          // but link handling must own the key before boundary paging.
          input.props.onHistoryIntent?.(event);
        }}
        onClick={(event) => {
          handleMarkdownCodeBlockClick(event);
          handleMarkdownTableInteraction(event);
          const navigation = shouldHandleNavigationClick(event);
          if (
            navigation &&
            (handleTemplateReference(event) ||
              openManagedArtifactLink(event, input.props) ||
              navigateCronRunLink(event, input.props))
          ) {
            return;
          }
          const target = markdownFileLinkFromEvent(event);
          if (target) {
            input.props.onOpenWorkspaceFile?.(target);
            return;
          }
          const sessionTarget = markdownSessionLinkFromEvent(event, input.props.basePath);
          if (sessionTarget && navigation) {
            event.preventDefault();
            input.props.onOpenSessionLink?.(sessionTarget);
          }
        }}
        onMouseDown={(event) => {
          stopSelectionGesture?.();
          stopSelectionGesture = handleTranscriptSelectionMouseDown(event);
        }}
        onPointerDown={(event) => {
          // Keep late floating controls from stealing the pressed content's context menu.
          if (event.button === 2 && event.target instanceof Element) {
            event.target.setPointerCapture(event.pointerId);
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
            <Loading>
              <ChatCommentPins
                threadState={threadState}
                transcript={current().session}
                attachments={input.props.commentAttachments}
                sessionKey={input.props.sessionKey}
                disabled={input.props.commentsDisabled ?? false}
              />
            </Loading>
          )}
        </Show>
      </div>
      <Show when={templateIntent()}>
        <TemplateReferenceView
          presented={isPresented()}
          source={() => input.props}
          intent={templateIntent()!}
          onDismiss={() => setTemplateIntent(null)}
        />
      </Show>
    </div>
  );
}
