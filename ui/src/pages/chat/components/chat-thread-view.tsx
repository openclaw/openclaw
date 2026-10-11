import { createEffect, createMemo, onCleanup } from "solid-js";
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
import { t } from "../../../lib/reactive/i18n.ts";
import { LitContent } from "../../../lit/solid-content.tsx";
import { hydrateLinkFavicons } from "../link-favicon-loader.ts";
import {
  CHAT_HISTORY_BOUNDARY_HEIGHT_PX,
  renderChatHistoryBoundary,
} from "./chat-history-boundary.ts";
import "./chat-comment-pins.ts";
import { ChatPositionRail } from "./chat-position-rail-solid.tsx";
import {
  handleTranscriptContextMenu,
  handleTranscriptPointerUp,
  type ChatThreadProps,
} from "./chat-thread-interactions.ts";
import type { ChatTranscriptController } from "./chat-transcript-controller.ts";
import { projectChatTranscript } from "./chat-transcript-projection.ts";
import { renderWelcomeState, resolveAssistantDisplayAvatar } from "./chat-welcome.ts";

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
  transcript: ChatTranscriptController;
}) {
  let root: HTMLDivElement | undefined;
  const historyIntent = (event: Event) => input.props.onHistoryIntent?.(event);
  onCleanup(() => {
    root?.removeEventListener("wheel", historyIntent);
    root?.removeEventListener("touchstart", historyIntent);
    root?.removeEventListener("touchmove", historyIntent);
  });
  const current = createMemo(() =>
    input.transcript.renderSession(input.props.sessionKey, (session) => {
      const projection = projectChatTranscript(input.props, session);
      // Empty shells establish the baseline for first-submission animation.
      if (projection.isEmpty || projection.showLoadingSkeleton) {
        session.entryAnimations.sync(
          EMPTY_ENTRY_KEYS,
          input.props.announceTranscript !== false &&
            !projection.searchOpen &&
            !input.props.loading,
        );
      }
      return { session, projection };
    }),
  );
  const routeLoading = () =>
    input.props.routeLoadingSkeleton && current().projection.showLoadingSkeleton;
  const commentPins = () =>
    input.props.commentAttachments?.some((attachment) => attachment.selectionAnnotation);
  const prefetchRef = createLinkReaderPrefetchRef(() => [
    input.props.sessionKey,
    current().projection.showLoadingSkeleton ? false : (input.props.transcriptVisible ?? true),
    Boolean(input.props.gatewayClient?.connected),
  ]);
  const markdownRef = createMarkdownBlocksRef(() => input.props.transcriptVisible ?? true);
  createEffect(
    () => [current(), input.props.fetchLinkFavicon] as const,
    ([, fetchLinkFavicon]) => {
      if (root) {
        hydrateLinkFavicons(root, fetchLinkFavicon);
      }
    },
  );
  const historyHeader = () =>
    input.props.historyPagination
      ? {
          template: <LitContent value={renderChatHistoryBoundary(input.props.historyPagination)} />,
          height: CHAT_HISTORY_BOUNDARY_HEIGHT_PX,
        }
      : null;
  const sentinel = () =>
    input.props.historyPagination ? <div class="chat-history-sentinel" /> : undefined;
  const contents = () => {
    const projection = current().projection;
    if (routeLoading()) {
      return <LoadingState />;
    }
    if (projection.showLoadingSkeleton || projection.isEmpty) {
      return (
        <div class="chat-thread-inner">
          {sentinel()}
          {projection.isEmpty && !projection.showLoadingSkeleton
            ? historyHeader()?.template
            : undefined}
          {projection.showLoadingSkeleton ? (
            <PanelLoadingSkeleton variant="chat" label={t("chat.thread.loading")} />
          ) : undefined}
          {projection.isEmpty && !projection.showLoadingSkeleton && !projection.searchOpen ? (
            <LitContent value={renderWelcomeState({ ...input.props, onModelSetup: undefined })} />
          ) : undefined}
          {projection.isEmpty && projection.searchOpen ? (
            <div class="agent-chat__empty">{t("chat.thread.noMatches")}</div>
          ) : undefined}
        </div>
      );
    }
    return projection.renderRows(sentinel(), historyHeader());
  };
  return (
    <div class="chat-thread-viewport">
      <div
        ref={(element) => {
          root = element;
          markdownRef(element);
          prefetchRef(element);
          element.addEventListener("wheel", historyIntent, { passive: true });
          element.addEventListener("touchstart", historyIntent, { passive: true });
          element.addEventListener("touchmove", historyIntent, { passive: true });
        }}
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
        onContextMenu={(event) => handleTranscriptContextMenu(event, input.props)}
        onPointerUp={(event) => handleTranscriptPointerUp(event, input.props)}
      >
        <span
          class="chat-transcript-announcement sr-only"
          role="status"
          aria-live={input.props.announceTranscript !== false ? "polite" : "off"}
          aria-atomic="true"
        >
          {current().session.liveAnnouncementText}
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
        {commentPins() ? (
          <openclaw-chat-comment-pins
            prop:attachments={input.props.commentAttachments}
            prop:sessionKey={input.props.sessionKey}
            prop:disabled={input.props.commentsDisabled ?? false}
          />
        ) : undefined}
      </div>
    </div>
  );
}
