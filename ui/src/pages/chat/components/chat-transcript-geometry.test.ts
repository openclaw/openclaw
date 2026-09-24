/* @vitest-environment jsdom */

import { expectDefined } from "@openclaw/normalization-core";
import { VirtualizerController } from "@tanstack/lit-virtual";
import { html, render } from "lit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestTranscript, stubAnimationFrames } from "../chat-view.test-helpers.ts";
import { SIDEBAR_GEOMETRY_COMMIT_EVENT } from "../sidebar-layout.ts";
import { renderChatThread } from "./chat-thread.ts";
import { ChatTranscriptController } from "./chat-transcript-controller.ts";
import { measureConnectedTranscriptRows } from "./chat-transcript-geometry.ts";
import {
  flushDeferredRowPrune,
  installTranscriptDomMocks,
  mountTestTranscript,
  resetTranscriptTestDom,
  resizeObservers,
  threadProps,
  transcriptDomState,
  transcriptRows,
  transcriptSize,
} from "./chat-transcript.test-support.ts";

describe("chat transcript geometry", () => {
  beforeEach(installTranscriptDomMocks);
  afterEach(resetTranscriptTestDom);

  it("measures fractional layout height instead of a containing transform", () => {
    const container = document.body.appendChild(document.createElement("div"));
    container.innerHTML =
      '<div class="chat-virtual-row" data-index="0" style="height: 100.375px"></div>';
    const row = expectDefined(container.firstElementChild, "measured row");
    vi.spyOn(row, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, 400, 50.1875));
    const controller = new VirtualizerController<HTMLDivElement, HTMLElement>(
      {
        addController: vi.fn(),
        removeController: vi.fn(),
        requestUpdate: vi.fn(),
        updateComplete: Promise.resolve(true),
      },
      {
        count: 1,
        estimateSize: () => 100,
        getScrollElement: () => container,
        getItemKey: () => "fractional",
        observeElementRect: (_, callback) => {
          callback({ width: 800, height: 600 });
        },
        observeElementOffset: (_, callback) => {
          callback(0, false);
        },
        scrollToFn: (offset) => {
          container.scrollTop = offset;
        },
      },
    );
    controller.hostConnected();
    controller.hostUpdated();
    const virtualizer = controller.getVirtualizer();
    virtualizer.getVirtualItems();
    try {
      expect(measureConnectedTranscriptRows(container, virtualizer)).toBe(true);
      expect(virtualizer.itemSizeCache.get("fractional")).toBe(100.375);
      expect(measureConnectedTranscriptRows(container, virtualizer)).toBe(false);
    } finally {
      controller.hostDisconnected();
    }
  });

  it("keeps fractional observer sizes as the sole skipped-row sizing input", async () => {
    const rows = Array.from({ length: 4 }, (_, index) => ({
      kind: "content" as const,
      key: `fractional:${index}`,
      content: html`<div>row ${index}</div>`,
    }));
    const { container, transcript, renderRows } = await mountTestTranscript(
      "fractional-rows",
      rows,
    );
    try {
      for (const observer of resizeObservers) {
        for (const row of transcriptRows(container)) {
          observer.emitTarget(row, 800, 100.375);
        }
      }
      renderRows(rows);
      expect(transcriptSize(container)).toBe(401.5);
      for (const row of transcriptRows(container)) {
        expect(row.style.containIntrinsicBlockSize).toBe("100.375px");
      }
    } finally {
      transcript.hostDisconnected();
    }
  });

  it.each([false, true])(
    "coalesces end geometry across commits and retires disconnected work=%s",
    async (disconnect) => {
      const flushFrames = stubAnimationFrames();
      const { container, transcript } = await mountTestTranscript("coalesced-end", [
        { kind: "content", key: "reply", content: html`<div>Reply</div>` },
      ]);
      try {
        Object.defineProperties(container, {
          clientHeight: { configurable: true, value: 600 },
          scrollHeight: { configurable: true, value: 1200 },
        });
        container.scrollTop = 600;
        // JSDOM does not emit the browser's scroll read-back that settles initial compensation.
        container.dispatchEvent(new Event("scroll"));
        flushFrames();
        transcript.hostUpdated();
        flushFrames();
        const readHeight = vi.fn(() => 1200);
        Object.defineProperty(container, "scrollHeight", {
          configurable: true,
          get: readHeight,
        });
        for (let index = 0; index < 4; index++) {
          transcript.hostUpdated();
        }
        expect(readHeight).not.toHaveBeenCalled();
        if (disconnect) {
          transcript.hostDisconnected();
        }
        flushFrames();
        expect(readHeight).toHaveBeenCalledTimes(disconnect ? 0 : 1);
      } finally {
        transcript.hostDisconnected();
      }
    },
  );

  it("updates transcript extent from freshly wrapped heights while scrolling", async () => {
    const transcript = createTestTranscript();
    const container = document.body.appendChild(document.createElement("div"));
    const props = threadProps("pane-width-remeasure");
    const renderTranscript = async () => {
      render(renderChatThread(props, transcript), container);
      transcript.hostUpdated();
      await flushDeferredRowPrune();
    };

    await renderTranscript();
    transcript.hostConnected();
    await renderTranscript();
    for (const observer of resizeObservers) {
      for (const row of transcriptRows(container)) {
        observer.emitTarget(row, 800, 100);
      }
    }
    await renderTranscript();
    expect(transcriptSize(container)).toBe(400);

    const scrollElement = container.querySelector<HTMLElement>(".chat-thread");
    expect(scrollElement).not.toBeNull();
    // Establish the real viewport baseline first: zero rects from jsdom's
    // 0-width offsetWidth are ignored as hide transitions, matching browsers
    // where the initial attach rect is the true width.
    for (const observer of resizeObservers) {
      if (observer.observes(scrollElement!)) {
        observer.emit(800, 600);
      }
    }
    scrollElement!.scrollTop = 40;
    scrollElement!.dispatchEvent(new Event("scroll"));

    transcriptDomState.measuredRowHeight = 180;
    for (const observer of resizeObservers) {
      if (scrollElement && observer.observes(scrollElement)) {
        observer.emit(640, 600);
      }
    }
    await renderTranscript();

    expect(transcriptSize(container)).toBe(720);
    transcript.hostDisconnected();
  });

  it("remeasures every visible pane transcript while preserving hidden transcript rows", async () => {
    const host = Object.assign(document.body.appendChild(document.createElement("div")), {
      addController: vi.fn(),
      removeController: vi.fn(),
      requestUpdate: vi.fn(),
      updateComplete: Promise.resolve(true),
    });
    const viewportChanged = vi.fn();
    const main = new ChatTranscriptController(host, { onViewportResize: viewportChanged });
    const detail = new ChatTranscriptController(host);
    // Another pane may precede main chat in DOM order; neither observer nor
    // scroll commands may rediscover the first thread under the shared host.
    const detailPanel = host.appendChild(document.createElement("div"));
    const mainPanel = host.appendChild(document.createElement("div"));
    const mainProps = threadProps("pane-geometry-main", "agent:main:geometry-main");
    const detailProps = threadProps("pane-geometry-detail", "agent:main:geometry-detail");
    const renderTranscripts = () => {
      render(renderChatThread(mainProps, main), mainPanel);
      render(renderChatThread(detailProps, detail), detailPanel);
      main.hostUpdated();
      detail.hostUpdated();
    };

    renderTranscripts();
    main.hostConnected();
    detail.hostConnected();
    await flushDeferredRowPrune();
    renderTranscripts();

    const mainScroller = expectDefined(
      mainPanel.querySelector<HTMLElement>(".chat-thread"),
      "main transcript scroll element",
    );
    const detailScroller = expectDefined(
      detailPanel.querySelector<HTMLElement>(".chat-thread"),
      "detail transcript scroll element",
    );
    mainScroller.getBoundingClientRect = () => new DOMRect(0, 0, 640, 600);
    detailScroller.getBoundingClientRect = () =>
      detailPanel.hidden ? new DOMRect() : new DOMRect(0, 0, 640, 600);
    expect(main.scrollElement).toBe(mainScroller);
    expect(detail.scrollElement).toBe(detailScroller);
    for (const width of [800, 640]) {
      for (const observer of resizeObservers) {
        observer.emitTarget(detailScroller, width, 600);
      }
    }
    expect(viewportChanged).not.toHaveBeenCalled();
    for (const width of [800, 640]) {
      for (const observer of resizeObservers) {
        observer.emitTarget(mainScroller, width, 600);
      }
    }
    expect(viewportChanged).toHaveBeenCalledOnce();

    transcriptDomState.measuredRowHeight = 180;
    detailPanel.dispatchEvent(new Event(SIDEBAR_GEOMETRY_COMMIT_EVENT, { bubbles: true }));
    renderTranscripts();
    expect(transcriptSize(mainPanel)).toBe(720);
    expect(transcriptSize(detailPanel)).toBe(720);

    detailPanel.hidden = true;
    for (const row of transcriptRows(detailPanel)) {
      Object.defineProperty(row, "offsetHeight", { configurable: true, value: 0 });
    }
    transcriptDomState.measuredRowHeight = 240;
    detailPanel.dispatchEvent(new Event(SIDEBAR_GEOMETRY_COMMIT_EVENT, { bubbles: true }));
    renderTranscripts();

    expect(transcriptSize(mainPanel)).toBe(960);
    expect(transcriptSize(detailPanel)).toBe(720);
    main.hostDisconnected();
    detail.hostDisconnected();
    expect(main.scrollElement).toBeNull();
    expect(detail.scrollElement).toBeNull();
  });

  it("keeps rendering rows after a hide-transition zero rect", async () => {
    const transcript = createTestTranscript();
    const container = document.body.appendChild(document.createElement("div"));
    const messages = Array.from({ length: 40 }, (_, index) => ({
      role: index % 2 === 0 ? "user" : "assistant",
      content: `message ${index}`,
      timestamp: index + 1,
    }));
    const props = threadProps("pane-zero-rect", "agent:main:zero-rect", messages);
    render(renderChatThread(props, transcript), container);
    transcript.hostConnected();
    transcript.hostUpdated();
    await flushDeferredRowPrune();
    // Commit initial row measurements before recording the visible extent.
    render(renderChatThread(props, transcript), container);
    transcript.hostUpdated();
    const scrollElement = container.querySelector<HTMLElement>(".chat-thread");
    expect(scrollElement).not.toBeNull();
    expect(transcriptRows(container).length).toBeGreaterThan(0);

    // Hiding reports zero sizes for both the viewport and its connected rows.
    // Neither observation may replace the last measurable transcript geometry.
    const visibleSize = transcriptSize(container);
    Object.defineProperty(scrollElement!, "clientHeight", { configurable: true, value: 0 });
    for (const observer of resizeObservers) {
      if (observer.observes(scrollElement!)) {
        observer.emit(0, 0);
      }
      for (const row of transcriptRows(container)) {
        if (observer.observes(row)) {
          observer.emitTarget(row, 0, 0);
        }
      }
    }
    render(renderChatThread(props, transcript), container);
    transcript.hostUpdated();

    expect(transcriptRows(container).length).toBeGreaterThan(0);
    expect(transcriptSize(container)).toBe(visibleSize);
    transcript.hostDisconnected();
  });
});
