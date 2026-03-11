import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  handleChatScroll,
  initChatScrollObserver,
  scheduleChatScroll,
  resetChatScroll,
  teardownChatScrollObserver,
} from "./app-scroll.ts";

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

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

  vi.spyOn(window, "getComputedStyle").mockReturnValue({
    overflowY,
  } as unknown as CSSStyleDeclaration);

  const host = {
    updateComplete: Promise.resolve(),
    querySelector: vi.fn().mockReturnValue(container),
    style: { setProperty: vi.fn() } as unknown as CSSStyleDeclaration,
    chatScrollFrame: null as number | null,
    chatScrollObserver: null as IntersectionObserver | null,
    chatHasAutoScrolled: false,
    chatUserNearBottom: true,
    chatNewMessagesBelow: false,
    logsScrollFrame: null as number | null,
    logsAtBottom: true,
    topbarObserver: null as ResizeObserver | null,
  };

  return { host, container };
}

/* ------------------------------------------------------------------ */
/*  handleChatScroll – clears indicator when at bottom                 */
/* ------------------------------------------------------------------ */

describe("handleChatScroll", () => {
  it("clears chatNewMessagesBelow when user is at bottom", () => {
    const { host } = createScrollHost({});
    host.chatUserNearBottom = true;
    host.chatNewMessagesBelow = true;
    handleChatScroll(host, new Event("scroll"));
    expect(host.chatNewMessagesBelow).toBe(false);
  });

  it("does not clear chatNewMessagesBelow when user is scrolled up", () => {
    const { host } = createScrollHost({});
    host.chatUserNearBottom = false;
    host.chatNewMessagesBelow = true;
    handleChatScroll(host, new Event("scroll"));
    expect(host.chatNewMessagesBelow).toBe(true);
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
    host.chatUserNearBottom = true;

    scheduleChatScroll(host);
    await host.updateComplete;

    expect(container.scrollTop).toBe(container.scrollHeight);
  });

  it("does NOT scroll when user is scrolled up and no force", async () => {
    const { host, container } = createScrollHost({
      scrollHeight: 2000,
      scrollTop: 500,
      clientHeight: 400,
    });
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
    host.chatUserNearBottom = false;
    host.chatHasAutoScrolled = true;
    const originalScrollTop = container.scrollTop;

    scheduleChatScroll(host, true);
    await host.updateComplete;

    expect(container.scrollTop).toBe(originalScrollTop);
  });

  it("DOES scroll with force=true on initial load (chatHasAutoScrolled=false)", async () => {
    const { host, container } = createScrollHost({
      scrollHeight: 2000,
      scrollTop: 500,
      clientHeight: 400,
    });
    host.chatUserNearBottom = false;
    host.chatHasAutoScrolled = false;

    scheduleChatScroll(host, true);
    await host.updateComplete;

    expect(container.scrollTop).toBe(container.scrollHeight);
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

    scheduleChatScroll(host);
    await host.updateComplete;

    expect(container.scrollTop).toBe(container.scrollHeight);
  });
});

/* ------------------------------------------------------------------ */
/*  IntersectionObserver init/teardown                                  */
/* ------------------------------------------------------------------ */

describe("initChatScrollObserver", () => {
  it("creates an IntersectionObserver on the sentinel", () => {
    const sentinel = document.createElement("div");
    const container = document.createElement("div");
    const host = {
      updateComplete: Promise.resolve(),
      querySelector: vi.fn((sel: string) => (sel === ".chat-scroll-anchor" ? sentinel : container)),
      style: { setProperty: vi.fn() } as unknown as CSSStyleDeclaration,
      chatScrollFrame: null as number | null,
      chatScrollObserver: null as IntersectionObserver | null,
      chatHasAutoScrolled: false,
      chatUserNearBottom: true,
      chatNewMessagesBelow: false,
      logsScrollFrame: null as number | null,
      logsAtBottom: true,
      topbarObserver: null as ResizeObserver | null,
    };

    initChatScrollObserver(host);
    expect(host.chatScrollObserver).not.toBeNull();
    expect(host.chatScrollObserver).toBeInstanceOf(IntersectionObserver);
  });

  it("disconnects on teardown", () => {
    const sentinel = document.createElement("div");
    const container = document.createElement("div");
    const host = {
      updateComplete: Promise.resolve(),
      querySelector: vi.fn((sel: string) => (sel === ".chat-scroll-anchor" ? sentinel : container)),
      style: { setProperty: vi.fn() } as unknown as CSSStyleDeclaration,
      chatScrollFrame: null as number | null,
      chatScrollObserver: null as IntersectionObserver | null,
      chatHasAutoScrolled: false,
      chatUserNearBottom: true,
      chatNewMessagesBelow: false,
      logsScrollFrame: null as number | null,
      logsAtBottom: true,
      topbarObserver: null as ResizeObserver | null,
    };

    initChatScrollObserver(host);
    const observer = host.chatScrollObserver!;
    const disconnectSpy = vi.spyOn(observer, "disconnect");

    teardownChatScrollObserver(host);
    expect(disconnectSpy).toHaveBeenCalled();
    expect(host.chatScrollObserver).toBeNull();
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
