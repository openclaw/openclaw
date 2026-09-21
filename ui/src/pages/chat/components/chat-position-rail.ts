import { nothing } from "lit";
import { AsyncDirective } from "lit/async-directive.js";
import { directive } from "lit/directive.js";
import { t } from "../../../i18n/index.ts";
import { captureChatSessionScrollPosition, type ChatSessionScrollPosition } from "../scroll.ts";
import type { ChatPositionIndex } from "./chat-position-projection.ts";
import { renderChatPositionRailView } from "./chat-position-rail-view.ts";
import { subscribeTranscriptScroll } from "./chat-transcript-scroll-events.ts";
import type { ChatTranscriptSession } from "./chat-transcript-session.ts";

const MARKER_HEIGHT = 12;
const MARKER_OVERSCAN = 6;
const MESSAGE_SELECTOR = ".chat-bubble[data-entry-id]";
const PROVISIONAL_MESSAGE_SELECTOR = ".chat-bubble[data-message-id]:not([data-entry-id])";

type RailInteraction = {
  hoveredId: string | null;
  focusedId: string | null;
  dismissed: boolean;
};

type PositionRailParams = {
  positions: ChatPositionIndex;
  transcript: ChatTranscriptSession;
  requestUpdate: () => void;
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
  private markerIndexes = new Map<string, number>();
  private renderedIndexes: number[] = [];
  private viewportHeight: number | undefined;
  private viewportOffset = 0;
  private renderParams: PositionRailParams | undefined;
  private pendingFocusId: string | undefined;
  private restoringFocus = false;
  private projectionChanged = false;
  private mountedMarkersChanged = true;
  private markerIdsByMessageId: ReadonlyMap<string, string> = new Map();
  private positionMessageIds: string[] = [];
  private markersChanged = true;
  private readonly markerElements = new Map<string, HTMLElement>();
  private transcriptElement: HTMLElement | undefined;
  private intersectionObserver: IntersectionObserver | undefined;
  private mutationObserver: MutationObserver | undefined;
  private stopTranscriptScroll: (() => void) | undefined;
  private readonly observedMessages = new Map<
    Element,
    { id: string; messageId: string; visible: boolean }
  >();
  private visibleIds = new Set<string>();
  private initialVisibilityPending = true;
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

  private revealMarker(id: string) {
    const scroller = this.scrollElement;
    const index = this.markerIndexes.get(id);
    if (!scroller || scroller.clientHeight === 0 || index === undefined) {
      return;
    }
    const inset = Number.parseFloat(getComputedStyle(scroller).scrollPaddingTop) || 0;
    const top = index * MARKER_HEIGHT;
    const bottom = top + MARKER_HEIGHT;
    if (
      top < scroller.scrollTop + inset ||
      bottom > scroller.scrollTop + scroller.clientHeight - inset
    ) {
      // Scroll only the rail: scrollIntoView would also move the transcript.
      scroller.scrollTop = (top + bottom - scroller.clientHeight) / 2;
    }
  }

  private windowIndexes(): number[] {
    const count = this.markerIds.length;
    const start = Math.max(0, Math.floor(this.viewportOffset / MARKER_HEIGHT) - MARKER_OVERSCAN);
    const end = Math.min(
      count,
      Math.ceil(
        (this.viewportOffset + (this.viewportHeight ?? window.innerHeight)) / MARKER_HEIGHT,
      ) + MARKER_OVERSCAN,
    );
    const indexes = new Set<number>();
    for (let index = start; index < end; index++) {
      indexes.add(index);
    }
    // Roving Tab entry and an explored focus must survive an independently scrolled rail.
    for (const id of [
      this.activeId ?? this.markerIds[0],
      this.interaction.focusedId,
      this.interaction.hoveredId,
      this.pendingFocusId,
    ]) {
      const index = id ? this.markerIndexes.get(id) : undefined;
      if (index !== undefined) {
        indexes.add(index);
      }
    }
    return [...indexes].toSorted((left, right) => left - right);
  }

  private refreshWindow(): void {
    const params = this.renderParams;
    if (this.isConnected && params) {
      const scroller = this.scrollElement;
      const session = this.session;
      const focused = scroller?.ownerDocument.activeElement;
      const focusedId =
        focused instanceof HTMLElement ? focused.dataset.positionMarkerId : undefined;
      this.setValue(this.render(params));
      // Lit can move a retained keyed part, which blurs its focused button.
      // Restore that focus without treating it as new navigation or recentering.
      if (
        !this.pendingFocusId &&
        focusedId &&
        focused instanceof HTMLElement &&
        this.isConnected &&
        this.session === session &&
        this.scrollElement === scroller &&
        scroller?.contains(focused) &&
        scroller.ownerDocument.activeElement === scroller.ownerDocument.body
      ) {
        this.interaction.focusedId = focusedId;
        this.restoringFocus = true;
        try {
          focused.focus({ preventScroll: true });
        } finally {
          this.restoringFocus = false;
        }
      }
    }
  }

  private syncMountedMarkers(): void {
    if (!this.mountedMarkersChanged) {
      return;
    }
    this.mountedMarkersChanged = false;
    this.markerElements.clear();
    for (const marker of this.scrollElement?.querySelectorAll<HTMLElement>(
      ".chat-position-rail__marker",
    ) ?? []) {
      this.markerElements.set(marker.dataset.positionMarkerId!, marker);
    }
  }

  private focusMarker(id: string): void {
    const session = this.session;
    const scroller = this.scrollElement;
    this.pendingFocusId = id;
    this.revealMarker(id);
    this.viewportOffset = scroller?.scrollTop ?? 0;
    this.refreshWindow();
    // Rendering can retire this directive through a host update; never focus its successor.
    if (!this.isConnected || this.session !== session || this.scrollElement !== scroller) {
      this.pendingFocusId = undefined;
      return;
    }
    this.syncMountedMarkers();
    this.markerElements.get(id)?.focus({ preventScroll: true });
    this.pendingFocusId = undefined;
  }

  private disconnectVisibility() {
    this.stopTranscriptScroll?.();
    this.stopTranscriptScroll = undefined;
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
    this.initialVisibilityPending = true;
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
      this.stopTranscriptScroll = subscribeTranscriptScroll(root, (observation) => {
        if (observation.type === "input") {
          if (this.followingResize) {
            this.followActive = true;
            this.scheduleLayout();
          }
          this.followingResize = false;
          this.resizeScrollTarget = undefined;
        } else if (
          observation.type === "resize" &&
          this.layoutVisible &&
          this.scrollElement?.clientHeight
        ) {
          // Retain the committed viewport before another composer change can replace it.
          this.syncReaderViewport();
          this.scheduleLayout();
        }
      });
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
          // Publish current position, retained markers, and Tab entry in one layout commit.
          this.scheduleLayout();
        },
        { root, threshold: [0, Number.EPSILON, 1] },
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

  private syncReaderViewport() {
    const root = this.transcriptElement;
    if (root) {
      const viewport = {
        height: root.clientHeight,
        ...captureChatSessionScrollPosition(root),
      };
      const previous = this.readerViewport;
      if (previous && viewport.height !== previous.height) {
        // Intersections can precede resize compensation. Preserve the reader's
        // rail offset while keeping any keyboard-focused marker in view.
        this.followingResize = true;
        this.followActive =
          this.markerElements.get(this.interaction.focusedId ?? "")?.matches(":focus-visible") ??
          false;
        if (this.followActive) {
          this.scheduleLayout();
        }
        // A measured end supersedes startup's non-end estimate; smooth follow may still be pending.
        const atEnd = this.resizeScrollTarget?.atEnd || previous.anchorToEnd;
        const maxOffset = Math.max(0, root.scrollHeight - viewport.height);
        this.resizeScrollTarget = {
          offset: atEnd ? maxOffset : Math.min(previous.scrollTop, maxOffset),
          atEnd,
        };
      }
      // Navigation and a resize can arrive in the same observer delivery.
      if (previous && viewport.scrollTop !== previous.scrollTop) {
        const target = this.resizeScrollTarget?.offset;
        // Smooth resize compensation crosses intermediate offsets before its target.
        // The transcript input owner above retires it when the reader takes over.
        const compensating =
          target !== undefined &&
          (Math.abs(viewport.scrollTop - target) <= 1 ||
            (viewport.scrollTop >= Math.min(previous.scrollTop, target) &&
              viewport.scrollTop <= Math.max(previous.scrollTop, target)));
        if (!compensating) {
          if (this.followingResize) {
            this.followActive = true;
            this.scheduleLayout();
          }
          this.followingResize = false;
          this.resizeScrollTarget = undefined;
        }
      }
      this.readerViewport = viewport;
    }
  }

  private syncVisibleMarks() {
    this.syncReaderViewport();
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
    if (this.initialVisibilityPending && visible.size > 0) {
      // Startup resizes can precede the first measured message. Anchor that
      // initial position before preserving rail offsets through later resizes.
      this.followActive = true;
      this.scheduleLayout();
    }
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
      this.syncTabStop();
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
    const projectionChanged = this.projectionChanged;
    this.projectionChanged = false;
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
      this.targetsChanged = true;
    }
    this.syncMountedMarkers();
    this.syncVisibilityTargets();
    // Reader offsets can move the anchor without changing any intersections.
    this.syncVisibleMarks();
    this.syncTabStop();
    if (initialize || this.followActive) {
      this.followActive = false;
      const focused = this.markerElements.get(this.interaction.focusedId ?? "");
      const current =
        (initialize || focused?.matches(":focus-visible")
          ? this.interaction.focusedId
          : undefined) ?? this.activeId;
      if (current) {
        this.revealMarker(current);
        if (this.visibleIds.size > 0) {
          this.initialVisibilityPending = false;
        }
      }
    }
    this.viewportHeight = scroller.clientHeight;
    this.viewportOffset = scroller.scrollTop;
    const indexes = this.windowIndexes();
    if (
      indexes.length !== this.renderedIndexes.length ||
      indexes.some((index, position) => index !== this.renderedIndexes[position])
    ) {
      this.refreshWindow();
      this.syncMountedMarkers();
      this.syncTabStop();
    }
    // Reserve only the trailing space needed to keep this offset when the viewport grows.
    scroller.style.setProperty("--chat-position-scroll-top", `${scroller.scrollTop}px`);
    const contentBottom = this.markerIds.length * MARKER_HEIGHT;
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
        const center =
          (this.markerIndexes.get(previewId!)! + 0.5) * MARKER_HEIGHT - scroller.scrollTop;
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
    this.mountedMarkersChanged = true;
    this.layoutVisible = false;
    this.viewportHeight = undefined;
    this.viewportOffset = 0;
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
    );
    this.previewElement = element instanceof HTMLElement ? element : undefined;
    this.scheduleLayout();
    // Focused markers handle Escape before the window fallback dismisses hover-only previews.
    element?.ownerDocument.defaultView?.addEventListener("keydown", this.dismissPreview);
  };

  protected override disconnected() {
    this.pendingFocusId = undefined;
    this.bindPreview();
    this.bindScroller();
    this.interaction.hoveredId = null;
    this.interaction.focusedId = null;
    this.interaction.dismissed = false;
  }

  protected override reconnected() {
    this.requestUpdate?.();
  }

  render(params: PositionRailParams) {
    this.renderParams = params;
    const { positions, transcript, requestUpdate } = params;
    this.requestUpdate = requestUpdate;
    if (this.session !== transcript) {
      this.session = transcript;
      this.interaction = initialInteraction();
      this.pendingFocusId = undefined;
      this.viewportOffset = 0;
      this.viewportHeight = undefined;
      this.layoutVisible = false;
      this.disconnectVisibility();
      this.markersChanged = true;
    }
    const markers = positions.markers;
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
    const count = markers.length;
    if (count === 0) {
      this.disconnected();
      return nothing;
    }
    const interaction = this.interaction;
    if (!markers.some((candidate) => candidate.id === interaction.focusedId)) {
      interaction.focusedId = null;
    }
    if (!markers.some((candidate) => candidate.id === interaction.hoveredId)) {
      interaction.hoveredId = null;
    }

    const ids = markers.map((marker) => marker.id);
    if (
      ids.length !== this.markerIds.length ||
      ids.some((id, index) => id !== this.markerIds[index])
    ) {
      this.projectionChanged ||= this.markerIds.some((id, index) => id !== ids[index]);
      this.markerIds = ids;
      this.markerIndexes = new Map(ids.map((id, index) => [id, index]));
      if (this.activeId && !this.markerIndexes.has(this.activeId)) {
        this.activeId = undefined;
      }
      this.markersChanged = true;
    }
    const indexes = this.windowIndexes();
    if (
      indexes.length !== this.renderedIndexes.length ||
      indexes.some((index, position) => index !== this.renderedIndexes[position]) ||
      this.markersChanged
    ) {
      this.renderedIndexes = indexes;
      this.mountedMarkersChanged = true;
    }
    this.scheduleLayout();
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
      // Commit a distant logical target before focusing it; keyboard input never waits a frame.
      if (!(event.currentTarget instanceof HTMLButtonElement)) {
        return;
      }
      this.focusMarker(markers[nextIndex]!.id);
    };
    return renderChatPositionRailView({
      transcript,
      markers,
      renderedIndexes: this.renderedIndexes,
      markerHeight: MARKER_HEIGHT,
      activeId: this.activeId,
      visibleIds: this.visibleIds,
      rovingId,
      previewId: interaction.dismissed
        ? undefined
        : (interaction.hoveredId ?? interaction.focusedId),
      bindScroller: this.bindScroller,
      bindPreview: this.bindPreview,
      onScroll: this.scheduleLayout,
      stopScrollInput: this.stopScrollInput,
      onPointerLeave: () => {
        interaction.hoveredId = null;
        this.requestUpdate?.();
      },
      onMarkerHover: (id) => {
        interaction.hoveredId = id;
        interaction.dismissed = false;
        this.requestUpdate?.();
      },
      onMarkerFocus: (id, event) => {
        if (this.restoringFocus) {
          return;
        }
        // Pointer focus must not move the target before pointer-up.
        if (
          event.currentTarget instanceof HTMLElement &&
          event.currentTarget.matches(":focus-visible")
        ) {
          this.revealMarker(id);
        }
        interaction.focusedId = id;
        interaction.dismissed = false;
        this.viewportOffset = this.scrollElement?.scrollTop ?? 0;
        this.refreshWindow();
        this.syncMountedMarkers();
        this.syncTabStop();
        this.requestUpdate?.();
      },
      onMarkerBlur: () => {
        interaction.focusedId = null;
        this.syncTabStop();
        this.requestUpdate?.();
      },
      onMarkerKeyDown: (index, event) => {
        if (
          ["ArrowDown", "ArrowLeft", "ArrowRight", "ArrowUp", "End", "Home"].includes(event.key)
        ) {
          moveFocus(event, index);
        } else if (event.key === "Escape") {
          this.dismissPreview(event);
        } else if (event.key === "PageUp" || event.key === "PageDown") {
          event.stopPropagation();
        }
      },
      onMarkerSelect: (anchorId) => transcript.revealMessage(anchorId),
    });
  }
}

export const renderChatPositionRail = directive(ChatPositionRailDirective);
