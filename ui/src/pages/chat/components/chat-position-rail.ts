import { nothing } from "lit";
import { AsyncDirective } from "lit/async-directive.js";
import { directive } from "lit/directive.js";
import type { ChatPositionIndex } from "./chat-position-projection.ts";
import {
  renderChatPositionRailView,
  syncPositionRailPreview,
  syncPositionRailTabStop,
  syncPositionRailVisibility,
  type PositionRailAssistant,
} from "./chat-position-rail-view.ts";
import {
  POSITION_RAIL_MARKER_HEIGHT as MARKER_HEIGHT,
  positionRailWindowIndexes,
  resolvePositionRailReaderViewport,
  type PositionRailReaderState,
} from "./chat-transcript-geometry.ts";
import { transcriptArraysEqual } from "./chat-transcript-memo.ts";
import {
  readTranscriptViewport,
  subscribeTranscriptScroll,
  type TranscriptViewportMeasurement,
} from "./chat-transcript-scroll-events.ts";
import type { ChatTranscriptSession } from "./chat-transcript-session.ts";

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
  assistant?: PositionRailAssistant;
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
  private observationPending = false;
  private refreshingWindow = false;
  private layoutFrame: number | undefined;
  private activeId: string | undefined;
  private markerIds: string[] = [];
  private markerIndexes = new Map<string, number>();
  private renderedIndexes: number[] = [];
  private viewportHeight: number | undefined;
  private viewportVisible = false;
  private viewportOffset = 0;
  private viewportInset = 0;
  private reservedOffset = 0;
  private viewportResizePending = false;
  private observedActiveId: string | undefined;
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
  private layoutVisible = false;
  private reader: PositionRailReaderState = { followingResize: false, followActive: false };
  private readonly stopScrollInput = {
    handleEvent: (event: Event) => {
      this.reader.followActive = false;
      event.stopPropagation();
    },
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

  private readonly observeLayout = () => {
    const scroller = this.scrollElement;
    if (!scroller) {
      return;
    }
    // Observer and scroll delivery supply clean geometry; the frame only publishes it.
    const height = scroller.clientHeight;
    this.viewportVisible = height > 0;
    if (!this.viewportVisible) {
      // Hidden rails retain their mounted window and scroll reserve until they return.
      this.layoutVisible = false;
      return;
    }
    this.viewportHeight = height;
    this.viewportOffset = scroller.scrollTop;
    this.viewportInset = Number.parseFloat(getComputedStyle(scroller).scrollPaddingTop) || 0;
    this.viewportResizePending = this.session?.layout.viewportResizePending ?? false;
    const root = this.transcriptElement ?? scroller.closest<HTMLElement>(".chat-thread");
    if (root) {
      this.syncReaderViewport(readTranscriptViewport(root));
    }
    const visibleMessageIds = new Set(
      [...this.observedMessages.values()]
        .filter((message) => message.visible)
        .map((message) => message.messageId),
    );
    const visibleOrder = this.positionMessageIds.filter((id) => visibleMessageIds.has(id));
    const activeMessageId = this.session?.activeMessageId(
      visibleOrder.length ? visibleOrder : this.positionMessageIds,
    );
    this.observedActiveId = activeMessageId
      ? this.markerIdsByMessageId.get(activeMessageId)
      : undefined;
    this.scheduleLayout();
  };

  private requestObservation() {
    if (this.scrollElement && this.resizeObserver && !this.observationPending) {
      this.observationPending = true;
      // Same-size content and programmatic offsets still need a clean measurement.
      this.resizeObserver.unobserve(this.scrollElement);
      this.resizeObserver.observe(this.scrollElement);
    }
  }

  private revealMarker(id: string) {
    const scroller = this.scrollElement;
    const index = this.markerIndexes.get(id);
    const height = this.viewportHeight ?? 0;
    if (!scroller || !this.viewportVisible || index === undefined) {
      return;
    }
    const top = index * MARKER_HEIGHT;
    const bottom = top + MARKER_HEIGHT;
    if (
      top < this.viewportOffset + this.viewportInset ||
      bottom > this.viewportOffset + height - this.viewportInset
    ) {
      // Scroll only the rail: scrollIntoView would also move the transcript.
      const maxOffset = Math.max(
        this.markerIds.length * MARKER_HEIGHT - height,
        this.reservedOffset,
      );
      this.viewportOffset = Math.max(0, Math.min((top + bottom - height) / 2, maxOffset));
      scroller.scrollTop = this.viewportOffset;
    }
  }

  private windowIndexes(): number[] {
    return positionRailWindowIndexes(
      this.markerIds.length,
      this.markerIndexes,
      this.viewportOffset,
      this.viewportHeight ?? window.innerHeight,
      this.activeId ?? this.markerIds[0],
      this.interaction.focusedId,
      this.interaction.hoveredId,
      this.pendingFocusId,
    );
  }

  private refreshWindow(): void {
    const params = this.renderParams;
    if (this.isConnected && params) {
      const scroller = this.scrollElement;
      const session = this.session;
      const focused = scroller?.ownerDocument.activeElement;
      const focusedId =
        focused instanceof HTMLElement ? focused.dataset.positionMarkerId : undefined;
      this.refreshingWindow = true;
      try {
        this.setValue(this.render(params));
      } finally {
        this.refreshingWindow = false;
      }
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
    this.scrollElement?.closest(".chat-position-rail")?.removeAttribute("data-overflow");
    this.intersectionObserver?.disconnect();
    this.mutationObserver?.disconnect();
    this.transcriptElement?.removeEventListener("scroll", this.observeLayout);
    this.intersectionObserver = undefined;
    this.mutationObserver = undefined;
    this.transcriptElement = undefined;
    this.reader = { followingResize: false, followActive: this.reader.followActive };
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
    this.observedActiveId = undefined;
  }

  private syncVisibilityTargets() {
    const root = this.scrollElement?.closest<HTMLElement>(".chat-thread");
    if (!root) {
      return;
    }
    if (root !== this.transcriptElement) {
      if (this.transcriptElement) {
        this.disconnectVisibility();
      }
      this.transcriptElement = root;
      root.addEventListener("scroll", this.observeLayout, { passive: true });
      this.stopTranscriptScroll = subscribeTranscriptScroll(root, (observation) => {
        if (observation.type === "offset") {
          // The reading position can cross a landmark without changing the
          // rendered rows; follow it here instead of re-rendering the pane.
          this.requestObservation();
        } else if (observation.type === "input") {
          if (this.reader.followingResize) {
            this.reader.followActive = true;
            this.scheduleLayout();
          }
          this.reader.followingResize = false;
          this.reader.resizeTarget = undefined;
        } else if (observation.type === "resize" && this.layoutVisible && this.viewportHeight) {
          // Retain the committed viewport before another composer change can replace it.
          this.syncReaderViewport(observation.viewport);
          this.requestObservation();
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
          this.observeLayout();
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

  private syncReaderViewport(measured: TranscriptViewportMeasurement) {
    const overflowing =
      measured.clientHeight > 0 && measured.scrollHeight - measured.clientHeight > 1;
    if (syncPositionRailVisibility(this.scrollElement, overflowing) && !overflowing) {
      // Guarded marker callbacks retain this object while the rail is hidden.
      Object.assign(this.interaction, initialInteraction());
      this.refreshWindow();
    }
    const { state, scheduleLayout } = resolvePositionRailReaderViewport(
      this.reader,
      measured,
      this.markerElements.get(this.interaction.focusedId ?? "")?.matches(":focus-visible") ?? false,
    );
    this.reader = state;
    if (scheduleLayout) {
      this.scheduleLayout();
    }
  }

  private syncVisibleMarks() {
    const visible = new Set<string>();
    for (const message of this.observedMessages.values()) {
      if (message.visible) {
        visible.add(message.id);
      }
    }
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
      this.reader.followActive = true;
      this.scheduleLayout();
    }
    // A continuation, folded tool row, or virtualized jump still belongs to a transcript position.
    const activeId = this.observedActiveId ?? this.markerIds[0];
    if (activeId !== this.activeId) {
      this.markerElements.get(this.activeId ?? "")?.setAttribute("aria-current", "false");
      this.activeId = activeId;
      this.markerElements.get(activeId ?? "")?.setAttribute("aria-current", "true");
      this.syncTabStop();
      if (!this.reader.followingResize) {
        this.reader.followActive = true;
      }
      this.scheduleLayout();
    }
  }

  private syncLayout() {
    const scroller = this.scrollElement;
    const height = this.viewportHeight ?? 0;
    if (!scroller || !this.viewportVisible || height === 0) {
      this.layoutVisible = false;
      return;
    }
    this.syncMountedMarkers();
    this.syncVisibilityTargets();
    const projectionChanged = this.projectionChanged;
    this.projectionChanged = false;
    const initialize = !this.layoutVisible || projectionChanged;
    this.layoutVisible = true;
    if (initialize) {
      this.reader.resizeTarget = undefined;
      this.reader.followingResize = false;
    }
    if (this.markersChanged) {
      // Appends keep existing offsets valid; filtering or reordering retires that scroll room.
      if (projectionChanged) {
        scroller.style.removeProperty("--chat-position-scroll-top");
        this.reservedOffset = 0;
      }
      this.markersChanged = false;
      this.targetsChanged = true;
    }
    // Reader offsets can move the anchor without changing any intersections.
    this.syncVisibleMarks();
    this.syncTabStop();
    if (initialize || this.reader.followActive) {
      // Navigation must reach the final viewport, even if its slot resized before this frame.
      this.reader.followActive = this.viewportResizePending;
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
    const indexes = this.windowIndexes();
    if (!transcriptArraysEqual(indexes, this.renderedIndexes)) {
      this.refreshWindow();
      this.syncMountedMarkers();
      this.syncTabStop();
    }
    // Reserve only the trailing space needed to keep this offset when the viewport grows.
    this.reservedOffset = this.viewportOffset;
    scroller.style.setProperty("--chat-position-scroll-top", `${this.viewportOffset}px`);
    const contentBottom = this.markerIds.length * MARKER_HEIGHT;
    scroller.toggleAttribute("data-overflow-top", this.viewportOffset > 1);
    scroller.toggleAttribute(
      "data-overflow-bottom",
      contentBottom - height - this.viewportOffset > 1,
    );
    const previewId = this.interaction.hoveredId ?? this.interaction.focusedId;
    syncPositionRailPreview(
      this.previewElement,
      this.markerElements.get(previewId ?? ""),
      ((this.markerIndexes.get(previewId ?? "") ?? 0) + 0.5) * MARKER_HEIGHT - this.viewportOffset,
      height,
    );
  }

  private syncTabStop() {
    // Reenter at the reader position; arrow navigation owns focus only while inside the rail.
    const rovingId = this.interaction.focusedId ?? this.activeId ?? this.markerIds[0];
    syncPositionRailTabStop(this.scrollElement, this.markerElements.get(rovingId ?? ""));
  }

  private readonly bindScroller = (element?: Element) => {
    this.resizeObserver?.disconnect();
    this.observationPending = false;
    this.disconnectVisibility();
    this.markersChanged = true;
    this.mountedMarkersChanged = true;
    this.layoutVisible = false;
    this.viewportHeight = undefined;
    this.viewportVisible = false;
    this.viewportOffset = 0;
    this.viewportInset = 0;
    this.reservedOffset = 0;
    this.viewportResizePending = false;
    if (this.layoutFrame !== undefined) {
      cancelAnimationFrame(this.layoutFrame);
      this.layoutFrame = undefined;
    }
    this.scrollElement = element instanceof HTMLElement ? element : undefined;
    if (this.scrollElement) {
      this.reader.followActive = true;
      this.observationPending = true;
      this.resizeObserver = new ResizeObserver((_entries, observer) => {
        if (observer !== this.resizeObserver) {
          return;
        }
        this.observationPending = false;
        this.observeLayout();
      });
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
    Object.assign(this.interaction, initialInteraction());
  }

  protected override reconnected() {
    this.requestUpdate?.();
  }

  render(params: PositionRailParams) {
    this.renderParams = params;
    const { positions, transcript, assistant, requestUpdate } = params;
    this.requestUpdate = requestUpdate;
    if (this.session !== transcript) {
      this.session = transcript;
      this.interaction = initialInteraction();
      this.pendingFocusId = undefined;
      this.viewportOffset = 0;
      this.viewportHeight = undefined;
      this.viewportVisible = false;
      this.layoutVisible = false;
      this.disconnectVisibility();
      this.markersChanged = true;
    }
    const markers = positions.markers;
    if (positions.markerIdsByMessageId !== this.markerIdsByMessageId) {
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
    }
    const count = markers.length;
    if (count === 0) {
      this.disconnected();
      return nothing;
    }
    const interaction = this.interaction;
    for (const field of ["focusedId", "hoveredId"] as const) {
      if (!markers.some((candidate) => candidate.id === interaction[field])) {
        interaction[field] = null;
      }
    }

    const ids = markers.map((marker) => marker.id);
    if (!transcriptArraysEqual(ids, this.markerIds)) {
      this.projectionChanged ||= this.markerIds.some((id, index) => id !== ids[index]);
      this.markerIds = ids;
      this.markerIndexes = new Map(ids.map((id, index) => [id, index]));
      if (this.activeId && !this.markerIndexes.has(this.activeId)) {
        this.activeId = undefined;
      }
      this.markersChanged = true;
    }
    if (!this.refreshingWindow) {
      this.requestObservation();
    }
    const indexes = this.windowIndexes();
    if (!transcriptArraysEqual(indexes, this.renderedIndexes) || this.markersChanged) {
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
      assistant,
      markers,
      renderedIndexes: this.renderedIndexes,
      activeId: this.activeId,
      visibleIds: this.visibleIds,
      rovingId,
      hoveredId: interaction.hoveredId,
      previewId: interaction.dismissed
        ? undefined
        : (interaction.hoveredId ?? interaction.focusedId),
      bindScroller: this.bindScroller,
      bindPreview: this.bindPreview,
      onScroll: this.observeLayout,
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
