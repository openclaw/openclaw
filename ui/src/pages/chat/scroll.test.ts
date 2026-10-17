import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RenderLifecycle } from "./render-lifecycle.ts";
import {
  CHAT_TRANSCRIPT_END_THRESHOLD_PX,
  cancelChatScroll,
  canAutoFollowChat,
  type ChatScrollToEndOptions,
  getChatSessionScrollPosition,
  handleChatScroll,
  handleChatScrollTakeover,
  lockChatScroll,
  resetChatScroll,
  saveChatSessionScrollPosition,
  scheduleChatScroll,
  scheduleCommittedChatScroll,
} from "./scroll.ts";

function createScrollHost(
  overrides: {
    scrollHeight?: number;
    scrollTop?: number;
    clientHeight?: number;
  } = {},
) {
  const { scrollHeight = 2000, scrollTop = 1500, clientHeight = 500 } = overrides;

  const container = document.createElement("div");
  Object.defineProperties(container, {
    scrollHeight: { configurable: true, writable: true, value: scrollHeight },
    clientHeight: { configurable: true, writable: true, value: clientHeight },
  });
  container.scrollTop = scrollTop;

  const renderLifecycle: RenderLifecycle = {
    invalidate: vi.fn(),
    afterCommit: vi.fn((effect) => {
      renderLifecycle.invalidate();
      effect(() => undefined);
      return vi.fn();
    }),
  };
  const host = {
    renderLifecycle,
    updateComplete: Promise.resolve(),
    chatScrollElement: vi.fn<() => HTMLElement | null>().mockReturnValue(container),
    chatLastScrollTop: 0,
    chatLastScrollHeight: 0,
    chatHasAutoScrolled: false,
    chatUserNearBottom: true,
    chatFollowLocked: false,
    chatReadingHistory: false,
    chatNewMessagesBelow: false,
    chatIsProgrammaticScroll: () => false,
    chatScrollToEnd: vi.fn((options: ChatScrollToEndOptions) => {
      if (typeof container.scrollTo === "function") {
        container.scrollTo({ top: container.scrollHeight, behavior: options.behavior });
      } else {
        container.scrollTop = container.scrollHeight;
      }
      return true;
    }),
  };

  return { host, container };
}

function createScrollEvent(scrollHeight: number, scrollTop: number, clientHeight: number) {
  const event = new Event("scroll");
  Object.defineProperty(event, "currentTarget", {
    value: { scrollHeight, scrollTop, clientHeight },
  });
  return event;
}

function installAnimationFrameQueue() {
  const callbacks = new Map<number, FrameRequestCallback>();
  let nextId = 0;
  vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
    callbacks.set(++nextId, callback);
    return nextId;
  });
  vi.spyOn(window, "cancelAnimationFrame").mockImplementation((id) => {
    callbacks.delete(id);
  });
  return {
    get callbacks() {
      return [...callbacks.values()];
    },
    runNext(timestamp = 0) {
      const entry = callbacks.entries().next().value;
      if (!entry) {
        throw new Error("expected a queued animation frame");
      }
      const [id, callback] = entry;
      callbacks.delete(id);
      callback(timestamp);
    },
  };
}

function immediateFrames() {
  vi.useFakeTimers();
  vi.spyOn(window, "requestAnimationFrame").mockImplementation((cb) => {
    cb(0);
    return 1;
  });
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("handleChatScroll", () => {
  it("shows the scroll-to-bottom affordance only beyond the shared end boundary", () => {
    const { host } = createScrollHost();
    host.chatLastScrollTop = 1600;
    handleChatScroll(
      host,
      createScrollEvent(2000, 1600 - CHAT_TRANSCRIPT_END_THRESHOLD_PX + 0.5, 400),
    );
    expect(host.chatNewMessagesBelow).toBe(false);
    handleChatScroll(
      host,
      createScrollEvent(2000, 1600 - CHAT_TRANSCRIPT_END_THRESHOLD_PX - 0.5, 400),
    );
    expect(host.chatNewMessagesBelow).toBe(true);
  });

  it("keeps reader control when a shrinking dock clamps the viewport to its new end", () => {
    const { host, container } = createScrollHost({ scrollTop: 1600, clientHeight: 400 });
    host.chatLastScrollTop = 1600;
    handleChatScroll(host, createScrollEvent(2000, 1568, 400));
    expect(host.chatFollowLocked).toBe(true);
    handleChatScroll(host, createScrollEvent(2000, 1400, 600));
    handleChatScroll(host, createScrollEvent(2000, 1400, 600));
    expect(host).toMatchObject({ chatFollowLocked: true, chatUserNearBottom: false });
    Object.defineProperty(container, "clientHeight", { value: 600 });
    container.scrollTop = 1400;
    const invalidate = vi.fn();
    host.renderLifecycle.invalidate = invalidate;
    handleChatScrollTakeover(host);
    expect(host).toMatchObject({ chatReadingHistory: true, chatFollowLocked: true });
    handleChatScrollTakeover(host, true);
    expect(host.chatFollowLocked).toBe(false);
    expect(invalidate).toHaveBeenCalled();
  });
});

describe("scheduleChatScroll", () => {
  beforeEach(immediateFrames);

  it.each([false, true])("guards DOM access until commit (cancelled: %s)", (cancelled) => {
    const { host, container } = createScrollHost({ scrollTop: 1600, clientHeight: 400 });
    let commit = () => {};
    const cancelCommit = vi.fn();
    host.renderLifecycle.afterCommit = vi.fn((effect) => {
      host.renderLifecycle.invalidate();
      commit = () => {
        effect(() => undefined);
      };
      return cancelCommit;
    });
    scheduleChatScroll(host);
    expect(host.chatScrollElement).not.toHaveBeenCalled();
    expect(container.scrollTop).toBe(1600);
    if (cancelled) {
      cancelChatScroll(host);
    }
    commit();
    if (cancelled) {
      expect(cancelCommit).toHaveBeenCalledOnce();
      expect(host.chatScrollElement).not.toHaveBeenCalled();
    } else {
      expect(container.scrollTop).toBe(container.scrollHeight);
    }
  });

  it.each(["before commit", "after commit"])(
    "releases a cancelled render's manual jump %s",
    (phase) => {
      const frames = installAnimationFrameQueue();
      const { host } = createScrollHost();
      let commit = () => {};
      let cancel = () => {};
      host.renderLifecycle.afterCommit = (effect, onCancel) => {
        cancel = () => onCancel?.();
        commit = () => {
          const cleanup = effect(() => {
            cancel = () => {};
          });
          cancel = cleanup ?? (() => {});
        };
        return () => cancel();
      };
      scheduleChatScroll(host, true, false, { source: "manual" });
      if (phase === "after commit") {
        commit();
      }
      cancel();
      expect(frames.callbacks).toHaveLength(0);
      scheduleCommittedChatScroll(host);
      expect(frames.callbacks).toHaveLength(1);
      frames.runNext();
      expect(host.chatScrollToEnd).toHaveBeenCalledExactlyOnceWith({
        behavior: "auto",
        source: "auto",
      });
    },
  );

  it("keeps only the newest equivalent session-key scroll position", () => {
    saveChatSessionScrollPosition("alias-pane", "main", { scrollTop: 100, anchorToEnd: false });
    saveChatSessionScrollPosition("alias-pane", "agent:main:main", {
      scrollTop: 200,
      anchorToEnd: false,
    });
    expect(getChatSessionScrollPosition("alias-pane", "main")).toEqual({
      scrollTop: 200,
      anchorToEnd: false,
    });
  });

  it("preserves a locked viewport across the same resize", async () => {
    const { host, container } = createScrollHost({ scrollTop: 1100, clientHeight: 900 });
    host.chatHasAutoScrolled = true;
    host.chatUserNearBottom = false;
    host.chatFollowLocked = true;
    host.chatLastScrollHeight = 2000;
    Object.defineProperty(container, "clientHeight", { value: 400 });
    scheduleChatScroll(host, false, false, { source: "resize" });
    await host.updateComplete;
    expect(container.scrollTop).toBe(1100);
    expect(host.chatFollowLocked).toBe(true);
    expect(host.chatNewMessagesBelow).toBe(false);
  });

  it("does not re-stick streaming after a user scrolls slightly up near the bottom", async () => {
    const { host, container } = createScrollHost({ scrollTop: 1589, clientHeight: 400 });
    host.chatHasAutoScrolled = true;
    host.chatUserNearBottom = true;
    host.chatIsProgrammaticScroll = () => true;
    host.chatLastScrollTop = 1600;
    handleChatScroll(host, createScrollEvent(2000, 1589, 400));
    expect(host).toMatchObject({ chatFollowLocked: true, chatUserNearBottom: false });
    Object.defineProperty(container, "scrollHeight", { value: 2050 });
    scheduleChatScroll(host);
    await host.updateComplete;
    expect(container.scrollTop).toBe(1589);
    expect(host.chatNewMessagesBelow).toBe(true);
    host.chatIsProgrammaticScroll = () => false;
    container.scrollTop = 1600;
    handleChatScroll(host, createScrollEvent(2000, 1600, 400));
    expect(host).toMatchObject({
      chatFollowLocked: false,
      chatUserNearBottom: true,
      chatNewMessagesBelow: false,
    });
  });

  it.each([1600, 1200])("settles a manual return only at the end (starting at %s)", (scrollTop) => {
    const { host, container } = createScrollHost({ scrollTop, clientHeight: 400 });
    Object.assign(host, {
      chatHasAutoScrolled: true,
      chatFollowLocked: true,
      chatReadingHistory: true,
      chatLastScrollTop: scrollTop,
    });
    host.chatScrollToEnd.mockImplementation(() => true);
    if (scrollTop < 1600) {
      host.chatIsProgrammaticScroll = () => container.scrollTop < 1592;
    }
    scheduleChatScroll(host, true, true, { source: "manual" });
    expect(host).toMatchObject({ chatFollowLocked: false, chatReadingHistory: scrollTop < 1600 });
    if (scrollTop < 1600) {
      container.scrollTop = 1400;
      handleChatScroll(host, createScrollEvent(2000, 1400, 400));
      expect(host.chatReadingHistory).toBe(true);
      container.scrollTop = 1600;
      handleChatScroll(host, createScrollEvent(2000, 1600, 400));
      expect(host.chatReadingHistory).toBe(false);
    }
  });
});

describe("resetChatScroll", () => {
  it("resets state for new chat session", () => {
    const { host } = createScrollHost();
    host.chatHasAutoScrolled = true;
    host.chatUserNearBottom = false;
    host.chatFollowLocked = true;
    host.chatLastScrollTop = 300;
    resetChatScroll(host);
    expect(host).toMatchObject({
      chatHasAutoScrolled: false,
      chatUserNearBottom: true,
      chatFollowLocked: false,
      chatLastScrollTop: 0,
    });
    expect(host.chatIsProgrammaticScroll()).toBe(false);
  });
});

describe("programmatic scroll ownership", () => {
  beforeEach(immediateFrames);

  it("leaves restoration policy unchanged when automatic follow is declined", () => {
    const { host, container } = createScrollHost({ scrollTop: 420 });
    host.chatScrollToEnd = vi.fn(() => false);
    host.chatIsProgrammaticScroll = () => true;
    host.chatNewMessagesBelow = true;
    scheduleChatScroll(host, true);
    expect(host.chatScrollToEnd).toHaveBeenCalledWith({ behavior: "auto", source: "auto" });
    expect(container.scrollTop).toBe(420);
    expect(host.chatHasAutoScrolled).toBe(false);
    expect(host.chatNewMessagesBelow).toBe(true);
  });

  it("keeps the affordance hidden while the owner reports an active command", async () => {
    const frames = installAnimationFrameQueue();
    const { host } = createScrollHost({ scrollTop: 500 });
    host.chatScrollToEnd = vi.fn(() => true);
    host.chatIsProgrammaticScroll = () => true;
    host.chatNewMessagesBelow = true;
    host.chatLastScrollTop = 500;
    scheduleChatScroll(host, true, true, { source: "manual" });
    await host.updateComplete;
    expect(canAutoFollowChat(host)).toBe(false);
    frames.runNext();
    expect(canAutoFollowChat(host)).toBe(false);
    expect(host.chatScrollToEnd).not.toHaveBeenCalled();
    scheduleCommittedChatScroll(host, false, false, { source: "resize" });
    frames.runNext();
    expect(canAutoFollowChat(host)).toBe(true);
    expect(host.chatScrollToEnd).toHaveBeenCalledWith({ behavior: "smooth", source: "manual" });
    expect(frames.callbacks).toHaveLength(0);
    handleChatScroll(host, createScrollEvent(2000, 900, 400));
    expect(host.chatLastScrollTop).toBe(900);
    expect(host.chatNewMessagesBelow).toBe(false);
  });

  it("uses auto under reduced motion without adding a page scroll guard", async () => {
    const frames = installAnimationFrameQueue();
    const { host } = createScrollHost({ scrollTop: 500 });
    vi.stubGlobal("matchMedia", vi.fn().mockReturnValue({ matches: true }));
    host.chatHasAutoScrolled = true;
    host.chatUserNearBottom = false;
    scheduleChatScroll(host, true, true, { source: "manual" });
    await host.updateComplete;
    frames.runNext();
    expect(host.chatScrollToEnd).toHaveBeenCalledWith({ behavior: "auto", source: "manual" });
    expect(frames.callbacks).toHaveLength(0);
  });

  it("user takeover retires queued follow after a downward delta", () => {
    const frames = installAnimationFrameQueue();
    const { host, container } = createScrollHost({ scrollTop: 600 });
    host.chatLastScrollTop = 500;
    scheduleChatScroll(host, true, true, { source: "manual" });
    // Reader input can arrive while the command waits for measured layout.
    frames.runNext();
    expect(canAutoFollowChat(host)).toBe(false);
    handleChatScrollTakeover(host);
    expect(frames.callbacks).toHaveLength(0);
    expect(host.chatScrollToEnd).not.toHaveBeenCalled();
    expect(container.scrollTop).toBe(600);
    expect(host.chatHasAutoScrolled).toBe(true);
    expect(host).toMatchObject({ chatFollowLocked: true, chatUserNearBottom: false });
    expect(host.chatNewMessagesBelow).toBe(true);
  });
});

it("retires pending follow at the physical end and publishes the locked state once", () => {
  const { host } = createScrollHost();
  const invalidate = vi.fn();
  host.renderLifecycle.invalidate = invalidate;
  const frames = installAnimationFrameQueue();
  scheduleChatScroll(host, true);
  expect(frames.callbacks).toHaveLength(1);
  invalidate.mockClear();
  lockChatScroll(host);
  expect(frames.callbacks).toHaveLength(0);
  expect(host).toMatchObject({ chatFollowLocked: true, chatUserNearBottom: false });
  expect(host.chatHasAutoScrolled).toBe(true);
  expect(invalidate).toHaveBeenCalledTimes(1);
  lockChatScroll(host);
  expect(invalidate).toHaveBeenCalledTimes(1);
  handleChatScrollTakeover(host, true);
  expect(host.chatFollowLocked).toBe(false);
  expect(host.chatUserNearBottom).toBe(true);
});
