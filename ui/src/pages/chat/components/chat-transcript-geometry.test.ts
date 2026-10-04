/* @vitest-environment jsdom */

import { expectDefined } from "@openclaw/normalization-core";
import { VirtualizerController } from "@tanstack/lit-virtual";
import { html, nothing, render } from "lit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestTranscript, stubAnimationFrames } from "../chat-view.test-helpers.ts";
import { saveChatSessionScrollPosition } from "../scroll.ts";
import { SIDEBAR_GEOMETRY_COMMIT_EVENT } from "../sidebar-layout.ts";
import { renderChatThread } from "./chat-thread.ts";
import { ChatTranscriptController } from "./chat-transcript-controller.ts";
import { measureConnectedTranscriptRows } from "./chat-transcript-geometry.ts";
import type { TranscriptRow } from "./chat-transcript-layout.ts";
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

  it.each([null, 4_800])(
    "bounds the first presented frame then restores the scrolling buffer at offset %s",
    (offset) => {
      const flushFrames = stubAnimationFrames();
      let presented = true;
      const paneId = `render-window-${offset}`;
      const sessionKey = `agent:main:${paneId}`;
      if (offset !== null) {
        saveChatSessionScrollPosition(paneId, sessionKey, {
          scrollTop: offset,
          anchorToEnd: false,
        });
      }
      const host = Object.assign(document.createElement("div"), {
        addController: vi.fn(),
        removeController: vi.fn(),
        requestUpdate: vi.fn(),
        updateComplete: Promise.resolve(true),
      });
      vi.stubGlobal("innerWidth", 800);
      vi.stubGlobal("innerHeight", 600);
      const readHostWidth = vi.fn(() => 800);
      const readHostHeight = vi.fn(() => 600);
      Object.defineProperties(host, {
        clientWidth: { get: readHostWidth },
        clientHeight: { get: readHostHeight },
      });
      const transcript = new ChatTranscriptController(host, () => paneId, {
        visuallyPresented: () => presented,
      });
      const rows = Array.from({ length: 100 }, (_, index) => ({
        kind: "content" as const,
        key: `row:${index}`,
        content: html`<div>Turn ${index}</div>`,
      }));
      const renderRow = vi.fn((row: TranscriptRow) =>
        row.kind === "content" ? row.content : nothing,
      );
      const container = document.body.appendChild(document.createElement("div"));
      const renderWindow = (windowRows = rows) => {
        renderRow.mockClear();
        render(
          transcript.renderSession(sessionKey, (session) =>
            session.render(windowRows, renderRow, null, false),
          ),
          container,
        );
        transcript.hostUpdated();
        return renderRow.mock.calls.length;
      };
      transcript.hostConnected();
      expect(renderWindow([])).toBe(0);
      expect(readHostWidth).not.toHaveBeenCalled();
      expect(readHostHeight).not.toHaveBeenCalled();
      flushFrames();

      // A saved viewport needs five estimated rows; the implicit end starts
      // with the tail row. Neither needs more than two neighbors per edge.
      expect(renderWindow()).toBe(offset === null ? 3 : 9);
      const mounted = transcriptRows(container).map((row) => Number(row.dataset.index));
      expect(mounted).toEqual(expect.arrayContaining(offset === null ? [99] : [40, 44]));
      // Multiple commits before the next frame must not consume the first-paint budget.
      expect(renderWindow()).toBe(offset === null ? 3 : 9);
      flushFrames();
      expect(renderWindow()).toBe(offset === null ? 7 : 17);

      // A retained pane gets the small window again. Hiding before its queued
      // frame (even without rendering rows) must not widen its next presentation.
      presented = false;
      transcript.hostUpdated();
      presented = true;
      expect(renderWindow()).toBe(offset === null ? 3 : 9);
      presented = false;
      transcript.hostUpdated();
      flushFrames();
      presented = true;
      expect(renderWindow()).toBe(offset === null ? 3 : 9);
      flushFrames();
      expect(renderWindow()).toBe(offset === null ? 7 : 17);
      transcript.hostDisconnected();
    },
  );

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
    saveChatSessionScrollPosition("fractional-rows", "agent:main:fractional-rows", {
      scrollTop: 0,
      anchorToEnd: false,
    });
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

  it("updates rail geometry for size changes without measuring streamed content or retired transcripts", () => {
    const flushFrames = stubAnimationFrames();
    const transcript = createTestTranscript();
    const region = document.body.appendChild(document.createElement("div"));
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
    vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (
      this: Element,
    ) {
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
      transcript.hostUpdated();
    };
    const emitResize = (element: Element, width: number, height: number) => {
      for (const observer of resizeObservers) {
        observer.emitTarget(element, width, height);
      }
    };
    try {
      renderTranscript();
      transcript.hostConnected();
      transcript.hostUpdated();
      const viewport = expectDefined(transcript.scrollElement, "rail viewport");
      const inner = expectDefined(viewport.querySelector(".chat-thread-inner"), "rail column");
      const column = expectDefined(inner.querySelector(".chat-virtual-sizer"), "column width");
      emitResize(column, innerWidth, 0);
      emitResize(region, 1200, regionHeight);
      flushFrames();
      expect(viewport.hasAttribute("data-position-rail-gutter")).toBe(true);
      expect(viewport.style.getPropertyValue("--chat-position-rail-viewport-height")).toBe("600px");
      expect(viewport.style.getPropertyValue("--chat-transcript-column-width")).toBe("768px");
      readInnerBounds.mockClear();

      for (const [index, text] of ["one", "two", "three"].entries()) {
        props.stream = `Live ${text}`;
        renderTranscript();
        emitResize(inner, innerWidth, 1300 + index * 100);
        flushFrames();
        expect(viewport.textContent).toContain(`Live ${text}`);
      }
      expect(readInnerBounds).not.toHaveBeenCalled();

      // Saved message width changes the column without resizing its viewport.
      gutter = 20;
      innerWidth = 1160;
      emitResize(column, innerWidth, 0);
      flushFrames();
      expect(viewport.hasAttribute("data-position-rail-gutter")).toBe(false);
      expect(viewport.style.getPropertyValue("--chat-transcript-column-width")).toBe("1160px");
      expect(readInnerBounds).toHaveBeenCalledOnce();
      readInnerBounds.mockClear();

      regionHeight = 720;
      emitResize(region, 1200, regionHeight);
      flushFrames();
      expect(viewport.style.getPropertyValue("--chat-position-rail-viewport-height")).toBe("720px");
      expect(readInnerBounds).toHaveBeenCalledOnce();

      // A restamped shell retires its old column observation and binds the new one.
      props.loading = true;
      props.messages = [];
      props.stream = "";
      props.runActive = false;
      render(nothing, region);
      transcript.hostUpdated();
      renderTranscript();
      const replacementViewport = expectDefined(
        transcript.scrollElement,
        "replacement rail viewport",
      );
      const replacement = expectDefined(
        replacementViewport.querySelector(".chat-thread-inner"),
        "replacement rail column",
      );
      expect(replacement).not.toBe(inner);
      gutter = 100;
      innerWidth = 768;
      emitResize(
        expectDefined(replacement.querySelector(".chat-virtual-sizer"), "replacement column"),
        innerWidth,
        0,
      );
      emitResize(region, 1200, regionHeight);
      flushFrames();
      expect(replacementViewport.hasAttribute("data-position-rail-gutter")).toBe(true);
      expect(replacementViewport.style.getPropertyValue("--chat-transcript-column-width")).toBe(
        "768px",
      );
      readInnerBounds.mockClear();
      emitResize(inner, 400, 400);
      flushFrames();
      expect(readInnerBounds).not.toHaveBeenCalled();

      emitResize(replacement, 700, 400);
      transcript.hostDisconnected();
      render(nothing, region);
      flushFrames();
      expect(readInnerBounds).not.toHaveBeenCalled();
      vi.mocked(requestAnimationFrame).mockClear();
      emitResize(replacement, 600, 400);
      emitResize(region, 1200, 800);
      expect(requestAnimationFrame).not.toHaveBeenCalled();

      transcript.hostConnected();
      renderTranscript();
      emitResize(region, 1200, regionHeight);
      flushFrames();
      const restored = expectDefined(transcript.scrollElement, "restored rail viewport");
      expect(restored.hasAttribute("data-position-rail-gutter")).toBe(true);
      expect(restored.style.getPropertyValue("--chat-position-rail-viewport-height")).toBe("720px");
    } finally {
      transcript.hostDisconnected();
      render(nothing, region);
    }
  });

  it("remeasures scrolling and visible panes while preserving hidden transcript rows", async () => {
    for (const pane of ["main", "detail"]) {
      saveChatSessionScrollPosition(`pane-geometry-${pane}`, `agent:main:geometry-${pane}`, {
        scrollTop: 0,
        anchorToEnd: false,
      });
    }
    const host = Object.assign(document.body.appendChild(document.createElement("div")), {
      addController: vi.fn(),
      removeController: vi.fn(),
      requestUpdate: vi.fn(),
      updateComplete: Promise.resolve(true),
    });
    const viewportChanged = vi.fn();
    const main = new ChatTranscriptController(host, () => "pane-geometry-main", {
      onViewportResize: viewportChanged,
    });
    const detail = new ChatTranscriptController(host, () => "pane-geometry-detail");
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
    for (const observer of resizeObservers) {
      for (const row of transcriptRows(mainPanel)) {
        observer.emitTarget(row, 800, 100);
      }
    }
    renderTranscripts();
    await flushDeferredRowPrune();
    expect(transcriptSize(mainPanel)).toBe(400);

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
    for (const observer of resizeObservers) {
      observer.emitTarget(mainScroller, 800, 600);
    }
    mainScroller.scrollTop = 40;
    mainScroller.dispatchEvent(new Event("scroll"));
    transcriptDomState.measuredRowHeight = 180;
    for (const observer of resizeObservers) {
      observer.emitTarget(mainScroller, 640, 600);
    }
    renderTranscripts();
    await flushDeferredRowPrune();
    expect(viewportChanged).toHaveBeenCalledOnce();
    expect(transcriptSize(mainPanel)).toBe(720);

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
