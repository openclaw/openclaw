/* @vitest-environment jsdom */

import { expectDefined } from "@openclaw/normalization-core";
import { createRoot } from "solid-js";
import { afterEach, beforeEach, expect, it, onTestFinished, vi } from "vitest";
import { createDeferred } from "../../../../../test/helpers/promise.js";
import { flush, waitForSolid } from "../../../test-helpers/solid-settle.ts";
import { projectChatFields } from "../chat-field-projection.ts";
import { makeChatHost } from "../chat-host.test-support.ts";
import { createTestTranscript, stubAnimationFrames } from "../chat-view.test-helpers.ts";
import { handleChatScrollTakeover, saveChatSessionScrollPosition } from "../scroll.ts";
import { SIDEBAR_GEOMETRY_COMMIT_EVENT } from "../sidebar-layout.ts";
import {
  render,
  renderChatThread,
  mountTestTranscript as mountRows,
  numberedContentRows,
  mcpRangeRows,
  stubMcpAppLifecycle,
  TranscriptTestHost,
} from "../test-helpers/chat-transcript-native.tsx";
import { createChatTranscript } from "./chat-transcript-controller.ts";
import { projectChatTranscript } from "./chat-transcript-projection.ts";
import {
  flushDeferredRowPrune,
  installTranscriptDomMocks,
  observedElements,
  resetTranscriptTestDom,
  requireElement,
  resizeObservers,
  threadProps,
  type TestContentRow,
  transcriptDomState,
  transcriptRows,
  transcriptSize,
} from "./chat-transcript.test-support.ts";

customElements.define("scroll-restore-test-host", TranscriptTestHost);

const cleanup: (() => void)[] = [];

async function mountTestTranscript(...args: Parameters<typeof mountRows>) {
  const view = await mountRows(...args);
  cleanup.push(() => view.transcript.dispose());
  return view;
}

function threadFixture(props: ReturnType<typeof threadProps>, transcript = createTestTranscript()) {
  const container = document.body.appendChild(document.createElement("div"));
  cleanup.push(() => transcript.dispose());
  const draw = (next = props) => render(renderChatThread(next, transcript), container);
  return { container, transcript, draw };
}

const messages = (length: number, prefix: string) =>
  Array.from({ length }, (_, index) => ({
    role: index % 2 === 0 ? "user" : "assistant",
    content: `${prefix} ${index}`,
    timestamp: index + 1,
  }));

function geometry(
  element: Element,
  values: Partial<
    Record<"clientHeight" | "scrollHeight" | "offsetHeight", number | (() => number)>
  >,
) {
  for (const [key, value] of Object.entries(values)) {
    Object.defineProperty(element, key, {
      configurable: true,
      ...(typeof value === "function" ? { get: value } : { value }),
    });
  }
}

function emitSize(target: Element, height: number) {
  for (const observer of resizeObservers) {
    observer.emitTarget(target, 800, height);
  }
}

function emitRowSizes(rows: HTMLElement[], height: number) {
  for (const observer of resizeObservers) {
    for (const row of rows) {
      observer.emitTarget(row, 800, height);
    }
  }
}

function expectObservedRows(container: HTMLElement) {
  const scroller = requireElement(container, ".chat-thread");
  const rows = transcriptRows(container);
  expect([scroller, ...rows].every((row) => observedElements.has(row))).toBe(true);
  return { scroller, rows };
}

function applyScroll(element: HTMLElement, options?: ScrollToOptions | number) {
  if (typeof options === "object") {
    element.scrollTop = options.top ?? element.scrollTop;
  }
}

const contentRow = (key: string, content: TestContentRow["content"]): TestContentRow => ({
  kind: "content",
  key,
  content,
});

function renderReadySession(
  transcript: ReturnType<typeof createChatTranscript>,
  key: string,
  rows: TestContentRow[],
  tail?: TestContentRow["content"],
) {
  return transcript.renderSession(`agent:main:${key}`, (session) => {
    session.layout.ready = true;
    return session.render(
      rows,
      (row) => (row.kind === "content" ? row.content : null),
      null,
      false,
      tail,
    );
  });
}

function scroll(element: HTMLElement, top?: number) {
  if (top !== undefined) {
    element.scrollTop = top;
  }
  element.dispatchEvent(new Event("scroll"));
}

beforeEach(installTranscriptDomMocks);
afterEach(() => {
  for (const dispose of cleanup.splice(0).toReversed()) {
    dispose();
  }
  if (vi.isFakeTimers()) {
    vi.clearAllTimers();
    vi.useRealTimers();
  }
  resetTranscriptTestDom();
});

it.each([false, true])("re-observes re-stamped rows (foreign host=%s)", async (foreignHost) => {
  const props = threadProps("pane-measure");
  saveChatSessionScrollPosition(props.paneId, props.sessionKey, {
    scrollTop: 0,
    anchorToEnd: false,
  });
  const transcript = createTestTranscript(props.paneId);
  const chatFace = document.body.appendChild(document.createElement("div"));
  render(renderChatThread(props, transcript), chatFace);
  transcript.start();
  transcript.update();
  await flushDeferredRowPrune();
  const { scroller: chatScroller, rows: chatRows } = expectObservedRows(chatFace);
  expect(chatRows.length).toBeGreaterThanOrEqual(4);
  if (foreignHost) {
    render(null, chatFace);
    transcript.update();
    await flushDeferredRowPrune();
  }
  const dock = document.body.appendChild(document.createElement("div"));
  render(renderChatThread(props, transcript), dock);
  // A foreign Solid host mounts after the pane's last update; attachment must follow the DOM ref.
  if (!foreignHost) {
    transcript.update();
  }
  await flushDeferredRowPrune();
  const { rows: dockRows } = expectObservedRows(dock);
  expect(dockRows).toEqual(chatRows);
  expect(observedElements.has(chatScroller)).toBe(false);
  transcript.dispose();
});

it("updates the visible range on native scroll without a parent render", async () => {
  const flushFrames = stubAnimationFrames();
  const props = threadProps("local-geometry", "agent:main:local-geometry", messages(40, "message"));
  saveChatSessionScrollPosition(props.paneId, props.sessionKey, {
    scrollTop: 0,
    anchorToEnd: false,
  });
  const { container, transcript, draw } = threadFixture(props, createTestTranscript(props.paneId));
  draw();
  transcript.start();
  transcript.update();
  await flushDeferredRowPrune();
  const { scroller, rows } = expectObservedRows(container);
  geometry(scroller, { clientHeight: 600, scrollHeight: 4_000 });
  emitSize(scroller, 600);
  emitRowSizes(rows, 100);
  draw();
  flushFrames();
  await flushDeferredRowPrune();
  expect(container.textContent).toContain("message 0");

  scroll(scroller, 2_400);
  flushFrames();
  await flushDeferredRowPrune();
  expect(container.textContent).not.toContain("message 0");
  expect(Number(transcriptRows(container)[0]?.dataset.index)).toBeGreaterThan(0);
});

it("keeps retained MCP rows and the virtual row model atomic through teardown", async () => {
  const teardownPending = createDeferred();
  transcriptDomState.measuredRowHeight = 180;
  const initialRows = [
    contentRow("app", <mcp-app-view />),
    contentRow("group:tool", <div>tool</div>),
    contentRow("group:reply", <div>reply</div>),
  ];
  const regroupedRows = [
    contentRow("history", <div>history</div>),
    contentRow("group:reply", <div>regrouped</div>),
    contentRow("group:next", <div>next</div>),
  ];
  const { container, renderRows } = await mountTestTranscript("pane-mcp-rows", initialRows);
  emitRowSizes(transcriptRows(container), 180);
  renderRows(initialRows);
  expect(transcriptSize(container)).toBe(540);
  stubMcpAppLifecycle(container, () => teardownPending.promise);

  renderRows(regroupedRows);
  const retainedRows = transcriptRows(container);
  expect(retainedRows.map((row) => row.dataset.virtualRowKey)).toEqual([
    "app",
    "group:tool",
    "group:reply",
  ]);

  // Old-tree resize must still address the old key model during teardown.
  geometry(retainedRows[1]!, { offsetHeight: 40 });
  emitSize(retainedRows[1]!, 40);
  teardownPending.resolve();
  await teardownPending.promise;
  await Promise.resolve();
  renderRows(regroupedRows);
  await flushDeferredRowPrune();
  renderRows(regroupedRows);

  const committedRows = transcriptRows(container);
  expect(committedRows.map((row) => row.dataset.virtualRowKey)).toEqual([
    "history",
    "group:reply",
    "group:next",
  ]);
  emitRowSizes(
    committedRows.filter((row) => row.dataset.virtualRowKey !== "group:reply"),
    180,
  );
  renderRows(regroupedRows);
  // The old tool's 40px delivery must not resize the retained reply key.
  expect(transcriptSize(container)).toBe(540);
});

it.each(["append", "reorder", "focused reorder"] as const)(
  "retains only MCP rows in the next rendered range (%s)",
  async (change) => {
    const focused = change === "focused reorder";
    const initialRows =
      change === "append"
        ? [contentRow("app", <mcp-app-view />), contentRow("reply", <div>reply</div>)]
        : mcpRangeRows(
            focused ? (
              <mcp-app-view>
                <iframe title="Retained application" />
                <button>focus app</button>
              </mcp-app-view>
            ) : (
              <mcp-app-view />
            ),
          );
    const { container, renderRows } = await mountTestTranscript("pane-mcp-range", initialRows);
    const { app, teardown } = stubMcpAppLifecycle(container);
    const frame = app.querySelector("iframe");
    const rowParent = app.parentElement?.parentElement;
    if (focused) {
      expectDefined(frame, "retained application frame");
      expectDefined(rowParent, "retained row parent");
      expectDefined(app.querySelector("button"), "MCP app focus target").dispatchEvent(
        new FocusEvent("focusin", { bubbles: true }),
      );
    }
    renderRows(
      change === "append"
        ? [...initialRows, contentRow("next", <div>next</div>)]
        : [initialRows.at(-1)!, ...initialRows.slice(0, -1)],
    );
    if (change === "reorder") {
      expect(teardown).toHaveBeenCalledOnce();
      expect(app.isConnected).toBe(true);
    } else {
      expect(teardown).not.toHaveBeenCalled();
      expect(container.querySelector("mcp-app-view")).toBe(app);
      if (focused) {
        expect(app.isConnected).toBe(true);
        expect(app.querySelector("iframe")).toBe(frame);
        expect(app.parentElement?.parentElement).toBe(rowParent);
      }
    }
  },
);

it("reconciles an implicit end anchor when committed content has no scroll range", async () => {
  const flushFrames = stubAnimationFrames();
  transcriptDomState.measuredRowHeight = 20;
  const { container, transcript, draw } = threadFixture(
    threadProps("pane-underfill-anchor", "agent:main:underfill", messages(18, "message")),
  );
  draw();
  await Promise.resolve();
  flush();
  const scrollElement = container.querySelector<HTMLElement>(".chat-thread");
  expect(scrollElement).not.toBeNull();
  geometry(scrollElement!, { clientHeight: 600, scrollHeight: 600 });

  transcript.start();
  transcript.scrollToEnd({ source: "auto" });
  transcript.update();
  await Promise.resolve();
  flushFrames();
  for (let commit = 0; commit < 2; commit++) {
    draw();
    await Promise.resolve();
    flush();
  }
  await waitForSolid(() => expect(transcriptRows(container)[0]?.dataset.index).toBe("0"));
  expect(container.textContent).toContain("message 0");
});

it("retains history controls across callback and loading replacements", async () => {
  const props = threadProps("history-controls");
  const { container, transcript, draw: renderThread } = threadFixture(props);
  const first = vi.fn();
  const next = vi.fn();
  const draw = async (loading: boolean, onShowEarlier: () => void) => {
    renderThread({ ...props, historyPagination: { hasMore: true, loading, onShowEarlier } });
    transcript.update();
    await flushDeferredRowPrune();
  };
  transcript.start();
  await draw(false, first);
  const button = container.querySelector<HTMLButtonElement>(".chat-history-boundary__action")!;
  expect(button).not.toBeNull();
  button.click();
  expect(first).toHaveBeenCalledOnce();

  await draw(true, next);
  expect(container.querySelector(".chat-history-boundary__action")).toBe(button);
  expect(button.getAttribute("aria-disabled")).toBe("true");
  expect(button).toMatchObject({ textContent: expect.stringContaining("Loading") });

  await draw(false, next);
  expect(container.querySelector(".chat-history-boundary__action")).toBe(button);
  button.click();
  expect(next).toHaveBeenCalledOnce();
  expect(first).toHaveBeenCalledOnce();
});

it.each([true, false])("settles a non-overflowing restore (initially loading=%s)", (loading) => {
  const flushFrames = stubAnimationFrames();
  if (!loading) {
    vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => undefined);
  }
  const props = loading
    ? threadProps("pane-loading-scroll", "agent:main:session-a", [])
    : threadProps("pane-short-scroll", "agent:main:session-a");
  const { container, transcript, draw } = threadFixture(props);
  const renderWindow = (isLoading: boolean) => {
    draw({ ...props, loading: isLoading });
    transcript.update();
    flush();
  };
  renderWindow(loading);
  if (!loading) {
    geometry(container.querySelector(".chat-thread")!, { clientHeight: 600 });
  }
  transcript.start();
  transcript.update();
  const onSettled = vi.fn();
  transcript.scrollToOffset(420, onSettled);
  renderWindow(loading);
  for (let update = 0; update < (loading ? 1 : 100); update++) {
    transcript.update();
  }
  expect(onSettled).not.toHaveBeenCalled();
  if (loading) {
    renderWindow(false);
  } else {
    for (let frame = 0; frame <= 60; frame++) {
      transcript.update();
      flushFrames();
    }
  }
  expect(onSettled).toHaveBeenCalledWith({ scrollTop: 0, anchorToEnd: true });
});

it("retries a growing restore without pane commits and renders the settled reader", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const flushFrame = stubAnimationFrames();
  transcriptDomState.measuredRowHeight = 120;
  const host = new TranscriptTestHost();
  cleanup.push(() => host.remove());
  const container = host.transcriptRoot;
  const policy = makeChatHost({ chatScrollElement: () => container });
  const readerStatus = createRoot((dispose) => {
    onTestFinished(dispose);
    projectChatFields(policy, ["chatReadingHistory"]);
    return <output>{policy.chatReadingHistory ? "Reading history" : "Following"}</output>;
  });
  const onReaderScroll = vi.fn((towardEnd?: boolean) =>
    handleChatScrollTakeover(policy, towardEnd),
  );
  const transcript = (host.transcript = createChatTranscript(() => "restore-retry", {
    canFollowEnd: () => !policy.chatFollowLocked,
    onReaderScroll,
  }));
  const rows = numberedContentRows(40);
  let scrollHeight = 600;
  geometry(container, { clientHeight: 600, scrollHeight: () => scrollHeight });
  container.scrollTo = (options?: ScrollToOptions | number) => applyScroll(container, options);
  host.renderTranscript = () => renderReadySession(transcript, "restore-retry", rows, readerStatus);
  document.body.append(host);
  await host.settleUpdates();
  for (let frame = 0; frame < 2; frame++) {
    flushFrame();
    await host.settleUpdates();
  }
  const onSettled = vi.fn();
  transcript.scrollToOffset(2420, onSettled);
  await host.settleUpdates();
  const initialCommits = host.committedRenders;
  for (const height of [600, 600, 600, 720, 720, 720, 720, 900, 900, 900, 900]) {
    scrollHeight = height;
    flushFrame();
    await host.settleUpdates();
    expect(onSettled).not.toHaveBeenCalled();
  }
  scrollHeight = 4800;
  flushFrame();
  await host.settleUpdates();
  expect(onSettled).toHaveBeenCalledExactlyOnceWith({ scrollTop: 2420, anchorToEnd: false });
  expect(container.scrollTop).toBe(2420);
  expect(container.querySelector("output")?.textContent).toBe("Reading history");
  expect.soft(host.committedRenders - initialCommits).toBe(0);

  // jsdom does not emit native scroll events for scrollTop writes. Deliver the browser read-back.
  scroll(container);
  await host.settleUpdates();
  expect(container.querySelector('[data-virtual-row-key="row:20"]')?.textContent?.trim()).toBe(
    "row 20",
  );
  expect(container.querySelector('[data-virtual-row-key="row:0"]')).toBeNull();
  expect(onReaderScroll).toHaveBeenLastCalledWith();
});

it.each(["measurable", "growing", "short"] as const)(
  "applies a saved offset once when the %s range settles",
  async (range) => {
    const flushFrames = stubAnimationFrames();
    const rows = numberedContentRows(12);
    const { container, transcript, renderRows } = await mountTestTranscript(
      `${range}-restore`,
      rows,
    );
    let scrollHeight = range === "measurable" ? 2000 : 900;
    geometry(container, { clientHeight: 600, scrollHeight: () => scrollHeight });
    const scrollTo = vi.fn((options?: ScrollToOptions | number) => applyScroll(container, options));
    container.scrollTo = scrollTo;
    const callsTo = (...tops: number[]) =>
      scrollTo.mock.calls.filter(
        ([options]) =>
          typeof options === "object" && options.top !== undefined && tops.includes(options.top),
      );
    const onSettled = vi.fn();
    const frames = (count: number) => {
      for (let frame = 0; frame < count; frame++) {
        renderRows(rows);
        flushFrames();
      }
    };
    transcript.scrollToOffset(420, range === "measurable" ? undefined : onSettled);
    if (range === "growing") {
      for (let update = 0; update < 20; update++) {
        transcript.update();
      }
      expect(onSettled).not.toHaveBeenCalled();
      frames(4);
      expect(callsTo(300, 420)).toHaveLength(0);
      expect(onSettled).not.toHaveBeenCalled();
      scrollHeight = 2000;
      frames(1);
    } else if (range === "short") {
      frames(10);
      scrollHeight = 600;
      renderRows(rows);
      scrollHeight = 900;
      frames(4);
      expect(onSettled).not.toHaveBeenCalled();
      frames(14);
    } else {
      frames(4);
    }
    if (range === "short") {
      expect(onSettled).toHaveBeenCalledExactlyOnceWith({ scrollTop: 300, anchorToEnd: true });
    } else {
      expect(container.scrollTop).toBe(420);
      expect(callsTo(420)).toHaveLength(1);
      if (range === "growing") {
        expect(onSettled).toHaveBeenCalledWith({ scrollTop: 420, anchorToEnd: false });
      }
    }
  },
);

it.each([
  { behavior: "auto", resizeBefore: true, deltaY: -100, observerLate: false },
  { behavior: "smooth", resizeBefore: true, deltaY: -100, observerLate: false },
  { behavior: "smooth", resizeBefore: false, deltaY: -100, observerLate: false },
  { behavior: "smooth", resizeBefore: true, deltaY: 100, observerLate: false },
  { behavior: "smooth", resizeBefore: true, deltaY: -100, observerLate: true },
  { behavior: "smooth", resizeBefore: true, deltaY: -100_000, observerLate: "after-wheel" },
] as const)(
  "recovers $behavior measurements: resize first=$resizeBefore, wheel=$deltaY, late=$observerLate",
  async ({ behavior, resizeBefore, deltaY, observerLate }) => {
    const flushFrames = stubAnimationFrames();
    transcriptDomState.measuredRowHeight = 120;
    const rows = numberedContentRows(40);
    const { container, renderRows, transcript } = await mountTestTranscript(
      `pane-${behavior}-${resizeBefore}-${deltaY}-${observerLate}-resize`,
      rows,
    );
    container.scrollTo = (options?: ScrollToOptions | number) => {
      if (typeof options === "object" && options.behavior !== "smooth") {
        container.scrollTop = options.top ?? container.scrollTop;
      }
    };
    geometry(container, { clientHeight: 600, scrollHeight: 4000 });
    emitSize(container, 600);
    transcript.scrollToOffset(0);
    renderRows(rows);
    scroll(container);
    renderRows(rows);
    await flushDeferredRowPrune();
    flushFrames();
    renderRows(rows);
    const first = requireElement(container, '[data-index="0"]');
    const initialSize = transcriptSize(container);
    const resize = () => {
      geometry(first, { offsetHeight: 200 });
      emitSize(first, 200);
    };
    transcript.scrollToEnd({ behavior });
    if (observerLate) {
      scroll(container, 135);
    }
    if (resizeBefore) {
      resize();
    }
    if (observerLate === true) {
      // Native movement can precede wheel delivery and the offset observer.
      container.scrollTop = 0;
    }
    container.dispatchEvent(new WheelEvent("wheel", { deltaY }));
    if (observerLate === "after-wheel") {
      // Native default action follows wheel delivery but precedes the offset observer.
      container.scrollTop = 0;
    }
    if (!observerLate) {
      scroll(container, 0);
    }
    if (!resizeBefore) {
      resize();
    }
    flushFrames();
    renderRows(rows);
    expect(transcriptSize(container)).toBe(initialSize + 80);
    expect.soft(container.scrollTop).toBe(0);
    if (observerLate) {
      scroll(container);
      flushFrames();
      renderRows(rows);
      expect(container.scrollTop).toBe(0);
    }
  },
);

it.each([0, 252])(
  "retires an end index without losing newer native movement (%s px)",
  async (nativeGrowth) => {
    const flushFrames = stubAnimationFrames();
    // Match estimates from the start so row measurement adds no unrelated compensation.
    transcriptDomState.measuredRowHeight = 120;
    const transcript = createChatTranscript(() => `retired-end-index-${nativeGrowth}`, {
      canFollowEnd: () => false,
    });
    const content = numberedContentRows(12);
    const typing = contentRow("presence:typing", <div>Typing</div>);
    const { container, renderRows } = await mountTestTranscript(
      "retired-end-index",
      [...content, typing],
      transcript,
    );
    let extraExtent = 0;
    geometry(container, {
      clientHeight: 600,
      scrollHeight: () => transcriptSize(container) + extraExtent,
    });
    container.scrollTo = vi.fn((options?: ScrollToOptions | number, y?: number) => {
      container.scrollTop = typeof options === "number" ? (y ?? 0) : (options?.top ?? 0);
    });
    const typingRow = requireElement(container, '[data-virtual-row-key="presence:typing"]');
    geometry(typingRow, { offsetHeight: 30 });
    for (const observer of resizeObservers) {
      observer.emitTarget(container, 800, 600);
      observer.emitTarget(typingRow, 800, 30);
    }
    renderRows([...content, typing]);
    flushFrames();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    transcript.scrollToEnd({ behavior: "auto" });
    scroll(container);
    if (nativeGrowth > 0) {
      extraExtent = nativeGrowth;
      transcript.scrollToEnd({ behavior: "auto" });
      // Its native scroll event has not arrived when the earlier idle callback fires.
    }
    const before = container.scrollTop;
    // Native idle can beat the queued frame; they are separate schedulers.
    vi.advanceTimersByTime(150);
    expect(container.scrollTop, "stale idle must not restore its old offset").toBe(before);
    transcript.cancelScroll();
    const next: TestContentRow[] = [...content, contentRow("peer", <div>Peer</div>), typing];
    renderRows(next);
    await Promise.resolve();
    renderRows(next);
    flushFrames();
    expect(container.scrollTop, "retired index must not follow the peer replacing typing").toBe(
      before,
    );
  },
);

it("keeps smooth latest through settlement and idle until the target", async () => {
  const flushFrames = stubAnimationFrames();
  transcriptDomState.measuredRowHeight = 120;
  const rows = numberedContentRows(40);
  const { container, transcript } = await mountTestTranscript("idle-latest", rows);
  geometry(container, { clientHeight: 600, scrollHeight: 4800 });
  const scrollTo = vi.fn();
  container.scrollTo = scrollTo;
  // Keep mount-time reconciliation on the same frame queue while faking native idle.
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  scroll(container, 1000);
  transcript.update();
  transcript.scrollToEnd({ behavior: "smooth" });
  await Promise.resolve();
  expect(scrollTo).toHaveBeenLastCalledWith({ top: 4200, behavior: "smooth" });
  scroll(container, 1500);
  geometry(container, { scrollHeight: 4900 });
  flushFrames();
  expect(scrollTo).toHaveBeenLastCalledWith({ top: 4300, behavior: "smooth" });
  scrollTo.mockClear();

  vi.advanceTimersByTime(150);
  expect(transcript.isProgrammaticScroll).toBe(true);
  expect(scrollTo).not.toHaveBeenCalled();

  // The 8px UI-follow boundary does not complete the native end command.
  scroll(container, 4296);
  vi.advanceTimersByTime(150);
  expect(transcript.isProgrammaticScroll).toBe(false);
  expect(scrollTo).not.toHaveBeenCalled();

  scroll(container, 4300);
  vi.advanceTimersByTime(150);
  expect(scrollTo).toHaveBeenCalledExactlyOnceWith({ top: 4300, behavior: "instant" });
  expect(transcript.isProgrammaticScroll).toBe(false);
});

it.each([false, true])(
  "keeps disclosure anchoring through geometry commit unless interrupted=%s",
  async (interrupt) => {
    const geometryEventTarget = document.body.appendChild(document.createElement("div"));
    const transcript = createChatTranscript(() => `disclosure-${interrupt}`, {
      geometryEventTarget,
    });
    const rows: TestContentRow[] = [
      contentRow("disclosure", <button aria-expanded="false">Expand</button>),
    ];
    const { container } = await mountTestTranscript(`disclosure-${interrupt}`, rows, transcript);
    geometryEventTarget.append(container);
    container.className = "sidebar-region__right-runtime";
    const row = transcriptRows(container)[0]!;
    let rowTop = 100;
    row.getBoundingClientRect = () => new DOMRect(0, rowTop, 800, 100);
    container.scrollTop = 300;
    container.querySelector("button")!.click();
    rowTop = 160;
    transcript.update();
    expect(container.scrollTop).toBe(300);
    if (interrupt) {
      container.dispatchEvent(new WheelEvent("wheel", { deltaY: -100 }));
      container.scrollTop = 200;
      rowTop = 260;
      scroll(container);
    }
    container.dispatchEvent(
      new CustomEvent(SIDEBAR_GEOMETRY_COMMIT_EVENT, {
        bubbles: true,
        detail: { widthChanged: false },
      }),
    );
    expect(container.scrollTop).toBe(interrupt ? 200 : 360);
  },
);

it("preserves saved reader restoration when initial rows include typing", async () => {
  const flushFrames = stubAnimationFrames();
  const paneId = "restore-initial-typing";
  saveChatSessionScrollPosition(paneId, `agent:main:${paneId}`, {
    scrollTop: 420,
    anchorToEnd: false,
  });
  const rows: TestContentRow[] = [
    contentRow("history", <div>History</div>),
    contentRow("presence:typing", <div>Typing</div>),
  ];
  const { container, renderRows } = await mountTestTranscript(paneId, rows);
  // Initial unmeasurable DOM and automatic typing follow must preserve the saved offset.
  geometry(container, { clientHeight: 600, scrollHeight: 2000 });
  renderRows(rows);
  for (let frame = 0; frame < 3; frame += 1) {
    await Promise.resolve();
    flushFrames();
    renderRows(rows);
  }
  expect(container.scrollTop).toBe(420);
});

it("keeps late reactions when geometry replays an older projection", async () => {
  const sessionKey = "agent:main:reaction-replay";
  const props = threadProps("reaction-replay", sessionKey, [
    {
      role: "assistant",
      content: "A retained reply",
      timestamp: 1_000,
      __openclaw: { id: "reply" },
    },
  ]);
  const transcript = createTestTranscript();
  const container = document.body.appendChild(document.createElement("div"));
  transcript.start();
  onTestFinished(() => {
    render(null, container);
    transcript.dispose();
    container.remove();
  });
  const project = (messageReactions: NonNullable<typeof props.messageReactions>) =>
    transcript.renderSession(sessionKey, (session) =>
      projectChatTranscript({ ...props, messageReactions, onReact: vi.fn() }, session),
    );
  const before = project(new Map());
  render(before.renderRows(), container);
  await flushDeferredRowPrune();
  const bubble = requireElement(container, ".chat-bubble");
  const after = project(
    new Map([["reply", [{ emoji: "👍", count: 1, identities: [{ id: "peer", label: "Peer" }] }]]]),
  );

  // A queued geometry pass can replay the accepted snapshot before the new one commits.
  render(before.renderRows(), container);
  flush();
  render(after.renderRows(), container);
  flush();

  expect(requireElement(container, ".chat-message-reactions").textContent).toContain("👍");
  expect(requireElement(container, ".chat-bubble")).toBe(bubble);
});
