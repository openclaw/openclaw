/* @vitest-environment jsdom */
import { Virtualizer } from "@tanstack/virtual-core";
import { expect, it, onTestFinished, vi } from "vitest";
import { makeChatHost } from "../chat-host.test-support.ts";
import { canAutoFollowChat, handleChatScroll } from "../scroll.ts";
import { TranscriptEndAnchor } from "./chat-transcript-end-anchor.ts";
import { TranscriptLayoutOwner } from "./chat-transcript-layout-owner.ts";
import {
  isTranscriptProgrammaticScroll,
  isTranscriptMaintenanceScroll,
  observeTranscriptOffset,
  scrollTranscriptOffset,
  TranscriptOffsetState,
} from "./chat-transcript-offset-observer.ts";
import { TranscriptPrependAnchor } from "./chat-transcript-prepend-anchor.ts";
import { subscribeTranscriptScroll } from "./chat-transcript-scroll-events.ts";

it.each([false, true])(
  "classifies an idle or pending offset without layout (pending: %s)",
  (pending) => {
    const state = new TranscriptOffsetState();
    if (pending) {
      state.pendingScrollOffset = { offset: 200, stableFrames: 0, zeroMaxFrames: 0 };
      state.maintenanceScrollOffset = 100;
    }
    const element = document.createElement("div");
    const readGeometry = vi.fn(() => 100);
    for (const key of ["scrollTop", "scrollHeight", "clientHeight"]) {
      Object.defineProperty(element, key, { get: readGeometry });
    }
    expect(isTranscriptProgrammaticScroll(state, element)).toBe(pending);
    expect(readGeometry).not.toHaveBeenCalled();
  },
);

it("keeps maintenance and active commands owned until the committed viewport settles", () => {
  const state = new TranscriptOffsetState();
  const element = document.createElement("div");
  Object.defineProperties(element, {
    clientHeight: { value: 200 },
    scrollHeight: { value: 1000 },
  });
  state.maintenanceScrollOffset = 900;
  element.scrollTop = 800;
  expect(isTranscriptProgrammaticScroll(state, element)).toBe(true);
  element.scrollTop = 400;
  expect(isTranscriptProgrammaticScroll(state, element)).toBe(false);
  state.maintenanceScrollOffset = null;
  state.scrollCommand = { behavior: "smooth", target: "end" };
  expect(isTranscriptProgrammaticScroll(state, element)).toBe(true);
  element.scrollTop = 800;
  expect(isTranscriptProgrammaticScroll(state, element)).toBe(false);
});

it("delivers native offsets without checking end geometry when no end command is active", () => {
  const element = document.createElement("div");
  const readGeometry = vi.fn(() => 100);
  for (const key of ["scrollHeight", "clientHeight"]) {
    Object.defineProperty(element, key, { get: readGeometry });
  }
  const virtualizer = new Virtualizer<HTMLDivElement, HTMLElement>({
    count: 0,
    getScrollElement: () => element,
    estimateSize: () => 40,
    scrollToFn: vi.fn(),
    observeElementRect: vi.fn(),
    observeElementOffset: vi.fn(),
  });
  virtualizer.scrollElement = element;
  virtualizer.targetWindow = window;
  const onOffset = vi.fn();
  const deliver = vi.fn();
  onTestFinished(
    observeTranscriptOffset(
      {
        state: new TranscriptOffsetState(),
        getScrollElement: () => element,
        endAnchor: new TranscriptEndAnchor(() => {}),
        prependAnchor: new TranscriptPrependAnchor(new Map(), vi.fn()),
        canFollowEnd: () => false,
        isProgrammaticScroll: () => false,
        isMaintenanceScroll: () => false,
        cancelScroll: vi.fn(),
        onLayoutCorrection: vi.fn(),
        invalidate: vi.fn(),
        onOffset,
        onReaderScroll: vi.fn(),
        onComposerLayout: vi.fn(),
      },
      virtualizer,
      deliver,
    ),
  );
  element.scrollTop = 20;
  element.dispatchEvent(new Event("scroll"));
  expect(deliver).toHaveBeenCalledWith(20, true);
  expect(onOffset).toHaveBeenCalledOnce();
  expect(readGeometry).not.toHaveBeenCalled();
});

function observedMaintenance(useScrollendEvent = false) {
  vi.useFakeTimers();
  const state = new TranscriptOffsetState();
  const element = document.createElement("div");
  let maximum = 800;
  Object.defineProperties(element, {
    clientHeight: { value: 200 },
    scrollHeight: { get: () => maximum + 200 },
  });
  element.scrollTop = 800;
  element.scrollTo = (options?: ScrollToOptions | number) => {
    if (typeof options === "object") {
      element.scrollTop = Math.max(0, Math.min(options.top ?? element.scrollTop, maximum));
    }
  };
  const virtualizer = new Virtualizer<HTMLDivElement, HTMLElement>({
    useScrollendEvent,
    count: 0,
    getScrollElement: () => element,
    estimateSize: () => 40,
    scrollToFn: vi.fn(),
    observeElementRect: vi.fn(),
    observeElementOffset: vi.fn(),
  });
  virtualizer.scrollElement = element;
  virtualizer.targetWindow = window;
  virtualizer.scrollOffset = element.scrollTop;
  const programmatic = () => isTranscriptProgrammaticScroll(state, element);
  const deliveries: Array<{ offset: number; scrolling: boolean; programmatic: boolean }> = [];
  const owner = {
    state,
    getScrollElement: () => element,
    endAnchor: new TranscriptEndAnchor(() => {}),
    prependAnchor: new TranscriptPrependAnchor(new Map(), vi.fn()),
    canFollowEnd: () => false,
    isProgrammaticScroll: programmatic,
    isMaintenanceScroll: () => isTranscriptMaintenanceScroll(state, element),
    cancelScroll: vi.fn(),
    onLayoutCorrection: vi.fn(),
    invalidate: vi.fn(),
    onOffset: vi.fn(),
    onReaderScroll: vi.fn(),
    onNativeScroll: vi.fn(),
    onComposerLayout: vi.fn(),
  };
  const connect = () =>
    observeTranscriptOffset(owner, virtualizer, (offset, scrolling) => {
      virtualizer.scrollOffset = offset;
      virtualizer.isScrolling = scrolling;
      deliveries.push({ offset, scrolling, programmatic: programmatic() });
    });
  const stop = connect();
  onTestFinished(() => {
    stop();
    vi.useRealTimers();
  });
  return {
    state,
    element,
    virtualizer,
    deliveries,
    owner,
    programmatic,
    stop,
    connect,
    resize: (next: number) => {
      maximum = next;
    },
    write: (offset: number) =>
      scrollTranscriptOffset(
        state,
        { contentElement: null, layout: new TranscriptLayoutOwner(vi.fn()) },
        0,
        offset,
        { behavior: "instant" },
        virtualizer,
      ),
    native: (offset = element.scrollTop) => {
      element.scrollTop = offset;
      element.dispatchEvent(new Event("scroll"));
    },
  };
}

it("delivers late maintenance readback after its previous event receipt retired", () => {
  const observed = observedMaintenance();
  observed.write(40);
  expect(observed.element.scrollTop).toBe(40);
  observed.native();
  expect(observed.deliveries.at(-1)).toEqual({ offset: 40, scrolling: true, programmatic: true });
  vi.advanceTimersToNextFrame();
  expect(observed.programmatic()).toBe(false);

  observed.native();
  expect(observed.deliveries.at(-1)).toEqual({ offset: 40, scrolling: true, programmatic: true });
  vi.advanceTimersToNextFrame();
  expect(observed.programmatic()).toBe(false);
});

it.each(["debounced idle", "scrollend", "explicit sync"] as const)(
  "retires a maintenance receipt delivered by %s",
  (delivery) => {
    const observed = observedMaintenance(delivery === "scrollend");
    observed.write(40);
    observed.native();
    vi.advanceTimersToNextFrame();
    expect(observed.programmatic()).toBe(false);
    if (delivery === "debounced idle") {
      vi.advanceTimersByTime(150);
    } else if (delivery === "scrollend") {
      observed.element.dispatchEvent(new Event("scrollend"));
    } else {
      observed.virtualizer.scrollOffset = 800;
      observed.virtualizer.isScrolling = false;
      observed.state.syncNativeOffset?.();
    }
    expect(observed.deliveries.at(-1)).toEqual({
      offset: 40,
      scrolling: false,
      programmatic: true,
    });
    vi.advanceTimersToNextFrame();
    expect(observed.programmatic()).toBe(false);
  },
);

it("keeps the latest actual write owned when an older receipt frame retires", () => {
  const observed = observedMaintenance();
  observed.write(40);
  observed.native();
  observed.write(60);
  vi.advanceTimersToNextFrame();
  expect(observed.element.scrollTop).toBe(60);
  expect(observed.programmatic()).toBe(true);
  observed.native();
  expect(observed.deliveries.at(-1)?.programmatic).toBe(true);
  vi.advanceTimersToNextFrame();
  expect(observed.programmatic()).toBe(false);
});

it("adopts the actual clamped target and releases it on different native movement", () => {
  const observed = observedMaintenance();
  observed.native(400);
  observed.write(900);
  expect(observed.element.scrollTop).toBe(800);
  observed.native();
  vi.advanceTimersToNextFrame();
  observed.resize(600);
  observed.native(600);
  expect(observed.deliveries.at(-1)?.programmatic).toBe(true);
  vi.advanceTimersToNextFrame();
  observed.resize(1000);
  observed.native();
  expect(observed.deliveries.at(-1)?.programmatic).toBe(true);
  vi.advanceTimersToNextFrame();
  // Growth must not restore the target from before the native clamp.
  observed.native(800);
  expect(observed.deliveries.at(-1)?.programmatic).toBe(false);
  observed.native(600);
  expect(observed.deliveries.at(-1)?.programmatic).toBe(false);
  expect(observed.owner.onOffset).toHaveBeenLastCalledWith(true);
});

it.each(["wheel", "keydown", "pointerdown", "touchstart"] as const)(
  "lets genuine %s input take over even at the last owned target",
  (type) => {
    const observed = observedMaintenance();
    observed.write(40);
    observed.native();
    vi.advanceTimersToNextFrame();
    const event = {
      wheel: () => new WheelEvent("wheel", { deltaY: -40 }),
      keydown: () => new KeyboardEvent("keydown", { key: "ArrowUp" }),
      pointerdown: () => new PointerEvent("pointerdown"),
      touchstart: () => new TouchEvent("touchstart"),
    }[type]();
    observed.element.dispatchEvent(event);
    observed.native();
    expect(observed.deliveries.at(-1)?.programmatic).toBe(false);
    expect(observed.owner.onReaderScroll).toHaveBeenCalled();
  },
);

it("publishes preceding native movement before marking a new correction", () => {
  const observed = observedMaintenance();
  const events: Array<{ delta: number; programmatic: boolean }> = [];
  onTestFinished(
    subscribeTranscriptScroll(observed.element, (event) => {
      if (event.type === "offset") {
        events.push({ delta: event.delta, programmatic: event.programmatic });
      }
    }),
  );
  observed.element.scrollTop = 780;
  observed.write(40);
  expect(events).toEqual([{ delta: -20, programmatic: false }]);
  expect(observed.programmatic()).toBe(true);
});

it("does not transfer a retired observer's target to its replacement", () => {
  const observed = observedMaintenance();
  observed.write(40);
  observed.native();
  observed.stop();
  expect(observed.state.maintenanceScrollOffset).toBeNull();
  expect(observed.state.recordProgrammaticScroll).toBeNull();
  expect(observed.state.syncNativeOffset).toBeNull();
  onTestFinished(observed.connect());
  observed.native();
  expect(observed.deliveries.at(-1)?.programmatic).toBe(false);
  vi.advanceTimersToNextFrame();
  expect(observed.programmatic()).toBe(false);
});

it("delivers policy only for native events, preserving generic write, sync and idle observations", () => {
  const observed = observedMaintenance();
  const events: Array<{ delta: number; scrolling: boolean }> = [];
  onTestFinished(
    subscribeTranscriptScroll(observed.element, (event) => {
      if (event.type === "offset") {
        events.push({ delta: event.delta, scrolling: event.scrolling });
      }
    }),
  );
  observed.native(800);
  expect(observed.deliveries.at(-1)?.scrolling).toBe(true);
  events.length = 0;
  observed.owner.onNativeScroll.mockClear();
  observed.element.scrollTop = 780;
  observed.write(40);
  expect(events[0]).toEqual({ delta: -20, scrolling: true });
  expect(observed.owner.onNativeScroll).not.toHaveBeenCalled();
  observed.element.scrollTop = 60;
  observed.state.syncNativeOffset?.();
  expect(events.at(-1)).toEqual({ delta: 20, scrolling: true });
  expect(observed.owner.onNativeScroll).not.toHaveBeenCalled();
  observed.native(80);
  expect(observed.owner.onNativeScroll).toHaveBeenCalledExactlyOnceWith({
    viewport: { scrollTop: 80, clientHeight: 200, scrollHeight: 1_000 },
    delta: 20,
    programmatic: false,
    maintenance: false,
  });
  vi.runAllTimers();
  expect(events.at(-1)?.scrolling).toBe(false);
  expect(observed.owner.onNativeScroll).toHaveBeenCalledOnce();
});

it.each([false, true])(
  "restores native end anchoring only at the true tail (detached: %s)",
  (detached) => {
    const observed = observedMaintenance();
    const policy = makeChatHost({ chatHasAutoScrolled: true });
    if (detached) {
      policy.chatHistoryPagination = {
        hasMore: true,
        olderCursor: "older",
        hasNewer: true,
        newerCursor: "newer",
      };
    }
    observed.owner.canFollowEnd = () => canAutoFollowChat(policy);
    observed.owner.onNativeScroll.mockImplementation((scroll) => handleChatScroll(policy, scroll));
    observed.native(600);
    policy.chatFollowLocked = true;
    policy.chatReadingHistory = true;
    observed.native(800);
    expect(policy.chatFollowLocked).toBe(detached);
    expect(policy.chatReadingHistory).toBe(detached);
    observed.resize(900);
    const follow = vi.fn();
    observed.owner.endAnchor.reconcile(observed.element, canAutoFollowChat(policy), false, follow);
    expect(follow).toHaveBeenCalledTimes(detached ? 0 : 1);
  },
);
