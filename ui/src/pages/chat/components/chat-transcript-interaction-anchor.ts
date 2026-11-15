import type { Virtualizer } from "@tanstack/virtual-core";

export type ChatTranscriptInteractionAnchor = {
  row: HTMLElement;
  /** The element kept in place and its top when the control was activated. */
  target: Element;
  top: number;
};

/**
 * A control the reader sees keeps its row in place. One the reader cannot see (scrolled away or
 * not laid out) keeps the reader's visible content in place instead, when there is a record of it.
 */
export function resolveChatTranscriptInteractionAnchor(
  event: Event,
  readerContent: () => Element | null,
): ChatTranscriptInteractionAnchor | null {
  const target = event.target;
  const geometryControl =
    target instanceof Element
      ? target.closest("button[aria-expanded], button[aria-pressed], summary")
      : null;
  const row = geometryControl?.closest<HTMLElement>(".chat-virtual-row");
  if (!geometryControl || !row) {
    return null;
  }
  const control = geometryControl.getBoundingClientRect();
  const viewport = row.closest(".chat-thread")?.getBoundingClientRect();
  const seen =
    control.height > 0 &&
    viewport !== undefined &&
    control.bottom > viewport.top &&
    control.top < viewport.bottom;
  const kept = (!seen && readerContent()) || row;
  return { row, target: kept, top: kept.getBoundingClientRect().top };
}

export function reconcileChatTranscriptInteractionResize(
  anchor: ChatTranscriptInteractionAnchor | null,
  sidebarCommitTarget: EventTarget | null | undefined,
  scrollElement: HTMLDivElement | null,
  virtualizer: Virtualizer<HTMLDivElement, HTMLElement>,
): boolean {
  if (!anchor) {
    return true;
  }
  const row = anchor.row;
  const sidebarRuntime = row.closest(".sidebar-region__right-runtime");
  if (
    sidebarRuntime &&
    !(sidebarCommitTarget instanceof Element && sidebarCommitTarget.contains(row))
  ) {
    return false;
  }
  if (!row.isConnected || !scrollElement?.contains(row)) {
    return true;
  }
  const index = virtualizer.indexFromElement(row);
  const options = virtualizer.options;
  // The clicked row is the interaction anchor. Measure its committed height
  // before paint without letting the transcript's ordinary end anchor compete.
  virtualizer.setOptions({ ...options, anchorTo: "start" });
  virtualizer.resizeItem(index, row.offsetHeight);
  virtualizer.setOptions(options);
  if (anchor.target.isConnected) {
    scrollElement.scrollTop += anchor.target.getBoundingClientRect().top - anchor.top;
  }
  return true;
}
