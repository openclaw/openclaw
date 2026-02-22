import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handleChatScroll, scheduleChatScroll, resetChatScroll } from "./app-scroll.ts";

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

/** Minimal ScrollHost stub for unit tests. */
function createScrollHost(
  overrides: {
    scrollHeight?: number;
    scrollTop?: number;
    clientHeight?: number;
    overflowY?: string;
  } = {},
) {
  const {
    scrollHeight = 2000,
    scrollTop = 1500,
    clientHeight = 500,
    overflowY = "auto",
  } = overrides;

  const container = {
    scrollHeight,
    scrollTop,
    clientHeight,
    style: { overflowY } as unknown as CSSStyleDeclaration,
  };

  // Make getComputedStyle return the overflowY value
  vi.spyOn(window, "getComputedStyle").mockReturnValue({
    overflowY,
  } as unknown as CSSStyleDeclaration);

  const host = {
    updateComplete: Promise.resolve(),
    querySelector: vi.fn().mockReturnValue(container),
    style: { setProperty: vi.fn() } as unknown as CSSStyleDeclaration,
    chatScrollFrame: null as number | null,
    chatScrollTimeout: null as number | null,
    chatHasAutoScrolled: false,
    chatUserNearBottom: true,
    chatNewMessagesBelow: false,
    logsScrollFrame: null as number | null,
    logsAtBottom: true,
    topbarObserver: null as ResizeObserver | null,
  };

  return { host, container };
}

function createScrollEvent(scrollHeight: number, scrollTop: number, clientHeight: number) {
  return {
    currentTarget: { scrollHeight, scrollTop, clientHeight },
  } as unknown as Event;
}

/* ------------------------------------------------------------------ */
/*  handleChatScroll – threshold tests                                 */
/* ------------------------------------------------------------------ */

describe("handleChatScroll", () => {
  it("updates near-bottom state across threshold boundaries", () => {
    const cases = [
      {
        name: "clearly near bottom",
        event: createScrollEvent(2000, 1600, 400),
        expected: true,
      },
      {
        name: "just under threshold",
        event: createScrollEvent(2000, 1151, 400),
        expected: true,
      },
      {
        name: "exactly at threshold",
        event: createScrollEvent(2000, 1150, 400),
        expected: false,
      },
      {
        name: "well above threshold",
        event: createScrollEvent(2000, 500, 400),
        expected: false,
      },
      {
        name: "scrolled up beyond long message",
        event: createScrollEvent(2000, 1100, 400),
        expected: false,
      },
    ] as const;
    for (const testCase of cases) {
      const { host } = createScrollHost({});
      handleChatScroll(host, testCase.event);
      expect(host.chatUserNearBottom, testCase.name).toBe(testCase.expected);
    }
  });
});

/* ------------------------------------------------------------------ */
/*  scheduleChatScroll – respects user scroll position                 */
/* ------------------------------------------------------------------ */

describe("scheduleChatScroll", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((cb) => {
      cb(0);
      return 1;
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("respects near-bottom, force, and initial-load behavior", async () => {
    const cases = [
      {
        name: "near-bottom auto-scroll",
        scrollTop: 1600,
        chatUserNearBottom: true,
        chatHasAutoScrolled: false,
        force: false,
        expectedScrollsToBottom: true,
        expectedNewMessagesBelow: false,
      },
      {
        name: "scrolled-up no-force",
        scrollTop: 500,
        chatUserNearBottom: false,
        chatHasAutoScrolled: false,
        force: false,
        expectedScrollsToBottom: false,
        expectedNewMessagesBelow: true,
      },
      {
        name: "scrolled-up force after initial load",
        scrollTop: 500,
        chatUserNearBottom: false,
        chatHasAutoScrolled: true,
        force: true,
        expectedScrollsToBottom: false,
        expectedNewMessagesBelow: true,
      },
      {
        name: "scrolled-up force on initial load",
        scrollTop: 500,
        chatUserNearBottom: false,
        chatHasAutoScrolled: false,
        force: true,
        expectedScrollsToBottom: true,
        expectedNewMessagesBelow: false,
      },
    ] as const;

    for (const testCase of cases) {
      const { host, container } = createScrollHost({
        scrollHeight: 2000,
        scrollTop: testCase.scrollTop,
        clientHeight: 400,
      });
      host.chatUserNearBottom = testCase.chatUserNearBottom;
      host.chatHasAutoScrolled = testCase.chatHasAutoScrolled;
      host.chatNewMessagesBelow = false;
      const originalScrollTop = container.scrollTop;

      scheduleChatScroll(host, testCase.force);
      await host.updateComplete;

      if (testCase.expectedScrollsToBottom) {
        expect(container.scrollTop, testCase.name).toBe(container.scrollHeight);
      } else {
        expect(container.scrollTop, testCase.name).toBe(originalScrollTop);
      }
      expect(host.chatNewMessagesBelow, testCase.name).toBe(testCase.expectedNewMessagesBelow);
    }
  });
});

/* ------------------------------------------------------------------ */
/*  Streaming: rapid chatStream changes should not reset scroll        */
/* ------------------------------------------------------------------ */

describe("streaming scroll behavior", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((cb) => {
      cb(0);
      return 1;
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("multiple rapid scheduleChatScroll calls do not scroll when user is scrolled up", async () => {
    const { host, container } = createScrollHost({
      scrollHeight: 2000,
      scrollTop: 500,
      clientHeight: 400,
    });
    host.chatUserNearBottom = false;
    host.chatHasAutoScrolled = true;
    const originalScrollTop = container.scrollTop;

    // Simulate rapid streaming token updates
    scheduleChatScroll(host);
    scheduleChatScroll(host);
    scheduleChatScroll(host);
    await host.updateComplete;

    expect(container.scrollTop).toBe(originalScrollTop);
  });

  it("streaming scrolls correctly when user IS at bottom", async () => {
    const { host, container } = createScrollHost({
      scrollHeight: 2000,
      scrollTop: 1600,
      clientHeight: 400,
    });
    host.chatUserNearBottom = true;
    host.chatHasAutoScrolled = true;

    // Simulate streaming
    scheduleChatScroll(host);
    await host.updateComplete;

    expect(container.scrollTop).toBe(container.scrollHeight);
  });
});

/* ------------------------------------------------------------------ */
/*  resetChatScroll                                                    */
/* ------------------------------------------------------------------ */

describe("resetChatScroll", () => {
  it("resets state for new chat session", () => {
    const { host } = createScrollHost({});
    host.chatHasAutoScrolled = true;
    host.chatUserNearBottom = false;

    resetChatScroll(host);

    expect(host.chatHasAutoScrolled).toBe(false);
    expect(host.chatUserNearBottom).toBe(true);
  });
});
