/* @vitest-environment jsdom */

import { expectDefined } from "@openclaw/normalization-core";
import { html, nothing, render } from "lit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../../test/helpers/promise.js";
import { makeChatHost } from "../chat-host.test-support.ts";
import { createTestTranscript, stubAnimationFrames } from "../chat-view.test-helpers.ts";
import {
  handleChatScrollTakeover,
  saveChatSessionScrollPosition,
  scheduleCommittedChatScroll,
} from "../scroll.ts";
import { SIDEBAR_GEOMETRY_COMMIT_EVENT } from "../sidebar-layout.ts";
import { renderChatThread } from "./chat-thread.ts";
import { ChatTranscriptController } from "./chat-transcript-controller.ts";
import {
  flushDeferredRowPrune,
  installTranscriptDomMocks,
  mountTestTranscript,
  observedElements,
  resetTranscriptTestDom,
  resizeObservers,
  threadProps,
  type TestContentRow,
  transcriptDomState,
  transcriptRows,
  transcriptSize,
} from "./chat-transcript.test-support.ts";

function stubMcpAppLifecycle(
  container: ParentNode,
  teardown: () => Promise<void> = () => Promise.resolve(),
) {
  const app = expectDefined(
    container.querySelector<HTMLElement>("mcp-app-view"),
    "mounted MCP app",
  );
  const lifecycle = {
    restartAfterTeardown: vi.fn(),
    teardown: vi.fn(teardown),
  };
  return { app: Object.assign(app, lifecycle), ...lifecycle };
}

function numberedContentRows(length: number): TestContentRow[] {
  return Array.from({ length }, (_, index) => ({
    kind: "content",
    key: `row:${index}`,
    content: html`<div>row ${index}</div>`,
  }));
}

function mcpRangeRows(appContent: unknown): TestContentRow[] {
  return Array.from({ length: 24 }, (_, index) => ({
    kind: "content" as const,
    key: `row:${index}`,
    content: index === 17 ? appContent : html`<div>row ${index}</div>`,
  }));
}

describe("chat transcript controller", () => {
  beforeEach(installTranscriptDomMocks);
  afterEach(resetTranscriptTestDom);

  it("keeps every re-stamped row observed after moving containers", async () => {
    const transcript = createTestTranscript();
    const props = threadProps("pane-measure");
    const chatFace = document.body.appendChild(document.createElement("div"));
    render(renderChatThread(props, transcript), chatFace);
    transcript.hostConnected();
    transcript.hostUpdated();
    await flushDeferredRowPrune();

    const chatRows = transcriptRows(chatFace);
    expect(chatRows.length).toBeGreaterThanOrEqual(4);
    for (const row of chatRows) {
      expect(observedElements.has(row)).toBe(true);
    }

    // Re-stamp the same session transcript into a new container while the old
    // tree is still tracked, mirroring the dashboard face-switch commit.
    const dashboardDock = document.body.appendChild(document.createElement("div"));
    render(renderChatThread(props, transcript), dashboardDock);
    transcript.hostUpdated();
    await flushDeferredRowPrune();

    const dockRows = transcriptRows(dashboardDock);
    expect(dockRows.length).toBe(chatRows.length);
    for (const row of dockRows) {
      expect(observedElements.has(row)).toBe(true);
    }
    for (const row of chatRows) {
      expect(observedElements.has(row)).toBe(false);
    }
  });

  it("measures newly inserted rows after Lit connects them", async () => {
    // Lit invokes ref callbacks while a new row is still detached. Browsers
    // report a zero offsetHeight there, which must not become the row's
    // durable virtual size before the following user bubble is positioned.
    transcriptDomState.detachedRowHeight = 0;
    const transcript = createTestTranscript();
    const container = document.body.appendChild(document.createElement("div"));
    const props = threadProps("pane-commentary-insert", "agent:main:session-a", [
      { role: "assistant", content: "commentary", timestamp: 1_000 },
      { role: "user", content: "next turn", timestamp: 2_000 },
    ]);

    render(renderChatThread(props, transcript), container);
    transcript.hostConnected();
    transcript.hostUpdated();
    await flushDeferredRowPrune();
    render(renderChatThread(props, transcript), container);

    expect(transcriptSize(container)).toBe(200);
  });

  it("keeps retained MCP rows and the virtual row model atomic through teardown", async () => {
    const teardownPending = createDeferred();
    transcriptDomState.measuredRowHeight = 180;
    const initialRows = [
      { kind: "content" as const, key: "app", content: html`<mcp-app-view></mcp-app-view>` },
      { kind: "content" as const, key: "group:tool", content: html`<div>tool</div>` },
      { kind: "content" as const, key: "group:reply", content: html`<div>reply</div>` },
    ];
    const regroupedRows = [
      { kind: "content" as const, key: "history", content: html`<div>history</div>` },
      {
        kind: "content" as const,
        key: "group:reply",
        content: html`<div>regrouped</div>`,
      },
      { kind: "content" as const, key: "group:next", content: html`<div>next</div>` },
    ];
    const { container, renderRows } = await mountTestTranscript("pane-mcp-rows", initialRows);
    stubMcpAppLifecycle(container, () => teardownPending.promise);

    renderRows(regroupedRows);
    const retainedRows = transcriptRows(container);
    expect(retainedRows.map((row) => row.dataset.virtualRowKey)).toEqual([
      "app",
      "group:tool",
      "group:reply",
    ]);

    // Deliver an old-tree resize while teardown keeps that tree connected.
    // Its data-index values must still resolve through the old key model.
    Object.defineProperty(retainedRows[1]!, "offsetHeight", { configurable: true, value: 40 });
    for (const observer of resizeObservers) {
      observer.emitTarget(retainedRows[1]!, 800, 40);
    }
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
    // The old tool's 40px delivery must not resize the retained reply key.
    expect(transcriptSize(container)).toBe(540);
  });

  it.each([
    { idleBeforeRelease: false, outsideContact: false },
    { idleBeforeRelease: true, outsideContact: false },
    { idleBeforeRelease: true, outsideContact: true },
  ])(
    "keeps the committed rows and message lookup together while a touch holds a prepend, idle=$idleBeforeRelease, outside contact=$outsideContact",
    async ({ idleBeforeRelease, outsideContact }) => {
      const initial: TestContentRow[] = [
        {
          kind: "content",
          key: "retained-row",
          content: html`<div class="chat-bubble" data-message-id="retained">retained</div>`,
        },
      ];
      const next: TestContentRow[] = [
        {
          kind: "content",
          key: "expanded-row",
          content: html`<div class="chat-bubble" data-message-id="older">older</div>
            <div class="chat-bubble" data-message-id="retained">retained</div>`,
        },
      ];
      const { container, session, transcript, renderRows } = await mountTestTranscript(
        "touch-map",
        initial,
      );
      try {
        session.syncMessageRows(
          new Map([["retained", "retained-row"]]),
          new Map([["retained", "retained-row"]]),
        );
        renderRows(initial);
        const bubble = expectDefined(container.querySelector(".chat-bubble"), "retained bubble");
        const contact = (identifier: number, target: EventTarget): Touch => ({
          identifier,
          target,
          clientX: 0,
          clientY: 100,
          pageX: 0,
          pageY: 100,
          screenX: 0,
          screenY: 100,
          radiusX: 1,
          radiusY: 1,
          rotationAngle: 0,
          force: 1,
        });
        const owned = contact(1, bubble);
        const remaining = outsideContact ? [contact(2, document.body)] : [];
        bubble.dispatchEvent(
          new TouchEvent("touchstart", {
            touches: [...remaining, owned],
            targetTouches: [owned],
            changedTouches: [owned],
            bubbles: true,
          }),
        );
        if (idleBeforeRelease) {
          // The finger can remain down after native offset notifications settle.
          vi.useFakeTimers();
          container.scrollTop = 10;
          container.dispatchEvent(new Event("scroll"));
          await vi.advanceTimersByTimeAsync(200);
        }
        session.syncMessageRows(
          new Map([
            ["older", "expanded-row"],
            ["retained", "expanded-row"],
          ]),
          new Map([
            ["older", "expanded-row"],
            ["retained", "expanded-row"],
          ]),
        );
        renderRows(next);
        expect(transcriptRows(container).map((row) => row.dataset.virtualRowKey)).toEqual([
          "retained-row",
        ]);
        expect(container.textContent).not.toContain("older");
        expect(session.activeMessageId(["retained"])).toBe("retained");
        expect(session.activeMessageId(["older"])).toBeNull();
        bubble.dispatchEvent(
          new TouchEvent("touchend", {
            touches: remaining,
            targetTouches: [],
            changedTouches: [owned],
            bubbles: true,
          }),
        );
        renderRows(next);
        expect(transcriptRows(container).map((row) => row.dataset.virtualRowKey)).toEqual([
          "expanded-row",
        ]);
        expect(container.textContent).toContain("older");
        expect(session.activeMessageId(["retained"])).toBe("retained");
        expect(session.activeMessageId(["older"])).toBe("older");
      } finally {
        transcript.hostDisconnected();
        if (idleBeforeRelease) {
          vi.useRealTimers();
        }
      }
    },
  );

  it("does not teardown an MCP row retained by an append", async () => {
    const initialRows = [
      { kind: "content" as const, key: "app", content: html`<mcp-app-view></mcp-app-view>` },
      { kind: "content" as const, key: "reply", content: html`<div>reply</div>` },
    ];
    const { container, renderRows } = await mountTestTranscript("pane-mcp-append", initialRows);
    const { app, teardown } = stubMcpAppLifecycle(container);

    renderRows([...initialRows, { kind: "content", key: "next", content: html`<div>next</div>` }]);

    expect(teardown).not.toHaveBeenCalled();
    expect(container.querySelector("mcp-app-view")).toBe(app);
  });

  it("tears down a retained MCP key that leaves the next virtual range", async () => {
    const initialRows = mcpRangeRows(html`<mcp-app-view></mcp-app-view>`);
    const { container, renderRows } = await mountTestTranscript("pane-mcp-range", initialRows);
    const { app, teardown } = stubMcpAppLifecycle(container);

    renderRows([initialRows[17]!, ...initialRows.slice(0, 17), ...initialRows.slice(18)]);

    expect(teardown).toHaveBeenCalledOnce();
    expect(app.isConnected).toBe(true);
  });

  it("keeps a focused MCP key at its next-model index", async () => {
    const initialRows = mcpRangeRows(
      html`<mcp-app-view
        ><iframe title="Retained application"></iframe><button>focus app</button></mcp-app-view
      >`,
    );
    const { container, renderRows } = await mountTestTranscript(
      "pane-mcp-focused-range",
      initialRows,
    );
    const { app, teardown } = stubMcpAppLifecycle(container);
    const frame = expectDefined(app.querySelector("iframe"), "retained application frame");
    const rowParent = expectDefined(app.parentElement?.parentElement, "retained row parent");
    const button = expectDefined(container.querySelector("button"), "MCP app focus target");
    button.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));

    renderRows([initialRows[17]!, ...initialRows.slice(0, 17), ...initialRows.slice(18)]);

    expect(teardown).not.toHaveBeenCalled();
    expect(app.isConnected).toBe(true);
    expect(container.querySelector("mcp-app-view")).toBe(app);
    expect(app.querySelector("iframe")).toBe(frame);
    expect(app.parentElement?.parentElement).toBe(rowParent);
  });

  it("reconciles an implicit end anchor when committed content has no scroll range", () => {
    const flushFrames = stubAnimationFrames();
    const transcript = createTestTranscript();
    const container = document.body.appendChild(document.createElement("div"));
    const messages = Array.from({ length: 18 }, (_, index) => ({
      role: index % 2 === 0 ? "user" : "assistant",
      content: `message ${index}`,
      timestamp: index + 1,
    }));
    const props = threadProps("pane-underfill-anchor", "agent:main:underfill", messages);
    render(renderChatThread(props, transcript), container);
    const scrollElement = container.querySelector<HTMLElement>(".chat-thread");
    expect(scrollElement).not.toBeNull();
    Object.defineProperties(scrollElement, {
      clientHeight: { configurable: true, value: 600 },
      scrollHeight: { configurable: true, value: 600 },
    });

    transcript.hostConnected();
    transcript.scrollToEnd({ source: "auto" });
    transcript.hostUpdated();
    flushFrames();
    render(renderChatThread(props, transcript), container);
    expect(transcriptRows(container)[0]?.dataset.index).toBe("0");
    expect(container.textContent).toContain("message 0");
  });

  it("pauses an unmeasurable restore until loading commits an empty transcript", () => {
    const transcript = createTestTranscript();
    const container = document.body.appendChild(document.createElement("div"));
    const props = threadProps("pane-loading-scroll", "agent:main:session-a", []);
    render(renderChatThread({ ...props, loading: true }, transcript), container);
    transcript.hostConnected();
    transcript.hostUpdated();
    const onSettled = vi.fn();
    transcript.scrollToOffset(420, onSettled);
    transcript.hostUpdated();

    expect(onSettled).not.toHaveBeenCalled();

    render(renderChatThread(props, transcript), container);
    transcript.hostUpdated();
    expect(onSettled).toHaveBeenCalledWith({ scrollTop: 0, anchorToEnd: true });
  });

  it("settles a restored offset when loaded rows no longer overflow", () => {
    const flushFrames = stubAnimationFrames();
    vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => undefined);
    const transcript = createTestTranscript();
    const container = document.body.appendChild(document.createElement("div"));
    const props = threadProps("pane-short-scroll", "agent:main:session-a");
    render(renderChatThread(props, transcript), container);
    Object.defineProperty(container.querySelector(".chat-thread")!, "clientHeight", {
      configurable: true,
      value: 600,
    });
    transcript.hostConnected();
    transcript.hostUpdated();
    const onSettled = vi.fn();
    transcript.scrollToOffset(420, onSettled);

    for (let index = 0; index <= 60; index += 1) {
      transcript.hostUpdated();
      flushFrames();
    }

    expect(onSettled).toHaveBeenCalledWith({ scrollTop: 0, anchorToEnd: true });
  });

  it.each([
    { behavior: "auto", resizeBefore: true, deltaY: -100, observerLate: false },
    { behavior: "smooth", resizeBefore: true, deltaY: -100, observerLate: false },
    { behavior: "smooth", resizeBefore: false, deltaY: -100, observerLate: false },
    { behavior: "smooth", resizeBefore: true, deltaY: 100, observerLate: false },
    { behavior: "smooth", resizeBefore: true, deltaY: -100, observerLate: true },
    { behavior: "smooth", resizeBefore: true, deltaY: -100_000, observerLate: "after-wheel" },
  ] as const)(
    "recovers $behavior measurements with resizeBeforeInterruption=$resizeBefore, wheel=$deltaY, and late offset=$observerLate",
    async ({ behavior, resizeBefore, deltaY, observerLate }) => {
      const flushFrames = stubAnimationFrames();
      transcriptDomState.measuredRowHeight = 120;
      const rows = numberedContentRows(40);
      const { container, renderRows, transcript } = await mountTestTranscript(
        `pane-${behavior}-${resizeBefore}-${deltaY}-${observerLate}-resize`,
        rows,
      );
      try {
        container.scrollTo = (options?: ScrollToOptions | number) => {
          if (typeof options === "object" && options.behavior !== "smooth") {
            container.scrollTop = options.top ?? container.scrollTop;
          }
        };
        Object.defineProperties(container, {
          clientHeight: { configurable: true, value: 600 },
          scrollHeight: { configurable: true, value: 4000 },
        });
        for (const observer of resizeObservers) {
          observer.emitTarget(container, 800, 600);
        }
        transcript.scrollToOffset(0);
        renderRows(rows);
        container.dispatchEvent(new Event("scroll"));
        renderRows(rows);
        await flushDeferredRowPrune();
        flushFrames();
        renderRows(rows);
        const first = expectDefined(
          container.querySelector<HTMLElement>('[data-index="0"]'),
          "first row",
        );
        const initialSize = transcriptSize(container);
        const resize = () => {
          Object.defineProperty(first, "offsetHeight", { configurable: true, value: 200 });
          for (const observer of resizeObservers) {
            observer.emitTarget(first, 800, 200);
          }
        };
        transcript.scrollToEnd({ behavior });
        if (observerLate) {
          container.scrollTop = 135;
          container.dispatchEvent(new Event("scroll"));
        }
        if (resizeBefore) {
          resize();
        }
        if (observerLate === true) {
          // Native wheel movement can precede both input delivery and the
          // offset observer. Remeasurement must use this viewport, not 135.
          container.scrollTop = 0;
        }
        container.dispatchEvent(new WheelEvent("wheel", { deltaY }));
        if (observerLate === "after-wheel") {
          // The wheel's native default action can land before its offset observer,
          // but after the input callback queued skipped row measurements.
          container.scrollTop = 0;
        }
        if (!observerLate) {
          container.scrollTop = 0;
          container.dispatchEvent(new Event("scroll"));
        }
        if (!resizeBefore) {
          resize();
        }
        flushFrames();
        renderRows(rows);
        expect(transcriptSize(container)).toBe(initialSize + 80);
        expect.soft(container.scrollTop).toBe(0);
        if (observerLate) {
          container.dispatchEvent(new Event("scroll"));
          flushFrames();
          renderRows(rows);
          expect(container.scrollTop).toBe(0);
        }
      } finally {
        transcript.hostDisconnected();
      }
    },
  );

  it.each([0, 252])(
    "retires an end index without losing newer native movement (%s px)",
    async (nativeGrowth) => {
      const flushFrames = stubAnimationFrames();
      const transcript = new ChatTranscriptController(
        {
          addController: vi.fn(),
          removeController: vi.fn(),
          requestUpdate: vi.fn(),
          updateComplete: Promise.resolve(true),
        },
        { canFollowEnd: () => false },
      );
      const content = numberedContentRows(12);
      const typing: TestContentRow = {
        kind: "content",
        key: "presence:typing",
        content: html`<div>Typing</div>`,
      };
      const { container, renderRows } = await mountTestTranscript(
        "retired-end-index",
        [...content, typing],
        transcript,
      );
      let extraExtent = 0;
      Object.defineProperties(container, {
        clientHeight: { configurable: true, value: 600 },
        scrollHeight: { configurable: true, get: () => transcriptSize(container) + extraExtent },
      });
      container.scrollTo = vi.fn((options?: ScrollToOptions | number, y?: number) => {
        container.scrollTop = typeof options === "number" ? (y ?? 0) : (options?.top ?? 0);
      });
      const typingRow = expectDefined(
        container.querySelector<HTMLElement>('[data-virtual-row-key="presence:typing"]'),
        "typing row",
      );
      Object.defineProperty(typingRow, "offsetHeight", { configurable: true, value: 30 });
      for (const observer of resizeObservers) {
        observer.emitTarget(container, 800, 600);
        observer.emitTarget(typingRow, 800, 30);
      }
      renderRows([...content, typing]);
      flushFrames();
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      try {
        transcript.scrollToEnd({ behavior: "auto" });
        container.dispatchEvent(new Event("scroll"));
        if (nativeGrowth > 0) {
          extraExtent = nativeGrowth;
          transcript.scrollToEnd({ behavior: "auto" });
          // Its native scroll event has not arrived when the earlier idle callback fires.
        }
        const before = container.scrollTop;
        // Native idle can beat the queued frame; they are separate schedulers.
        vi.advanceTimersByTime(150);
        expect(container.scrollTop, "stale idle must not restore its old offset").toBe(before);
        // A remote receipt cancels following after the UI considers the command settled.
        transcript.cancelScroll();
        transcriptDomState.measuredRowHeight = 120;
        const next: TestContentRow[] = [
          ...content,
          { kind: "content", key: "peer", content: html`<div>Peer</div>` },
          typing,
        ];
        renderRows(next);
        await Promise.resolve();
        renderRows(next);
        flushFrames();
        expect(container.scrollTop, "retired index must not follow the peer replacing typing").toBe(
          before,
        );
      } finally {
        transcript.hostDisconnected();
        vi.useRealTimers();
      }
    },
  );

  it("keeps a smooth latest command through an idle observer delivery before reaching its target", async () => {
    const rows = numberedContentRows(40);
    const { container, transcript } = await mountTestTranscript("idle-latest", rows);
    Object.defineProperties(container, {
      clientHeight: { configurable: true, value: 600 },
      scrollHeight: { configurable: true, value: 4800 },
    });
    const scrollTo = vi.fn();
    container.scrollTo = scrollTo;
    vi.useFakeTimers();
    try {
      container.scrollTop = 1000;
      container.dispatchEvent(new Event("scroll"));
      transcript.scrollToEnd({ behavior: "smooth" });
      expect(scrollTo).toHaveBeenLastCalledWith({ top: 4200, behavior: "smooth" });
      container.scrollTop = 1500;
      container.dispatchEvent(new Event("scroll"));
      Object.defineProperty(container, "scrollHeight", { configurable: true, value: 4900 });
      vi.advanceTimersByTime(16);
      expect(scrollTo).toHaveBeenLastCalledWith({ top: 4300, behavior: "smooth" });
      scrollTo.mockClear();

      // A retargeted native animation can pause between offset events. Core's
      // idle debounce still fires, but the requested end has not been reached.
      vi.advanceTimersByTime(150);
      expect(transcript.isProgrammaticScroll).toBe(true);
      expect(scrollTo).not.toHaveBeenCalled();

      // The 8px UI-follow boundary does not complete the native end command.
      container.scrollTop = 4296;
      container.dispatchEvent(new Event("scroll"));
      vi.advanceTimersByTime(150);
      expect(transcript.isProgrammaticScroll).toBe(false);
      expect(scrollTo).not.toHaveBeenCalled();

      container.scrollTop = 4300;
      container.dispatchEvent(new Event("scroll"));
      vi.advanceTimersByTime(150);
      expect(scrollTo).toHaveBeenCalledExactlyOnceWith({ top: 4300, behavior: "instant" });
      expect(transcript.isProgrammaticScroll).toBe(false);
    } finally {
      transcript.hostDisconnected();
      vi.useRealTimers();
    }
  });

  it.each([true, false])(
    "leaves height-resize follow to page policy with reader lock=%s",
    async (locked) => {
      const flushFrames = stubAnimationFrames();
      const policy = makeChatHost({ chatHasAutoScrolled: true });
      const onViewportResize = vi.fn(() =>
        scheduleCommittedChatScroll(policy, false, false, { source: "resize" }),
      );
      const transcript = new ChatTranscriptController(
        {
          addController: vi.fn(),
          removeController: vi.fn(),
          requestUpdate: vi.fn(),
          updateComplete: Promise.resolve(true),
        },
        {
          onViewportResize,
          canFollowEnd: () => !policy.chatFollowLocked,
          onReaderScroll: (towardEnd) => handleChatScrollTakeover(policy, towardEnd),
        },
      );
      const rows = numberedContentRows(12);
      const { container } = await mountTestTranscript(`height-resize-${locked}`, rows, transcript);
      try {
        const total = transcriptSize(container);
        Object.defineProperties(container, {
          clientHeight: { configurable: true, value: 600 },
          // Real container padding leaves the reader 88px above the actual end,
          // even though the virtual rows alone appear to be end-pinned.
          scrollHeight: { configurable: true, value: total + 88 },
        });
        const scrollTo = vi.fn();
        container.scrollTo = scrollTo;
        policy.chatScrollElement = () => container;
        policy.chatScrollToEnd = (options) => transcript.scrollToEnd(options);
        for (const observer of resizeObservers) {
          observer.emitTarget(container, 800, 600);
        }
        container.scrollTop = total - 600;
        container.dispatchEvent(new Event("scroll"));
        if (locked) {
          container.dispatchEvent(new WheelEvent("wheel", { deltaY: -88 }));
        }
        expect(policy.chatFollowLocked).toBe(locked);
        scrollTo.mockClear();

        for (const height of [560, 640]) {
          Object.defineProperty(container, "clientHeight", { configurable: true, value: height });
          for (const observer of resizeObservers) {
            observer.emitTarget(container, 800, height);
          }
          // The observer only reports geometry; follow waits for the policy frame.
          expect(scrollTo).not.toHaveBeenCalled();
          flushFrames();
          if (locked) {
            expect(scrollTo).not.toHaveBeenCalled();
            expect(container.scrollTop).toBe(total - 600);
          } else {
            expect(scrollTo).toHaveBeenLastCalledWith({
              top: total + 88 - height,
              behavior: "auto",
            });
          }
          scrollTo.mockClear();
        }
        expect(onViewportResize).toHaveBeenCalledTimes(2);
        expect(policy.chatFollowLocked).toBe(locked);
      } finally {
        transcript.hostDisconnected();
      }
    },
  );

  it("keeps a reader above the padded real end stationary when a rendered row grows", async () => {
    transcriptDomState.measuredRowHeight = 120;
    const rows = numberedContentRows(12);
    const { container, renderRows, transcript } = await mountTestTranscript(
      "padded-row-resize",
      rows,
    );
    try {
      const total = transcriptSize(container);
      container.style.padding = "28px 0 56px";
      container.scrollTo = (options?: ScrollToOptions | number) => {
        if (typeof options === "object") {
          container.scrollTop = options.top ?? container.scrollTop;
        }
      };
      Object.defineProperties(container, {
        clientHeight: { configurable: true, value: 600 },
        scrollHeight: { configurable: true, value: total + 84 },
      });
      for (const observer of resizeObservers) {
        observer.emitTarget(container, 800, 600);
      }
      container.scrollTop = container.scrollHeight - container.clientHeight - 44;
      container.dispatchEvent(new Event("scroll"));
      const readerOffset = container.scrollTop;
      expect(Math.max(total - container.clientHeight - readerOffset, 0)).toBe(0);
      const row = expectDefined(
        container.querySelector<HTMLElement>('[data-index="11"]'),
        "last row",
      );
      expect(observedElements.has(row)).toBe(true);

      Object.defineProperty(row, "offsetHeight", { configurable: true, value: 192 });
      Object.defineProperty(container, "scrollHeight", {
        configurable: true,
        value: total + 84 + 72,
      });
      for (const observer of resizeObservers) {
        observer.emitTarget(row, 800, 192);
      }
      renderRows(rows);
      expect(transcriptSize(container)).toBe(total + 72);
      expect(container.scrollTop).toBe(readerOffset);
    } finally {
      transcript.hostDisconnected();
    }
  });

  it.each([false, true])(
    "keeps disclosure anchoring only without reader interruption=%s",
    async (interrupt) => {
      const host = Object.assign(document.body.appendChild(document.createElement("div")), {
        addController: vi.fn(),
        removeController: vi.fn(),
        requestUpdate: vi.fn(),
        updateComplete: Promise.resolve(true),
      });
      const transcript = new ChatTranscriptController(host);
      const rows: TestContentRow[] = [
        {
          kind: "content",
          key: "disclosure",
          content: html`<button aria-expanded="false">Expand</button>`,
        },
      ];
      const { container } = await mountTestTranscript(`disclosure-${interrupt}`, rows, transcript);
      host.append(container);
      container.className = "sidebar-region__right-runtime";
      try {
        const row = transcriptRows(container)[0]!;
        let rowTop = 100;
        row.getBoundingClientRect = () => new DOMRect(0, rowTop, 800, 100);
        container.scrollTop = 300;
        container.querySelector("button")!.click();
        rowTop = 160;
        transcript.hostUpdated();
        expect(container.scrollTop).toBe(300);
        if (interrupt) {
          container.dispatchEvent(new WheelEvent("wheel", { deltaY: -100 }));
          container.scrollTop = 200;
          rowTop = 260;
          container.dispatchEvent(new Event("scroll"));
        }
        container.dispatchEvent(
          new CustomEvent(SIDEBAR_GEOMETRY_COMMIT_EVENT, {
            bubbles: true,
            detail: { widthChanged: false },
          }),
        );
        expect(container.scrollTop).toBe(interrupt ? 200 : 360);
      } finally {
        transcript.hostDisconnected();
      }
    },
  );

  it("preserves saved reader restoration when initial rows include typing", async () => {
    const paneId = "restore-initial-typing";
    saveChatSessionScrollPosition(paneId, `agent:main:${paneId}`, {
      scrollTop: 420,
      anchorToEnd: false,
    });
    const rows: TestContentRow[] = [
      { kind: "content", key: "history", content: html`<div>History</div>` },
      { kind: "content", key: "presence:typing", content: html`<div>Typing</div>` },
    ];
    const { container, transcript } = await mountTestTranscript(paneId, rows);
    try {
      // The saved offset initially encounters an unmeasurable DOM. Once the
      // viewport commits, automatic typing follow must not have retired it.
      Object.defineProperties(container, {
        clientHeight: { configurable: true, value: 600 },
        scrollHeight: { configurable: true, value: 2000 },
      });
      transcript.hostUpdated();
      expect(container.scrollTop).toBe(420);
    } finally {
      transcript.hostDisconnected();
    }
  });

  it.each([
    { distance: 0, followEnabled: true },
    { distance: 8, followEnabled: true },
    { distance: 50, followEnabled: true },
    { distance: 0, followEnabled: false },
    { distance: 8, followEnabled: false },
  ])(
    "does not follow another person’s typing ($distance, $followEnabled)",
    async ({ distance, followEnabled }) => {
      const rows = numberedContentRows(12);
      const { container, renderRows, transcript } = await mountTestTranscript(
        `typing-distance-${distance}`,
        rows,
        new ChatTranscriptController(
          {
            addController: () => undefined,
            removeController: () => undefined,
            requestUpdate: () => undefined,
            updateComplete: Promise.resolve(true),
          },
          { canFollowEnd: () => followEnabled },
        ),
      );
      try {
        const total = transcriptSize(container);
        Object.defineProperties(container, {
          clientHeight: { configurable: true, value: 600 },
          scrollHeight: { configurable: true, value: total + 84 },
        });
        for (const observer of resizeObservers) {
          observer.emitTarget(container, 800, 600);
        }
        container.scrollTop = container.scrollHeight - container.clientHeight - distance;
        container.dispatchEvent(new Event("scroll"));
        const readerOffset = container.scrollTop;
        const scrollTo = vi.fn();
        container.scrollTo = scrollTo;
        renderRows([
          ...rows,
          { kind: "content", key: "presence:typing", content: html`<div>Typing</div>` },
        ]);
        expect(scrollTo).not.toHaveBeenCalled();
        expect(container.scrollTop).toBe(readerOffset);
      } finally {
        transcript.hostDisconnected();
      }
    },
  );

  it("does not introduce a typing command while native reader movement is pending", async () => {
    const flushFrames = stubAnimationFrames();
    const rows = numberedContentRows(12);
    const { container, renderRows, transcript } = await mountTestTranscript(
      "typing-interrupt",
      rows,
    );
    try {
      const total = transcriptSize(container);
      Object.defineProperties(container, {
        clientHeight: { configurable: true, value: 600 },
        scrollHeight: { configurable: true, value: total + 88 },
      });
      for (const observer of resizeObservers) {
        observer.emitTarget(container, 800, 600);
      }
      container.scrollTop = total + 88 - 600;
      container.dispatchEvent(new Event("scroll"));
      // Reader movement can reach the DOM before the offset observer runs.
      container.scrollTop -= 100;
      const readerOffset = container.scrollTop;
      const scrollTo = vi.fn();
      container.scrollTo = scrollTo;
      renderRows([
        ...rows,
        { kind: "content", key: "presence:typing", content: html`<div>Typing</div>` },
      ]);
      expect(scrollTo).not.toHaveBeenCalled();
      container.dispatchEvent(new WheelEvent("wheel", { deltaY: -100 }));
      expect(scrollTo).not.toHaveBeenCalled();
      container.scrollTop -= 100;
      container.dispatchEvent(new Event("scroll"));
      scrollTo.mockClear();
      Object.defineProperty(container, "scrollHeight", { configurable: true, value: total + 188 });
      flushFrames();
      expect(scrollTo).not.toHaveBeenCalled();
      expect(container.scrollTop).toBe(readerOffset - 100);
    } finally {
      transcript.hostDisconnected();
    }
  });

  it("re-attaches the virtualizer when a foreign host re-stamps the transcript", async () => {
    const transcript = createTestTranscript();
    const props = threadProps("pane-foreign-stamp");
    const chatFace = document.body.appendChild(document.createElement("div"));
    render(renderChatThread(props, transcript), chatFace);
    transcript.hostConnected();
    transcript.hostUpdated();
    await flushDeferredRowPrune();
    const chatScroller = chatFace.querySelector<HTMLElement>(".chat-thread");
    expect(chatScroller).not.toBeNull();
    expect(observedElements.has(chatScroller!)).toBe(true);

    // Dashboard face: the pane unmounts the transcript and finishes its update.
    render(nothing, chatFace);
    transcript.hostUpdated();
    await flushDeferredRowPrune();

    // Split restore: the sidebar region — a different Lit host that receives
    // the chat template as a property — stamps the transcript in its own
    // update cycle. The pane does not update again, so attachment must follow
    // the ref-recorded DOM identity rather than the pane's render cycle.
    const dock = document.body.appendChild(document.createElement("div"));
    render(renderChatThread(props, transcript), dock);
    await flushDeferredRowPrune();

    const dockScroller = dock.querySelector<HTMLElement>(".chat-thread");
    expect(dockScroller).not.toBeNull();
    expect(observedElements.has(dockScroller!)).toBe(true);
    expect(transcriptRows(dock).length).toBeGreaterThan(0);
    transcript.hostDisconnected();
  });
});
