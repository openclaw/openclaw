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
import {
  handleChatScroll,
  lockChatScroll,
  saveChatSessionScrollPosition,
  type ChatScrollHost,
} from "../scroll.ts";
import type { ChatThreadProps } from "./chat-thread-interactions.ts";
import { ChatThread } from "./chat-thread-view.tsx";
import type { ChatTranscript } from "./chat-transcript-controller.ts";
import { TranscriptEndAnchor } from "./chat-transcript-end-anchor.ts";
import { subscribeTranscriptScroll } from "./chat-transcript-scroll-events.ts";
import { ChatSessionVirtualizerHost } from "./chat-transcript-virtualizer-host.ts";

// mock-isolation: Keep the pane shell small while exercising the production transcript owner.
vi.mock("../chat-pane-layout-view.tsx", async (importOriginal) => {
  const { PaneLayout } = await importOriginal<typeof import("../chat-pane-layout-view.tsx")>();
  const { createPaneLayoutFixture } = await import("../chat-pane-layout.test-support.tsx");
  return createPaneLayoutFixture(PaneLayout);
});

class GeometryPane extends ChatPaneRuntime {
  session: ChatSessionVirtualizerHost | undefined;
  fixtureStream: string | null = null;
  private messages: unknown[] = [];
  private rowHeight = 120;

  initialize(context: ApplicationContext, followEnd = false) {
    projectChatFields(this, ["fixtureStream"]);
    this.context = context;
    this.paneId = "geometry-render";
    this.sessionKey = "agent:main:geometry-render";
    this.rowHeight = followEnd ? 360 : 120;
    this.messages = Array.from({ length: 100 }, (_, index) => ({
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

  get scrollState() {
    return expectDefined(this.state, "mounted pane state");
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
          thread: {
            paneId: this.paneId,
            sessionKey: this.sessionKey,
            selectedSession: undefined,
            messages: this.messages,
            toolMessages: [],
            streamSegments: [],
            stream: this.fixtureStream,
            streamStartedAt: null,
            loading: false,
            queue: [],
            showThinking: false,
            showToolCalls: false,
            sessions: null,
            assistantName: "Assistant",
            assistantAvatar: null,
            onDraftChange: () => {},
            onSend: () => {},
          } satisfies ChatThreadProps,
          rowHeight: this.rowHeight,
          scroll: this.scrollState,
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
  scroll: Pick<
    ChatScrollHost,
    "chatReadingHistory" | "chatNewMessagesBelow" | "chatFollowLocked" | "chatUserNearBottom"
  >;
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
      <output
        data-reading-history={String(props.scroll.chatReadingHistory)}
        data-new-messages-below={String(props.scroll.chatNewMessagesBelow)}
        data-follow-locked={String(props.scroll.chatFollowLocked)}
        data-near-bottom={String(props.scroll.chatUserNearBottom)}
      />
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

async function mountPane(followEnd = false) {
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
  pane.initialize(fixture.context, followEnd);
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

it("keeps the initial tail rows mounted while their estimated sizes settle", async () => {
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
    const { host, viewport } = await mountPane(true);
    const tail = expectDefined(host.querySelector('[data-index="99"]'), "last transcript row");
    expect([...mounted.get(tail.getAttribute("data-virtual-row-key")!)!]).toEqual([tail]);
    expect([...mounted.keys()].some((key) => key.includes("geometry-row-0:"))).toBe(false);
    expect(viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop).toBeLessThanOrEqual(
      1,
    );
  } finally {
    observer.disconnect();
  }
});

it("commits each settled pane width without preparing the whole pane", async () => {
  const { host, viewport, virtualizer } = await mountPane();
  const updates = vi.spyOn(host, "render");
  const counts: number[] = [];
  for (const width of [760, 720, 680, 740, 1001.5, 999.75]) {
    updates.mockClear();
    host.style.width = `${width}px`;
    await settleLayout();
    counts.push(updates.mock.calls.length);
    expect.soft(virtualizer.scrollRect).toEqual({ width: Math.round(width), height: 400 });
    expect.soft(updates).not.toHaveBeenCalled();
    expect(viewport.getBoundingClientRect().width).toBe(width);
  }
  console.info(`Settled width render counts: ${counts.join(", ")}`);
});

it("reconciles the streaming end only when native row geometry changes", async () => {
  const { host, viewport, virtualizer } = await mountPane(true);
  host.fixtureStream = "Initial streaming text";
  await settleLayout();
  await expect.poll(() => virtualizer.isScrolling).toBe(false);
  await settleLayout();
  const tail = expectDefined(
    host.querySelector<HTMLElement>(".chat-virtual-row:last-child"),
    "streaming row",
  );
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

it("publishes reader policy and the tail indicator through the pane state", async () => {
  const { host } = await mountPane();
  const state = host.scrollState;
  const updates = vi.spyOn(host, "render");
  const scroll = (scrollTop: number) => {
    const event = new Event("scroll");
    Object.defineProperty(event, "currentTarget", {
      value: { scrollHeight: 2000, clientHeight: 400, scrollTop },
    });
    handleChatScroll(state, event);
  };
  expect(state.chatReadingHistory).toBe(true);
  scroll(1600);
  await settleLayout();
  expect(host.querySelector("output")?.dataset).toMatchObject({
    readingHistory: "false",
    newMessagesBelow: "false",
    followLocked: "false",
    nearBottom: "true",
  });
  expect(updates).not.toHaveBeenCalled();

  updates.mockClear();
  state.chatLastScrollTop = 600;
  lockChatScroll(state);
  scroll(500);
  await settleLayout();
  expect(host.querySelector("output")?.dataset).toMatchObject({
    readingHistory: "true",
    newMessagesBelow: "true",
    followLocked: "true",
    nearBottom: "false",
  });
  expect(updates).not.toHaveBeenCalled();
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
        Number.parseFloat(
          expectDefined(host.querySelector<HTMLElement>(".chat-thread-inner"), "transcript sizer")
            .style.height,
        ),
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
])(
  "consumes the unscaled $boxSizing rect once at scale $scale",
  async ({ scale, boxSizing, width, height }) => {
    const { host, session, viewport, slot } = await mountPane();
    const observed: Array<{ width: number; height: number }> = [];
    const observer = new ResizeObserver(([entry]) => {
      const size = expectDefined(entry?.borderBoxSize[0], "viewport border box");
      observed.push({ width: size.inlineSize, height: size.blockSize });
    });
    observer.observe(viewport, { box: "border-box" });
    const updates = vi.spyOn(host, "render");
    try {
      slot.style.cssText = `box-sizing: ${boxSizing}; width: 620.25px; height: 460.5px; flex: none; padding: 20px 0; border: 3px solid transparent; transform: scale(${scale})`;
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

it.each(["border-box", "content-box"])(
  "syncs the unscaled %s viewport idempotently and publishes its native clamp once",
  async (boxSizing) => {
    const { session, viewport, slot } = await mountPane();
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
    try {
      slot.style.cssText = `box-sizing: ${boxSizing}; width: 620.25px; height: 460.5px; flex: none; padding: 20px 0; transform: scale(0.8)`;
      session.layout.sync();
      expect(viewport.style.width).toBe("620.25px");
      expect(viewport.style.height).toBe(boxSizing === "border-box" ? "460.5px" : "500.5px");
      expect(viewport.scrollTop).toBeLessThan(before);
      expect(resized).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          scrollCorrection: { before, after: viewport.scrollTop },
        }),
      );
      expect(mutations.takeRecords().length).toBeGreaterThan(0);
      session.layout.sync();
      expect(mutations.takeRecords()).toEqual([]);
      expect(resized).toHaveBeenCalledTimes(1);
    } finally {
      mutations.disconnect();
      stop();
    }
  },
);

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
