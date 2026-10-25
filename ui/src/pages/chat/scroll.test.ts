import { createEffect, createRoot } from "solid-js";
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { createFrameClock } from "../../test-helpers/animation-frame-clock.ts";
import { flush } from "../../test-helpers/solid-settle.ts";
import { projectChatFields } from "./chat-field-projection.ts";
import type { RenderLifecycle } from "./render-lifecycle.ts";
import {
  CHAT_TRANSCRIPT_END_THRESHOLD_PX,
  cancelChatScroll,
  canAutoFollowChat,
  type ChatScrollHost,
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
  { scrollHeight = 2000, scrollTop = 1500, clientHeight = 500 } = {},
  deferred = false,
) {
  const container = document.createElement("div");
  Object.defineProperties(container, {
    scrollHeight: { configurable: true, writable: true, value: scrollHeight },
    clientHeight: { configurable: true, writable: true, value: clientHeight },
  });
  container.scrollTop = scrollTop;

  let commit = () => {};
  let cancel = () => {};
  const cancelCommit = vi.fn();
  const renderLifecycle: Pick<RenderLifecycle, "afterCommit"> = {
    afterCommit: vi.fn((effect, onCancel) => {
      cancel = () => onCancel?.();
      commit = () => {
        cancel =
          effect(() => {
            cancel = () => {};
          }) ?? (() => {});
      };
      if (!deferred) {
        commit();
      }
      return cancelCommit;
    }),
  };
  const host = {
    renderLifecycle,
    chatScrollElement: vi.fn<() => HTMLElement | null>().mockReturnValue(container),
    chatLastScrollTop: 0,
    chatLastScrollHeight: 0,
    chatHasAutoScrolled: false,
    chatUserNearBottom: true,
    chatFollowLocked: false,
    chatReadingHistory: false,
    chatNewMessagesBelow: false,
    chatIsProgrammaticScroll: () => false,
    chatScrollToEnd: vi.fn<(options: ChatScrollToEndOptions) => boolean>(() => {
      // Record the owner's requested end, independently of viewport clamping.
      container.scrollTop = container.scrollHeight;
      return true;
    }),
  };

  return { host, container, commit: () => commit(), cancel: () => cancel(), cancelCommit };
}

function observeScrollState(host: ChatScrollHost) {
  const changed = vi.fn();
  createRoot((dispose) => {
    onTestFinished(dispose);
    projectChatFields(host, [
      "chatReadingHistory",
      "chatNewMessagesBelow",
      "chatFollowLocked",
      "chatUserNearBottom",
    ]);
    createEffect(
      () => ({
        readingHistory: host.chatReadingHistory,
        newMessagesBelow: host.chatNewMessagesBelow,
        followLocked: host.chatFollowLocked,
        nearBottom: host.chatUserNearBottom,
      }),
      changed,
    );
  });
  flush();
  changed.mockClear();
  return changed;
}

function scroll(host: ChatScrollHost, scrollTop: number, clientHeight = 400) {
  handleChatScroll(
    host,
    Object.defineProperty(new Event("scroll"), "currentTarget", {
      value: { scrollHeight: 2000, scrollTop, clientHeight },
    }),
  );
}

function installAnimationFrameQueue() {
  const framesClock = createFrameClock();
  const callbacks = framesClock.frames;

  vi.spyOn(window, "requestAnimationFrame").mockImplementation(framesClock.request);
  vi.spyOn(window, "cancelAnimationFrame").mockImplementation((id) => {
    framesClock.cancel(id);
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
    scroll(host, 1600 - CHAT_TRANSCRIPT_END_THRESHOLD_PX + 0.5);
    expect(host.chatNewMessagesBelow).toBe(false);
    scroll(host, 1600 - CHAT_TRANSCRIPT_END_THRESHOLD_PX - 0.5);
    expect(host.chatNewMessagesBelow).toBe(true);
  });

  it("keeps reader control when a shrinking dock clamps the viewport to its new end", () => {
    const { host, container } = createScrollHost({ scrollTop: 1600, clientHeight: 400 });
    host.chatLastScrollTop = 1600;
    scroll(host, 1568);
    expect(host.chatFollowLocked).toBe(true);
    scroll(host, 1400, 600);
    scroll(host, 1400, 600);
    expect(host).toMatchObject({ chatFollowLocked: true, chatUserNearBottom: false });
    Object.defineProperty(container, "clientHeight", { value: 600 });
    container.scrollTop = 1400;
    const changed = observeScrollState(host);
    handleChatScrollTakeover(host);
    expect(host).toMatchObject({ chatReadingHistory: true, chatFollowLocked: true });
    handleChatScrollTakeover(host, true);
    expect(host.chatFollowLocked).toBe(false);
    flush();
    expect(changed).toHaveBeenCalledExactlyOnceWith(
      { readingHistory: false, newMessagesBelow: false, followLocked: false, nearBottom: true },
      expect.anything(),
    );
  });
});

describe("scheduleChatScroll", () => {
  beforeEach(immediateFrames);

  it.each([false, true])("guards DOM access until commit (cancelled: %s)", (cancelled) => {
    const { host, container, commit, cancelCommit } = createScrollHost(
      { scrollTop: 1600, clientHeight: 400 },
      true,
    );
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
      const { host, commit, cancel } = createScrollHost({}, true);
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
    const latest = { scrollTop: 200, anchorToEnd: false };
    saveChatSessionScrollPosition("alias-pane", "main", { scrollTop: 100, anchorToEnd: false });
    saveChatSessionScrollPosition("alias-pane", "agent:main:main", latest);
    expect(getChatSessionScrollPosition("alias-pane", "main")).toEqual(latest);
  });

  it("preserves a locked viewport across the same resize", () => {
    const { host, container } = createScrollHost({ scrollTop: 1100, clientHeight: 900 });
    host.chatHasAutoScrolled = true;
    host.chatUserNearBottom = false;
    host.chatFollowLocked = true;
    host.chatLastScrollHeight = 2000;
    Object.defineProperty(container, "clientHeight", { value: 400 });
    scheduleChatScroll(host, false, false, { source: "resize" });
    expect(container.scrollTop).toBe(1100);
    expect(host).toMatchObject({ chatFollowLocked: true, chatNewMessagesBelow: false });
  });

  it("does not re-stick streaming after a user scrolls slightly up near the bottom", () => {
    const { host, container } = createScrollHost({ scrollTop: 1589, clientHeight: 400 });
    host.chatHasAutoScrolled = true;
    host.chatUserNearBottom = true;
    host.chatIsProgrammaticScroll = () => true;
    host.chatLastScrollTop = 1600;
    scroll(host, 1589);
    expect(host).toMatchObject({ chatFollowLocked: true, chatUserNearBottom: false });
    Object.defineProperty(container, "scrollHeight", { value: 2050 });
    scheduleChatScroll(host);
    expect(container.scrollTop).toBe(1589);
    expect(host.chatNewMessagesBelow).toBe(true);
    host.chatIsProgrammaticScroll = () => false;
    container.scrollTop = 1600;
    scroll(host, 1600);
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
      scroll(host, 1400);
      expect(host.chatReadingHistory).toBe(true);
      container.scrollTop = 1600;
      scroll(host, 1600);
      expect(host.chatReadingHistory).toBe(false);
    }
  });
});

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
    expect(host).toMatchObject({ chatHasAutoScrolled: false, chatNewMessagesBelow: true });
  });

  it("keeps the affordance hidden while the owner reports an active command", () => {
    const frames = installAnimationFrameQueue();
    const { host } = createScrollHost({ scrollTop: 500 });
    host.chatScrollToEnd = vi.fn(() => true);
    host.chatIsProgrammaticScroll = () => true;
    host.chatNewMessagesBelow = true;
    host.chatLastScrollTop = 500;
    scheduleChatScroll(host, true, true, { source: "manual" });
    expect(canAutoFollowChat(host)).toBe(false);
    frames.runNext();
    expect(canAutoFollowChat(host)).toBe(false);
    expect(host.chatScrollToEnd).not.toHaveBeenCalled();
    scheduleCommittedChatScroll(host, false, false, { source: "resize" });
    frames.runNext();
    expect(canAutoFollowChat(host)).toBe(true);
    expect(host.chatScrollToEnd).toHaveBeenCalledWith({ behavior: "smooth", source: "manual" });
    expect(frames.callbacks).toHaveLength(0);
    scroll(host, 900);
    expect(host).toMatchObject({ chatLastScrollTop: 900, chatNewMessagesBelow: false });
  });

  it("uses auto under reduced motion without adding a page scroll guard", () => {
    const frames = installAnimationFrameQueue();
    const { host } = createScrollHost({ scrollTop: 500 });
    vi.stubGlobal("matchMedia", vi.fn().mockReturnValue({ matches: true }));
    host.chatHasAutoScrolled = true;
    host.chatUserNearBottom = false;
    scheduleChatScroll(host, true, true, { source: "manual" });
    frames.runNext();
    expect(host.chatScrollToEnd).toHaveBeenCalledWith({ behavior: "auto", source: "manual" });
    expect(frames.callbacks).toHaveLength(0);
  });

  it("user takeover retires queued follow after a downward delta", () => {
    const frames = installAnimationFrameQueue();
    const { host, container } = createScrollHost({ scrollTop: 600 });
    host.chatLastScrollTop = 500;
    scheduleChatScroll(host, true, true, { source: "manual" });
    frames.runNext();
    expect(canAutoFollowChat(host)).toBe(false);
    handleChatScrollTakeover(host);
    expect(frames.callbacks).toHaveLength(0);
    expect(host.chatScrollToEnd).not.toHaveBeenCalled();
    expect(container.scrollTop).toBe(600);
    expect(host).toMatchObject({
      chatHasAutoScrolled: true,
      chatFollowLocked: true,
      chatUserNearBottom: false,
      chatNewMessagesBelow: true,
    });
  });
});

it("retires pending follow at the physical end and publishes the locked state once", () => {
  const { host } = createScrollHost();
  const changed = observeScrollState(host);
  const frames = installAnimationFrameQueue();
  scheduleChatScroll(host, true);
  expect(frames.callbacks).toHaveLength(1);
  lockChatScroll(host);
  expect(frames.callbacks).toHaveLength(0);
  expect(host).toMatchObject({
    chatFollowLocked: true,
    chatUserNearBottom: false,
    chatHasAutoScrolled: true,
  });
  flush();
  expect(changed).toHaveBeenCalledExactlyOnceWith(
    { readingHistory: false, newMessagesBelow: false, followLocked: true, nearBottom: false },
    expect.anything(),
  );
  lockChatScroll(host);
  flush();
  expect(changed).toHaveBeenCalledTimes(1);
  handleChatScrollTakeover(host, true);
  expect(host).toMatchObject({ chatFollowLocked: false, chatUserNearBottom: true });
});
