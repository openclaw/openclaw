/* @vitest-environment jsdom */
import { Virtualizer } from "@tanstack/virtual-core";
import { expect, it, onTestFinished, vi } from "vitest";
import { makeChatHost } from "../chat-host.test-support.ts";
import { canAutoFollowChat, handleChatScroll, handleChatScrollTakeover } from "../scroll.ts";
import { TranscriptEndAnchor } from "./chat-transcript-end-anchor.ts";
import { readerScroll } from "./chat-transcript-offset-observer.test-support.ts";
import {
  isTranscriptProgrammaticScroll,
  isTranscriptMaintenanceScroll,
  observeTranscriptOffset,
  scrollTranscriptToEnd,
  TranscriptOffsetState,
} from "./chat-transcript-offset-observer.ts";
import { TranscriptPrependAnchor } from "./chat-transcript-prepend-anchor.ts";
import type { TranscriptNativeScroll } from "./chat-transcript-scroll-events.ts";
import { clampedMeasurements, offsetOwner } from "./chat-transcript.test-support.ts";

it("waits for measured rows before renewing a growing end destination", () => {
  const element = document.createElement("div");
  Object.defineProperties(element, {
    clientHeight: { value: 300 },
    scrollHeight: { value: 1540 },
  });
  const state = new TranscriptOffsetState();
  const command = { target: "end", behavior: "smooth", offset: 1000 } as const;
  state.scrollCommand = command;
  const virtualizer = new Virtualizer<HTMLDivElement, HTMLElement>({
    count: 0,
    getScrollElement: () => element,
    estimateSize: () => 120,
    scrollToFn: () => {},
    observeElementRect: () => () => {},
    observeElementOffset: () => () => {},
  });
  virtualizer.scrollElement = element;
  const scroll = vi.spyOn(virtualizer, "scrollToEnd").mockImplementation(() => {});
  const prepare = vi.fn<Parameters<typeof scrollTranscriptToEnd>[6]>();
  const cancel = vi.fn();
  scrollTranscriptToEnd(
    state,
    virtualizer,
    { source: "auto", behavior: "instant" },
    cancel,
    vi.fn(),
    new TranscriptEndAnchor(() => {}),
    prepare,
    true,
  );
  expect(scroll).not.toHaveBeenCalled();
  expect(cancel).not.toHaveBeenCalled();
  expect(state.scrollCommand).toBe(command);
  expect(prepare).toHaveBeenCalledOnce();
  const [ready, isCurrent, native] = prepare.mock.calls[0]!;
  expect(native).toBe(true);
  expect(isCurrent()).toBe(true);
  ready();
  expect(scroll).toHaveBeenCalledExactlyOnceWith({ behavior: "smooth" });
  state.scrollCommand = null;
  expect(isCurrent()).toBe(false);
});

function createWheelForecastObserver() {
  const element = document.createElement("div");
  Object.defineProperties(element, {
    clientHeight: { value: 300 },
    scrollHeight: { value: 5000 },
  });
  element.scrollTop = 1000;
  const state = new TranscriptOffsetState();
  const virtualizer = new Virtualizer<HTMLDivElement, HTMLElement>({
    count: 0,
    getScrollElement: () => element,
    estimateSize: () => 120,
    scrollToFn: () => {},
    observeElementRect: () => () => {},
    observeElementOffset: () => () => {},
  });
  virtualizer.scrollElement = element;
  virtualizer.scrollOffset = 1000;
  virtualizer.targetWindow = window;
  const onWheel = vi.fn();
  const onHistoryIntent = vi.fn();
  const onOffset = vi.fn();
  onTestFinished(
    observeTranscriptOffset(
      {
        state,
        getScrollElement: () => element,
        endAnchor: new TranscriptEndAnchor(() => {}),
        prependAnchor: new TranscriptPrependAnchor(
          new Map(),
          () => {},
          () => false,
        ),
        canFollowEnd: () => false,
        isProgrammaticScroll: () => isTranscriptProgrammaticScroll(state, element),
        cancelScroll: () => {},
        onLayoutCorrection: () => {},
        invalidate: () => {},
        onOffset,
        onWheel,
        onHistoryIntent,
        onReaderScroll: () => {},
        onComposerLayout: () => {},
      },
      virtualizer,
      (offset) => {
        virtualizer.scrollOffset = offset;
      },
    ),
  );
  onWheel.mockClear();
  onOffset.mockClear();
  return { element, virtualizer, onWheel, onOffset, onHistoryIntent };
}

it.each([
  { name: "pixel", options: {}, expected: true },
  { name: "horizontal", options: { deltaX: 300 }, expected: false },
  { name: "line", options: { deltaMode: WheelEvent.DOM_DELTA_LINE }, expected: false },
  { name: "page", options: { deltaMode: WheelEvent.DOM_DELTA_PAGE }, expected: false },
  { name: "zoom", options: { ctrlKey: true }, expected: false },
  { name: "meta", options: { metaKey: true }, expected: false },
  { name: "alt", options: { altKey: true }, expected: false },
  { name: "shift", options: { shiftKey: true }, expected: false },
])("forecasts eligible $name wheel input without consuming it", ({ options, expected }) => {
  const { element, virtualizer, onWheel } = createWheelForecastObserver();
  const event = new WheelEvent("wheel", { deltaY: 240, cancelable: true, ...options });
  element.dispatchEvent(event);
  expect(onWheel.mock.calls).toEqual(expected ? [[240]] : []);
  expect(event.defaultPrevented).toBe(false);
  expect(element.scrollTop).toBe(1000);
  expect(virtualizer.scrollOffset).toBe(1000);
});

it.each([
  { name: "consumed", top: 50, behavior: "auto", cancelled: false, expected: false },
  { name: "chained", top: 0, behavior: "auto", cancelled: false, expected: true },
  { name: "contained", top: 0, behavior: "contain", cancelled: false, expected: false },
  { name: "blocked", top: 0, behavior: "none", cancelled: false, expected: false },
  { name: "cancelled", top: 0, behavior: "auto", cancelled: true, expected: false },
])(
  "forecasts only $name nested wheel movement that can reach the transcript",
  ({ top, behavior, cancelled, expected }) => {
    const { element, onWheel } = createWheelForecastObserver();
    const nested = document.createElement("div");
    nested.style.overflowY = "auto";
    nested.style.overscrollBehaviorY = behavior;
    Object.defineProperties(nested, {
      clientHeight: { value: 100 },
      scrollHeight: { value: 500 },
    });
    nested.scrollTop = top;
    if (cancelled) {
      nested.addEventListener("wheel", (event) => event.preventDefault(), { once: true });
    }
    element.append(nested);
    nested.dispatchEvent(
      new WheelEvent("wheel", { deltaY: -240, bubbles: true, cancelable: true }),
    );
    expect(onWheel.mock.calls).toEqual(expected ? [[-240]] : []);
  },
);

it.each([
  { direction: 1, consumed: 100, remaining: 140 },
  { direction: -1, consumed: 100, remaining: 140 },
  { direction: 1, consumed: 240, remaining: 0 },
  { direction: -1, consumed: 240, remaining: 0 },
])(
  "retains the wheel input after discounting $consumed px of native travel ($direction)",
  ({ direction, consumed, remaining }) => {
    const { element, virtualizer, onWheel, onOffset } = createWheelForecastObserver();
    element.scrollTop += direction * consumed;
    element.dispatchEvent(new WheelEvent("wheel", { deltaY: direction * 240 }));
    expect(onOffset).toHaveBeenCalledExactlyOnceWith(direction * consumed);
    expect(onWheel).toHaveBeenCalledExactlyOnceWith(direction * remaining);
    expect(virtualizer.scrollOffset).toBe(1000 + direction * consumed);
  },
);

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

it.each([undefined, 1000])(
  "keeps latest through a temporary native end clamp (issued target: %s)",
  (offset) => {
    const element = document.createElement("div");
    let height = 1000;
    Object.defineProperties(element, {
      clientHeight: { value: 200 },
      scrollHeight: { get: () => height },
    });
    element.scrollTop = 800;
    const state = new TranscriptOffsetState();
    const command = { target: "end" as const, behavior: "smooth" as const, offset };
    state.scrollCommand = command;
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
    const cancelScroll = vi.fn(() => {
      state.scrollCommand = null;
    });
    onTestFinished(
      observeTranscriptOffset(
        offsetOwner(state, element, { canFollowEnd: () => true, cancelScroll }),
        virtualizer,
        vi.fn(),
      ),
    );
    expect(state.scrollCommand).toBe(command);
    expect(cancelScroll).not.toHaveBeenCalled();

    command.offset = 1000;
    element.dispatchEvent(new Event("scroll"));
    element.dispatchEvent(new Event("scrollend"));
    expect(cancelScroll).not.toHaveBeenCalled();
    height = 1200;
    element.scrollTop = 998;
    element.dispatchEvent(new Event("scroll"));
    element.dispatchEvent(new Event("scrollend"));
    expect(cancelScroll).not.toHaveBeenCalled();
    element.scrollTop = 1000;
    element.dispatchEvent(new Event("scroll"));
    expect(cancelScroll).toHaveBeenCalledExactlyOnceWith(true);
  },
);

it.each([
  {
    name: "records native end geometry before rendering and pane policy",
    logicalDrift: false,
  },
  {
    name: "reconciles non-clamped virtual drift at an unchanged native offset",
    logicalDrift: true,
  },
])("$name", ({ logicalDrift }) => {
  const element = document.createElement("div");
  let delivered = false;
  const geometryReads: boolean[] = [];
  for (const key of ["scrollHeight", "clientHeight"]) {
    Object.defineProperty(element, key, {
      configurable: true,
      get: () => {
        geometryReads.push(delivered);
        return key === "scrollHeight" ? 120 : 100;
      },
    });
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
  const state = new TranscriptOffsetState();
  const endAnchor = new TranscriptEndAnchor(() => {});
  const onOffset = vi.fn();
  const cancelScroll = vi.fn(() => {
    state.scrollCommand = null;
  });
  const onReaderScroll = vi.fn();
  const onRequestEnd = vi.fn();
  const order: string[] = [];
  const recordedEnd: boolean[] = [];
  const paneRecordedEnd: boolean[] = [];
  const deliver = vi.fn((offset: number) => {
    delivered = true;
    recordedEnd.push(endAnchor.isRecordedEnd(offset));
    order.push("virtualizer");
  });
  const onNativeScroll = vi.fn((scroll: TranscriptNativeScroll) => {
    expect(scroll.viewport).toEqual({
      scrollTop: element.scrollTop,
      clientHeight: 100,
      scrollHeight: 120,
    });
    paneRecordedEnd.push(endAnchor.isRecordedEnd(scroll.viewport.scrollTop));
    order.push("pane");
  });
  onTestFinished(
    observeTranscriptOffset(
      offsetOwner(state, element, {
        endAnchor,
        cancelScroll,
        onOffset,
        onReaderScroll,
        onRequestEnd,
        onComposerLayout: () => order.push("composer"),
        onNativeScroll,
      }),
      virtualizer,
      deliver,
    ),
  );
  order.length = 0;
  delivered = false;
  geometryReads.length = 0;
  recordedEnd.length = 0;
  element.scrollTop = 20;
  element.dispatchEvent(new Event("scroll"));
  expect(order).toEqual(["composer", "pane", "virtualizer"]);
  expect(onNativeScroll).toHaveBeenCalledExactlyOnceWith(readerScroll(20, 20, 100, 120));
  expect(state.nativeInputActive).toBe(false);
  expect(deliver).toHaveBeenCalledWith(20, true);
  expect(onOffset).toHaveBeenCalledOnce();
  expect(recordedEnd).toEqual([true]);
  expect(paneRecordedEnd).toEqual([true]);
  expect(geometryReads).toEqual([false, false, false, false]);
  // Earlier PageUp motion can arrive while a newer Latest prepares its destination.
  state.scrollCommand = { target: "end", behavior: "smooth" };
  element.scrollTop = 12;
  element.dispatchEvent(new Event("scroll"));
  expect(state.scrollCommand?.target).toBe("end");
  expect(cancelScroll).not.toHaveBeenCalled();
  state.scrollCommand = null;
  expect(onReaderScroll).toHaveBeenCalledExactlyOnceWith(true);
  onReaderScroll.mockClear();
  const nested = document.createElement("div");
  element.append(nested);
  order.length = 0;
  nested.dispatchEvent(new Event("scroll"));
  expect(order).toEqual(["composer"]);
  expect(onNativeScroll).toHaveBeenCalledTimes(2);
  nested.addEventListener("wheel", (event) => event.preventDefault(), { once: true });
  nested.dispatchEvent(new WheelEvent("wheel", { deltaY: -240, bubbles: true, cancelable: true }));
  expect(cancelScroll).not.toHaveBeenCalled();
  expect(onReaderScroll).not.toHaveBeenCalled();
  nested.addEventListener("keydown", (event) => event.preventDefault(), { once: true });
  nested.dispatchEvent(
    new KeyboardEvent("keydown", { key: "End", bubbles: true, cancelable: true }),
  );
  expect(onRequestEnd).not.toHaveBeenCalled();
  const end = new KeyboardEvent("keydown", { key: "End", bubbles: true, cancelable: true });
  element.dispatchEvent(end);
  expect(end.defaultPrevented).toBe(true);
  expect(onRequestEnd).toHaveBeenCalledOnce();
  expect(onReaderScroll).not.toHaveBeenCalled();
  for (const tag of ["div", "textarea", "input"]) {
    const target = element.appendChild(document.createElement(tag));
    target.tabIndex = 0;
    const nestedEnd = new KeyboardEvent("keydown", {
      key: "End",
      bubbles: true,
      cancelable: true,
    });
    target.dispatchEvent(nestedEnd);
    expect(nestedEnd.defaultPrevented).toBe(false);
    expect(onRequestEnd).toHaveBeenCalledOnce();
  }
  const modifiedEnd = new KeyboardEvent("keydown", {
    key: "End",
    ctrlKey: true,
    bubbles: true,
    cancelable: true,
  });
  element.dispatchEvent(modifiedEnd);
  expect(modifiedEnd.defaultPrevented).toBe(false);
  expect(onRequestEnd).toHaveBeenCalledOnce();
  cancelScroll.mockClear();
  onReaderScroll.mockClear();
  element.scrollTop = 12;
  element.dispatchEvent(new Event("scroll"));
  onOffset.mockClear();
  state.scrollCommand = { target: "end", behavior: "smooth", offset: 20 };
  // Native smooth settling can move backward without new reader input.
  element.scrollTop = 10;
  element.dispatchEvent(new Event("scroll"));
  expect(cancelScroll).not.toHaveBeenCalled();
  expect(state.scrollCommand?.target).toBe("end");
  onOffset.mockClear();
  element.scrollTop = 19;
  expect(isTranscriptProgrammaticScroll(state, element)).toBe(false);
  element.dispatchEvent(new Event("scroll"));
  expect(onOffset).toHaveBeenCalledExactlyOnceWith(0);
  // Actual input retires the command before its native movement reaches the observer.
  virtualizer.scrollOffset = 19;
  element.dispatchEvent(new WheelEvent("wheel", { deltaY: 1, bubbles: true, cancelable: true }));
  expect(state.nativeInputActive).toBe(true);
  expect(cancelScroll).toHaveBeenCalledOnce();
  expect(state.scrollCommand).toBeNull();
  onOffset.mockClear();
  element.scrollTop = 20;
  element.dispatchEvent(new Event("scroll"));
  expect(onOffset).toHaveBeenCalledExactlyOnceWith(1);
  if (logicalDrift) {
    Object.defineProperties(element, {
      clientHeight: { value: 200 },
      scrollHeight: { value: 1000 },
    });
    virtualizer.scrollOffset = 40;
    deliver.mockClear();
    state.syncNativeOffset?.();
    expect(deliver).toHaveBeenCalledExactlyOnceWith(20, false);
  }
  state.recordProgrammaticScroll?.(20, 20, true);
  expect(state.nativeInputActive).toBe(true);
  element.scrollTop = 21;
  state.recordProgrammaticScroll?.(20, 21, true);
  expect(state.nativeInputActive).toBe(false);
  element.dispatchEvent(new WheelEvent("wheel", { deltaY: -1, bubbles: true, cancelable: true }));
  expect(state.nativeInputActive).toBe(true);
  element.dispatchEvent(new Event("scrollend"));
  expect(state.nativeInputActive).toBe(false);
});

it.each([
  { position: "end", offset: 800, expected: 870, following: true, growthBeforeArrival: 0 },
  { position: "grown end", offset: 870, expected: 940, following: true, growthBeforeArrival: 70 },
  { position: "history", offset: 600, expected: 600, following: false, growthBeforeArrival: 0 },
])("preserves $position after synchronizing a reader before its scroll event", (testCase) => {
  const element = document.createElement("div");
  let scrollHeight = 1000;
  Object.defineProperties(element, {
    clientHeight: { value: 200 },
    scrollHeight: { get: () => scrollHeight },
  });
  element.scrollTop = 400;
  const state = new TranscriptOffsetState();
  const endAnchor = new TranscriptEndAnchor(() => {});
  const policy = makeChatHost({
    renderLifecycle: { afterCommit: () => () => {} },
    chatScrollElement: () => element,
    chatLastScrollTop: 400,
    chatHasAutoScrolled: true,
    chatUserNearBottom: false,
    chatHistoryPagination: { hasMore: false },
    chatIsProgrammaticScroll: () => isTranscriptProgrammaticScroll(state, element),
  });
  handleChatScrollTakeover(policy);
  expect(canAutoFollowChat(policy)).toBe(false);

  const virtualizer = new Virtualizer<HTMLDivElement, HTMLElement>({
    count: 0,
    initialOffset: 400,
    getScrollElement: () => element,
    estimateSize: () => 40,
    scrollToFn: (offset) => {
      element.scrollTop = offset;
    },
    observeElementRect: (_, callback) => callback({ width: 800, height: 200 }),
    observeElementOffset: (instance, callback) =>
      observeTranscriptOffset(
        offsetOwner(state, element, {
          endAnchor,
          canFollowEnd: () => canAutoFollowChat(policy),
          onLayoutCorrection: (before, after) => endAnchor.recordLayoutCorrection(before, after),
          onReaderScroll: (towardEnd) => handleChatScrollTakeover(policy, towardEnd),
          onNativeScroll: (scroll) => handleChatScroll(policy, scroll),
        }),
        instance,
        callback,
      ),
  });
  const { _didMount: mount, _willUpdate: update } = virtualizer;
  onTestFinished(mount());
  update();
  element.dispatchEvent(new Event("scroll"));

  // ResizeObserver can synchronize physical movement before the native scroll event.
  scrollHeight += testCase.growthBeforeArrival;
  element.scrollTop = testCase.offset;
  state.syncNativeOffset?.();
  expect(virtualizer.scrollOffset).toBe(testCase.offset);
  element.dispatchEvent(new Event("scroll"));
  expect(canAutoFollowChat(policy)).toBe(testCase.following);

  scrollHeight += 70;
  endAnchor.reconcile(element, canAutoFollowChat(policy), false, () => {
    element.scrollTop = scrollHeight - element.clientHeight;
  });
  expect(element.scrollTop).toBe(testCase.expected);
});

it.each([
  { action: "accumulates separate resize deliveries", command: false, expected: 500 },
  { action: "settles an explicit no-op command before measurement", command: true, expected: 300 },
])("$action while native compensation is clamped", async ({ command, expected }) => {
  const { element, range, state, virtualizer, update, measure } = clampedMeasurements();
  measure(0, 200);
  expect(virtualizer.scrollOffset).toBe(400);
  expect(element.scrollTop).toBe(300);

  // Separate observer deliveries must retain compensation until the sizer commits.
  await Promise.resolve();
  if (command) {
    virtualizer.scrollToOffset(300, { behavior: "instant" });
    state.syncNativeOffset?.();
  } else {
    measure(1, 200);
  }
  expect.soft(virtualizer.scrollOffset).toBe(expected);
  if (!command) {
    range.height = 600;
    update();
    expect(element.scrollTop).toBe(expected);
  }
});

it("preserves reader policy when virtual measurement retries a clamped adjustment", () => {
  const policy = makeChatHost({
    chatHasAutoScrolled: true,
    chatFollowLocked: true,
    chatReadingHistory: true,
    chatLastScrollTop: 300,
  });
  const { element, range, state, virtualizer, update, owner, measure } = clampedMeasurements();
  policy.chatScrollElement = () => element;
  policy.chatIsProgrammaticScroll = () => isTranscriptProgrammaticScroll(state, element);
  policy.chatIsMaintenanceScroll = () => isTranscriptMaintenanceScroll(state, element);
  Object.assign(owner, {
    canFollowEnd: () => canAutoFollowChat(policy),
    onReaderScroll: (towardEnd: boolean | undefined) => handleChatScrollTakeover(policy, towardEnd),
    onNativeScroll: (scroll: TranscriptNativeScroll) => handleChatScroll(policy, scroll),
  });
  const native = (offset = element.scrollTop) => {
    element.scrollTop = offset;
    element.dispatchEvent(new Event("scroll"));
  };
  measure(0, 200);
  expect(virtualizer.scrollOffset).toBe(400);
  expect(element.scrollTop).toBe(300);
  native();
  // Partial and complete sizer commits retry the same absolute target.
  for (const [height, offset] of [
    [416, 316],
    [500, 400],
  ] as const) {
    range.height = height;
    update();
    expect(element.scrollTop).toBe(offset);
    native();
    expect([policy.chatFollowLocked, policy.chatReadingHistory]).toEqual([true, true]);
  }
  range.height -= 8;
  native(392);
  expect([policy.chatFollowLocked, policy.chatReadingHistory]).toEqual([true, true]);
  element.dispatchEvent(new WheelEvent("wheel", { deltaY: 1 }));
  expect([policy.chatFollowLocked, policy.chatReadingHistory]).toEqual([false, false]);
  expect(isTranscriptProgrammaticScroll(state, element)).toBe(false);
});

it("forecasts a clamped wheel before one history intent without writing its position", () => {
  const { element, virtualizer, onWheel, onHistoryIntent } = createWheelForecastObserver();
  element.scrollTop = 0;
  virtualizer.scrollOffset = 0;
  const order: string[] = [];
  onWheel.mockImplementation(() => order.push("forecast"));
  onHistoryIntent.mockImplementation(() => order.push("history"));
  const write = vi.spyOn(virtualizer, "scrollToOffset");
  const event = new WheelEvent("wheel", { deltaY: -240, bubbles: true, cancelable: true });
  element.dispatchEvent(event);
  expect(onWheel).toHaveBeenCalledExactlyOnceWith(-240);
  expect(onHistoryIntent).toHaveBeenCalledExactlyOnceWith(event);
  expect(order).toEqual(["forecast", "history"]);
  expect(event.defaultPrevented).toBe(false);
  expect(element.scrollTop).toBe(0);
  expect(virtualizer.scrollOffset).toBe(0);
  expect(write).not.toHaveBeenCalled();
});
