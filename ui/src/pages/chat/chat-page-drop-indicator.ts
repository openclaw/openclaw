import type { ReactiveControllerHost } from "lit";
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
  host: ParentNode,
  pane: ChatPaneElement,
  x: number,
  y: number,
): DropIndicator | null {
  const paneId = pane.paneId ?? pane.dataset.unboundPaneId;
  const container = host.querySelector<HTMLElement>(".chat-split-view__drop-container");
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

export class ChatPageDropIndicator {
  indicator: DropIndicator | null = null;
  private dragDepth = 0;
  private dragFrame = 0;
  private pendingDragOver: { pane: ChatPaneElement; x: number; y: number } | null = null;

  constructor(
    private readonly host: HTMLElement & Pick<ReactiveControllerHost, "requestUpdate">,
    private readonly options: {
      sessionSplitAvailable: () => boolean;
      narrow: () => boolean;
      applySessionDrop: (sessionKey: string, paneId: string, zone: SplitDropZone) => void;
    },
  ) {}

  connect(): void {
    this.host.addEventListener("dragenter", this.handleDragEnter);
    this.host.addEventListener("dragover", this.handleDragOver);
    this.host.addEventListener("dragleave", this.handleDragLeave);
    this.host.addEventListener("drop", this.handleDrop);
    window.addEventListener("dragend", this.clear);
  }

  disconnect(): void {
    this.host.removeEventListener("dragenter", this.handleDragEnter);
    this.host.removeEventListener("dragover", this.handleDragOver);
    this.host.removeEventListener("dragleave", this.handleDragLeave);
    this.host.removeEventListener("drop", this.handleDrop);
    window.removeEventListener("dragend", this.clear);
    this.clear();
  }

  private readonly handleDragEnter = (event: DragEvent) => {
    if (!this.options.sessionSplitAvailable() || !sessionDragActive(event.dataTransfer)) {
      return;
    }
    this.dragDepth += 1;
  };

  private readonly handleDragOver = (event: DragEvent) => {
    if (!this.options.sessionSplitAvailable() || !sessionDragActive(event.dataTransfer)) {
      return;
    }
    event.preventDefault();
    if (event.dataTransfer) {
      event.dataTransfer.dropEffect = "copy";
    }
    const target = event.target instanceof Element ? event.target : null;
    const pane = target?.closest<ChatPaneElement>("openclaw-chat-pane, [data-unbound-pane-id]");
    if (!pane || !this.host.contains(pane)) {
      this.clear();
      return;
    }
    this.pendingDragOver = { pane, x: event.clientX, y: event.clientY };
    if (this.dragFrame) {
      return;
    }
    this.dragFrame = window.requestAnimationFrame(() => {
      this.dragFrame = 0;
      const pending = this.pendingDragOver;
      this.pendingDragOver = null;
      if (!pending || this.options.narrow() || !this.host.isConnected) {
        return;
      }
      const indicator = resolveDropIndicator(this.host, pending.pane, pending.x, pending.y);
      if (!indicator) {
        this.clear();
        return;
      }
      const current = this.indicator;
      if (
        current?.paneId === indicator.paneId &&
        current.zone.kind === indicator.zone.kind &&
        (indicator.zone.kind === "center" ||
          (current.zone.kind === "edge" && current.zone.edge === indicator.zone.edge))
      ) {
        return;
      }
      this.indicator = indicator;
      this.host.requestUpdate();
    });
  };

  private readonly handleDragLeave = (event: DragEvent) => {
    if (!this.options.sessionSplitAvailable() || !sessionDragActive(event.dataTransfer)) {
      return;
    }
    this.dragDepth = Math.max(0, this.dragDepth - 1);
    if (this.dragDepth === 0) {
      this.clear();
    }
  };

  private readonly handleDrop = (event: DragEvent) => {
    if (!this.options.sessionSplitAvailable() || !sessionDragActive(event.dataTransfer)) {
      return;
    }
    event.preventDefault();
    const sessionKey = readSessionDragData(event.dataTransfer);
    const target = event.target instanceof Element ? event.target : null;
    const pane = target?.closest<ChatPaneElement>("openclaw-chat-pane, [data-unbound-pane-id]");
    const indicator =
      pane && this.host.contains(pane)
        ? resolveDropIndicator(this.host, pane, event.clientX, event.clientY)
        : null;
    this.clear();
    if (sessionKey && indicator) {
      this.options.applySessionDrop(sessionKey, indicator.paneId, indicator.zone);
    }
  };

  readonly clear = () => {
    this.dragDepth = 0;
    this.pendingDragOver = null;
    if (this.dragFrame) {
      window.cancelAnimationFrame(this.dragFrame);
      this.dragFrame = 0;
    }
    if (this.indicator) {
      this.indicator = null;
      this.host.requestUpdate();
    }
  };
}
