import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { html, nothing } from "lit";
import { guard } from "lit/directives/guard.js";
import { ref } from "lit/directives/ref.js";
import { repeat } from "lit/directives/repeat.js";
import { unsafeHTML } from "lit/directives/unsafe-html.js";
import { renderAgentIdentityAvatar } from "../../../components/identity-avatar-view.ts";
import { toSanitizedMarkdownHtml } from "../../../components/markdown.ts";
import { t } from "../../../i18n/index.ts";
import { resolveMessageDisplayMarkdown } from "../../../lib/chat/message-display.ts";
import { normalizeMessage } from "../../../lib/chat/message-normalizer.ts";
import { renderChatAuthorAvatar } from "./chat-author-avatar.ts";
import type { ChatPositionIndex } from "./chat-position-projection.ts";
import { POSITION_RAIL_MARKER_HEIGHT } from "./chat-transcript-geometry.ts";
import type { ChatTranscriptSession } from "./chat-transcript-session.ts";

const PREVIEW_LENGTH = 140;

export function syncPositionRailTabStop(
  scroller: HTMLElement | undefined,
  tabStop: HTMLElement | undefined,
): void {
  const previousTabStop = scroller?.querySelector<HTMLElement>('[tabindex="0"]');
  if (tabStop && tabStop !== previousTabStop) {
    if (previousTabStop) {
      previousTabStop.tabIndex = -1;
    }
    tabStop.tabIndex = 0;
  }
}

export function syncPositionRailPreview(
  preview: HTMLElement | undefined,
  marker: HTMLElement | undefined,
  center: number,
  viewportHeight: number,
): void {
  if (!preview || !marker) {
    return;
  }
  const label = preview.querySelector(".chat-position-rail__preview-label")?.textContent?.trim();
  const copy = preview.querySelector(".chat-position-rail__preview-copy")?.textContent?.trim();
  const description = `${label ?? ""} ${copy ?? ""}. ${t("chat.thread.positionMarkerHint")}`;
  if (marker.getAttribute("aria-description") !== description) {
    marker.setAttribute("aria-description", description);
  }
  preview.style.setProperty("--chat-position-preview", `${center}px`);
  preview.style.visibility = center < 0 || center > viewportHeight ? "hidden" : "";
}

export type PositionRailAssistant = {
  id: string;
  name: string;
  avatar: string | null;
  textAvatar: string | null;
};

type PositionRailViewParams = {
  transcript: ChatTranscriptSession;
  assistant?: PositionRailAssistant;
  markers: Readonly<ChatPositionIndex["markers"]>;
  renderedIndexes: readonly number[];
  activeId: string | undefined;
  visibleIds: ReadonlySet<string>;
  rovingId: string;
  previewId: string | null | undefined;
  hoveredId: string | null;
  bindScroller: (element?: Element) => void;
  bindPreview: (element?: Element) => void;
  onScroll: () => void;
  stopScrollInput: EventListenerObject & AddEventListenerOptions;
  onPointerLeave: () => void;
  onMarkerHover: (id: string) => void;
  onMarkerFocus: (id: string, event: FocusEvent) => void;
  onMarkerBlur: () => void;
  onMarkerKeyDown: (index: number, event: KeyboardEvent) => void;
  onMarkerSelect: (anchorId: string) => void;
};

/** Presentation only; the directive owns windowing, interaction, and DOM lifetime. */
export function renderChatPositionRailView({
  transcript,
  assistant,
  markers: candidates,
  renderedIndexes,
  activeId,
  visibleIds,
  rovingId,
  previewId,
  hoveredId,
  bindScroller,
  bindPreview,
  onScroll,
  stopScrollInput,
  onPointerLeave,
  onMarkerHover,
  onMarkerFocus,
  onMarkerBlur,
  onMarkerKeyDown,
  onMarkerSelect,
}: PositionRailViewParams) {
  const count = candidates.length;
  const userLabel = t("chat.thread.positionUserMessage");
  const assistantLabel = assistant?.name.trim() || t("chat.thread.positionAssistantMessage");
  const markerLabel = (marker: ChatPositionIndex["markers"][number]) =>
    marker.role === "user" ? userLabel : assistantLabel;
  const previewMarker =
    previewId == null ? undefined : candidates.find((marker) => marker.id === previewId);
  // Parse message content only for the open preview, even in long sessions.
  const previewMessage = previewMarker ? normalizeMessage(previewMarker.message) : undefined;
  const previewSender = previewMessage?.role === "user" ? previewMessage.sender : undefined;
  const previewLabel =
    (previewSender ? previewMessage?.senderLabel : null) ??
    (previewMarker ? markerLabel(previewMarker) : undefined);
  const previewText =
    previewMarker && previewMessage
      ? truncateUtf16Safe(
          resolveMessageDisplayMarkdown(previewMarker.message, previewMessage).trim(),
          PREVIEW_LENGTH,
        )
      : "";
  return html`
    <aside
      class="chat-position-rail"
      style=${`--chat-position-rail-count: ${count}`}
      aria-label=${t("chat.thread.positionRail")}
      @pointerleave=${onPointerLeave}
    >
      <div class="chat-position-rail__track">
        <div
          ${ref(bindScroller)}
          class="chat-position-rail__marks"
          role="list"
          aria-label=${t("chat.thread.positionRail")}
          @scroll=${onScroll}
          @wheel=${stopScrollInput}
          @touchstart=${stopScrollInput}
          @touchmove=${stopScrollInput}
        >
          <div class="chat-position-rail__virtual-space">
            ${guard(
              [
                transcript,
                count,
                hoveredId,
                ...renderedIndexes.flatMap((index) => [
                  index,
                  candidates[index]!.id,
                  markerLabel(candidates[index]!),
                  candidates[index]!.anchorId,
                ]),
              ],
              () =>
                repeat(
                  renderedIndexes,
                  (index) => candidates[index]!.id,
                  (index, renderedIndex) => {
                    const marker = candidates[index]!;
                    const previous = renderedIndexes[renderedIndex - 1];
                    // Keep distant retained marks outside the local hover wave.
                    return html`
                      ${previous !== undefined && index > previous + 1 ? html`<div aria-hidden="true"></div>` : nothing}
                      <div
                        class="chat-position-rail__item"
                        ?data-hovered=${marker.id === hoveredId}
                        role="listitem"
                        aria-posinset=${index + 1}
                        aria-setsize=${count}
                      >
                        <button
                          class="chat-position-rail__marker"
                          style=${`top: ${index * POSITION_RAIL_MARKER_HEIGHT}px`}
                          type="button"
                          data-position-marker-id=${marker.id}
                          tabindex=${marker.id === rovingId ? "0" : "-1"}
                          aria-label=${t("chat.thread.positionMarker", { position: String(index + 1), count: String(count), label: markerLabel(marker) })}
                          aria-description=${t("chat.thread.positionMarkerHint")}
                          aria-current=${String(marker.id === activeId)}
                          ?data-visible=${visibleIds.has(marker.id)}
                          @pointerenter=${() => onMarkerHover(marker.id)}
                          @focus=${(event: FocusEvent) => onMarkerFocus(marker.id, event)}
                          @blur=${onMarkerBlur}
                          @keydown=${(event: KeyboardEvent) => onMarkerKeyDown(index, event)}
                          @click=${() => onMarkerSelect(marker.anchorId)}
                        >
                          <span class="chat-position-rail__tick" aria-hidden="true"></span>
                        </button>
                      </div>
                    `;
                  },
                ),
            )}
          </div>
        </div>
        ${
          previewMarker
            ? html`
                <div ${ref(bindPreview)} class="chat-position-rail__preview" aria-hidden="true">
                  <div class="chat-position-rail__preview-header">
                    ${
                      previewMarker.role === "assistant" && assistant
                        ? html`<span
                            class="chat-author-avatar"
                            role="img"
                            aria-label=${assistantLabel}
                          >
                            ${renderAgentIdentityAvatar(assistant)}
                          </span>`
                        : renderChatAuthorAvatar(previewSender)
                    }
                    <span class="chat-position-rail__preview-label">${previewLabel}</span>
                  </div>
                  <!-- Preview links remain non-interactive; the marker owns keyboard navigation. -->
                  <div class="chat-position-rail__preview-copy" inert>
                    ${previewText ? unsafeHTML(toSanitizedMarkdownHtml(previewText, { codeBlockChrome: "none" })) : t("chat.attachments.previewUnavailable")}
                  </div>
                </div>
              `
            : nothing
        }
      </div>
    </aside>
  `;
}
