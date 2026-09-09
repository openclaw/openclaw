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
import { normalizeMessage, resolveMessageRole } from "../../../lib/chat/message-normalizer.ts";
import { persistedMessageEntryId } from "../chat-thread-items.ts";
import { resolveMessageDisplayMarkdown } from "./chat-message-text.ts";
import type { ChatTranscriptSession } from "./chat-transcript-session.ts";

const PREVIEW_LENGTH = 140;

type RailInteraction = {
  hoveredId: string | null;
  focusedId: string | null;
  rovingId: string | null;
  dismissed: boolean;
};

function initialInteraction(): RailInteraction {
  return { hoveredId: null, focusedId: null, rovingId: null, dismissed: false };
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
  private markersChanged = true;
  private readonly markerElements = new Map<string, HTMLElement>();
  private transcriptElement: HTMLElement | undefined;
  private intersectionObserver: IntersectionObserver | undefined;
  private mutationObserver: MutationObserver | undefined;
  private readonly observedMessages = new Map<Element, { id: string; visible: boolean }>();
  private visibleIds = new Set<string>();
  private targetsChanged = true;
  private followActive = false;
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
      this.mutationObserver = new MutationObserver((records, observer) => {
        if (observer !== this.mutationObserver) {
          return;
        }
        if (
          records.some(
            (record) =>
              !(record.target instanceof Element) || !record.target.closest(".chat-position-rail"),
          )
        ) {
          this.targetsChanged = true;
          this.scheduleLayout();
        }
      });
      this.mutationObserver.observe(root, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ["data-entry-id"],
      });
      this.targetsChanged = true;
    }
    if (!this.targetsChanged) {
      return;
    }
    this.targetsChanged = false;
    const targets = new Set(root.querySelectorAll(".chat-bubble[data-entry-id]"));
    for (const [element, message] of this.observedMessages) {
      if (
        !targets.has(element) ||
        !this.markerElements.has(message.id) ||
        element.getAttribute("data-entry-id") !== message.id
      ) {
        this.intersectionObserver?.unobserve(element);
        this.observedMessages.delete(element);
      }
    }
    for (const element of targets) {
      const id = element.getAttribute("data-entry-id")!;
      if (this.markerElements.has(id) && !this.observedMessages.has(element)) {
        this.observedMessages.set(element, { id, visible: false });
        this.intersectionObserver?.observe(element);
      }
    }
  }

  private syncVisibleMarks() {
    const visible = new Set(
      Array.from(this.observedMessages.values())
        .filter((message) => message.visible)
        .map((message) => message.id),
    );
    let changed = false;
    for (const id of this.visibleIds) {
      if (!visible.has(id)) {
        this.markerElements.get(id)?.removeAttribute("data-visible");
        changed = true;
      }
    }
    for (const id of visible) {
      if (!this.visibleIds.has(id)) {
        this.markerElements.get(id)?.setAttribute("data-visible", "");
        changed = true;
      }
    }
    this.visibleIds = visible;
    const visibleOrder = this.markerIds.filter((id) => visible.has(id));
    const activeId = this.session?.activeMessageId(visibleOrder) ?? visibleOrder[0];
    if (activeId !== this.activeId) {
      this.markerElements.get(this.activeId ?? "")?.setAttribute("aria-current", "false");
      this.activeId = activeId;
      this.markerElements.get(activeId ?? "")?.setAttribute("aria-current", "true");
      changed = true;
    }
    if (changed) {
      this.followActive = true;
      this.scheduleLayout();
    }
  }

  private syncLayout() {
    const scroller = this.scrollElement;
    if (!scroller || scroller.clientHeight === 0) {
      return;
    }
    if (this.markersChanged) {
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
    const rovingId = this.interaction.rovingId ?? this.activeId ?? this.markerIds[0];
    const previousTabStop = scroller.querySelector<HTMLElement>('[tabindex="0"]');
    const tabStop = this.markerElements.get(rovingId ?? "");
    if (tabStop && tabStop !== previousTabStop) {
      if (previousTabStop) {
        previousTabStop.tabIndex = -1;
      }
      tabStop.tabIndex = 0;
    }
    if (this.followActive) {
      this.followActive = false;
      const current = this.markerElements.get(this.activeId ?? "");
      if (current) {
        this.revealMarker(current);
      }
    }
    scroller.toggleAttribute("data-overflow-top", scroller.scrollTop > 1);
    scroller.toggleAttribute(
      "data-overflow-bottom",
      scroller.scrollHeight - scroller.clientHeight - scroller.scrollTop > 1,
    );
    const preview = this.previewElement;
    if (preview) {
      const previewId = this.interaction.hoveredId ?? this.interaction.focusedId;
      const marker = this.markerElements.get(previewId ?? "");
      if (marker) {
        const center = marker.offsetTop + marker.offsetHeight / 2 - scroller.scrollTop;
        const description = `${preview.textContent?.trim() ?? ""}. ${t("chat.thread.positionMarkerHint")}`;
        if (marker.getAttribute("aria-description") !== description) {
          marker.setAttribute("aria-description", description);
        }
        preview.style.setProperty("--chat-position-preview", `${center}px`);
        preview.style.visibility = center < 0 || center > scroller.clientHeight ? "hidden" : "";
      }
    }
  }

  private readonly bindScroller = (element?: Element) => {
    this.resizeObserver?.disconnect();
    this.disconnectVisibility();
    this.markersChanged = true;
    if (this.layoutFrame !== undefined) {
      cancelAnimationFrame(this.layoutFrame);
      this.layoutFrame = undefined;
    }
    this.scrollElement = element instanceof HTMLElement ? element : undefined;
    if (this.scrollElement) {
      this.followActive = true;
      this.resizeObserver = new ResizeObserver(() => {
        this.followActive = true;
        this.scheduleLayout();
      });
      this.resizeObserver.observe(this.scrollElement);
      this.scheduleLayout();
    }
  };

  private readonly dismissPreview = (event: KeyboardEvent) => {
    const rail = this.previewElement?.closest(".chat-position-rail");
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
    messages,
    transcript,
    requestUpdate,
  }: {
    messages: readonly unknown[];
    transcript: ChatTranscriptSession;
    requestUpdate: () => void;
  }) {
    this.requestUpdate = requestUpdate;
    if (this.session !== transcript) {
      this.session = transcript;
      this.interaction = initialInteraction();
      this.disconnectVisibility();
      this.markersChanged = true;
    }
    const candidates = messages.flatMap((message) => {
      const id = persistedMessageEntryId(message);
      return id ? [{ id, message }] : [];
    });
    const count = candidates.length;
    if (count < 2) {
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
    if (!candidates.some((candidate) => candidate.id === interaction.rovingId)) {
      interaction.rovingId = null;
    }
    const markers = candidates.map(({ id, message }) => ({
      id,
      message,
      label: t(
        resolveMessageRole(message) === "user"
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
    const previewText = previewMarker
      ? truncateUtf16Safe(
          resolveMessageDisplayMarkdown(
            previewMarker.message,
            normalizeMessage(previewMarker.message),
          ).trim(),
          PREVIEW_LENGTH,
        )
      : "";
    const rovingId = interaction.rovingId ?? this.activeId ?? markers[0]!.id;
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
            @scroll=${this.scheduleLayout}
            @wheel=${this.stopScrollInput}
            @touchstart=${this.stopScrollInput}
            @touchmove=${this.stopScrollInput}
          >
            <!-- Scroll visibility updates only changed DOM attributes; keep marker templates stable. -->
            ${guard([transcript, ...markers.flatMap((marker) => [marker.id, marker.label])], () =>
              repeat(
                markers,
                (marker) => marker.id,
                (marker, index) => html`
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
                      interaction.rovingId = marker.id;
                      interaction.dismissed = false;
                      this.requestUpdate?.();
                    }}
                    @blur=${() => {
                      interaction.focusedId = null;
                      this.requestUpdate?.();
                    }}
                    @keydown=${(event: KeyboardEvent) => {
                      if (
                        ["ArrowDown", "ArrowLeft", "ArrowRight", "ArrowUp", "End", "Home"].includes(
                          event.key,
                        )
                      ) {
                        moveFocus(event, index);
                      } else if (event.key === "PageUp" || event.key === "PageDown") {
                        event.stopPropagation();
                      }
                    }}
                    @click=${() => transcript.revealMessage(marker.id)}
                  >
                    <span class="chat-position-rail__tick" aria-hidden="true"></span>
                  </button>
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
                    <span class="chat-position-rail__preview-label">${previewMarker.label}</span>
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
