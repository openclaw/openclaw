// @vitest-environment jsdom
import { Virtualizer } from "@tanstack/virtual-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { collectGarbageForTest } from "../../../test-helpers/garbage-collection.ts";
import {
  cacheChatSessionSnapshot,
  createChatWidgetLayout,
  type ChatMessageCache,
  type ChatWidgetLayout,
} from "../session-message-cache.ts";
import { TranscriptLayoutOwner } from "./chat-transcript-layout-owner.ts";
import { ChatSessionVirtualizerHost } from "./chat-transcript-virtualizer-host.ts";
import {
  installTranscriptDomMocks,
  resetTranscriptTestDom,
  threadProps,
} from "./chat-transcript.test-support.ts";

function hasLiveTarget(reference: WeakRef<object>): boolean {
  return reference.deref() !== undefined;
}

function scheduledCallbacks(idle: boolean) {
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

function footprintLayout() {
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

function mountedVirtualizer(layout: TranscriptLayoutOwner, height = 100) {
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

const phases = [
  { label: "animation frame", idle: true, advance: false },
  { label: "idle callback", idle: true, advance: true },
  { label: "fallback animation frame", idle: false, advance: true },
];

beforeEach(installTranscriptDomMocks);
afterEach(resetTranscriptTestDom);

describe("transcript layout lifetime", () => {
  it.each(phases)("releases a disconnected virtualizer during its $label", async (phase) => {
    const scheduled = scheduledCallbacks(phase.idle);
    const { layout } = footprintLayout();
    const retire = () => {
      const mounted = mountedVirtualizer(layout);
      layout.persistRows(mounted.instance, false);
      if (phase.advance) {
        scheduled.takeFrame()();
      }
      layout.disconnect();
      mounted.dispose();
      return new WeakRef(mounted.instance);
    };
    const obsolete = retire();
    const control = new WeakRef({ unowned: true });

    await collectGarbageForTest();
    expect(hasLiveTarget(control)).toBe(false);
    expect(hasLiveTarget(obsolete)).toBe(false);
    expect(scheduled.frames.size + scheduled.idleCallbacks.size).toBe(0);
    // The retained layout still owns useful geometry across reconnection.
    expect(layout.rowMinimum(0)).toBe(300);
  });

  it.each(phases)("ignores an obsolete $label after reconnecting", (phase) => {
    const scheduled = scheduledCallbacks(phase.idle);
    const { layout, writeRows } = footprintLayout();
    const old = mountedVirtualizer(layout);
    layout.persistRows(old.instance, false);
    if (phase.advance) {
      scheduled.takeFrame()();
    }
    const obsolete = phase.advance && phase.idle ? scheduled.takeIdle() : scheduled.takeFrame();
    layout.disconnect();
    old.dispose();
    const current = mountedVirtualizer(layout, 250);
    try {
      layout.persistRows(current.instance, false);
      expect(scheduled.frames.size).toBe(1);
      obsolete();
      layout.persistRows(current.instance, false);
      expect(scheduled.frames.size).toBe(1);
      expect(scheduled.idleCallbacks.size).toBe(0);
      scheduled.takeFrame()();
      (phase.idle ? scheduled.takeIdle() : scheduled.takeFrame())();
      expect(writeRows).toHaveBeenCalledTimes(1);
      expect(Object.values(writeRows.mock.calls[0]![0])).toEqual([250]);
      expect(layout.rowMinimum(0)).toBe(300);
    } finally {
      layout.disconnect();
      current.dispose();
    }
  });

  it("retains only geometry identities when a rendered host disconnects", async () => {
    scheduledCallbacks(true);
    const host = new ChatSessionVirtualizerHost(() => {});
    const { layout } = footprintLayout();
    host.layout.rowLayout = layout.rowLayout;
    host.layout.rowWidth = 768;
    host.layout.paneWidth = 1100;
    const renderAndDisconnect = () => {
      const message = { body: "obsolete transcript body" };
      const content = document.createElement("div");
      content.textContent = "obsolete content row";
      host.render(
        [
          { kind: "item", key: "row", revision: "revision", item: message },
          { kind: "content", key: "content", content },
        ],
        () => null,
        null,
        false,
      );
      host.disconnect();
      return {
        obsolete: [new WeakRef(message), new WeakRef(content)],
        control: new WeakRef({ unowned: true }),
      };
    };
    const { obsolete, control } = renderAndDisconnect();
    try {
      await collectGarbageForTest();
      expect(hasLiveTarget(control)).toBe(false);
      expect(obsolete.map(hasLiveTarget)).toEqual([false, false]);
      expect(host.layout.rows).toEqual([
        { key: "row", revision: "revision" },
        { key: "content", revision: undefined },
      ]);
      expect(host.layout.rowMinimum(0)).toBe(300);
    } finally {
      host.dispose();
    }
  });

  it("releases the admitted cache after terminal host disposal", async () => {
    const host = new ChatSessionVirtualizerHost(() => {});
    const admitAndDispose = () => {
      const cache: ChatMessageCache = new Map();
      const message = { role: "assistant", content: "retired cached transcript" };
      const target = { sessionKey: "agent:main:layout-lifetime" };
      cacheChatSessionSnapshot(cache, {}, target, {
        messages: [message],
        pagination: { hasMore: false },
        sessionId: "session-1",
      });
      host.layout.configureRows(
        threadProps("layout-disposal", target.sessionKey, [], {
          widgetLayout: createChatWidgetLayout()(cache, {}, target),
        }),
        "gutter",
        false,
      );
      host.layout.rows = [{ key: "row", revision: "revision" }];
      host.dispose();
      return new WeakRef(message);
    };
    const obsolete = admitAndDispose();
    const control = new WeakRef({ unowned: true });

    await collectGarbageForTest();
    expect(hasLiveTarget(control)).toBe(false);
    expect(hasLiveTarget(obsolete)).toBe(false);
    expect(host.layout.rows).toEqual([]);
    expect(host.layout.rowLayout).toBeUndefined();
  });
});
