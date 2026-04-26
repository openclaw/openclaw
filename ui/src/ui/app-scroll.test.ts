/* @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  handleChatScroll,
  handleChatWheelIntent,
  resetChatScroll,
  scheduleChatScroll,
} from "./app-scroll.ts";

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
    chatFollowLocked: false,
    chatSmoothAutoScrolling: false,
    chatLastScrollTop: scrollTop,
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

function createWheelEvent(
  deltaY: number,
  scrollHeight: number,
  clientHeight: number,
  target: EventTarget | null = null,
) {
  return {
    deltaY,
    target,
    currentTarget: { scrollHeight, clientHeight },
  } as unknown as WheelEvent;
}

describe("handleChatScroll", () => {
  it("sets chatUserNearBottom=true when within the 450px threshold", () => {
    const { host } = createScrollHost({});
    host.chatUserNearBottom = false;
    host.chatLastScrollTop = 0;

    handleChatScroll(host, createScrollEvent(2000, 1600, 400));

    expect(host.chatUserNearBottom).toBe(true);
  });

  it("sets chatUserNearBottom=true when distance is just under threshold", () => {
    const { host } = createScrollHost({});
    host.chatUserNearBottom = false;
    host.chatLastScrollTop = 0;

    handleChatScroll(host, createScrollEvent(2000, 1151, 400));

    expect(host.chatUserNearBottom).toBe(true);
  });

  it("sets chatUserNearBottom=false when distance is exactly at threshold", () => {
    const { host } = createScrollHost({});

    handleChatScroll(host, createScrollEvent(2000, 1150, 400));

    expect(host.chatUserNearBottom).toBe(false);
  });

  it("sets chatUserNearBottom=false when scrolled well above threshold", () => {
    const { host } = createScrollHost({});

    handleChatScroll(host, createScrollEvent(2000, 500, 400));

    expect(host.chatUserNearBottom).toBe(false);
  });

  it("releases auto-follow immediately when the user scrolls upward away from bottom", () => {
    const { host } = createScrollHost({
      scrollHeight: 2000,
      scrollTop: 1600,
      clientHeight: 400,
    });
    host.chatUserNearBottom = true;
    host.chatLastScrollTop = 1600;

    handleChatScroll(host, createScrollEvent(2000, 1540, 400));

    expect(host.chatUserNearBottom).toBe(false);
    expect(host.chatFollowLocked).toBe(true);
  });

  it("does NOT re-enable follow just because a post-wheel scroll event is still near bottom", () => {
    const { host } = createScrollHost({
      scrollHeight: 2000,
      scrollTop: 2000,
      clientHeight: 400,
    });
    host.chatUserNearBottom = true;
    host.chatLastScrollTop = 2000;

    handleChatWheelIntent(host, createWheelEvent(-120, 2000, 400));
    handleChatScroll(host, createScrollEvent(2000, 1540, 400));

    expect(host.chatUserNearBottom).toBe(false);
    expect(host.chatFollowLocked).toBe(true);
  });

  it("re-enables follow once the user actually returns to the bottom", () => {
    const { host } = createScrollHost({
      scrollHeight: 2000,
      scrollTop: 1576,
      clientHeight: 400,
    });
    host.chatUserNearBottom = false;
    host.chatFollowLocked = true;
    host.chatLastScrollTop = 1540;
    host.chatNewMessagesBelow = true;

    handleChatScroll(host, createScrollEvent(2000, 1576, 400));

    expect(host.chatUserNearBottom).toBe(true);
    expect(host.chatFollowLocked).toBe(false);
    expect(host.chatNewMessagesBelow).toBe(false);
  });

  it("does not treat smooth auto-scroll progress as upward manual scroll intent", () => {
    const { host } = createScrollHost({
      scrollHeight: 2000,
      scrollTop: 1200,
      clientHeight: 400,
    });
    host.chatUserNearBottom = true;
    host.chatSmoothAutoScrolling = true;
    host.chatLastScrollTop = 1200;

    handleChatScroll(host, createScrollEvent(2000, 1300, 400));

    expect(host.chatUserNearBottom).toBe(true);
    expect(host.chatFollowLocked).toBe(false);
  });

  it("releases follow when the user scrolls upward during smooth auto-scroll", () => {
    const { host } = createScrollHost({
      scrollHeight: 2000,
      scrollTop: 1200,
      clientHeight: 400,
    });
    host.chatUserNearBottom = true;
    host.chatSmoothAutoScrolling = true;
    host.chatLastScrollTop = 1600;

    handleChatScroll(host, createScrollEvent(2000, 1100, 400));

    expect(host.chatSmoothAutoScrolling).toBe(false);
    expect(host.chatUserNearBottom).toBe(false);
    expect(host.chatFollowLocked).toBe(true);
  });
});

describe("handleChatWheelIntent", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("cancels pending auto-follow when the user wheels upward", () => {
    const { host } = createScrollHost({});
    host.chatUserNearBottom = true;
    host.chatScrollFrame = 99;
    host.chatScrollTimeout = window.setTimeout(() => {}, 1000);

    handleChatWheelIntent(host, createWheelEvent(-120, 2000, 500));

    expect(host.chatUserNearBottom).toBe(false);
    expect(host.chatFollowLocked).toBe(true);
    expect(host.chatScrollFrame).toBeNull();
    expect(host.chatScrollTimeout).toBeNull();
  });

  it("does not cancel auto-follow when wheeling downward", () => {
    const { host } = createScrollHost({});
    host.chatUserNearBottom = true;

    handleChatWheelIntent(host, createWheelEvent(120, 2000, 500));

    expect(host.chatUserNearBottom).toBe(true);
    expect(host.chatFollowLocked).toBe(false);
  });

  it("does not disengage follow when the chat cannot actually scroll", () => {
    const { host } = createScrollHost({
      scrollHeight: 400,
      clientHeight: 400,
    });
    host.chatUserNearBottom = true;

    handleChatWheelIntent(host, createWheelEvent(-120, 400, 400));

    expect(host.chatUserNearBottom).toBe(true);
    expect(host.chatFollowLocked).toBe(false);
  });

  it("does not disengage follow for bubbled wheel events from nested scrollables that can still scroll up", () => {
    const { host } = createScrollHost({
      scrollHeight: 2000,
      clientHeight: 400,
    });
    host.chatUserNearBottom = true;
    host.chatScrollFrame = 99;
    host.chatScrollTimeout = window.setTimeout(() => {}, 1000);

    const container = document.createElement("div");
    const nestedScrollable = document.createElement("div");
    container.appendChild(nestedScrollable);
    Object.defineProperty(container, "scrollHeight", { value: 2000, configurable: true });
    Object.defineProperty(container, "clientHeight", { value: 400, configurable: true });
    Object.defineProperty(nestedScrollable, "scrollHeight", { value: 600, configurable: true });
    Object.defineProperty(nestedScrollable, "clientHeight", { value: 300, configurable: true });
    Object.defineProperty(nestedScrollable, "scrollTop", { value: 120, configurable: true });

    handleChatWheelIntent(host, {
      deltaY: -120,
      currentTarget: container,
      target: nestedScrollable,
    } as unknown as WheelEvent);

    expect(host.chatUserNearBottom).toBe(true);
    expect(host.chatFollowLocked).toBe(false);
    expect(host.chatScrollFrame).toBe(99);
    expect(host.chatScrollTimeout).not.toBeNull();
  });

  it("does not ignore wheel intent when a nested scrollable is already at the top", () => {
    const { host } = createScrollHost({
      scrollHeight: 2000,
      clientHeight: 400,
    });
    host.chatUserNearBottom = true;
    host.chatScrollFrame = 99;
    host.chatScrollTimeout = window.setTimeout(() => {}, 1000);

    const container = document.createElement("div");
    const nestedScrollable = document.createElement("div");
    container.appendChild(nestedScrollable);
    Object.defineProperty(container, "scrollHeight", { value: 2000, configurable: true });
    Object.defineProperty(container, "clientHeight", { value: 400, configurable: true });
    Object.defineProperty(nestedScrollable, "scrollHeight", { value: 600, configurable: true });
    Object.defineProperty(nestedScrollable, "clientHeight", { value: 300, configurable: true });
    Object.defineProperty(nestedScrollable, "scrollTop", { value: 0, configurable: true });

    vi.spyOn(window, "getComputedStyle").mockImplementation(
      () => ({ overflowY: "auto" }) as CSSStyleDeclaration,
    );

    handleChatWheelIntent(host, {
      deltaY: -120,
      currentTarget: container,
      target: nestedScrollable,
    } as unknown as WheelEvent);

    expect(host.chatUserNearBottom).toBe(false);
    expect(host.chatFollowLocked).toBe(true);
    expect(host.chatScrollFrame).toBeNull();
    expect(host.chatScrollTimeout).toBeNull();
  });

  it("does not ignore wheel intent for a clipped descendant that cannot scroll vertically", () => {
    const { host } = createScrollHost({
      scrollHeight: 2000,
      clientHeight: 400,
    });
    host.chatUserNearBottom = true;
    host.chatScrollFrame = 99;
    host.chatScrollTimeout = window.setTimeout(() => {}, 1000);

    const container = document.createElement("div");
    const clippedBlock = document.createElement("div");
    container.appendChild(clippedBlock);
    Object.defineProperty(container, "scrollHeight", { value: 2000, configurable: true });
    Object.defineProperty(container, "clientHeight", { value: 400, configurable: true });
    Object.defineProperty(clippedBlock, "scrollHeight", { value: 600, configurable: true });
    Object.defineProperty(clippedBlock, "clientHeight", { value: 300, configurable: true });

    vi.spyOn(window, "getComputedStyle").mockImplementation(
      (element) =>
        ({ overflowY: element === clippedBlock ? "hidden" : "auto" }) as CSSStyleDeclaration,
    );

    handleChatWheelIntent(host, {
      deltaY: -120,
      currentTarget: container,
      target: clippedBlock,
    } as unknown as WheelEvent);

    expect(host.chatUserNearBottom).toBe(false);
    expect(host.chatFollowLocked).toBe(true);
    expect(host.chatScrollFrame).toBeNull();
    expect(host.chatScrollTimeout).toBeNull();
  });
});

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

  it("reacquires follow when the chat is no longer scrollable", async () => {
    const { host, container } = createScrollHost({
      scrollHeight: 400,
      scrollTop: 0,
      clientHeight: 400,
    });
    host.chatUserNearBottom = false;
    host.chatFollowLocked = true;
    host.chatHasAutoScrolled = true;
    host.chatNewMessagesBelow = true;

    scheduleChatScroll(host);
    await host.updateComplete;

    expect(container.scrollTop).toBe(container.scrollHeight);
    expect(host.chatUserNearBottom).toBe(true);
    expect(host.chatFollowLocked).toBe(false);
    expect(host.chatNewMessagesBelow).toBe(false);
  });

  it("DOES scroll with force=true on initial load", async () => {
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

  it("does NOT snap back when the user manually scrolls up but is still within the old near-bottom threshold", async () => {
    const { host, container } = createScrollHost({
      scrollHeight: 2000,
      scrollTop: 1540,
      clientHeight: 400,
    });
    host.chatUserNearBottom = false;
    host.chatHasAutoScrolled = true;
    host.chatLastScrollTop = 1540;
    const originalScrollTop = container.scrollTop;

    scheduleChatScroll(host);
    await host.updateComplete;

    expect(container.scrollTop).toBe(originalScrollTop);
    expect(host.chatNewMessagesBelow).toBe(true);
  });
});

describe("handleChatWheelIntent + handleChatScroll interaction", () => {
  it("preserves the wheel-intent lock for small upward deltas that still land within the bottom threshold", () => {
    const { host } = createScrollHost({
      scrollHeight: 2000,
      scrollTop: 2000,
      clientHeight: 400,
    });
    host.chatUserNearBottom = true;
    host.chatLastScrollTop = 1600;

    handleChatWheelIntent(host, createWheelEvent(-5, 2000, 400));
    handleChatScroll(host, createScrollEvent(2000, 1592, 400));

    expect(host.chatUserNearBottom).toBe(false);
    expect(host.chatFollowLocked).toBe(true);
  });
});

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

describe("resetChatScroll", () => {
  it("resets state for new chat session", () => {
    const { host } = createScrollHost({});
    host.chatHasAutoScrolled = true;
    host.chatUserNearBottom = false;
    host.chatFollowLocked = true;
    host.chatLastScrollTop = 1234;

    resetChatScroll(host);

    expect(host.chatHasAutoScrolled).toBe(false);
    expect(host.chatUserNearBottom).toBe(true);
    expect(host.chatFollowLocked).toBe(false);
    expect(host.chatLastScrollTop).toBe(0);
  });
});
