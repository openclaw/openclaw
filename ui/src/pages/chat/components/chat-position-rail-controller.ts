import { createMemo, onCleanup, onSettled, refresh } from "solid-js";
import { listen } from "../../../lib/reactive/listener.ts";
import type { ChatPositionIndex } from "./chat-position-projection.ts";
import {
  syncPositionRailPreview,
  syncPositionRailTabStop,
  syncPositionRailVisibility,
  type PositionRailAssistant,
  type PositionRailViewParams,
} from "./chat-position-rail-view.tsx";
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

type RailInteraction = {
  hoveredId: string | null;
  focusedId: string | null;
  dismissed: boolean;
};

export type PositionRailParams = {
  positions: ChatPositionIndex;
  transcript: ChatTranscriptSession;
  assistant?: PositionRailAssistant;
};

function initialInteraction(): RailInteraction {
  return { hoveredId: null, focusedId: null, dismissed: false };
}

// Transient DOM interaction stays here; the transcript session owns reader position.
export function createPositionRail(props: PositionRailParams) {
  let connected = true;

  let session: ChatTranscriptSession | null = null;
  let interactionState = initialInteraction();
  let previewElement: HTMLElement | undefined;
  let previewDescription: (() => string) | undefined;
  let stopPreviewKeydown: (() => void) | undefined;
  let scrollElement: HTMLElement | undefined;
  let resizeObserver: ResizeObserver | undefined;
  let observationPending = false;
  let refreshingWindow = false;
  let layoutFrame: number | undefined;
  let currentActiveId: string | undefined;
  let markerIds: string[] = [];
  let markerSource: ChatPositionIndex["markers"] | undefined;
  let markerIndexes = new Map<string, number>();
  let renderedIndexes: number[] = [];
  let viewportHeight: number | undefined;
  let viewportVisible = false;
  let viewportOffset = 0;
  let viewportInset = 0;
  let reservedOffset = 0;
  let viewportResizePending = false;
  let observedActiveId: string | undefined;
  let pendingFocusId: string | undefined;
  let restoringFocus = false;
  let pendingProjectionChange = false;
  let markerIdsByMessageId: ReadonlyMap<string, string> = new Map();
  let positionMessageIds: string[] = [];
  let markersChanged = true;
  const markerElements = new Map<string, HTMLElement>();
  let transcriptElement: HTMLElement | undefined;
  let intersectionObserver: IntersectionObserver | undefined;
  let stopTranscriptScroll: (() => void) | undefined;
  let stopMessageElements: (() => void) | undefined;
  const observedMessages = new Map<Element, { id: string; messageId: string; visible: boolean }>();
  let visibleIds = new Set<string>();
  let initialVisibilityPending = true;
  let targetsChanged = true;
  let layoutVisible = false;
  let reader: PositionRailReaderState = { followingResize: false, followActive: false };
  const stopScrollInput = (event: Event) => {
    reader.followActive = false;
    event.stopPropagation();
  };

  const scheduleLayout = () => {
    if (layoutFrame !== undefined || !scrollElement) {
      return;
    }
    layoutFrame = requestAnimationFrame(() => {
      if (observationPending) {
        observeLayout();
      }
      layoutFrame = undefined;
      syncLayout();
    });
  };

  const observeLayout = () => {
    observationPending = false;
    const scroller = scrollElement;
    if (!scroller) {
      return;
    }
    // Native observers supply geometry; offset-only changes read it in the queued frame.
    const height = scroller.clientHeight;
    viewportVisible = height > 0;
    if (!viewportVisible) {
      // Hidden rails retain their mounted window and scroll reserve until they return.
      layoutVisible = false;
      return;
    }
    const offset = scroller.scrollTop;
    const inset = Number.parseFloat(getComputedStyle(scroller).scrollPaddingTop) || 0;
    const geometryChanged =
      height !== viewportHeight || offset !== viewportOffset || inset !== viewportInset;
    viewportHeight = height;
    viewportOffset = offset;
    viewportInset = inset;
    viewportResizePending = session?.layout.viewportResizePending ?? false;
    const root = transcriptElement ?? scroller.closest<HTMLElement>(".chat-thread");
    if (root) {
      syncReaderViewport(readTranscriptViewport(root));
    }
    const visibleMessageIds = new Set<string>();
    for (const message of observedMessages.values()) {
      if (message.visible) {
        visibleMessageIds.add(message.messageId);
      }
    }
    const visibleOrder = positionMessageIds.filter((id) => visibleMessageIds.has(id));
    const activeMessageId = session?.activeMessageId(
      visibleOrder.length ? visibleOrder : positionMessageIds,
    );
    observedActiveId = activeMessageId ? markerIdsByMessageId.get(activeMessageId) : undefined;
    if (
      geometryChanged ||
      !layoutVisible ||
      reader.followActive ||
      (observedActiveId ?? markerIds[0]) !== currentActiveId
    ) {
      scheduleLayout();
    }
  };

  function requestObservation() {
    if (scrollElement && resizeObserver && !observationPending) {
      observationPending = true;
      // Re-observing during a row resize creates a shallower delivery and a WebKit loop error.
      scheduleLayout();
    }
  }

  function revealMarker(id: string) {
    const scroller = scrollElement;
    const index = markerIndexes.get(id);
    const height = viewportHeight ?? 0;
    if (!scroller || !viewportVisible || index === undefined) {
      return;
    }
    const top = index * MARKER_HEIGHT;
    const bottom = top + MARKER_HEIGHT;
    if (top < viewportOffset + viewportInset || bottom > viewportOffset + height - viewportInset) {
      // Scroll only the rail: scrollIntoView would also move the transcript.
      const maxOffset = Math.max(markerIds.length * MARKER_HEIGHT - height, reservedOffset);
      viewportOffset = Math.max(0, Math.min((top + bottom - height) / 2, maxOffset));
      scroller.scrollTop = viewportOffset;
    }
  }

  function windowIndexes(): number[] {
    return positionRailWindowIndexes(
      markerIds.length,
      markerIndexes,
      viewportOffset,
      viewportHeight ?? window.innerHeight,
      currentActiveId ?? markerIds[0],
      interactionState.focusedId,
      interactionState.hoveredId,
      pendingFocusId,
    );
  }

  function refreshWindow(): void {
    if (connected && session) {
      const scroller = scrollElement;
      const focused = scroller?.ownerDocument.activeElement;
      const focusedId =
        focused instanceof HTMLElement ? focused.dataset.positionMarkerId : undefined;
      refreshingWindow = true;
      void refresh(view);
      onSettled(() => {
        refreshingWindow = false;
        // A virtual window change can move the retained marker out of DOM order.
        // Restore its focus after commit without treating it as new navigation.
        if (
          connected &&
          scroller === scrollElement &&
          !pendingFocusId &&
          focusedId &&
          focused instanceof HTMLElement &&
          scroller?.contains(focused) &&
          scroller.ownerDocument.activeElement === scroller.ownerDocument.body
        ) {
          interactionState.focusedId = focusedId;
          restoringFocus = true;
          try {
            focused.focus({ preventScroll: true });
          } finally {
            restoringFocus = false;
          }
        }
      });
    }
  }

  function bindMarker(id: string, element?: HTMLButtonElement) {
    if (element) {
      markerElements.set(id, element);
    } else {
      markerElements.delete(id);
    }
  }

  function focusMarker(id: string): void {
    const scroller = scrollElement;
    const focused = scroller?.ownerDocument.activeElement;
    pendingFocusId = id;
    revealMarker(id);
    refreshWindow();
    onSettled(() => {
      if (connected && pendingFocusId === id) {
        pendingFocusId = undefined;
        const active = scroller?.ownerDocument.activeElement;
        if (
          scroller === scrollElement &&
          (active === focused || active === scroller?.ownerDocument.body)
        ) {
          markerElements.get(id)?.focus({ preventScroll: true });
        }
      }
    });
  }

  function disconnectVisibility() {
    stopTranscriptScroll?.();
    stopTranscriptScroll = undefined;
    stopMessageElements?.();
    stopMessageElements = undefined;
    scrollElement?.closest(".chat-position-rail")?.removeAttribute("data-overflow");
    intersectionObserver?.disconnect();
    intersectionObserver = undefined;
    transcriptElement = undefined;
    reader = { followingResize: false, followActive: reader.followActive };
    observedMessages.clear();
    for (const id of visibleIds) {
      markerElements.get(id)?.removeAttribute("data-visible");
    }
    markerElements.get(currentActiveId ?? "")?.setAttribute("aria-current", "false");
    visibleIds.clear();
    initialVisibilityPending = true;
    currentActiveId = undefined;
    observedActiveId = undefined;
  }

  function syncVisibilityTargets() {
    const root = scrollElement?.closest<HTMLElement>(".chat-thread");
    if (!root) {
      return;
    }
    if (root !== transcriptElement) {
      if (transcriptElement) {
        disconnectVisibility();
      }
      transcriptElement = root;
      stopTranscriptScroll = subscribeTranscriptScroll(root, (observation) => {
        if (observation.type === "offset") {
          // The reading position can cross a landmark without changing the
          // rendered rows; follow it here instead of re-rendering the pane.
          requestObservation();
        } else if (observation.type === "input") {
          if (reader.followingResize) {
            reader.followActive = true;
            scheduleLayout();
          }
          reader.followingResize = false;
          reader.resizeTarget = undefined;
        } else if (observation.type === "resize" && layoutVisible && viewportHeight) {
          // Retain the committed viewport before another composer change can replace it.
          reader.followActive ||= observation.resumeFollow === true;
          syncReaderViewport(observation.viewport);
          requestObservation();
        }
      });
      // Publish the first visible pixel after an initially zero-area edge touch.
      intersectionObserver = new IntersectionObserver(
        (entries) => {
          for (const entry of entries) {
            const message = observedMessages.get(entry.target);
            const visible = entry.isIntersecting && entry.intersectionRatio > 0;
            if (message && message.visible !== visible) {
              message.visible = visible;
              scheduleLayout();
            }
          }
          // Publish current position, retained markers, and Tab entry in one layout commit.
          observeLayout();
        },
        { root, threshold: [0, Number.EPSILON, 1] },
      );
      // Bubble refs publish virtualization changes; token paints keep their targets.
      stopMessageElements = session?.messageElements.subscribe(() => {
        targetsChanged = true;
        scheduleLayout();
      });
      targetsChanged = true;
    }
    if (!targetsChanged) {
      return;
    }
    targetsChanged = false;
    const targets = new Set<Element>(
      [...(session?.messageElements.elements.values() ?? [])].filter((element) =>
        root.contains(element),
      ),
    );
    const messageIdFor = (element: Element) =>
      element.getAttribute("data-entry-id") ?? element.getAttribute("data-message-id");
    for (const [element, message] of observedMessages) {
      if (
        !targets.has(element) ||
        messageIdFor(element) !== message.messageId ||
        markerIdsByMessageId.get(message.messageId) !== message.id
      ) {
        intersectionObserver?.unobserve(element);
        observedMessages.delete(element);
      }
    }
    for (const element of targets) {
      const messageId = messageIdFor(element);
      const id = messageId ? markerIdsByMessageId.get(messageId) : undefined;
      if (messageId && id && !observedMessages.has(element)) {
        observedMessages.set(element, { id, messageId, visible: false });
        intersectionObserver?.observe(element);
      }
    }
  }

  function syncReaderViewport(measured: TranscriptViewportMeasurement) {
    const overflowing =
      measured.clientHeight > 0 && measured.scrollHeight - measured.clientHeight > 1;
    if (syncPositionRailVisibility(scrollElement, overflowing) && !overflowing) {
      // Guarded marker callbacks retain this object while the rail is hidden.
      Object.assign(interactionState, initialInteraction());
      refreshWindow();
    }
    const { state, scheduleLayout: needsLayout } = resolvePositionRailReaderViewport(
      reader,
      measured,
      markerElements.get(interactionState.focusedId ?? "")?.matches(":focus-visible") ?? false,
    );
    reader = state;
    if (needsLayout) {
      scheduleLayout();
    }
  }

  function syncVisibleMarks() {
    const visible = new Set<string>();
    for (const message of observedMessages.values()) {
      if (message.visible) {
        visible.add(message.id);
      }
    }
    for (const id of visibleIds) {
      if (!visible.has(id)) {
        markerElements.get(id)?.removeAttribute("data-visible");
      }
    }
    for (const id of visible) {
      if (!visibleIds.has(id)) {
        markerElements.get(id)?.setAttribute("data-visible", "");
      }
    }
    visibleIds = visible;
    if (initialVisibilityPending && visible.size > 0) {
      // Startup resizes can precede the first measured message. Anchor that
      // initial position before preserving rail offsets through later resizes.
      reader.followActive = true;
      scheduleLayout();
    }
    // A continuation, folded tool row, or virtualized jump still belongs to a transcript position.
    const activeId = observedActiveId ?? markerIds[0];
    if (activeId !== currentActiveId) {
      markerElements.get(currentActiveId ?? "")?.setAttribute("aria-current", "false");
      currentActiveId = activeId;
      markerElements.get(activeId ?? "")?.setAttribute("aria-current", "true");
      if (!reader.followingResize) {
        reader.followActive = true;
      }
      scheduleLayout();
    }
  }

  function syncLayout() {
    const scroller = scrollElement;
    const height = viewportHeight ?? 0;
    if (!scroller || !viewportVisible || height === 0) {
      layoutVisible = false;
      return;
    }
    syncVisibilityTargets();
    const projectionChanged = pendingProjectionChange;
    pendingProjectionChange = false;
    const initialize = !layoutVisible || projectionChanged;
    layoutVisible = true;
    if (initialize) {
      reader.resizeTarget = undefined;
      reader.followingResize = false;
    }
    if (markersChanged) {
      // Appends keep existing offsets valid; filtering or reordering retires that scroll room.
      if (projectionChanged) {
        scroller.style.removeProperty("--chat-position-scroll-top");
        reservedOffset = 0;
      }
      markersChanged = false;
      targetsChanged = true;
    }
    // Reader offsets can move the anchor without changing any intersections.
    syncVisibleMarks();
    syncTabStop();
    if (initialize || reader.followActive) {
      // An older queued frame must retain navigation until its final viewport is measured.
      reader.followActive = viewportResizePending || observationPending;
      const focused = markerElements.get(interactionState.focusedId ?? "");
      const current =
        (initialize || focused?.matches(":focus-visible")
          ? interactionState.focusedId
          : undefined) ?? currentActiveId;
      if (current) {
        revealMarker(current);
        if (visibleIds.size > 0) {
          initialVisibilityPending = false;
        }
      }
    }
    const indexes = windowIndexes();
    if (!transcriptArraysEqual(indexes, renderedIndexes)) {
      refreshWindow();
      syncTabStop();
    }
    // Reserve only the trailing space needed to keep this offset when the viewport grows.
    reservedOffset = viewportOffset;
    scroller.style.setProperty("--chat-position-scroll-top", `${viewportOffset}px`);
    const contentBottom = markerIds.length * MARKER_HEIGHT;
    scroller.toggleAttribute("data-overflow-top", viewportOffset > 1);
    scroller.toggleAttribute("data-overflow-bottom", contentBottom - height - viewportOffset > 1);
    const previewId = interactionState.hoveredId ?? interactionState.focusedId;
    syncPositionRailPreview(
      previewElement,
      markerElements.get(previewId ?? ""),
      previewDescription?.() ?? "",
      ((markerIndexes.get(previewId ?? "") ?? 0) + 0.5) * MARKER_HEIGHT - viewportOffset,
      height,
    );
  }

  function syncTabStop() {
    // Reenter at the reader position; arrow navigation owns focus only while inside the rail.
    const rovingId = interactionState.focusedId ?? currentActiveId ?? markerIds[0];
    syncPositionRailTabStop(markerElements.values(), markerElements.get(rovingId ?? ""));
  }

  const bindScroller = (element?: Element) => {
    resizeObserver?.disconnect();
    observationPending = false;
    disconnectVisibility();
    markersChanged = true;
    layoutVisible = false;
    viewportHeight = undefined;
    viewportVisible = false;
    viewportOffset = 0;
    viewportInset = 0;
    reservedOffset = 0;
    viewportResizePending = false;
    if (layoutFrame !== undefined) {
      cancelAnimationFrame(layoutFrame);
      layoutFrame = undefined;
    }
    scrollElement = element instanceof HTMLElement ? element : undefined;
    if (scrollElement) {
      reader.followActive = true;
      observationPending = true;
      resizeObserver = new ResizeObserver(observeLayout);
      resizeObserver.observe(scrollElement);
      scheduleLayout();
    }
  };

  const dismissPreview = (event: KeyboardEvent) => {
    const rail = scrollElement?.closest(".chat-position-rail");
    if (
      event.key !== "Escape" ||
      event.defaultPrevented ||
      interactionState.dismissed ||
      !rail ||
      rail.ownerDocument.defaultView?.getComputedStyle(rail).display === "none"
    ) {
      return;
    }
    event.preventDefault();
    event.stopImmediatePropagation();
    interactionState.hoveredId = null;
    interactionState.dismissed = true;
    if (rail.contains(rail.ownerDocument.activeElement)) {
      // Every marker reveals a message in this transcript. Hover-only dismissal keeps focus.
      rail.closest<HTMLElement>(".chat-thread")?.focus({ preventScroll: true });
    }
    refreshWindow();
  };

  const bindPreview = (element?: Element, description?: () => string) => {
    stopPreviewKeydown?.();
    stopPreviewKeydown = undefined;
    previewElement = element instanceof HTMLElement ? element : undefined;
    previewDescription = description;
    // Solid refs run before the preview leaves its inert template document.
    // The mounted rail supplies the actual event window.
    const previewWindow = element ? scrollElement?.ownerDocument.defaultView : null;
    scheduleLayout();
    // Focused markers handle Escape before the window fallback dismisses hover-only previews.
    if (previewWindow) {
      stopPreviewKeydown = listen(previewWindow, "keydown", dismissPreview);
    }
  };

  function readView(params: PositionRailParams): PositionRailViewParams | undefined {
    const { positions, transcript, assistant } = params;
    if (session !== transcript) {
      session = transcript;
      interactionState = initialInteraction();
      pendingFocusId = undefined;
      viewportOffset = 0;
      viewportHeight = undefined;
      viewportVisible = false;
      layoutVisible = false;
      disconnectVisibility();
      markersChanged = true;
    }
    const markers = positions.markers;
    if (positions.markerIdsByMessageId !== markerIdsByMessageId) {
      targetsChanged = true;
      markerIdsByMessageId = positions.markerIdsByMessageId;
      positionMessageIds = [...positions.markerIdsByMessageId.keys()];
    }
    const count = markers.length;
    if (count === 0) {
      bindPreview();
      bindScroller();
      Object.assign(interactionState, initialInteraction());
      return undefined;
    }
    const interaction = interactionState;
    if (markers !== markerSource) {
      markerSource = markers;
      const ids = markers.map((marker) => marker.id);
      pendingProjectionChange ||= markerIds.some((id, index) => id !== ids[index]);
      markerIds = ids;
      markerIndexes = new Map(ids.map((id, index) => [id, index]));
      if (currentActiveId && !markerIndexes.has(currentActiveId)) {
        currentActiveId = undefined;
      }
      for (const field of ["focusedId", "hoveredId"] as const) {
        if (!markerIndexes.has(interaction[field] ?? "")) {
          interaction[field] = null;
        }
      }
      markersChanged = true;
    }
    // Text-only previews retain the rail geometry. Native resize/scroll and
    // transcript observations already request measurements when it changes.
    if (!refreshingWindow && markersChanged) {
      requestObservation();
    }
    const indexes = windowIndexes();
    if (!transcriptArraysEqual(indexes, renderedIndexes) || markersChanged) {
      renderedIndexes = indexes;
    }
    if (markersChanged || targetsChanged || refreshingWindow || previewElement) {
      scheduleLayout();
    }
    const rovingId = interaction.focusedId ?? currentActiveId ?? markers[0]!.id;
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
      // A distant logical target receives focus as soon as its marker commits, without a frame.
      if (!(event.currentTarget instanceof HTMLButtonElement)) {
        return;
      }
      focusMarker(markers[nextIndex]!.id);
    };
    return {
      assistant,
      markers,
      resolveLiveMessage: positions.resolveLiveMessage,
      renderedIndexes,
      activeId: currentActiveId,
      visibleIds,
      rovingId,
      hoveredId: interaction.hoveredId,
      previewId: interaction.dismissed
        ? undefined
        : (interaction.hoveredId ?? interaction.focusedId),
      bindMarker,
      bindScroller,
      bindPreview,
      onScroll: observeLayout,
      stopScrollInput,
      onPointerLeave: () => {
        interaction.hoveredId = null;
        refreshWindow();
      },
      onMarkerHover: (id) => {
        interaction.hoveredId = id;
        interaction.dismissed = false;
        refreshWindow();
      },
      onMarkerFocus: (id, event) => {
        if (restoringFocus) {
          return;
        }
        // Pointer focus must not move the target before pointer-up.
        if (
          event.currentTarget instanceof HTMLElement &&
          event.currentTarget.matches(":focus-visible")
        ) {
          revealMarker(id);
        }
        interaction.focusedId = id;
        interaction.dismissed = false;
        refreshWindow();
        syncTabStop();
      },
      onMarkerBlur: () => {
        interaction.focusedId = null;
        syncTabStop();
        refreshWindow();
      },
      onMarkerKeyDown: (index, event) => {
        if (
          ["ArrowDown", "ArrowLeft", "ArrowRight", "ArrowUp", "End", "Home"].includes(event.key)
        ) {
          moveFocus(event, index);
        } else if (event.key === "Escape") {
          dismissPreview(event);
        } else if (event.key === "PageUp" || event.key === "PageDown") {
          event.stopPropagation();
        }
      },
      onMarkerSelect: (anchorId) => transcript.revealMessage(anchorId),
    };
  }

  const view = createMemo(() => readView(props));
  onCleanup(() => {
    connected = false;
    pendingFocusId = undefined;
    bindPreview();
    bindScroller();
    Object.assign(interactionState, initialInteraction());
  });
  return view;
}
