import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { html, nothing } from "lit";
import { AsyncDirective } from "lit/async-directive.js";
import { directive } from "lit/directive.js";
import { guard } from "lit/directives/guard.js";
import { ref } from "lit/directives/ref.js";
import { repeat } from "lit/directives/repeat.js";
import { unsafeHTML } from "lit/directives/unsafe-html.js";
import { toSanitizedMarkdownHtml } from "../../../components/markdown.ts";
import { t } from "../../../i18n/index.ts";
import { resolveMessageDisplayMarkdown } from "../../../lib/chat/message-display.ts";
import { normalizeMessage } from "../../../lib/chat/message-normalizer.ts";
import { captureChatSessionScrollPosition, type ChatSessionScrollPosition } from "../scroll.ts";
import { renderChatAuthorAvatar } from "./chat-author-avatar.ts";
import type { ChatPositionIndex } from "./chat-position-projection.ts";
import type { ChatTranscriptSession } from "./chat-transcript-session.ts";

const PREVIEW_LENGTH = 140;
const MESSAGE_SELECTOR = ".chat-bubble[data-entry-id]";
const PROVISIONAL_MESSAGE_SELECTOR = ".chat-bubble[data-message-id]:not([data-entry-id])";

type RailInteraction = {
  hoveredId: string | null;
  focusedId: string | null;
  dismissed: boolean;
};

function initialInteraction(): RailInteraction {
  return { hoveredId: null, focusedId: null, dismissed: false };
}

// The directive owns transient DOM interaction; the session owns reader position.
class ChatPositionRailDirective extends AsyncDirective {
  private session: ChatTranscriptSession | null = null;
  private interaction = initialInteraction();
  private requestUpdate: (() => void) | undefined;
  private previewElement: HTMLElement | undefined;
  private scrollElement: HTMLElement | undefined;
  private resizeObserver: ResizeObserver | undefined;
  private layoutFrame: number | undefined;
  private activeId: string | undefined;
  private markerIds: string[] = [];
  private markerIdsByMessageId: ReadonlyMap<string, string> = new Map();
  private positionMessageIds: string[] = [];
  private markersChanged = true;
  private readonly markerElements = new Map<string, HTMLElement>();
  private transcriptElement: HTMLElement | undefined;
  private intersectionObserver: IntersectionObserver | undefined;
  private mutationObserver: MutationObserver | undefined;
  private readonly observedMessages = new Map<
    Element,
    { id: string; messageId: string; visible: boolean }
  >();
  private visibleIds = new Set<string>();
  private targetsChanged = true;
  private followActive = false;
  private layoutVisible = false;
  private readerViewport: (ChatSessionScrollPosition & { height: number }) | undefined;
  private resizeScrollTarget: { offset: number; atEnd: boolean } | undefined;
  private followingResize = false;
  private readonly stopScrollInput = {
    handleEvent: (event: Event) => event.stopPropagation(),
    passive: true,
  };

  private readonly scheduleLayout = () => {
    if (this.layoutFrame !== undefined || !this.scrollElement) {
      return;
    }
    this.layoutFrame = requestAnimationFrame(() => {
      this.layoutFrame = undefined;
      this.syncLayout();
    });
  };

  private revealMarker(marker: HTMLElement) {
    const scroller = this.scrollElement;
    if (!scroller || scroller.clientHeight === 0) {
      return;
    }
    const inset = Number.parseFloat(getComputedStyle(scroller).scrollPaddingTop) || 0;
    const top = marker.offsetTop;
    const bottom = top + marker.offsetHeight;
    if (
      top < scroller.scrollTop + inset ||
      bottom > scroller.scrollTop + scroller.clientHeight - inset
    ) {
      // Scroll only the rail: scrollIntoView would also move the transcript.
      scroller.scrollTop = (top + bottom - scroller.clientHeight) / 2;
    }
  }

  private disconnectVisibility() {
    this.intersectionObserver?.disconnect();
    this.mutationObserver?.disconnect();
    this.intersectionObserver = undefined;
    this.mutationObserver = undefined;
    this.transcriptElement = undefined;
    this.readerViewport = undefined;
    this.resizeScrollTarget = undefined;
    this.followingResize = false;
    this.observedMessages.clear();
    for (const id of this.visibleIds) {
      this.markerElements.get(id)?.removeAttribute("data-visible");
    }
    this.scrollElement
      ?.querySelector('[aria-current="true"]')
      ?.setAttribute("aria-current", "false");
    this.visibleIds.clear();
    this.activeId = undefined;
  }

  private syncVisibilityTargets() {
    const root = this.scrollElement?.closest<HTMLElement>(".chat-thread");
    if (!root) {
      return;
    }
    if (root !== this.transcriptElement) {
      this.disconnectVisibility();
      this.transcriptElement = root;
      // The composer covers this part of the scrollport; it is not visible text.
      const underlap =
        Number.parseFloat(
          getComputedStyle(root).getPropertyValue("--chat-transcript-composer-underlap"),
        ) || 0;
      // Publish the first visible pixel after an initially zero-area edge touch.
      this.intersectionObserver = new IntersectionObserver(
        (entries, observer) => {
          if (observer !== this.intersectionObserver) {
            return;
          }
          for (const entry of entries) {
            const message = this.observedMessages.get(entry.target);
            if (message) {
              message.visible = entry.isIntersecting && entry.intersectionRatio > 0;
            }
          }
          this.syncVisibleMarks();
        },
        { root, rootMargin: `0px 0px -${underlap}px 0px`, threshold: [0, Number.EPSILON, 1] },
      );
      // Virtualization replaces message nodes without replacing the rail.
      // Streaming descendants keep the same observed bubble targets.
      const isPositionTarget = (element: Element) =>
        element.matches(MESSAGE_SELECTOR) ||
        (element.matches(PROVISIONAL_MESSAGE_SELECTOR) &&
          this.markerIdsByMessageId.has(element.getAttribute("data-message-id")!));
      this.mutationObserver = new MutationObserver((records, observer) => {
        if (observer !== this.mutationObserver) {
          return;
        }
        if (
          records.some((record) => {
            if (record.target instanceof Element && record.target.closest(".chat-position-rail")) {
              return false;
            }
            return (
              record.type === "attributes" ||
              [...record.addedNodes, ...record.removedNodes].some(
                (node) =>
                  node instanceof Element &&
                  (isPositionTarget(node) ||
                    [
                      ...node.querySelectorAll(
                        `${MESSAGE_SELECTOR}, ${PROVISIONAL_MESSAGE_SELECTOR}`,
                      ),
                    ].some(isPositionTarget)),
              )
            );
          })
        ) {
          this.targetsChanged = true;
          this.scheduleLayout();
        }
      });
      this.mutationObserver.observe(root, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ["data-entry-id", "data-message-id"],
      });
      this.targetsChanged = true;
    }
    if (!this.targetsChanged) {
      return;
    }
    this.targetsChanged = false;
    const targets = new Set([
      ...root.querySelectorAll(MESSAGE_SELECTOR),
      ...root.querySelectorAll(PROVISIONAL_MESSAGE_SELECTOR),
    ]);
    const messageIdFor = (element: Element) =>
      element.getAttribute("data-entry-id") ?? element.getAttribute("data-message-id");
    for (const [element, message] of this.observedMessages) {
      if (
        !targets.has(element) ||
        messageIdFor(element) !== message.messageId ||
        this.markerIdsByMessageId.get(message.messageId) !== message.id
      ) {
        this.intersectionObserver?.unobserve(element);
        this.observedMessages.delete(element);
      }
    }
    for (const element of targets) {
      const messageId = messageIdFor(element);
      const id = messageId ? this.markerIdsByMessageId.get(messageId) : undefined;
      if (messageId && id && !this.observedMessages.has(element)) {
        this.observedMessages.set(element, { id, messageId, visible: false });
        this.intersectionObserver?.observe(element);
      }
    }
  }

  private syncVisibleMarks() {
    const root = this.transcriptElement;
    if (root) {
      const viewport = {
        height: root.clientHeight,
        ...captureChatSessionScrollPosition(root),
      };
      const previous = this.readerViewport;
      if (previous && viewport.height !== previous.height) {
        // The transcript can publish intersections before its resize scroll compensation.
        // Neither update is a request to navigate the rail.
        this.followingResize = true;
        this.followActive = false;
        const atEnd = this.resizeScrollTarget?.atEnd ?? previous.anchorToEnd;
        const maxOffset = Math.max(0, root.scrollHeight - viewport.height);
        this.resizeScrollTarget = {
          offset: atEnd ? maxOffset : Math.min(previous.scrollTop, maxOffset),
          atEnd,
        };
      } else if (previous && viewport.scrollTop !== previous.scrollTop) {
        if (
          !this.resizeScrollTarget ||
          Math.abs(viewport.scrollTop - this.resizeScrollTarget.offset) > 1
        ) {
          if (this.followingResize) {
            this.followActive = true;
            this.scheduleLayout();
          }
          this.followingResize = false;
        }
        this.resizeScrollTarget = undefined;
      }
      this.readerViewport = viewport;
    }
    const visible = new Set(
      Array.from(this.observedMessages.values())
        .filter((message) => message.visible)
        .map((message) => message.id),
    );
    for (const id of this.visibleIds) {
      if (!visible.has(id)) {
        this.markerElements.get(id)?.removeAttribute("data-visible");
      }
    }
    for (const id of visible) {
      if (!this.visibleIds.has(id)) {
        this.markerElements.get(id)?.setAttribute("data-visible", "");
      }
    }
    this.visibleIds = visible;
    const visibleMessageIds = new Set(
      Array.from(this.observedMessages.values())
        .filter((message) => message.visible)
        .map((message) => message.messageId),
    );
    const visibleOrder = this.positionMessageIds.filter((id) => visibleMessageIds.has(id));
    // A continuation, folded tool row, or virtualized jump still belongs to a transcript position.
    const activeMessageId = this.session?.activeMessageId(
      visibleOrder.length ? visibleOrder : this.positionMessageIds,
    );
    const activeId =
      (activeMessageId ? this.markerIdsByMessageId.get(activeMessageId) : undefined) ??
      this.markerIds[0];
    if (activeId !== this.activeId) {
      this.markerElements.get(this.activeId ?? "")?.setAttribute("aria-current", "false");
      this.activeId = activeId;
      this.markerElements.get(activeId ?? "")?.setAttribute("aria-current", "true");
      if (!this.followingResize) {
        this.followActive = true;
      }
      this.scheduleLayout();
    }
  }

  private syncLayout() {
    const scroller = this.scrollElement;
    if (!scroller || scroller.clientHeight === 0) {
      this.layoutVisible = false;
      return;
    }
    const projectionChanged =
      this.markersChanged &&
      [...this.markerElements.keys()].some((id, index) => id !== this.markerIds[index]);
    const initialize = !this.layoutVisible || projectionChanged;
    this.layoutVisible = true;
    if (initialize) {
      this.readerViewport = undefined;
      this.resizeScrollTarget = undefined;
      this.followingResize = false;
    }
    if (this.markersChanged) {
      // Appends keep existing offsets valid; filtering or reordering retires that scroll room.
      if (projectionChanged) {
        scroller.style.removeProperty("--chat-position-scroll-top");
      }
      this.markersChanged = false;
      this.markerElements.clear();
      for (const element of scroller.querySelectorAll<HTMLElement>(".chat-position-rail__marker")) {
        this.markerElements.set(element.dataset.positionMarkerId!, element);
      }
      this.targetsChanged = true;
    }
    this.syncVisibilityTargets();
    // Reader offsets can move the anchor without changing any intersections.
    this.syncVisibleMarks();
    this.syncTabStop();
    if (initialize || this.followActive) {
      this.followActive = false;
      const current = this.markerElements.get(
        (initialize ? this.interaction.focusedId : null) ?? this.activeId ?? "",
      );
      if (current) {
        this.revealMarker(current);
      }
    }
    // Reserve only the trailing space needed to keep this offset when the viewport grows.
    scroller.style.setProperty("--chat-position-scroll-top", `${scroller.scrollTop}px`);
    const lastMarker = this.markerElements.get(this.markerIds.at(-1)!);
    const contentBottom = lastMarker ? lastMarker.offsetTop + lastMarker.offsetHeight : 0;
    scroller.toggleAttribute("data-overflow-top", scroller.scrollTop > 1);
    scroller.toggleAttribute(
      "data-overflow-bottom",
      contentBottom - scroller.clientHeight - scroller.scrollTop > 1,
    );
    const preview = this.previewElement;
    if (preview) {
      const previewId = this.interaction.hoveredId ?? this.interaction.focusedId;
      const marker = this.markerElements.get(previewId ?? "");
      if (marker) {
        const center = marker.offsetTop + marker.offsetHeight / 2 - scroller.scrollTop;
        const label = preview
          .querySelector(".chat-position-rail__preview-label")
          ?.textContent?.trim();
        const copy = preview
          .querySelector(".chat-position-rail__preview-copy")
          ?.textContent?.trim();
        const description = `${label ?? ""} ${copy ?? ""}. ${t("chat.thread.positionMarkerHint")}`;
        if (marker.getAttribute("aria-description") !== description) {
          marker.setAttribute("aria-description", description);
        }
        preview.style.setProperty("--chat-position-preview", `${center}px`);
        preview.style.visibility = center < 0 || center > scroller.clientHeight ? "hidden" : "";
      }
    }
  }

  private syncTabStop() {
    // Reenter at the reader position; arrow navigation owns focus only while inside the rail.
    const rovingId = this.interaction.focusedId ?? this.activeId ?? this.markerIds[0];
    const previousTabStop = this.scrollElement?.querySelector<HTMLElement>('[tabindex="0"]');
    const tabStop = this.markerElements.get(rovingId ?? "");
    if (tabStop && tabStop !== previousTabStop) {
      if (previousTabStop) {
        previousTabStop.tabIndex = -1;
      }
      tabStop.tabIndex = 0;
    }
  }

  private readonly bindScroller = (element?: Element) => {
    this.resizeObserver?.disconnect();
    this.disconnectVisibility();
    this.markersChanged = true;
    this.layoutVisible = false;
    if (this.layoutFrame !== undefined) {
      cancelAnimationFrame(this.layoutFrame);
      this.layoutFrame = undefined;
    }
    this.scrollElement = element instanceof HTMLElement ? element : undefined;
    if (this.scrollElement) {
      this.followActive = true;
      this.resizeObserver = new ResizeObserver(this.scheduleLayout);
      this.resizeObserver.observe(this.scrollElement);
      this.scheduleLayout();
    }
  };

  private readonly dismissPreview = (event: KeyboardEvent) => {
    const rail = this.scrollElement?.closest(".chat-position-rail");
    if (
      event.key !== "Escape" ||
      event.defaultPrevented ||
      this.interaction.dismissed ||
      !rail ||
      rail.ownerDocument.defaultView?.getComputedStyle(rail).display === "none"
    ) {
      return;
    }
    event.preventDefault();
    event.stopImmediatePropagation();
    this.interaction.hoveredId = null;
    this.interaction.dismissed = true;
    if (rail.contains(rail.ownerDocument.activeElement)) {
      // Every marker reveals a message in this transcript. Hover-only dismissal keeps focus.
      rail.closest<HTMLElement>(".chat-thread")?.focus({ preventScroll: true });
    }
    this.requestUpdate?.();
  };

  private readonly bindPreview = (element?: Element) => {
    this.previewElement?.ownerDocument.defaultView?.removeEventListener(
      "keydown",
      this.dismissPreview,
      true,
    );
    this.previewElement = element instanceof HTMLElement ? element : undefined;
    this.scheduleLayout();
    element?.ownerDocument.defaultView?.addEventListener("keydown", this.dismissPreview, true);
  };

  protected override disconnected() {
    this.bindPreview();
    this.bindScroller();
    this.interaction.hoveredId = null;
    this.interaction.focusedId = null;
    this.interaction.dismissed = false;
  }

  protected override reconnected() {
    this.requestUpdate?.();
  }

  render({
    positions,
    transcript,
    requestUpdate,
  }: {
    positions: ChatPositionIndex;
    transcript: ChatTranscriptSession;
    requestUpdate: () => void;
  }) {
    this.requestUpdate = requestUpdate;
    if (this.session !== transcript) {
      this.session = transcript;
      this.interaction = initialInteraction();
      this.layoutVisible = false;
      this.disconnectVisibility();
      this.markersChanged = true;
    }
    const candidates = positions.markers;
    if (
      this.markerIdsByMessageId.size !== positions.markerIdsByMessageId.size ||
      [...positions.markerIdsByMessageId].some(
        ([messageId, markerId]) => this.markerIdsByMessageId.get(messageId) !== markerId,
      )
    ) {
      this.targetsChanged = true;
    }
    this.markerIdsByMessageId = positions.markerIdsByMessageId;
    this.positionMessageIds = [...positions.markerIdsByMessageId.keys()];
    const count = candidates.length;
    if (count === 0) {
      this.disconnected();
      return nothing;
    }
    const interaction = this.interaction;
    if (!candidates.some((candidate) => candidate.id === interaction.focusedId)) {
      interaction.focusedId = null;
    }
    if (!candidates.some((candidate) => candidate.id === interaction.hoveredId)) {
      interaction.hoveredId = null;
    }
    const markers = candidates.map(({ id, anchorId, message, role }) => ({
      id,
      anchorId,
      message,
      label: t(
        role === "user"
          ? "chat.thread.positionUserMessage"
          : "chat.thread.positionAssistantMessage",
      ),
    }));
    const ids = markers.map((marker) => marker.id);
    if (
      ids.length !== this.markerIds.length ||
      ids.some((id, index) => id !== this.markerIds[index])
    ) {
      this.markerIds = ids;
      this.markersChanged = true;
    }
    this.scheduleLayout();
    const previewMarker = interaction.dismissed
      ? undefined
      : markers.find((marker) => marker.id === (interaction.hoveredId ?? interaction.focusedId));
    // Parse message content only for the open preview, even in long sessions.
    const previewMessage = previewMarker ? normalizeMessage(previewMarker.message) : undefined;
    const previewSender = previewMessage?.role === "user" ? previewMessage.sender : undefined;
    const previewLabel =
      (previewSender ? previewMessage?.senderLabel : null) ?? previewMarker?.label;
    const previewText =
      previewMarker && previewMessage
        ? truncateUtf16Safe(
            resolveMessageDisplayMarkdown(previewMarker.message, previewMessage).trim(),
            PREVIEW_LENGTH,
          )
        : "";
    const rovingId = interaction.focusedId ?? this.activeId ?? markers[0]!.id;
    const moveFocus = (event: KeyboardEvent, index: number) => {
      const nextIndex =
        event.key === "Home"
          ? 0
          : event.key === "End"
            ? count - 1
            : Math.max(
                0,
                Math.min(
                  count - 1,
                  index + (event.key === "ArrowUp" || event.key === "ArrowLeft" ? -1 : 1),
                ),
              );
      event.preventDefault();
      event.stopPropagation();
      // Focus existing buttons synchronously: currentTarget expires after dispatch.
      if (!(event.currentTarget instanceof HTMLButtonElement)) {
        return;
      }
      event.currentTarget
        .closest(".chat-position-rail")
        ?.querySelectorAll<HTMLButtonElement>(".chat-position-rail__marker")
        .item(nextIndex)
        ?.focus({ preventScroll: true });
    };
    return html`
      <aside
        class="chat-position-rail"
        style=${`--chat-position-rail-count: ${count}`}
        aria-label=${t("chat.thread.positionRail")}
        @pointerleave=${() => {
          interaction.hoveredId = null;
          this.requestUpdate?.();
        }}
      >
        <div class="chat-position-rail__track">
          <div
            ${ref(this.bindScroller)}
            class="chat-position-rail__marks"
            role="list"
            aria-label=${t("chat.thread.positionRail")}
            @scroll=${this.scheduleLayout}
            @wheel=${this.stopScrollInput}
            @touchstart=${this.stopScrollInput}
            @touchmove=${this.stopScrollInput}
          >
            <!-- Scroll visibility updates only changed DOM attributes; keep marker templates stable. -->
            ${guard(
              [
                transcript,
                ...markers.flatMap((marker) => [marker.id, marker.label, marker.anchorId]),
              ],
              () =>
                repeat(
                  markers,
                  (marker) => marker.id,
                  (marker, index) => html`
                    <div class="chat-position-rail__item" role="listitem">
                      <button
                        class="chat-position-rail__marker"
                        type="button"
                        data-position-marker-id=${marker.id}
                        tabindex=${marker.id === rovingId ? "0" : "-1"}
                        aria-label=${t("chat.thread.positionMarker", { position: String(index + 1), count: String(count), label: marker.label })}
                        aria-description=${t("chat.thread.positionMarkerHint")}
                        aria-current="false"
                        @pointerenter=${() => {
                          interaction.hoveredId = marker.id;
                          interaction.dismissed = false;
                          this.requestUpdate?.();
                        }}
                        @focus=${(event: FocusEvent) => {
                          // Pointer focus must not move the target before pointer-up.
                          if (
                            event.currentTarget instanceof HTMLElement &&
                            event.currentTarget.matches(":focus-visible")
                          ) {
                            this.revealMarker(event.currentTarget);
                          }
                          interaction.focusedId = marker.id;
                          interaction.dismissed = false;
                          this.syncTabStop();
                          this.requestUpdate?.();
                        }}
                        @blur=${() => {
                          interaction.focusedId = null;
                          this.syncTabStop();
                          this.requestUpdate?.();
                        }}
                        @keydown=${(event: KeyboardEvent) => {
                          if (
                            [
                              "ArrowDown",
                              "ArrowLeft",
                              "ArrowRight",
                              "ArrowUp",
                              "End",
                              "Home",
                            ].includes(event.key)
                          ) {
                            moveFocus(event, index);
                          } else if (event.key === "Escape") {
                            this.dismissPreview(event);
                          } else if (event.key === "PageUp" || event.key === "PageDown") {
                            event.stopPropagation();
                          }
                        }}
                        @click=${() => transcript.revealMessage(marker.anchorId)}
                      >
                        <span class="chat-position-rail__tick" aria-hidden="true"></span>
                      </button>
                    </div>
                  `,
                ),
            )}
          </div>
          ${
            previewMarker
              ? html`
                  <div
                    ${ref(this.bindPreview)}
                    class="chat-position-rail__preview"
                    aria-hidden="true"
                  >
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
}

export const renderChatPositionRail = directive(ChatPositionRailDirective);
