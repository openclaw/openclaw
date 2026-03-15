import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handleChatScroll, scheduleChatScroll, resetChatScroll } from "./app-scroll.ts";
import type { ChatAutoScrollMode } from "./app-scroll.ts";

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
    scrollTo: undefined as ((options?: ScrollToOptions) => void) | undefined,
  };
  const threadInner: {
    lastElementChild: null;
    querySelectorAll: (selector: string) => HTMLElement[];
  } = {
    lastElementChild: null,
    querySelectorAll: vi.fn((): HTMLElement[] => []),
  };

  // Make getComputedStyle return the overflowY value
  vi.spyOn(window, "getComputedStyle").mockReturnValue({
    overflowY,
  } as unknown as CSSStyleDeclaration);

  const host = {
    updateComplete: Promise.resolve(),
    querySelector: vi.fn().mockImplementation((selector: string) => {
      if (selector === ".chat-thread") {
        return container as unknown as Element;
      }
      if (selector === ".chat-thread-inner") {
        return threadInner as unknown as Element;
      }
      return null;
    }),
    style: { setProperty: vi.fn() } as unknown as CSSStyleDeclaration,
    chatScrollFrame: null as number | null,
    chatScrollTimeout: null as number | null,
    chatHasAutoScrolled: false,
    chatLastScrollTop: null as number | null,
    chatProgrammaticScrollFrom: null as number | null,
    chatProgrammaticScrollTarget: null as number | null,
    chatAutoScrollBlockId: null as string | null,
    chatAutoScrollMode: "bottom" as ChatAutoScrollMode,
    chatBottomFollowPinned: false,
    chatSuppressedBlockId: null as string | null,
    chatUserNearBottom: true,
    chatNewMessagesBelow: false,
    logsScrollFrame: null as number | null,
    logsAtBottom: true,
    topbarObserver: null as ResizeObserver | null,
  };

  return { host, container, threadInner };
}

function createScrollEvent(scrollHeight: number, scrollTop: number, clientHeight: number) {
  return {
    currentTarget: { scrollHeight, scrollTop, clientHeight },
  } as unknown as Event;
}

function maxScrollTop(container: { scrollHeight: number; clientHeight: number }) {
  return container.scrollHeight - container.clientHeight;
}

function createChatBlock(offsetTop: number, id: string, opts: { streaming?: boolean } = {}) {
  const block = document.createElement("div");
  block.setAttribute("data-chat-block", "");
  block.dataset.chatBlockId = id;
  if (opts.streaming) {
    block.setAttribute("data-chat-streaming", "");
  }
  Object.defineProperty(block, "offsetTop", { value: offsetTop, configurable: true });
  return block;
}

/* ------------------------------------------------------------------ */
/*  handleChatScroll – threshold tests                                 */
/* ------------------------------------------------------------------ */

describe("handleChatScroll", () => {
  it("sets chatUserNearBottom=true when exactly at the bottom", () => {
    const { host } = createScrollHost({});
    // distanceFromBottom = 2000 - 1600 - 400 = 0 → clearly near bottom
    const event = createScrollEvent(2000, 1600, 400);
    handleChatScroll(host, event);
    expect(host.chatUserNearBottom).toBe(true);
  });

  it("sets chatUserNearBottom=false after even a tiny upward scroll", () => {
    const { host } = createScrollHost({});
    const event = createScrollEvent(2000, 1599, 400);
    handleChatScroll(host, event);
    expect(host.chatUserNearBottom).toBe(false);
  });

  it("sets chatUserNearBottom=false when distance from bottom is larger", () => {
    const { host } = createScrollHost({});
    const event = createScrollEvent(2000, 1150, 400);
    handleChatScroll(host, event);
    expect(host.chatUserNearBottom).toBe(false);
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

  it("scrolls to bottom when user is near bottom (no force)", async () => {
    const { host, container } = createScrollHost({
      scrollHeight: 2000,
      scrollTop: 1600,
      clientHeight: 400,
    });
    // distanceFromBottom = 2000 - 1600 - 400 = 0 → near bottom
    host.chatUserNearBottom = true;

    scheduleChatScroll(host);
    await host.updateComplete;

    expect(container.scrollTop).toBe(maxScrollTop(container));
  });

  it("does NOT scroll when user is scrolled up and no force", async () => {
    const { host, container } = createScrollHost({
      scrollHeight: 2000,
      scrollTop: 500,
      clientHeight: 400,
    });
    // distanceFromBottom = 2000 - 500 - 400 = 1100 → not near bottom
    host.chatUserNearBottom = false;
    const originalScrollTop = container.scrollTop;

    scheduleChatScroll(host);
    await host.updateComplete;

    expect(container.scrollTop).toBe(originalScrollTop);
  });

  it("does NOT scroll with force=true when user has explicitly scrolled up", async () => {
    const { host, container } = createScrollHost({
      scrollHeight: 2000,
      scrollTop: 500,
      clientHeight: 400,
    });
    // User has scrolled up — chatUserNearBottom is false
    host.chatUserNearBottom = false;
    host.chatHasAutoScrolled = true; // Already past initial load
    const originalScrollTop = container.scrollTop;

    scheduleChatScroll(host, true);
    await host.updateComplete;

    // force=true should still NOT override explicit user scroll-up after initial load
    expect(container.scrollTop).toBe(originalScrollTop);
  });

  it("DOES scroll with force=true on initial load (chatHasAutoScrolled=false)", async () => {
    const { host, container } = createScrollHost({
      scrollHeight: 2000,
      scrollTop: 500,
      clientHeight: 400,
    });
    host.chatUserNearBottom = false;
    host.chatHasAutoScrolled = false; // Initial load

    scheduleChatScroll(host, true);
    await host.updateComplete;

    // On initial load, force should work regardless
    expect(container.scrollTop).toBe(maxScrollTop(container));
  });

  it("keeps force=true pinned to the true bottom for streaming blocks", async () => {
    const { host, container, threadInner } = createScrollHost({
      scrollHeight: 2600,
      scrollTop: 500,
      clientHeight: 400,
    });
    host.chatHasAutoScrolled = false;
    host.chatUserNearBottom = false;
    const latestBlock = createChatBlock(1700, "stream:1", { streaming: true });
    threadInner.querySelectorAll = vi.fn(() => [latestBlock]);

    scheduleChatScroll(host, true);
    await host.updateComplete;

    expect(host.chatAutoScrollMode).toBe("bottom");
    expect(container.scrollTop).toBe(maxScrollTop(container));
    expect(host.chatSuppressedBlockId).toBeNull();
  });

  it("switches the same block from bottom-follow to clamp when streaming starts", async () => {
    const { host, container, threadInner } = createScrollHost({
      scrollHeight: 2000,
      scrollTop: 1600,
      clientHeight: 400,
    });
    host.chatUserNearBottom = true;
    const readingBlock = createChatBlock(1700, "stream:1");
    const streamingBlock = createChatBlock(1700, "stream:1", { streaming: true });
    threadInner.querySelectorAll = vi
      .fn<() => HTMLElement[]>()
      .mockReturnValueOnce([readingBlock])
      .mockReturnValue([streamingBlock]);

    scheduleChatScroll(host);
    await host.updateComplete;

    expect(host.chatAutoScrollMode).toBe("bottom");
    expect(container.scrollTop).toBe(maxScrollTop(container));

    container.scrollHeight = 2600;
    scheduleChatScroll(host);
    await host.updateComplete;

    expect(host.chatAutoScrollMode).toBe("clamp");
    expect(container.scrollTop).toBe(1700);
  });

  it("keeps an explicit bottom pin across a reading-indicator to stream transition", async () => {
    const { host, container, threadInner } = createScrollHost({
      scrollHeight: 2000,
      scrollTop: 500,
      clientHeight: 400,
    });
    const readingBlock = createChatBlock(1700, "stream:1");
    const streamingBlock = createChatBlock(1700, "stream:1", { streaming: true });
    threadInner.querySelectorAll = vi
      .fn<() => HTMLElement[]>()
      .mockReturnValueOnce([readingBlock])
      .mockReturnValue([streamingBlock]);

    scheduleChatScroll(host, true);
    await host.updateComplete;

    expect(host.chatAutoScrollMode).toBe("bottom");
    expect(host.chatBottomFollowPinned).toBe(true);

    container.scrollHeight = 2600;
    scheduleChatScroll(host);
    await host.updateComplete;

    expect(host.chatAutoScrollMode).toBe("bottom");
    expect(container.scrollTop).toBe(maxScrollTop(container));
  });

  it("sets chatNewMessagesBelow when not scrolling due to user position", async () => {
    const { host } = createScrollHost({
      scrollHeight: 2000,
      scrollTop: 500,
      clientHeight: 400,
    });
    host.chatUserNearBottom = false;
    host.chatHasAutoScrolled = true;
    host.chatNewMessagesBelow = false;

    scheduleChatScroll(host);
    await host.updateComplete;

    expect(host.chatNewMessagesBelow).toBe(true);
  });

  it("scrolls once for a new block, then stops following that block as it grows", async () => {
    const { host, container, threadInner } = createScrollHost({
      scrollHeight: 2000,
      scrollTop: 1600,
      clientHeight: 400,
    });
    host.chatUserNearBottom = true;
    const latestBlock = createChatBlock(1700, "stream:1", { streaming: true });
    threadInner.querySelectorAll = vi.fn(() => [latestBlock]);

    scheduleChatScroll(host);
    await host.updateComplete;
    expect(container.scrollTop).toBe(maxScrollTop(container));

    container.scrollHeight = 2600;
    scheduleChatScroll(host);
    await host.updateComplete;

    expect(container.scrollTop).toBe(1700);
    expect(host.chatSuppressedBlockId).toBe("stream:1");

    container.scrollTop = 1800;
    container.scrollHeight = 2800;
    scheduleChatScroll(host);
    await host.updateComplete;

    expect(container.scrollTop).toBe(1800);
  });

  it("stops auto-scroll for the current block after a small upward user scroll", async () => {
    const { host, container, threadInner } = createScrollHost({
      scrollHeight: 2000,
      scrollTop: 1600,
      clientHeight: 400,
    });
    host.chatUserNearBottom = true;
    const latestBlock = createChatBlock(1700, "stream:1", { streaming: true });
    threadInner.querySelectorAll = vi.fn(() => [latestBlock]);

    scheduleChatScroll(host);
    await host.updateComplete;
    expect(container.scrollTop).toBe(maxScrollTop(container));

    container.scrollTop = 1590;
    handleChatScroll(host, {
      currentTarget: container,
    } as unknown as Event);

    container.scrollHeight = 2600;
    scheduleChatScroll(host);
    await host.updateComplete;

    expect(container.scrollTop).toBe(1590);
  });

  it("lets the user resume bottom-follow for the current stream by scrolling back to bottom", async () => {
    const { host, container, threadInner } = createScrollHost({
      scrollHeight: 2000,
      scrollTop: 1600,
      clientHeight: 400,
    });
    host.chatUserNearBottom = true;
    const latestBlock = createChatBlock(1700, "stream:1", { streaming: true });
    threadInner.querySelectorAll = vi.fn(() => [latestBlock]);

    scheduleChatScroll(host);
    await host.updateComplete;

    container.scrollHeight = 2600;
    scheduleChatScroll(host);
    await host.updateComplete;

    expect(container.scrollTop).toBe(1700);
    expect(host.chatSuppressedBlockId).toBe("stream:1");

    container.scrollTop = maxScrollTop(container);
    handleChatScroll(host, {
      currentTarget: container,
    } as unknown as Event);

    expect(host.chatAutoScrollMode).toBe("bottom");
    expect(host.chatSuppressedBlockId).toBeNull();

    container.scrollHeight = 2800;
    container.scrollTo = undefined;
    scheduleChatScroll(host);
    await host.updateComplete;

    expect(container.scrollTop).toBe(maxScrollTop(container));
    expect(host.chatSuppressedBlockId).toBeNull();
  });

  it("keeps following bottom for a loading indicator block", async () => {
    const { host, container, threadInner } = createScrollHost({
      scrollHeight: 2000,
      scrollTop: 1600,
      clientHeight: 400,
    });
    host.chatUserNearBottom = true;
    const latestBlock = createChatBlock(1700, "loading:1");
    threadInner.querySelectorAll = vi.fn(() => [latestBlock]);

    scheduleChatScroll(host);
    await host.updateComplete;
    expect(container.scrollTop).toBe(maxScrollTop(container));

    container.scrollHeight = 2600;
    scheduleChatScroll(host);
    await host.updateComplete;

    expect(container.scrollTop).toBe(maxScrollTop(container));
    expect(host.chatSuppressedBlockId).toBeNull();
  });

  it("stores the intended smooth-scroll destination for follow-state tracking", async () => {
    const { host, container, threadInner } = createScrollHost({
      scrollHeight: 2600,
      scrollTop: 1800,
      clientHeight: 400,
    });
    host.chatUserNearBottom = true;
    host.chatAutoScrollBlockId = "stream:1";
    host.chatAutoScrollMode = "clamp";
    const latestBlock = createChatBlock(1700, "stream:1", { streaming: true });
    threadInner.querySelectorAll = vi.fn(() => [latestBlock]);
    container.scrollTo = vi.fn();

    scheduleChatScroll(host, false, true);
    await host.updateComplete;

    expect(container.scrollTo).toHaveBeenCalledWith({ top: 1700, behavior: "smooth" });
    expect(container.scrollTop).toBe(1800);
    expect(host.chatLastScrollTop).toBe(1700);
    expect(host.chatProgrammaticScrollFrom).toBe(1800);
    expect(host.chatProgrammaticScrollTarget).toBe(1700);
  });

  it("does not suppress follow mode during a smooth jump-to-bottom animation", async () => {
    const { host, container, threadInner } = createScrollHost({
      scrollHeight: 2600,
      scrollTop: 500,
      clientHeight: 400,
    });
    host.chatHasAutoScrolled = false;
    host.chatUserNearBottom = false;
    const latestBlock = createChatBlock(1700, "stream:1", { streaming: true });
    threadInner.querySelectorAll = vi.fn(() => [latestBlock]);
    container.scrollTo = vi.fn();

    scheduleChatScroll(host, true, true);
    await host.updateComplete;

    container.scrollTop = 1000;
    handleChatScroll(host, {
      currentTarget: container,
    } as unknown as Event);

    expect(host.chatSuppressedBlockId).toBeNull();
    expect(host.chatBottomFollowPinned).toBe(true);

    container.scrollHeight = 2800;
    container.scrollTo = undefined;
    scheduleChatScroll(host);
    await host.updateComplete;

    expect(host.chatNewMessagesBelow).toBe(false);
    expect(container.scrollTop).toBe(maxScrollTop(container));
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

    expect(container.scrollTop).toBe(maxScrollTop(container));
  });
});

/* ------------------------------------------------------------------ */
/*  resetChatScroll                                                    */
/* ------------------------------------------------------------------ */

describe("resetChatScroll", () => {
  it("resets state for new chat session", () => {
    const { host } = createScrollHost({});
    host.chatHasAutoScrolled = true;
    host.chatLastScrollTop = 1700;
    host.chatProgrammaticScrollFrom = 1800;
    host.chatProgrammaticScrollTarget = 1700;
    host.chatAutoScrollBlockId = "stream:1";
    host.chatAutoScrollMode = "clamp";
    host.chatBottomFollowPinned = true;
    host.chatSuppressedBlockId = "stream:1";
    host.chatUserNearBottom = false;

    resetChatScroll(host);

    expect(host.chatHasAutoScrolled).toBe(false);
    expect(host.chatLastScrollTop).toBeNull();
    expect(host.chatProgrammaticScrollFrom).toBeNull();
    expect(host.chatProgrammaticScrollTarget).toBeNull();
    expect(host.chatAutoScrollBlockId).toBeNull();
    expect(host.chatAutoScrollMode).toBe("bottom");
    expect(host.chatBottomFollowPinned).toBe(false);
    expect(host.chatSuppressedBlockId).toBeNull();
    expect(host.chatUserNearBottom).toBe(true);
  });
});
