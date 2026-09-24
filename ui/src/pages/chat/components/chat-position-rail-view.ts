import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { html, nothing } from "lit";
import { guard } from "lit/directives/guard.js";
import { ref } from "lit/directives/ref.js";
import { repeat } from "lit/directives/repeat.js";
import { unsafeHTML } from "lit/directives/unsafe-html.js";
import { toSanitizedMarkdownHtml } from "../../../components/markdown.ts";
import { t } from "../../../i18n/index.ts";
import { resolveMessageDisplayMarkdown } from "../../../lib/chat/message-display.ts";
import { normalizeMessage } from "../../../lib/chat/message-normalizer.ts";
import { renderChatAuthorAvatar } from "./chat-author-avatar.ts";
import type { ChatPositionIndex } from "./chat-position-projection.ts";
import type { ChatTranscriptSession } from "./chat-transcript-session.ts";

const PREVIEW_LENGTH = 140;

type PositionRailViewParams = {
  transcript: ChatTranscriptSession;
  markers: Readonly<ChatPositionIndex["markers"]>;
  renderedIndexes: readonly number[];
  markerHeight: number;
  activeId: string | undefined;
  visibleIds: ReadonlySet<string>;
  rovingId: string;
  previewId: string | null | undefined;
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
  markers: candidates,
  renderedIndexes,
  markerHeight,
  activeId,
  visibleIds,
  rovingId,
  previewId,
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
  const assistantLabel = t("chat.thread.positionAssistantMessage");
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
                        role="listitem"
                        aria-posinset=${index + 1}
                        aria-setsize=${count}
                      >
                        <button
                          class="chat-position-rail__marker"
                          style=${`top: ${index * markerHeight}px`}
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
                    ${renderChatAuthorAvatar(previewSender)}
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
