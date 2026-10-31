import { expectDefined } from "@openclaw/normalization-core";
import { Virtualizer } from "@tanstack/virtual-core";
import { createEffect, createRoot, createSignal } from "solid-js";
import { afterEach, expect, it, onTestFinished, vi } from "vitest";
import type { ApplicationContext } from "../../../app/context.ts";
import { flush } from "../../../test-helpers/solid-settle.ts";
import { projectChatFields } from "../chat-field-projection.ts";
import { createMountedPanes } from "../chat-pane-mounted.test-support.ts";
import "../../../styles.css";
import "../../../styles/chat.ts";
import { ChatPaneRuntime } from "../chat-pane-render.ts";
import { createPaneTestHost } from "../chat-pane.test-support.ts";
import { makeMessage } from "../chat-thread.test-support.ts";
import { saveChatSessionScrollPosition } from "../scroll.ts";
import type { ChatWidgetLayout } from "../session-message-cache.ts";
import type { ChatThreadProps } from "./chat-thread-interactions.ts";
import { ChatThread } from "./chat-thread-view.tsx";
import type { ChatTranscript } from "./chat-transcript-controller.ts";
import { TranscriptEndAnchor } from "./chat-transcript-end-anchor.ts";
import { TranscriptLayoutOwner } from "./chat-transcript-layout-owner.ts";
import {
  observeTranscriptOffset,
  TranscriptOffsetState,
} from "./chat-transcript-offset-observer.ts";
import { TranscriptPrependAnchor } from "./chat-transcript-prepend-anchor.ts";
import { subscribeTranscriptScroll } from "./chat-transcript-scroll-events.ts";
import { ChatSessionVirtualizerHost } from "./chat-transcript-virtualizer-host.ts";
import { requireElement, threadProps } from "./chat-transcript.test-support.ts";

// mock-isolation: Keep the pane shell small while exercising the production transcript owner.
vi.mock("../chat-pane-layout-view.tsx", async (importOriginal) => {
  const { PaneLayout } = await importOriginal<typeof import("../chat-pane-layout-view.tsx")>();
  const { createPaneLayoutFixture } = await import("../chat-pane-layout.test-support.tsx");
  return createPaneLayoutFixture(PaneLayout);
});

function geometryMessages(count: number) {
  return Array.from({ length: count }, (_, index) => ({
    role: index % 2 === 0 ? "user" : "assistant",
    content: `Row ${index}`,
    timestamp: index + 1,
    __openclaw: { id: `geometry-row-${index}` },
  }));
}

class GeometryPane extends ChatPaneRuntime {
  session: ChatSessionVirtualizerHost | undefined;
  fixtureStream: string | null = null;
  fixtureHistory = false;
  fixtureMessages: unknown[] = [];
  private rowHeight = 120;
  private fixtureWidgetLayout?: ChatWidgetLayout;

  initialize(
    context: ApplicationContext,
    followEnd = false,
    rowHeight = followEnd ? 360 : 120,
    widgetLayout?: ChatWidgetLayout,
    scrollTop = 0,
    messages?: unknown[],
  ) {
    projectChatFields(this, ["fixtureStream", "fixtureHistory", "fixtureMessages"]);
    this.context = context;
    this.paneId = "geometry-render";
    this.sessionKey = "agent:main:geometry-render";
    this.rowHeight = rowHeight;
    this.fixtureWidgetLayout = widgetLayout;
    this.fixtureMessages = messages ?? geometryMessages(100);
    saveChatSessionScrollPosition(this.paneId, this.sessionKey, {
      scrollTop,
      anchorToEnd: followEnd,
    });
  }

  renderGeometry() {
    this.transcript.renderSession(this.sessionKey, (session) => {
      if (!(session instanceof ChatSessionVirtualizerHost)) {
        throw new Error("Expected the session virtualizer owner");
      }
      this.session = session;
    });
    return {
      layout: {
        component: GeometryLayout,
        props: {
          transcript: this.transcript,
          thread: threadProps(this.paneId, this.sessionKey, this.fixtureMessages, {
            stream: this.fixtureStream,
            assistantName: "Assistant",
            historyPagination: this.fixtureHistory
              ? { hasMore: true, loading: false, onShowEarlier: () => {} }
              : undefined,
            widgetLayout: this.fixtureWidgetLayout,
          }),
          rowHeight: this.rowHeight,
        },
      },
      dialog: undefined,
      capabilityDialogs: undefined,
      providerReviewSource: undefined,
    };
  }
}

function GeometryLayout(props: {
  transcript: ChatTranscript;
  thread: ChatThreadProps;
  rowHeight: number;
}) {
  return (
    <div
      class="geometry-transcript-fixture"
      style={{ "--geometry-row-height": `${props.rowHeight}px` }}
    >
      <style>{`
        .geometry-transcript-fixture .chat-thread-viewport {
          height: 400px; flex: none; padding: 20px 0;
        }
        .geometry-transcript-fixture .chat-thread { overflow-anchor: none; }
        .geometry-transcript-fixture .chat-virtual-row { height: var(--geometry-row-height); }
      `}</style>
      <ChatThread props={props.thread} transcript={props.transcript} />
    </div>
  );
}

let pane: (GeometryPane & HTMLElement) | undefined;
afterEach(() => {
  pane?.remove();
  pane = undefined;
  vi.restoreAllMocks();
});

// Let real ResizeObservers and their resulting commits finish between widths.
async function settleLayout() {
  for (let frame = 0; frame < 4; frame++) {
    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => resolve());
    });
    await pane?.updateComplete;
  }
}

it("publishes native scroll policy and row position in one Solid update", async () => {
  const viewport = document.body.appendChild(document.createElement("div"));
  viewport.style.cssText = "height: 100px; overflow: auto; scroll-behavior: auto";
  viewport.appendChild(document.createElement("div")).style.height = "1000px";
  onTestFinished(() => viewport.remove());
  const updates: Array<readonly [number, number]> = [];
  createRoot((dispose) => {
    onTestFinished(dispose);
    const [policy, setPolicy] = createSignal(0);
    const [position, setPosition] = createSignal(0);
    createEffect(
      () => [policy(), position()],
      (value) => {
        updates.push(value);
      },
    );
    const virtualizer = new Virtualizer<HTMLDivElement, HTMLElement>({
      count: 0,
      getScrollElement: () => viewport,
      estimateSize: () => 40,
      scrollToFn: vi.fn(),
      observeElementRect: vi.fn(),
      observeElementOffset: vi.fn(),
    });
    virtualizer.scrollElement = viewport;
    virtualizer.targetWindow = window;
    onTestFinished(
      observeTranscriptOffset(
        {
          state: new TranscriptOffsetState(),
          getScrollElement: () => viewport,
          endAnchor: new TranscriptEndAnchor(() => {}),
          prependAnchor: new TranscriptPrependAnchor(new Map(), vi.fn()),
          canFollowEnd: () => false,
          isProgrammaticScroll: () => false,
          cancelScroll: vi.fn(),
          onLayoutCorrection: vi.fn(),
          invalidate: vi.fn(),
          onOffset: vi.fn(),
          onReaderScroll: vi.fn(),
          onComposerLayout: vi.fn(),
          onNativeScroll: () => setPolicy(1),
        },
        virtualizer,
        () => setPosition(1),
      ),
    );
  });
  flush();
  viewport.scrollTop = 20;
  await vi.waitFor(() => expect(updates.at(-1)).toEqual([1, 1]));
  expect(updates).toEqual([
    [0, 0],
    [1, 1],
  ]);
});

async function mountPane(
  followEnd = false,
  rowHeight?: number,
  widgetLayout?: ChatWidgetLayout,
  scrollTop = 0,
  messages?: unknown[],
) {
  const fixture = createMountedPanes([
    { key: "agent:main:geometry-render", kind: "direct", updatedAt: 1 },
  ]);
  fixture.pane.applyGatewaySnapshot({
    ...fixture.context.gateway.snapshot,
    phase: "stopped",
    client: null,
  });
  pane = createPaneTestHost("test-transcript-geometry-pane", GeometryPane);
  Object.assign(pane, { render: pane.renderGeometry.bind(pane) });
  pane.initialize(fixture.context, followEnd, rowHeight, widgetLayout, scrollTop, messages);
  pane.style.cssText = "display: block; width: 800px";
  document.body.append(pane.element);
  await pane.updateComplete;
  await vi.dynamicImportSettled();
  await settleLayout();
  const session = expectDefined(pane.session, "mounted transcript session");
  const viewport = expectDefined(session.scrollElement, "mounted transcript viewport");
  return {
    host: pane,
    session,
    viewport,
    slot: expectDefined(viewport.parentElement, "viewport slot"),
    virtualizer: session["virtualizer"],
  };
}

function scrollReader(viewport: HTMLElement, offset: number) {
  viewport.dispatchEvent(
    new WheelEvent("wheel", { deltaY: offset - viewport.scrollTop, bubbles: true }),
  );
  viewport.scrollTop = offset;
  // Deliver motion before a row measurement can synchronize this offset as idle.
  viewport.dispatchEvent(new Event("scroll"));
  flush();
}

it.each([
  { name: "interior", offset: 100, height: 1600, resize: false, expected: 100 },
  { name: "clamped", offset: 1400, height: 1600, resize: true, expected: 1200 },
  {
    name: "undelivered native offset",
    offset: 100,
    nextOffset: 1400,
    height: 1600,
    resize: true,
    expected: 1200,
  },
  { name: "fractional edge", offset: 1200, height: 1600.25, resize: true, expected: 1200 },
])("measures a shrinking range only near the native end ($name)", (scenario) => {
  const slot = document.body.appendChild(document.createElement("div"));
  const viewport = slot.appendChild(document.createElement("div"));
  viewport.style.cssText = "width: 600px; height: 400px; overflow: auto; overflow-anchor: none";
  const content = viewport.appendChild(document.createElement("div"));
  const changed = vi.fn();
  const layout = new TranscriptLayoutOwner(changed);
  layout.connect(viewport);
  layout.commitRange(content, 2400);
  viewport.scrollTop = scenario.offset;
  layout.commitRange(content, 2200);
  if (scenario.nextOffset !== undefined) {
    viewport.scrollTop = scenario.nextOffset;
  }
  const before = viewport.scrollTop;
  changed.mockClear();
  const resized = vi.fn();
  const stop = subscribeTranscriptScroll(viewport, (event) => {
    if (event.type === "resize") {
      resized(event);
    }
  });
  const extentReads = vi.spyOn(viewport, "scrollHeight", "get");
  try {
    layout.commitRange(content, scenario.height);
    expect(extentReads).toHaveBeenCalledTimes(scenario.resize ? 1 : 0);
    expect(resized).toHaveBeenCalledTimes(scenario.resize ? 1 : 0);
    const after = viewport.scrollTop;
    expect(after).toBe(scenario.expected);
    if (scenario.resize) {
      expect(changed).toHaveBeenCalledExactlyOnceWith(before, after);
      expect(resized).toHaveBeenCalledWith(
        expect.objectContaining({
          viewport: expect.objectContaining({ scrollTop: after }),
          ...(after !== before ? { scrollCorrection: { before, after } } : {}),
        }),
      );
    } else {
      expect(changed).not.toHaveBeenCalled();
    }
  } finally {
    extentReads.mockRestore();
    stop();
    layout.disconnect();
    slot.remove();
  }
});

it("retains the accepted history-header space while a touch holds the older row model", async () => {
  const { host, viewport } = await mountPane();
  host.fixtureHistory = true;
  await settleLayout();
  const retained = requireElement(host, ".chat-virtual-row");
  const top = retained.getBoundingClientRect().top;
  const touch = new Touch({ identifier: 1, target: viewport, clientY: 100 });
  viewport.dispatchEvent(
    new TouchEvent("touchstart", { touches: [touch], changedTouches: [touch], bubbles: true }),
  );
  host.fixtureMessages = [
    { role: "assistant", content: "Earlier synthetic message", timestamp: 0 },
    ...host.fixtureMessages,
  ];
  host.fixtureHistory = false;
  await settleLayout();
  expect(host.querySelector(".chat-history-boundary")).toBeNull();
  expect(retained.dataset.index).toBe("0");
  expect(Math.abs(retained.getBoundingClientRect().top - top)).toBeLessThanOrEqual(2);

  viewport.dispatchEvent(
    new TouchEvent("touchend", { touches: [], changedTouches: [touch], bubbles: true }),
  );
  await settleLayout();
  expect(retained.dataset.index).toBe("1");
  expect(Math.abs(retained.getBoundingClientRect().top - top)).toBeLessThanOrEqual(2);
});

it.each([
  // Complete footprints admit one overscan neighbor; a partial cache keeps
  // the initial viewport on its three known rows until reader navigation.
  { offset: null, rowHeight: 120, cachedRows: 100, expected: [95, 96, 97, 98, 99] },
  { offset: 3600, rowHeight: 120, cachedRows: 100, expected: [28, 29, 30, 31, 32, 33, 34] },
  { offset: null, rowHeight: 128, cachedRows: 3, expected: [97, 98, 99] },
])(
  "commits the cached initial window with $cachedRows footprints and $rowHeight px rows at $offset",
  async ({ offset, rowHeight, cachedRows, expected }) => {
    const cachedHeight = (key: string) =>
      key.startsWith("row:v1:") && Number(/geometry-row-(\d+):/.exec(key)?.[1]) >= 100 - cachedRows
        ? rowHeight
        : undefined;
    const windows: number[][] = [];
    const observer = new MutationObserver(() => {
      const active = [
        ...document.querySelectorAll<HTMLElement>(".chat-virtual-row:not([data-prepared-row])"),
      ].map((row) => Number(row.dataset.index));
      if (active.length && active.join(",") !== windows.at(-1)?.join(",")) {
        windows.push(active);
      }
    });
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["data-prepared-row"],
    });
    try {
      const { viewport } = await mountPane(
        offset === null,
        rowHeight,
        {
          read: cachedHeight,
          readRows: () => {
            const layout = expectDefined(pane?.session, "mounted transcript session").layout;
            return Object.fromEntries(
              layout.rows.flatMap((_, index) => {
                const key = layout["rowLayoutKey"](index);
                return key && cachedHeight(key) ? [[key, rowHeight]] : [];
              }),
            );
          },
          write: () => {},
          writeRows: () => {},
          invalidateRow: () => {},
        },
        offset ?? 0,
      );
      expect(
        windows.filter((rows) => rows.length > 0).length,
        JSON.stringify(windows),
      ).toBeLessThanOrEqual(cachedRows === 100 ? 2 : 3);
      if (cachedRows === 3) {
        expect(windows.find((rows) => rows.length > 1)).toEqual([97, 98, 99]);
      }
      expect(windows.at(-1)).toEqual(expected);
      if (offset === null) {
        expect(viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop).toBe(0);
      } else {
        expect(viewport.scrollTop).toBe(offset);
      }
    } finally {
      observer.disconnect();
    }
  },
);

it.each([120, 360, 1200])(
  "prepares only the tail window while initial %ipx rows settle",
  async (rowHeight) => {
    const mounted = new Map<string, Set<Element>>();
    const observer = new MutationObserver((records) => {
      for (const record of records) {
        for (const node of record.addedNodes) {
          if (!(node instanceof Element)) {
            continue;
          }
          const rows = node.matches(".chat-virtual-row")
            ? [node]
            : node.querySelectorAll(".chat-virtual-row");
          for (const row of rows) {
            const key = row.getAttribute("data-virtual-row-key")!;
            const elements = mounted.get(key) ?? new Set<Element>();
            elements.add(row);
            mounted.set(key, elements);
          }
        }
      }
    });
    observer.observe(document.body, { childList: true, subtree: true });
    try {
      const { host, viewport, virtualizer } = await mountPane(true, rowHeight);
      const tail = expectDefined(host.querySelector('[data-index="99"]'), "last transcript row");
      expect([...mounted.values()][0]).toEqual(new Set([tail]));
      expect([...mounted.get(tail.getAttribute("data-virtual-row-key")!)!]).toEqual([tail]);
      expect([...mounted.keys()].some((key) => key.includes("geometry-row-0:"))).toBe(false);
      expect(mounted.size).toBe(host.querySelectorAll(".chat-virtual-row").length);
      expect(
        [...mounted.values()].every((elements) => [...elements].every((row) => row.isConnected)),
      ).toBe(true);
      expect(
        virtualizer.getVirtualItems().reduce((height, row) => height + row.size, 0) +
          Number.parseFloat(getComputedStyle(viewport).paddingBottom),
      ).toBeGreaterThanOrEqual(viewport.clientHeight);
      expect(getComputedStyle(tail).visibility).toBe("visible");
      expect(
        viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop,
      ).toBeLessThanOrEqual(1);
    } finally {
      observer.disconnect();
    }
  },
);

it("parks retained rows without layout and restores their resized geometry and nested scroll", async () => {
  const prose = "A retained paragraph wraps to the current conversation width. ".repeat(20);
  const source = [prose, "```text", "wide".repeat(160), "```"].join("\n\n");
  // Only split completed runs retain DOM. The ordinary tail crosses the
  // windowing threshold without competing with the final fragment's retention.
  const messages = [
    makeMessage("geometry-question", 1, { role: "user" }),
    ...Array.from({ length: 34 }, (_, index) =>
      makeMessage(`geometry-work-${index}`, index + 2, { phase: "commentary" }),
    ),
    makeMessage("geometry-answer", 36, {
      phase: "final_answer",
      stopReason: "stop",
      content: source,
    }),
    ...geometryMessages(222).map((message, index) =>
      Object.assign({}, message, { timestamp: 400 + index }),
    ),
  ];
  const { host, viewport, session, virtualizer } = await mountPane(
    false,
    120,
    undefined,
    0,
    messages,
  );
  expect(session.revealMessage("geometry-answer")).toBe(true);
  await expect.poll(() => host.querySelector('[data-entry-id="geometry-answer"]')).not.toBeNull();
  session.cancelScroll();
  const row = expectDefined(
    requireElement(host, '[data-entry-id="geometry-answer"]').closest<HTMLElement>(
      ".chat-virtual-row",
    ),
    "answer virtual row",
  );
  const targetIndex = Number(row.dataset.index);
  // Other fixture rows have fixed CSS heights. Their later idle preparation
  // must not change total extent while this test measures the retained row.
  for (let index = 0; index < virtualizer.options.count; index++) {
    if (index !== targetIndex) {
      virtualizer.resizeItem(index, 120);
    }
  }
  virtualizer.scrollToIndex(targetIndex, { align: "start", behavior: "auto" });
  await settleLayout();
  // Other fixture rows have fixed heights. This row uses its real Markdown
  // height so the narrower pane must produce a new browser measurement.
  row.style.height = "auto";
  await settleLayout();
  const key = expectDefined(row.dataset.virtualRowKey, "retained row key");
  const code = requireElement(row, ".code-block-viewport");
  const height = row.getBoundingClientRect().height;
  const extent = viewport.scrollHeight;
  expect(height).toBeGreaterThan(120);
  expect(virtualizer.itemSizeCache.get(key)).toBeCloseTo(height, 1);
  expect(code.scrollWidth - code.clientWidth).toBeGreaterThan(80);
  code.scrollLeft = 37;
  expect(code.scrollLeft).toBe(37);

  const deliveredHeights: number[] = [];
  let parkedReceipt: ResizeObserverEntry | undefined;
  const observer = new ResizeObserver((entries) => {
    for (const entry of entries) {
      if (entry.target === row) {
        const size = entry.borderBoxSize[0]?.blockSize ?? entry.contentRect.height;
        deliveredHeights.push(size);
        if (size === 0) {
          parkedReceipt = entry;
        }
      }
    }
  });
  observer.observe(row, { box: "border-box" });
  try {
    virtualizer.scrollToIndex(targetIndex + 5, { align: "start", behavior: "auto" });
    await expect.poll(() => row.hasAttribute("data-prepared-row")).toBe(true);
    await settleLayout();
    expect(row.isConnected).toBe(true);
    // Parked DOM must create no layout box, while its cached height still
    // contributes to the native scroll extent after the real zero-size receipt.
    expect(row.getClientRects()).toHaveLength(0);
    expect(deliveredHeights).toContain(0);
    expect(virtualizer.itemSizeCache.get(key)).toBeCloseTo(height, 1);
    expect(Math.abs(viewport.scrollHeight - extent)).toBeLessThanOrEqual(1);

    host.style.width = "480px";
    session.syncViewportGeometry();
    await settleLayout();
    expect(row.getClientRects()).toHaveLength(0);
    expect(virtualizer.itemSizeCache.get(key)).toBeCloseTo(height, 1);
    expect(Math.abs(viewport.scrollHeight - extent)).toBeLessThanOrEqual(1);

    virtualizer.scrollToIndex(targetIndex, { align: "start", behavior: "auto" });
    await expect.poll(() => row.hasAttribute("data-prepared-row")).toBe(false);
    await settleLayout();
    expect(requireElement(host, `.chat-virtual-row[data-index="${targetIndex}"]`)).toBe(row);
    expect(requireElement(row, ".code-block-viewport")).toBe(code);
    expect(code.scrollLeft).toBe(37);
    const resizedHeight = row.getBoundingClientRect().height;
    expect(resizedHeight).toBeGreaterThan(height);
    expect(virtualizer.itemSizeCache.get(key)).toBeCloseTo(resizedHeight, 1);
    expect(deliveredHeights.some((value) => value > height)).toBe(true);
    expect(Math.abs(viewport.scrollHeight - extent - (resizedHeight - height))).toBeLessThanOrEqual(
      1,
    );
    // Frame-deferred delivery can outlive the parked state that produced zero.
    virtualizer.resizeItem(
      targetIndex,
      virtualizer.options.measureElement(
        row,
        expectDefined(parkedReceipt, "parked zero-size receipt"),
        virtualizer,
      ),
    );
    expect(virtualizer.itemSizeCache.get(key)).toBeCloseTo(resizedHeight, 1);
    row.style.height = "0px";
    expect(virtualizer.options.measureElement(row, parkedReceipt, virtualizer)).toBe(0);
  } finally {
    observer.disconnect();
  }
});

it("reconciles the streaming end only when native row geometry changes", async () => {
  const { host, viewport, virtualizer } = await mountPane(
    true,
    360,
    undefined,
    0,
    geometryMessages(6),
  );
  host.fixtureStream = "Initial streaming text";
  await settleLayout();
  const tail = requireElement(host, ".chat-virtual-row:not([data-prepared-row]):last-child");
  // Startup measures the live viewport; offscreen history can retain estimates.
  await expect.poll(() => tail.getBoundingClientRect().height).toBe(360);
  await expect.poll(() => virtualizer.isScrolling).toBe(false);
  await settleLayout();
  expect(viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop).toBeLessThanOrEqual(1);
  const keys = () =>
    [...host.querySelectorAll<HTMLElement>(".chat-virtual-row")].map(
      (row) => row.dataset.virtualRowKey,
    );
  const initialKeys = keys();
  const reconcile = vi.spyOn(TranscriptEndAnchor.prototype, "scheduleReconcile");
  for (const text of ["First delta", "Second delta", "Third delta"]) {
    host.fixtureStream = text;
    await settleLayout();
    expect(tail.textContent).toContain(text);
  }
  expect(reconcile).not.toHaveBeenCalled();

  const before = viewport.scrollHeight;
  tail.style.height = `${tail.getBoundingClientRect().height + 12}px`;
  await settleLayout();
  expect(viewport.scrollHeight).toBe(before + 12);
  expect(reconcile).toHaveBeenCalled();
  expect(keys()).toEqual(initialKeys);
  expect(viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop).toBeLessThanOrEqual(1);
});

it("commits uncompensated extents while coalescing reader row updates", async () => {
  // Observe the initial row heights before injecting the two resize receipts.
  const { host, session, viewport, virtualizer } = await mountPane(false, 120, undefined, 480);
  scrollReader(viewport, 480);
  expect(virtualizer.isScrolling).toBe(true);
  expect(session.isPositionSettled).toBe(true);
  const inner = requireElement(host, ".chat-thread-inner");
  const height = Number.parseFloat(inner.style.height);
  const commit = vi.spyOn(session.layout, "commitRange");
  const notification = vi.spyOn(virtualizer.options, "onChange");
  requireElement(host, '.chat-virtual-row[data-index="6"]').style.height = "180px";
  virtualizer.resizeItem(6, 180);
  requireElement(host, '.chat-virtual-row[data-index="7"]').style.height = "210px";
  virtualizer.resizeItem(7, 210);
  flush();
  await Promise.resolve();
  flush();

  expect(notification.mock.calls).toEqual([
    [virtualizer, false],
    [virtualizer, false],
  ]);
  expect(commit).toHaveBeenCalledWith(inner, height + 150);
  expect(Number.parseFloat(inner.style.height)).toBe(height + 150);
  expect(viewport.scrollTop).toBe(480);

  await new Promise<void>((resolve) => {
    requestAnimationFrame(() => resolve());
  });
  flush();
  // The post-mount check can repeat the same height without publishing a change.
  expect(commit).toHaveBeenCalledWith(inner, height + 150);
  expect(Number.parseFloat(inner.style.height)).toBe(height + 150);
  expect(viewport.scrollTop).toBe(480);
});

it("defers uncompensated measurement read-back until the next frame", async () => {
  const { host, session, viewport, virtualizer } = await mountPane(false, 120, undefined, 480);
  scrollReader(viewport, 480);
  const inner = requireElement(host, ".chat-thread-inner");
  const height = Number.parseFloat(inner.style.height);
  const row = requireElement(host, '.chat-virtual-row[data-index="6"]');
  const render = vi.spyOn(session["renderer"], "render");
  const paint = vi.fn();
  const frame = requestAnimationFrame(paint);
  try {
    // The compositor can advance before the next native scroll event arrives.
    viewport.scrollTop = 600;
    row.style.height = "180px";
    const entry: ResizeObserverEntry = {
      target: row,
      borderBoxSize: [{ inlineSize: 800, blockSize: 180 }],
      contentBoxSize: [{ inlineSize: 800, blockSize: 180 }],
      devicePixelContentBoxSize: [],
      contentRect: row.getBoundingClientRect(),
    };
    virtualizer.resizeItem(6, virtualizer.options.measureElement(row, entry, virtualizer));
    expect(virtualizer.scrollOffset).toBe(600);
    expect(render).not.toHaveBeenCalled();
    await Promise.resolve();
    flush();
    expect(render).not.toHaveBeenCalled();
    expect(paint).not.toHaveBeenCalled();
    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => resolve());
    });
    flush();
    expect(render).toHaveBeenCalledOnce();
    expect(Number.parseFloat(inner.style.height)).toBe(height + 60);
    expect(viewport.scrollTop).toBe(600);
    const bounds = viewport.getBoundingClientRect();
    const visible = [...host.querySelectorAll<HTMLElement>(".chat-virtual-row")]
      .map((element) => element.getBoundingClientRect())
      .filter((rect) => rect.bottom > bounds.top && rect.top < bounds.bottom);
    expect(Math.min(...visible.map((rect) => rect.top))).toBeLessThanOrEqual(bounds.top);
    expect(Math.max(...visible.map((rect) => rect.bottom))).toBeGreaterThanOrEqual(bounds.bottom);
  } finally {
    cancelAnimationFrame(frame);
  }
});

it("renders new viewport rows before paint when a measurement reads a fast scroll", async () => {
  const { host, session, viewport, virtualizer } = await mountPane();
  scrollReader(viewport, 480);
  const row = requireElement(host, '.chat-virtual-row[data-index="6"]');
  const render = vi.spyOn(session["renderer"], "render");
  const paint = vi.fn();
  const frame = requestAnimationFrame(paint);
  try {
    viewport.scrollTop = 1800;
    const entry: ResizeObserverEntry = {
      target: row,
      borderBoxSize: [{ inlineSize: 800, blockSize: 120 }],
      contentBoxSize: [{ inlineSize: 800, blockSize: 120 }],
      devicePixelContentBoxSize: [],
      contentRect: row.getBoundingClientRect(),
    };
    virtualizer.resizeItem(6, virtualizer.options.measureElement(row, entry, virtualizer));
    await Promise.resolve();
    flush();
    expect(render).toHaveBeenCalled();
    const bounds = viewport.getBoundingClientRect();
    const visible = [...host.querySelectorAll<HTMLElement>(".chat-virtual-row")]
      .map((element) => element.getBoundingClientRect())
      .filter((rect) => rect.bottom > bounds.top && rect.top < bounds.bottom);
    expect(Math.min(...visible.map((rect) => rect.top))).toBeLessThanOrEqual(bounds.top);
    expect(Math.max(...visible.map((rect) => rect.bottom))).toBeGreaterThanOrEqual(bounds.bottom);
    expect(paint).not.toHaveBeenCalled();
  } finally {
    cancelAnimationFrame(frame);
  }
});

it("commits rows before paint when an uncompensated extent shrink clamps the reader", async () => {
  const { host, viewport, virtualizer } = await mountPane(
    false,
    360,
    undefined,
    0,
    geometryMessages(6),
  );
  scrollReader(viewport, viewport.scrollHeight - viewport.clientHeight);
  await settleLayout();
  const last = requireElement(host, '.chat-virtual-row[data-index="5"]');
  last.style.height = "120px";
  virtualizer.resizeItem(5, 120);
  await settleLayout();
  scrollReader(viewport, viewport.scrollHeight - viewport.clientHeight - 200);
  const inner = requireElement(host, ".chat-thread-inner");
  const height = Number.parseFloat(inner.style.height);
  const before = viewport.scrollTop;
  const notification = vi.spyOn(virtualizer.options, "onChange");
  const paint = vi.fn();
  const frame = requestAnimationFrame(paint);
  try {
    requireElement(host, '.chat-virtual-row[data-index="4"]').style.height = "30px";
    virtualizer.resizeItem(4, 30);
    flush();
    await Promise.resolve();
    flush();

    expect(notification).toHaveBeenCalledWith(virtualizer, false);
    expect(Number.parseFloat(inner.style.height)).toBe(height - 330);
    expect(viewport.scrollTop).toBeLessThan(before);
    expect(viewport.scrollTop).toBe(viewport.scrollHeight - viewport.clientHeight);
    const finalRow = expectDefined(
      virtualizer.getVirtualItems().find((row) => row.index === 5),
      "final virtual row",
    );
    expect(
      Math.abs(
        last.getBoundingClientRect().top -
          inner.getBoundingClientRect().top -
          (finalRow.start - virtualizer.options.scrollMargin),
      ),
    ).toBeLessThanOrEqual(1);
    expect(paint).not.toHaveBeenCalled();
  } finally {
    cancelAnimationFrame(frame);
  }
});

it("commits reader compensation before paint after a deferred measurement", async () => {
  const { host, viewport, virtualizer } = await mountPane();
  // The observer's receipt can arrive after this row leaves the mounted window.
  requireElement(host, '.chat-virtual-row[data-index="2"]').style.height = "150px";
  scrollReader(viewport, 480);
  expect(virtualizer.isScrolling).toBe(true);
  expect(virtualizer.scrollDirection).toBe("forward");
  const inner = requireElement(host, ".chat-thread-inner");
  const height = Number.parseFloat(inner.style.height);
  const notification = vi.spyOn(virtualizer.options, "onChange");
  const paint = vi.fn();
  const frame = requestAnimationFrame(paint);
  try {
    requireElement(host, '.chat-virtual-row[data-index="6"]').style.height = "180px";
    virtualizer.resizeItem(6, 180);
    expect(Number.parseFloat(inner.style.height)).toBe(height + 60);
    const compensated = new Promise<void>((resolve) => {
      viewport.addEventListener("scroll", () => resolve(), { once: true });
    });
    virtualizer.resizeItem(2, 150);
    flush();
    await Promise.resolve();
    flush();

    expect(notification.mock.calls).toEqual([
      [virtualizer, false],
      [virtualizer, true],
    ]);
    expect(viewport.scrollTop).toBe(510);
    expect(Number.parseFloat(inner.style.height)).toBe(height + 90);
    expect(paint).not.toHaveBeenCalled();

    // The later native offset receipt must preserve the compensated geometry.
    await compensated;
    flush();
    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => resolve());
    });
    flush();
    expect(viewport.scrollTop).toBe(510);
    expect(Number.parseFloat(inner.style.height)).toBe(height + 90);
  } finally {
    cancelAnimationFrame(frame);
  }
});

it.each(["pending", "committed"] as const)(
  "commits a non-sync measurement before paint from a %s transcript update",
  async (phase) => {
    const { host, session, virtualizer } = await mountPane();
    const notification = vi.spyOn(virtualizer.options, "onChange");
    const updates = vi.spyOn(host, "render");
    const paint = vi.fn();
    const frame = requestAnimationFrame(paint);
    const measure = () => virtualizer.resizeItem(0, 180);
    if (phase === "committed") {
      session["renderer"].afterCommit(measure);
    }
    host.style.width = "780px";
    session.syncViewportGeometry();
    notification.mockClear();
    if (phase === "pending") {
      measure();
    }
    try {
      await host.updateComplete;
      flush();
      await Promise.resolve();
      flush();
      expect(notification).toHaveBeenCalledExactlyOnceWith(virtualizer, false);
      expect(updates).not.toHaveBeenCalled();
      expect(
        Number.parseFloat(requireElement(host, ".chat-thread-inner").style.height),
      ).toBeCloseTo(12060, 6);
      expect(paint).not.toHaveBeenCalled();
    } finally {
      cancelAnimationFrame(frame);
    }
  },
);

it.each([
  { scale: 1, boxSizing: "border-box", width: 620.25, height: 460.5 },
  { scale: 0.8, boxSizing: "border-box", width: 620.25, height: 460.5 },
  { scale: 0.8, boxSizing: "content-box", width: 626.25, height: 506.5 },
  { scale: 1, boxSizing: "border-box", slotWidth: 1001.5, width: 1001.5, height: 460.5 },
])(
  "consumes the unscaled $boxSizing rect once at scale $scale and publishes its native clamp",
  async ({ scale, boxSizing, slotWidth = 620.25, width, height }) => {
    const { host, session, viewport, slot } = await mountPane();
    viewport.scrollTop = viewport.scrollHeight;
    const before = viewport.scrollTop;
    const resized = vi.fn();
    const stop = subscribeTranscriptScroll(viewport, (event) => {
      if (event.type === "resize") {
        resized(event);
      }
    });
    const mutations = new MutationObserver(() => {});
    mutations.observe(viewport, { attributes: true, attributeFilter: ["style"] });
    const observed: Array<{ width: number; height: number }> = [];
    const observer = new ResizeObserver(([entry]) => {
      const size = expectDefined(entry?.borderBoxSize[0], "viewport border box");
      observed.push({ width: size.inlineSize, height: size.blockSize });
    });
    observer.observe(viewport, { box: "border-box" });
    const updates = vi.spyOn(host, "render");
    try {
      slot.style.cssText = `box-sizing: ${boxSizing}; width: ${slotWidth}px; height: 460.5px; flex: none; padding: 20px 0; border: 3px solid transparent; transform: scale(${scale})`;
      session.layout.sync();
      expect(viewport.style.width).toBe(`${width}px`);
      expect(viewport.style.height).toBe(`${height}px`);
      expect(viewport.scrollTop).toBeLessThan(before);
      expect(resized).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ scrollCorrection: { before, after: viewport.scrollTop } }),
      );
      expect(mutations.takeRecords().length).toBeGreaterThan(0);
      session.layout.sync();
      expect(mutations.takeRecords()).toEqual([]);
      expect(resized).toHaveBeenCalledTimes(1);
      session.syncViewportGeometry();
      const rect = { width: Math.round(width), height: Math.round(height) };
      expect(session["virtualizer"].scrollRect).toEqual(rect);
      await host.updateComplete;
      expect(updates).not.toHaveBeenCalled();
      await settleLayout();
      expect(observed).toEqual([{ width, height }]);
      expect(session["virtualizer"].scrollRect).toEqual(rect);
      expect(updates).not.toHaveBeenCalled();
    } finally {
      observer.disconnect();
      mutations.disconnect();
      stop();
    }
  },
);

it("synchronizes padding changes even when the viewport's outer rect stays the same", async () => {
  const { session, viewport, slot, virtualizer } = await mountPane();
  const rect = virtualizer.scrollRect;
  expect(virtualizer.options.scrollMargin).toBe(20);
  slot.style.paddingTop = "24px";
  session.syncViewportGeometry();
  expect(viewport.style.paddingTop).toBe("24px");
  expect(virtualizer.scrollRect).toEqual(rect);
  expect(virtualizer.options.scrollMargin).toBe(24);
  expect(virtualizer.getVirtualItems()[0]?.start).toBe(24);
});

it("retains measured viewport geometry while its slot is hidden", async () => {
  const { session, viewport, slot } = await mountPane();
  const before = viewport.style.cssText;
  const rect = session["virtualizer"].scrollRect;
  slot.style.display = "none";
  slot.style.width = "620px";
  slot.style.height = "500px";
  session.syncViewportGeometry();
  expect(viewport.style.cssText).toBe(before);
  expect(session["virtualizer"].scrollRect).toBe(rect);
  slot.style.display = "";
  session.syncViewportGeometry();
  expect(session["virtualizer"].scrollRect).toEqual({ width: 620, height: 500 });
});
