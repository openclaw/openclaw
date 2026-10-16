import { createSignal, onCleanup } from "solid-js";
import { readSessionDragData, sessionDragActive } from "../../lib/sessions/drag.ts";
import type { ChatPaneElement } from "./route-draft-focus-handoff.ts";
import {
  resolveSplitDropZone,
  splitDropIndicatorRect,
  type SplitDropRect,
  type SplitDropZone,
} from "./split-drop-zone.ts";

export type DropIndicator = { paneId: string; zone: SplitDropZone; rect: SplitDropRect };

function resolveDropIndicator(
  container: HTMLElement | undefined,
  pane: ChatPaneElement,
  x: number,
  y: number,
): DropIndicator | null {
  const paneId = pane.paneId ?? pane.dataset.unboundPaneId;
  if (!paneId || !container) {
    return null;
  }
  const paneRect = pane.getBoundingClientRect();
  const zone = resolveSplitDropZone(paneRect, x, y);
  const indicatorRect = splitDropIndicatorRect(paneRect, zone);
  const containerRect = container.getBoundingClientRect();
  return {
    paneId,
    zone,
    rect: {
      left: indicatorRect.left - containerRect.left,
      top: indicatorRect.top - containerRect.top,
      width: indicatorRect.width,
      height: indicatorRect.height,
    },
  };
}

export function createChatPageDropIndicator(
  host: HTMLElement,
  options: {
    sessionSplitAvailable: () => boolean;
    narrow: () => boolean;
    applySessionDrop: (sessionKey: string, paneId: string, zone: SplitDropZone) => void;
  },
) {
  const [indicator, setIndicator] = createSignal<DropIndicator | null>(null);
  let container: HTMLElement | undefined;
  let dragDepth = 0;
  let dragFrame = 0;
  let pendingDragOver: { pane: ChatPaneElement; x: number; y: number } | null = null;

  const handleDragEnter = (event: DragEvent) => {
    if (!options.sessionSplitAvailable() || !sessionDragActive(event.dataTransfer)) {
      return;
    }
    dragDepth += 1;
  };

  const handleDragOver = (event: DragEvent) => {
    if (!options.sessionSplitAvailable() || !sessionDragActive(event.dataTransfer)) {
      return;
    }
    event.preventDefault();
    if (event.dataTransfer) {
      event.dataTransfer.dropEffect = "copy";
    }
    const target = event.target instanceof Element ? event.target : null;
    const pane = target?.closest<ChatPaneElement>("openclaw-chat-pane, [data-unbound-pane-id]");
    if (!pane || !host.contains(pane)) {
      clear();
      return;
    }
    pendingDragOver = { pane, x: event.clientX, y: event.clientY };
    if (dragFrame) {
      return;
    }
    dragFrame = window.requestAnimationFrame(() => {
      dragFrame = 0;
      const pending = pendingDragOver;
      pendingDragOver = null;
      if (!pending || options.narrow() || !host.isConnected) {
        return;
      }
      const next = resolveDropIndicator(container, pending.pane, pending.x, pending.y);
      if (!next) {
        clear();
        return;
      }
      setIndicator((current) =>
        current?.paneId === next.paneId &&
        current.zone.kind === next.zone.kind &&
        (next.zone.kind === "center" ||
          (current.zone.kind === "edge" && current.zone.edge === next.zone.edge))
          ? current
          : next,
      );
    });
  };

  const handleDragLeave = (event: DragEvent) => {
    if (!options.sessionSplitAvailable() || !sessionDragActive(event.dataTransfer)) {
      return;
    }
    dragDepth = Math.max(0, dragDepth - 1);
    if (dragDepth === 0) {
      clear();
    }
  };

  const handleDrop = (event: DragEvent) => {
    if (!options.sessionSplitAvailable() || !sessionDragActive(event.dataTransfer)) {
      return;
    }
    event.preventDefault();
    const sessionKey = readSessionDragData(event.dataTransfer);
    const target = event.target instanceof Element ? event.target : null;
    const pane = target?.closest<ChatPaneElement>("openclaw-chat-pane, [data-unbound-pane-id]");
    const destination =
      pane && host.contains(pane)
        ? resolveDropIndicator(container, pane, event.clientX, event.clientY)
        : null;
    clear();
    if (sessionKey && destination) {
      options.applySessionDrop(sessionKey, destination.paneId, destination.zone);
    }
  };

  const clear = () => {
    dragDepth = 0;
    pendingDragOver = null;
    if (dragFrame) {
      window.cancelAnimationFrame(dragFrame);
      dragFrame = 0;
    }
    setIndicator(null);
  };

  const listeners = new AbortController();
  const optionsWithSignal = { signal: listeners.signal };
  host.addEventListener("dragenter", handleDragEnter, optionsWithSignal);
  host.addEventListener("dragover", handleDragOver, optionsWithSignal);
  host.addEventListener("dragleave", handleDragLeave, optionsWithSignal);
  host.addEventListener("drop", handleDrop, optionsWithSignal);
  window.addEventListener("dragend", clear, optionsWithSignal);
  onCleanup(() => {
    listeners.abort();
    pendingDragOver = null;
    if (dragFrame) {
      window.cancelAnimationFrame(dragFrame);
    }
  });
  return {
    indicator,
    clear,
    containerRef: (element: HTMLElement) => {
      container = element;
    },
  };
}
