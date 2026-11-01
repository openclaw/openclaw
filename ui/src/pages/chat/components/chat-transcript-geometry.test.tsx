/* @vitest-environment jsdom */

import { expectDefined } from "@openclaw/normalization-core";
import { Virtualizer } from "@tanstack/virtual-core";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  handleMarkdownCodeBlockClick,
  renderMarkdownCodeBlock,
} from "../../../components/markdown-code-blocks.ts";
import { flush } from "../../../test-helpers/solid-settle.ts";
import { createInitializationContext } from "../chat-application-context.test-support.ts";
import { createTestTranscript, stubAnimationFrames } from "../chat-view.test-helpers.ts";
import { saveChatSessionScrollPosition } from "../scroll.ts";
import {
  cacheChatSessionSnapshot,
  createChatWidgetLayout,
  observeChatCache,
  type ChatMessageCache,
  type ChatWidgetLayout,
} from "../session-message-cache.ts";
import { SIDEBAR_GEOMETRY_COMMIT_EVENT } from "../sidebar-layout.ts";
import {
  render,
  renderChatThread,
  mountTestTranscript,
} from "../test-helpers/chat-transcript-native.tsx";
import { RawOutputToggle } from "./chat-tool-content.solid.tsx";
import { createChatTranscript } from "./chat-transcript-controller.ts";
import {
  contentRows,
  emitTranscriptResize,
  setTranscriptViewport,
  transcriptContainer,
} from "./chat-transcript-fixture.test-support.tsx";
import { readConnectedTranscriptRows } from "./chat-transcript-geometry.ts";
import { TranscriptLayoutOwner } from "./chat-transcript-layout-owner.ts";
import { TranscriptRowRefs } from "./chat-transcript-row-refs.ts";
import {
  flushDeferredRowPrune,
  installTranscriptDomMocks,
  resetTranscriptTestDom,
  requireElement,
  resizeObservers,
  threadProps,
  transcriptDomState,
  transcriptRows,
  transcriptSize,
} from "./chat-transcript.test-support.ts";

function measureRows(container: HTMLElement, height: number) {
  for (const row of transcriptRows(container)) {
    emitTranscriptResize(row, 800, height);
  }
}

function railState(viewport: HTMLElement) {
  return {
    gutter: viewport.hasAttribute("data-position-rail-gutter"),
    height: viewport.style.getPropertyValue("--chat-position-rail-viewport-height"),
    width: viewport.style.getPropertyValue("--chat-transcript-column-width"),
  };
}

beforeEach(installTranscriptDomMocks);
afterEach(resetTranscriptTestDom);

it("reserves only the matching width and appearance, including text scale, width policy and recovery", () => {
  const context = createInitializationContext();
  const settings = {
    ...context.theme.settings,
    textScale: 100 as const,
    chatMessageMaxWidth: "48rem",
  };
  const theme = { ...context.theme, settings, resolvedMode: "light" as const };
  let cachedKey: string | undefined;
  const widgetLayout: ChatWidgetLayout = {
    read: (key) => {
      cachedKey ??= key;
      return key === cachedKey ? 300 : undefined;
    },
    readRows: () => undefined,
    write: vi.fn(),
    writeRows: vi.fn(),
    invalidateRow: vi.fn(),
  };
  const props = threadProps("footprint-appearance", "agent:main:footprint", [], {
    widgetLayout,
    applicationContext: { ...context, theme },
  });
  const layout = new TranscriptLayoutOwner(() => {});
  layout.rows = [{ key: "notice", revision: "notice-v1" }];
  layout.rowWidth = 768;
  layout.paneWidth = 1100;
  layout.rowGutter = 166;
  const reserve = (version = 0) => {
    layout.configureRows(props, "gutter", version !== 0);
    return layout.rowMinimum(0);
  };
  expect(reserve()).toBe(300);
  for (const patch of [{ textScale: 90 as const }, { chatMessageMaxWidth: undefined }]) {
    props.applicationContext = {
      ...context,
      theme: { ...theme, settings: { ...settings, ...patch } },
    };
    expect(reserve()).toBe(0);
  }
  props.applicationContext = { ...context, theme: { ...theme, resolvedMode: "dark" } };
  expect(reserve()).toBe(0);
  props.applicationContext = { ...context, theme };
  expect(reserve(1)).toBe(0);
  expect(reserve()).toBe(300);
  layout.rows = [{ key: "notice", revision: "notice-v2" }];
  expect(reserve()).toBe(0);
  layout.rows = [{ key: "notice", revision: "notice-v1" }];
  layout.rowWidth = 400;
  expect(reserve()).toBe(0);
  layout.rowWidth = 0;
  expect(reserve()).toBe(0);
  layout.rowWidth = 768;
  expect(reserve()).toBe(300);
  layout.paneWidth = 1300;
  expect(reserve()).toBe(0);
  layout.paneWidth = 1100;
  layout.rowGutter = 68;
  expect(reserve()).toBe(0);
  layout.rowGutter = 166;
  layout.paneWidth = 0;
  expect(reserve()).toBe(0);
  layout.paneWidth = 1100;
  expect(reserve()).toBe(300);
  const viewportHeight = window.innerHeight;
  vi.stubGlobal("innerHeight", viewportHeight - 200);
  expect(reserve()).toBe(0);
  vi.stubGlobal("innerHeight", viewportHeight);
  expect(reserve()).toBe(300);
  // A repeated expansion counter cannot admit a footprint from another recovered message.
  cachedKey = undefined;
  expect(reserve(2)).toBe(0);
});

it.each(["chat-bubble-activity", "", "code-block-expand", "code-block-wrap", "raw-output"])(
  "batches restorable footprints without persisting local disclosures (%s)",
  (control) => {
    const frames: FrameRequestCallback[] = [];
    const idle = new Map<number, IdleRequestCallback>();
    let nextIdle = 0;
    vi.stubGlobal(
      "requestAnimationFrame",
      vi.fn((callback: FrameRequestCallback) => frames.push(callback)),
    );
    vi.stubGlobal("requestIdleCallback", (callback: IdleRequestCallback) => {
      idle.set(++nextIdle, callback);
      return nextIdle;
    });
    vi.stubGlobal("cancelIdleCallback", (id: number) => idle.delete(id));
    const takeIdle = () => {
      const [id, callback] = idle.entries().next().value!;
      idle.delete(id);
      return () => callback({ didTimeout: false, timeRemaining: () => 50 });
    };
    const container = transcriptContainer();
    const code = control.startsWith("code-block-");
    const content = code
      ? renderMarkdownCodeBlock(
          control === "code-block-wrap"
            ? `const value = "${"synthetic code ".repeat(60)}";`
            : "const value = 1;\n".repeat(40),
          "ts",
          {
            codeBlockInteraction: "interactive",
          },
          { highlight: false },
        )
      : `<details class="${control}"><summary>Details</summary>Synthetic details</details>`;
    container.innerHTML = `<div data-index="0" data-virtual-row-key="row">${content}</div>`;
    const row = container.firstElementChild as HTMLElement;
    if (control === "raw-output") {
      render(<RawOutputToggle text={"Synthetic raw output\n".repeat(40)} />, row);
      flush();
    }
    const host = { assistantAgentId: "main" };
    const target = { sessionKey: "agent:main:footprints" };
    const cache: ChatMessageCache = new Map();
    cacheChatSessionSnapshot(cache, host, target, {
      messages: [],
      sessionId: "one",
      pagination: { hasMore: false },
    });
    const write = vi.fn();
    observeChatCache(cache, { write, delete: vi.fn() });
    const layout = new TranscriptLayoutOwner(() => {});
    layout.configureRows(
      threadProps("footprint-idle", target.sessionKey, [], {
        widgetLayout: createChatWidgetLayout()(cache, host, target),
      }),
      "gutter",
      false,
    );
    layout.rowWidth = 768;
    layout.paneWidth = 1100;
    layout.rows = [{ key: "row", revision: "one" }];
    layout.connect(container);
    const virtualizer = new Virtualizer<HTMLDivElement, HTMLElement>({
      count: 1,
      estimateSize: () => 120,
      getItemKey: () => "row",
      getScrollElement: () => container,
      measureElement: layout.measureRow,
      observeElementRect: (_, callback) => {
        callback({ width: 768, height: 600 });
      },
      observeElementOffset: (_, callback) => {
        callback(0, false);
      },
      scrollToFn: () => {},
    });
    // eslint-disable-next-line no-underscore-dangle -- Native adapter lifecycle installs row observers.
    const dispose = virtualizer._didMount();
    // eslint-disable-next-line no-underscore-dangle -- Bind the native viewport before measuring.
    virtualizer._willUpdate();
    try {
      virtualizer.measureElement(row);
      emitTranscriptResize(row, 768, 100);
      expect(write).not.toHaveBeenCalled();
      layout.persistRows(virtualizer, false);
      layout.persistRows(virtualizer, false);
      expect(frames).toHaveLength(1);
      frames.shift()!(0);
      expect(write).not.toHaveBeenCalled();
      takeIdle()();
      expect(write).toHaveBeenCalledTimes(1);
      expect(Object.values(write.mock.calls[0]![1].widgetHeights)).toEqual([100]);
      const disclosure = requireElement(
        row,
        control === "raw-output"
          ? ".chat-tool-card__raw-toggle"
          : code
            ? ".code-block-wrapper"
            : "details",
      );
      if (control === "raw-output") {
        disclosure.click();
        flush();
        expect(disclosure.getAttribute("aria-expanded")).toBe("true");
      } else if (code) {
        row.addEventListener("click", handleMarkdownCodeBlockClick);
        requireElement(row, `.${control}`).click();
      } else if (disclosure instanceof HTMLDetailsElement) {
        disclosure.open = true;
      }
      emitTranscriptResize(row, 768, 300);
      layout.persistRows(virtualizer, false);
      frames.shift()!(0);
      takeIdle()();
      expect(write).toHaveBeenCalledTimes(1);
      if (control === "raw-output") {
        disclosure.click();
        flush();
      } else if (disclosure instanceof HTMLDetailsElement) {
        disclosure.open = false;
      }
      disclosure.classList.remove("is-expanded", "is-wrapped");
      emitTranscriptResize(row, 768, 100);
      const savedKey = Object.keys(write.mock.calls[0]![1].widgetHeights)[0]!;
      expect(createChatWidgetLayout()(cache, host, target).read(savedKey)).toBe(100);
      layout.persistRows(virtualizer, false);
      frames.shift()!(0);
      const obsolete = takeIdle();
      layout.disconnect();
      obsolete();
      expect(write).toHaveBeenCalledTimes(1);
    } finally {
      if (control === "raw-output") {
        render(null, row);
      }
      layout.disconnect();
      dispose();
    }
  },
);

it("measures newly committed rows before observer registration using fractional layout height", () => {
  const container = transcriptContainer();
  container.innerHTML =
    '<div class="chat-virtual-row" data-index="0" data-virtual-row-key="fractional" style="height: 100.375px"></div>';
  const row = requireElement(container, ".chat-virtual-row");
  vi.spyOn(row, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, 400, 50.1875));
  const virtualizer = new Virtualizer<HTMLDivElement, HTMLElement>({
    count: 1,
    estimateSize: () => 100,
    getScrollElement: () => container,
    getItemKey: () => "fractional",
    measureElement: () => 100,
    observeElementRect: (_, callback) => {
      callback({ width: 800, height: 600 });
    },
    observeElementOffset: (_, callback) => {
      callback(0, false);
    },
    scrollToFn: (offset) => {
      container.scrollTop = offset;
    },
  });
  // eslint-disable-next-line no-underscore-dangle -- TanStack requires adapter mounting to install lifecycle cleanup.
  const dispose = virtualizer._didMount();
  // eslint-disable-next-line no-underscore-dangle -- TanStack requires adapter updates to bind observed elements.
  virtualizer._willUpdate();
  virtualizer.getVirtualItems();
  const rowRefs = new TranscriptRowRefs(virtualizer, {
    isCurrentRow: () => true,
    beforeMeasure: () => {},
    onMount: () => {},
  });
  try {
    rowRefs.forKey("fractional")(row);
    const commit = readConnectedTranscriptRows(container, virtualizer, rowRefs.elements);
    expect(virtualizer.elementsCache.size).toBe(0);
    expect(virtualizer.itemSizeCache.has("fractional")).toBe(false);
    expect([commit?.(), virtualizer.itemSizeCache.get("fractional")]).toEqual([true, 100.375]);
    expect(readConnectedTranscriptRows(container, virtualizer, rowRefs.elements)?.()).toBe(false);
  } finally {
    rowRefs.clear();
    dispose();
  }
});

it("keeps fractional observer sizes as the sole skipped-row sizing input", async () => {
  saveChatSessionScrollPosition("fractional-rows", "agent:main:fractional-rows", {
    scrollTop: 0,
    anchorToEnd: false,
  });
  const rows = contentRows(4, "fractional:", "row");
  const { container, transcript, renderRows } = await mountTestTranscript("fractional-rows", rows);
  try {
    measureRows(container, 100.375);
    await flushDeferredRowPrune();
    renderRows(rows);
    expect(transcriptSize(container)).toBe(401.5);
    for (const row of transcriptRows(container)) {
      expect(row.style.containIntrinsicBlockSize).toBe("100.375px");
    }
  } finally {
    transcript.dispose();
  }
});

it.each([false, true])(
  "coalesces end geometry across commits and retires disconnected work=%s",
  async (disconnect) => {
    const flushFrames = stubAnimationFrames();
    transcriptDomState.measuredRowHeight = 1200;
    const rows = contentRows(1, "reply", "Reply");
    const { container, transcript, renderRows } = await mountTestTranscript("coalesced-end", rows);
    try {
      setTranscriptViewport(container, 1200);
      // Native scrolling clamps without invoking the JavaScript geometry getter under test.
      container.scrollTo = (options?: ScrollToOptions | number) => {
        if (typeof options === "object") {
          container.scrollTop = Math.max(0, Math.min(options.top ?? container.scrollTop, 600));
        }
      };
      container.scrollTop = 600;
      // JSDOM does not emit the browser's scroll read-back that settles initial compensation.
      container.dispatchEvent(new Event("scroll"));
      flushFrames();
      renderRows(rows);
      flushFrames();
      const readHeight = vi.fn(() => 1200);
      Object.defineProperty(container, "scrollHeight", {
        configurable: true,
        get: readHeight,
      });
      for (let index = 0; index < 4; index++) {
        renderRows(rows);
      }
      flushFrames();
      expect(readHeight).not.toHaveBeenCalled();

      const row = requireElement(container, ".chat-virtual-row");
      for (let index = 0; index < 4; index++) {
        emitTranscriptResize(row, 800, 1240 + index);
        renderRows(rows);
      }
      expect(readHeight).not.toHaveBeenCalled();
      if (disconnect) {
        transcript.dispose();
      }
      flushFrames();
      await flushDeferredRowPrune();
      flushFrames();
      expect(readHeight).toHaveBeenCalledTimes(disconnect ? 0 : 1);
    } finally {
      transcript.dispose();
    }
  },
);

it("updates rail geometry for size changes without measuring streamed content or retired transcripts", async () => {
  const flushFrames = stubAnimationFrames();
  const transcript = createTestTranscript();
  const region = transcriptContainer();
  region.className = "chat-main__conversation";
  let regionHeight = 600;
  let gutter = 100;
  let innerWidth = 768;
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockImplementation(function (
    this: HTMLElement,
  ) {
    return this.classList.contains("chat-thread-inner") ? innerWidth : 1200;
  });
  const readInnerBounds = vi.fn(() => new DOMRect(gutter, 0, innerWidth, 1200));
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
    return this.classList.contains("chat-thread-inner")
      ? readInnerBounds()
      : new DOMRect(0, 0, 1200, 600);
  });
  Object.defineProperty(region, "clientHeight", { get: () => regionHeight });
  const props = {
    ...threadProps("rail-geometry"),
    runActive: true,
    stream: "Live start",
    streamStartedAt: 1000,
  };
  const renderTranscript = () => {
    render(renderChatThread(props, transcript), region);
    transcript.update();
    flush();
  };
  const remount = async () => {
    transcript.start();
    renderTranscript();
    await flushDeferredRowPrune();
    return expectDefined(transcript.scrollElement, "remounted rail viewport");
  };
  const resizeRail = (viewport: HTMLElement) => {
    emitTranscriptResize(requireElement(viewport, ".chat-virtual-sizer"), innerWidth, 0);
    emitTranscriptResize(region, 1200, regionHeight);
    flushFrames();
  };
  const disconnect = () => {
    transcript.dispose();
    render(null, region);
  };
  try {
    renderTranscript();
    transcript.start();
    transcript.update();
    flush();
    await flushDeferredRowPrune();
    const viewport = expectDefined(transcript.scrollElement, "rail viewport");
    const inner = requireElement(viewport, ".chat-thread-inner");
    const column = requireElement(inner, ".chat-virtual-sizer");
    resizeRail(viewport);
    expect(railState(viewport)).toEqual({ gutter: true, height: "600px", width: "768px" });
    readInnerBounds.mockClear();

    for (const [index, text] of ["one", "two", "three"].entries()) {
      props.stream = `Live ${text}`;
      renderTranscript();
      emitTranscriptResize(inner, innerWidth, 1300 + index * 100);
      flushFrames();
      expect(viewport.textContent).toContain(`Live ${text}`);
    }
    expect(readInnerBounds).not.toHaveBeenCalled();

    gutter = 20;
    innerWidth = 1160;
    emitTranscriptResize(column, innerWidth, 0);
    flushFrames();
    expect(railState(viewport)).toMatchObject({ gutter: false, width: "1160px" });
    expect(readInnerBounds).toHaveBeenCalledOnce();
    readInnerBounds.mockClear();

    regionHeight = 720;
    emitTranscriptResize(region, 1200, regionHeight);
    flushFrames();
    expect(railState(viewport)).toMatchObject({ height: "720px" });
    expect(readInnerBounds).toHaveBeenCalledOnce();

    disconnect();
    await flushDeferredRowPrune();
    const replacementViewport = await remount();
    const replacement = requireElement(replacementViewport, ".chat-thread-inner");
    expect(replacement).not.toBe(inner);
    gutter = 100;
    innerWidth = 768;
    resizeRail(replacementViewport);
    expect(railState(replacementViewport)).toMatchObject({ gutter: true, width: "768px" });
    readInnerBounds.mockClear();
    emitTranscriptResize(inner, 400, 400);
    flushFrames();
    expect(readInnerBounds).not.toHaveBeenCalled();

    emitTranscriptResize(replacement, 700, 400);
    disconnect();
    flushFrames();
    expect(readInnerBounds).not.toHaveBeenCalled();
    vi.mocked(requestAnimationFrame).mockClear();
    emitTranscriptResize(replacement, 600, 400);
    emitTranscriptResize(region, 1200, 800);
    expect(requestAnimationFrame).not.toHaveBeenCalled();

    const restored = await remount();
    emitTranscriptResize(region, 1200, regionHeight);
    flushFrames();
    expect(railState(restored)).toMatchObject({ gutter: true, height: "720px" });
  } finally {
    disconnect();
  }
});

it("remeasures panes from a plain owner geometry commit while preserving hidden rows", async () => {
  const geometryEventTarget = transcriptContainer();
  const viewportChanged = vi.fn();
  const makePane = (pane: string, onViewportResize?: () => void) => {
    const id = `pane-geometry-${pane}`;
    const session = `agent:main:geometry-${pane}`;
    saveChatSessionScrollPosition(id, session, { scrollTop: 0, anchorToEnd: false });
    const transcript = createChatTranscript(() => id, { geometryEventTarget, onViewportResize });
    const panel = geometryEventTarget.appendChild(document.createElement("div"));
    const props = threadProps(id, session);
    return {
      transcript,
      panel,
      render: () => render(renderChatThread(props, transcript), panel),
    };
  };
  // Detail precedes main in DOM order, but must not steal its observation or scrolling.
  const detailPane = makePane("detail");
  const mainPane = makePane("main", viewportChanged);
  const { transcript: detail, panel: detailPanel } = detailPane;
  const { transcript: main, panel: mainPanel } = mainPane;
  const renderTranscripts = () => {
    mainPane.render();
    detailPane.render();
    main.update();
    detail.update();
    flush();
  };

  renderTranscripts();
  main.start();
  detail.start();
  await flushDeferredRowPrune();
  renderTranscripts();
  measureRows(mainPanel, 100);
  renderTranscripts();
  await flushDeferredRowPrune();
  expect(transcriptSize(mainPanel)).toBe(400);

  const mainScroller = requireElement(mainPanel, ".chat-thread");
  const detailScroller = requireElement(detailPanel, ".chat-thread");
  mainScroller.getBoundingClientRect = () => new DOMRect(0, 0, 640, 600);
  detailScroller.getBoundingClientRect = () =>
    detailPanel.hidden ? new DOMRect() : new DOMRect(0, 0, 640, 600);
  expect(main.scrollElement).toBe(mainScroller);
  expect(detail.scrollElement).toBe(detailScroller);
  for (const width of [800, 640]) {
    emitTranscriptResize(detailScroller, width, 600);
  }
  expect(viewportChanged).not.toHaveBeenCalled();
  emitTranscriptResize(mainScroller, 800, 600);
  mainScroller.scrollTop = 40;
  mainScroller.dispatchEvent(new Event("scroll"));
  transcriptDomState.measuredRowHeight = 180;
  emitTranscriptResize(mainScroller, 640, 600);
  renderTranscripts();
  await flushDeferredRowPrune();
  expect(viewportChanged).toHaveBeenCalledOnce();
  expect(transcriptSize(mainPanel)).toBe(720);

  detailPanel.dispatchEvent(new Event(SIDEBAR_GEOMETRY_COMMIT_EVENT, { bubbles: true }));
  renderTranscripts();
  expect([transcriptSize(mainPanel), transcriptSize(detailPanel)]).toEqual([720, 720]);

  detailPanel.hidden = true;
  for (const row of transcriptRows(detailPanel)) {
    Object.defineProperty(row, "offsetHeight", { configurable: true, value: 0 });
  }
  transcriptDomState.measuredRowHeight = 240;
  detailPanel.dispatchEvent(new Event(SIDEBAR_GEOMETRY_COMMIT_EVENT, { bubbles: true }));
  renderTranscripts();

  expect([transcriptSize(mainPanel), transcriptSize(detailPanel)]).toEqual([960, 720]);
  main.dispose();
  detail.dispose();
  expect([main.scrollElement, detail.scrollElement]).toEqual([null, null]);
});

it("keeps rendering rows after a hide-transition zero rect", async () => {
  const transcript = createTestTranscript();
  const container = transcriptContainer();
  const messages = Array.from({ length: 40 }, (_, index) => ({
    role: index % 2 === 0 ? "user" : "assistant",
    content: `message ${index}`,
    timestamp: index + 1,
  }));
  const props = threadProps("pane-zero-rect", "agent:main:zero-rect", messages);
  render(renderChatThread(props, transcript), container);
  transcript.start();
  transcript.update();
  await flushDeferredRowPrune();
  render(renderChatThread(props, transcript), container);
  transcript.update();
  const scrollElement = requireElement(container, ".chat-thread");
  expect(transcriptRows(container).length).toBeGreaterThan(0);

  const visibleSize = transcriptSize(container);
  Object.defineProperty(scrollElement, "clientHeight", { configurable: true, value: 0 });
  for (const observer of resizeObservers) {
    if (observer.observes(scrollElement)) {
      observer.emit(0, 0);
    }
    for (const row of transcriptRows(container)) {
      observer.emitTarget(row, 0, 0);
    }
  }
  render(renderChatThread(props, transcript), container);
  transcript.update();

  expect(transcriptRows(container).length).toBeGreaterThan(0);
  expect(transcriptSize(container)).toBe(visibleSize);
  transcript.dispose();
});
