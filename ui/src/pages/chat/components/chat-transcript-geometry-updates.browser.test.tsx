import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, expect, it, vi } from "vitest";
import type { ApplicationContext } from "../../../app/context.ts";
import { flush } from "../../../test-helpers/solid-settle.ts";
import { projectChatFields } from "../chat-field-projection.ts";
import { createMountedPanes } from "../chat-pane-mounted.test-support.ts";
import "../../../styles.css";
import "../../../styles/chat.ts";
import { ChatPaneRuntime } from "../chat-pane-render.ts";
import { createPaneTestHost } from "../chat-pane.test-support.ts";
import { saveChatSessionScrollPosition } from "../scroll.ts";
import type { ChatThreadProps } from "./chat-thread-interactions.ts";
import { ChatThread } from "./chat-thread-view.tsx";
import type { ChatTranscript } from "./chat-transcript-controller.ts";
import { TranscriptEndAnchor } from "./chat-transcript-end-anchor.ts";
import { subscribeTranscriptScroll } from "./chat-transcript-scroll-events.ts";
import { ChatSessionVirtualizerHost } from "./chat-transcript-virtualizer-host.ts";
import { requireElement, threadProps } from "./chat-transcript.test-support.ts";

// mock-isolation: Keep the pane shell small while exercising the production transcript owner.
vi.mock("../chat-pane-layout-view.tsx", async (importOriginal) => {
  const { PaneLayout } = await importOriginal<typeof import("../chat-pane-layout-view.tsx")>();
  const { createPaneLayoutFixture } = await import("../chat-pane-layout.test-support.tsx");
  return createPaneLayoutFixture(PaneLayout);
});

class GeometryPane extends ChatPaneRuntime {
  session: ChatSessionVirtualizerHost | undefined;
  fixtureStream: string | null = null;
  fixtureHistory = false;
  fixtureMessages: unknown[] = [];
  private rowHeight = 120;

  initialize(context: ApplicationContext, followEnd = false, rowHeight = followEnd ? 360 : 120) {
    projectChatFields(this, ["fixtureStream", "fixtureHistory", "fixtureMessages"]);
    this.context = context;
    this.paneId = "geometry-render";
    this.sessionKey = "agent:main:geometry-render";
    this.rowHeight = rowHeight;
    this.fixtureMessages = Array.from({ length: 100 }, (_, index) => ({
      role: index % 2 === 0 ? "user" : "assistant",
      content: `Row ${index}`,
      timestamp: index + 1,
      __openclaw: { id: `geometry-row-${index}` },
    }));
    saveChatSessionScrollPosition(this.paneId, this.sessionKey, {
      scrollTop: 0,
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

async function mountPane(followEnd = false, rowHeight?: number) {
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
  pane.initialize(fixture.context, followEnd, rowHeight);
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

it("reconciles the streaming end only when native row geometry changes", async () => {
  const { host, viewport, virtualizer } = await mountPane(true);
  host.fixtureStream = "Initial streaming text";
  await settleLayout();
  await expect.poll(() => virtualizer.isScrolling).toBe(false);
  await settleLayout();
  const tail = requireElement(host, ".chat-virtual-row:last-child");
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
