import { Virtualizer } from "@tanstack/virtual-core";
import { vi } from "vitest";
import type { ChatWidgetLayout } from "../session-message-cache.ts";
import { TranscriptLayoutOwner } from "./chat-transcript-layout-owner.ts";
import { threadProps } from "./chat-transcript.test-support.ts";

export function scheduledCallbacks(idle: boolean) {
  let sequence = 0;
  const frames = new Map<number, FrameRequestCallback>();
  const idleCallbacks = new Map<number, IdleRequestCallback>();
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    frames.set(++sequence, callback);
    return sequence;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
  vi.stubGlobal(
    "requestIdleCallback",
    idle
      ? (callback: IdleRequestCallback) => {
          idleCallbacks.set(++sequence, callback);
          return sequence;
        }
      : undefined,
  );
  vi.stubGlobal("cancelIdleCallback", (id: number) => idleCallbacks.delete(id));
  const takeFrame = () => {
    const [id, callback] = frames.entries().next().value!;
    frames.delete(id);
    return () => callback(0);
  };
  const takeIdle = () => {
    const [id, callback] = idleCallbacks.entries().next().value!;
    idleCallbacks.delete(id);
    return () => callback({ didTimeout: false, timeRemaining: () => 50 });
  };
  return { frames, idleCallbacks, takeFrame, takeIdle };
}

export function footprintLayout() {
  const writeRows = vi.fn<(heights: Record<string, number>) => void>();
  const rowLayout: ChatWidgetLayout = {
    read: () => 300,
    readRows: () => undefined,
    write: () => undefined,
    writeRows,
    invalidateRow: () => {},
  };
  const layout = new TranscriptLayoutOwner(() => {});
  layout.configureRows(
    threadProps("layout-lifetime", undefined, [], { widgetLayout: rowLayout }),
    "gutter",
    false,
  );
  layout.rowWidth = 768;
  layout.paneWidth = 1100;
  layout.rows = [{ key: "row", revision: "revision" }];
  return { layout, writeRows };
}

export function mountedVirtualizer(layout: TranscriptLayoutOwner, height = 100) {
  const viewport = document.body.appendChild(document.createElement("div"));
  const row = viewport.appendChild(document.createElement("div"));
  row.dataset.index = "0";
  layout.connect(viewport);
  const instance = new Virtualizer<HTMLDivElement, HTMLElement>({
    count: 1,
    getItemKey: () => "row",
    estimateSize: () => height,
    getScrollElement: () => viewport,
    observeElementRect: (_, callback) => {
      callback({ width: 768, height: 600 });
    },
    observeElementOffset: (_, callback) => {
      callback(0, false);
    },
    scrollToFn: () => {},
  });
  const { _didMount: mount, _willUpdate: update } = instance;
  const dispose = mount();
  update();
  instance.measureElement(row);
  instance.resizeItem(0, height);
  return {
    instance,
    dispose: () => {
      dispose();
      viewport.remove();
    },
  };
}

export const phases = [
  { label: "animation frame", idle: true, advance: false },
  { label: "idle callback", idle: true, advance: true },
  { label: "fallback animation frame", idle: false, advance: true },
];
