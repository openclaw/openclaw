import { html, nothing, type TemplateResult } from "lit";
import { ref } from "lit/directives/ref.js";
import { linkReaderPrefetch } from "../../../components/link-reader-prefetch.ts";
import { renderLoadingState } from "../../../components/loading-state.ts";
import { markdownBlocks } from "../../../components/markdown-blocks.ts";
import { handleMarkdownCodeBlockClick } from "../../../components/markdown-code-blocks.ts";
import {
  markdownFileLinkFromEvent,
  markdownFileLinkFromKeyboardEvent,
} from "../../../components/markdown-file-links.ts";
import {
  markdownSessionLinkFromEvent,
  markdownSessionLinkFromKeyboardEvent,
} from "../../../components/markdown-session-links.ts";
import { handleMarkdownTableInteraction } from "../../../components/markdown-tables.ts";
import { renderPanelLoadingSkeleton } from "../../../components/panel-loading-skeleton.ts";
import { t } from "../../../i18n/index.ts";
import {
  anchorFromNavigationEvent,
  shouldHandleNavigationClick,
} from "../../../lib/navigation-click.ts";
import { hydrateLinkFavicons } from "../link-favicon-loader.ts";
import {
  CHAT_HISTORY_BOUNDARY_HEIGHT_PX,
  renderChatHistoryBoundary,
} from "./chat-history-boundary.ts";
import "./chat-comment-pins.ts";
import { renderChatPositionRail } from "./chat-position-rail.ts";
import {
  handleTranscriptContextMenu,
  handleTranscriptPointerUp,
  type ChatThreadProps,
} from "./chat-thread-interactions.ts";
import { ChatTranscriptController } from "./chat-transcript-controller.ts";
import { projectChatTranscript } from "./chat-transcript-projection.ts";
import type { ChatTranscriptSession } from "./chat-transcript-session.ts";
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

export function renderChatThread(
  props: ChatThreadProps,
  transcript: ChatTranscriptController,
): TemplateResult {
  return transcript.renderSession(props.sessionKey, (session) =>
    renderTranscriptShell(props, session),
  );
}

function renderTranscriptShell(
  props: ChatThreadProps,
  transcript: ChatTranscriptSession,
): TemplateResult {
  const projection = projectChatTranscript(props, transcript);
  // Empty/loading shells do not commit virtual rows. Record that baseline so
  // the first submitted turn animates, but initial loaded history stays still.
  if (projection.isEmpty || projection.showLoadingSkeleton) {
    transcript.entryAnimations.sync(
      EMPTY_ENTRY_KEYS,
      props.announceTranscript !== false && !projection.searchOpen && !props.loading,
    );
  }
  // The sentinel is an out-of-flow IntersectionObserver target pinned over the
  // virtualized rows; it stays empty because content here paints on top of real
  // messages. The visible affordance is the in-flow history boundary header.
  const historySentinel = props.historyPagination
    ? html`<div class="chat-history-sentinel"></div>`
    : nothing;
  // The boundary renders above the virtualized block and is charged to the
  // virtualizer as scrollMargin, so prepends re-anchor on message rows and the
  // viewport never follows the boundary itself.
  const historyHeader = props.historyPagination
    ? {
        template: renderChatHistoryBoundary(props.historyPagination),
        height: CHAT_HISTORY_BOUNDARY_HEIGHT_PX,
      }
    : null;
  const routeLoading = props.routeLoadingSkeleton && projection.showLoadingSkeleton;
  const commentPins = props.commentAttachments?.some(
    (attachment) => attachment.selectionAnnotation,
  );
  const transcriptContents = routeLoading
    ? renderLoadingState()
    : projection.showLoadingSkeleton || projection.isEmpty
      ? html`
          <div class="chat-thread-inner">
            ${historySentinel}
            ${
              projection.isEmpty && !projection.showLoadingSkeleton && historyHeader
                ? historyHeader.template
                : nothing
            }
            ${
              projection.showLoadingSkeleton
                ? renderPanelLoadingSkeleton("chat", t("chat.thread.loading"))
                : nothing
            }
            ${
              projection.isEmpty && !projection.showLoadingSkeleton && !projection.searchOpen
                ? renderWelcomeState({ ...props, onModelSetup: undefined })
                : nothing
            }
            ${
              projection.isEmpty && projection.searchOpen
                ? html` <div class="agent-chat__empty">${t("chat.thread.noMatches")}</div> `
                : nothing
            }
          </div>
        `
      : projection.renderRows(historySentinel, historyHeader);
  return html`
    <div class="chat-thread-viewport">
      <div
        class="chat-thread ${projection.isDirectThread ? "chat-thread--direct" : ""} ${
          routeLoading ? "chat-thread--route-loading" : ""
        } ${commentPins ? "chat-thread--comment-pins" : ""}"
        ${markdownBlocks(props.transcriptVisible ?? true)}
        ${linkReaderPrefetch(props.sessionKey, projection.showLoadingSkeleton ? false : (props.transcriptVisible ?? true), Boolean(props.gatewayClient?.connected))}
        ${ref((element) => {
          if (element instanceof HTMLElement) {
            hydrateLinkFavicons(element, props.fetchLinkFavicon);
          }
        })}
        role="log"
        aria-live="off"
        aria-relevant="additions"
        tabindex="0"
        @focusin=${(event: FocusEvent) => transcript.handleFocusIn(event)}
        @focusout=${(event: FocusEvent) => transcript.handleFocusOut(event)}
        @scroll=${props.onChatScroll}
        @wheel=${props.onHistoryIntent ? { handleEvent: props.onHistoryIntent, passive: true } : null}
        @keydown=${(event: KeyboardEvent) => {
          if (
            !event.defaultPrevented &&
            !event.isComposing &&
            (event.key === "Enter" || event.key === " ") &&
            navigateCronRunLink(event, props)
          ) {
            return;
          }
          const target = markdownFileLinkFromKeyboardEvent(event);
          if (target) {
            props.onOpenWorkspaceFile?.(target);
            return;
          }
          const sessionTarget = markdownSessionLinkFromKeyboardEvent(event, props.basePath);
          if (sessionTarget) {
            props.onOpenSessionLink?.(sessionTarget);
            return;
          }
          props.onHistoryIntent?.(event);
        }}
        @touchstart=${
          props.onHistoryIntent ? { handleEvent: props.onHistoryIntent, passive: true } : null
        }
        @touchmove=${
          props.onHistoryIntent ? { handleEvent: props.onHistoryIntent, passive: true } : null
        }
        @touchend=${props.onHistoryIntent}
        @touchcancel=${props.onHistoryIntent}
        @click=${(event: MouseEvent) => {
          handleMarkdownCodeBlockClick(event);
          handleMarkdownTableInteraction(event);
          if (shouldHandleNavigationClick(event) && navigateCronRunLink(event, props)) {
            return;
          }
          const target = markdownFileLinkFromEvent(event);
          if (target) {
            props.onOpenWorkspaceFile?.(target);
            return;
          }
          const sessionTarget = markdownSessionLinkFromEvent(event, props.basePath);
          if (sessionTarget && shouldHandleNavigationClick(event)) {
            event.preventDefault();
            props.onOpenSessionLink?.(sessionTarget);
          }
        }}
        @contextmenu=${(event: MouseEvent) => handleTranscriptContextMenu(event, props)}
        @pointerup=${(event: PointerEvent) => handleTranscriptPointerUp(event, props)}
      >
        <span
          class="chat-transcript-announcement sr-only"
          role="status"
          aria-live=${props.announceTranscript !== false ? "polite" : "off"}
          aria-atomic="true"
          >${transcript.liveAnnouncementText}</span
        >
        ${renderChatPositionRail({
          positions: projection.positionIndex,
          transcript,
          assistant: { ...resolveAssistantDisplayAvatar(props), name: props.assistantName },
          requestUpdate: props.onRequestUpdate ?? (() => {}),
        })}
        ${transcriptContents}
        ${
          commentPins
            ? html`<openclaw-chat-comment-pins
                .attachments=${props.commentAttachments}
                .sessionKey=${props.sessionKey}
                .disabled=${props.commentsDisabled ?? false}
              ></openclaw-chat-comment-pins>`
            : nothing
        }
      </div>
    </div>
  `;
}
