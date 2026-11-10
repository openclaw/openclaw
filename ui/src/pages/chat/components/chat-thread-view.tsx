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
import type { TemplateReference } from "../../../components/template-reference-surface.tsx";
import { registerChatSessionEnglish } from "../../../i18n/locales/en-chat-session.ts";
import { cancelLayout, scheduleLayout } from "../../../lib/layout-frame.ts";
import {
  anchorFromNavigationEvent,
  shouldHandleNavigationClick,
} from "../../../lib/navigation-click.ts";
import { elementRef } from "../../../lib/reactive/element-ref.ts";
import { registerEnglishCatalog, t } from "../../../lib/reactive/i18n.ts";
import { listen } from "../../../lib/reactive/listener.ts";
import { createParkedProjection } from "../../../lib/reactive/parked-projection.ts";
import { projectOwner, projectSource } from "../../../lib/reactive/projection.ts";
import { createTimeout } from "../../../lib/reactive/timers.ts";
import { usePanePresentation } from "../chat-pane-presentation.ts";
import {
  getExpandedToolCards,
  getExpandedUserMessages,
  getExpansionStateVersion,
  subscribeExpansionState,
} from "../chat-thread.ts";
import { retainLinkFaviconCache } from "../link-favicon-cache.ts";
import { ChatConversationLoading, renderChatLoading } from "./chat-conversation-loading.tsx";
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
import { prepareChatTranscript, projectChatTranscript } from "./chat-transcript-projection.ts";
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

type ChatThreadInput = {
  props: ChatThreadProps;
  transcript: ChatTranscript;
  bindViewport?: (element: HTMLDivElement) => () => void;
  historySupplement?: TranscriptHeader;
};

export function ChatThread(input: ChatThreadInput) {
  const mobile = useContext(ChatConversationMobile);
  // Undefined waits for the composer frame; false prepares history; true admits it.
  // Restored snapshots join the header and composer in their first visible frame.
  const [ready, setReady] = createSignal<boolean | undefined>(input.props.restoring || undefined);
  const isPresented = usePanePresentation(() => input.props.transcriptVisible ?? true);
  // Match boot admission: task yields delay Firefox's initial readiness.
  const preparation =
    "chrome" in window &&
    prepareChatTranscript(
      () => input.props,
      (key) => input.transcript.renderSession(key, (session) => session),
    );
  const reveal = createTimeout(
    () => {
      try {
        if (preparation && !preparation.next().done) {
          reveal.schedule();
          return;
        }
      } catch {
        // Replay failed preparation under the existing render error boundary.
      }
      setReady(true);
    },
    () =>
      ready() === false &&
      isPresented() &&
      (!input.props.loading ||
        input.props.messages.length ||
        input.props.queue.length ||
        input.props.pendingInputs?.length ||
        input.props.runActive)
        ? 0
        : undefined,
  );
  return (
    <div class="chat-thread-viewport" ref={[elementRef(input.props.onScrollPortRef)]}>
      <Show when={ready() || isPresented()}>
        {(_presented) => {
          onSettled(() => {
            // Let this frame paint the composer before preparing the transcript in a task.
            if (ready() === undefined) {
              scheduleLayout(
                reveal,
                () => () => (preparation ? setReady(false) : reveal.schedule(0)),
              );
            }
            return () => {
              cancelLayout(reveal);
              reveal.cancel();
            };
          });
          return (
            <>
              {ready() ? (
                <ChatThreadContent {...input} presented={isPresented()} />
              ) : (
                <div
                  class={[
                    "chat-thread",
                    {
                      "chat-thread--annotations": input.props.commentAttachments !== undefined,
                      "chat-thread--route-loading": mobile() && input.props.routeLoadingSkeleton,
                    },
                  ]}
                  ref={[elementRef(input.bindViewport)]}
                >
                  {input.props.loading ? (
                    renderChatLoading(mobile(), input.props.routeLoadingSkeleton)
                  ) : (
                    <ChatConversationLoading route />
                  )}
                </div>
              )}
            </>
          );
        }}
      </Show>
    </div>
  );
}

function ChatThreadContent(input: ChatThreadInput & { presented: boolean }) {
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
  const historyIntent = (event: Event) => input.props.onHistoryIntent?.(event);
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
  const search = createMemo(() =>
    projectOwner(getTranscriptState(paneId()).search, (owner) => owner.snapshot, Object.is),
  );
  const geometry = createMemo(() => projectOwner(input.transcript, (owner) => owner));
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
    () => input.presented,
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
    return projection;
  });
  const showLoadingSkeleton = createMemo(() => current().showLoadingSkeleton);
  const routeLoading = () => input.props.routeLoadingSkeleton && showLoadingSkeleton();
  const commentPins = () =>
    input.props.commentAttachments?.some((attachment) => attachment.selectionAnnotation);
  const prefetchRef = createLinkReaderPrefetchRef(() => [
    input.props.sessionKey,
    showLoadingSkeleton() ? false : (input.props.transcriptVisible ?? true),
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
    if (showLoadingSkeleton()) {
      return renderChatLoading(mobile(), routeLoading(), sentinel());
    }
    if (current().isEmpty) {
      return (
        <div class="chat-thread-inner">
          {sentinel()}
          {historyHeader()?.content}
          {current().searchOpen ? (
            <div class="agent-chat__empty">{t("chat.thread.noMatches")}</div>
          ) : (
            <div class="agent-chat__empty">{t("chat.thread.noMessages")}</div>
          )}
        </div>
      );
    }
    return current().renderRows(sentinel(), historyHeader());
  });
  const announcement = () => {
    // The row owner records the accepted announcement while rendering its rows.
    contents();
    return presentation().session.liveAnnouncementText;
  };
  return (
    <>
      <Show when={input.presented && root()}>
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
            // Retained roots can settle before refs; bind viewport and input together here.
            const releaseViewport = input.bindViewport?.(element);
            const stopHistory = ["wheel", "touchstart", "touchmove"].map((type) =>
              listen(element, type, historyIntent, { passive: true }),
            );
            return () => {
              stopSelectionGesture?.();
              stopHistory.forEach((stop) => stop());
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
            "chat-thread--direct": current().isDirectThread,
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
          presentation().session.handleFocusIn(event);
        }}
        onFocusOut={(event) => {
          presentation().session.handleFocusOut(event);
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
          historyIntent(event);
        }}
        onTouchEnd={historyIntent}
        onTouchCancel={historyIntent}
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
          positions={current().positionIndex}
          transcript={presentation().session}
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
                transcript={presentation().session}
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
          presented={input.presented}
          source={() => input.props}
          intent={templateIntent()!}
          onDismiss={() => setTemplateIntent(null)}
        />
      </Show>
    </>
  );
}
