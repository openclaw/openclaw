/* @vitest-environment jsdom */
import { Virtualizer } from "@tanstack/virtual-core";
import { expect, it, onTestFinished, vi } from "vitest";
import { makeChatHost } from "../chat-host.test-support.ts";
import { createNativeShowEarlierPane } from "../chat-pane-history.test-support.ts";
import {
  canAutoFollowChat,
  type ChatScrollHost,
  handleChatScroll,
  handleChatScrollTakeover,
} from "../scroll.ts";
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
import {
  subscribeTranscriptScroll,
  type TranscriptNativeScroll,
  type TranscriptScrollObservation,
} from "./chat-transcript-scroll-events.ts";
import { createTranscriptPresentation } from "./chat-transcript-session.ts";
import { ChatSessionVirtualizerHost } from "./chat-transcript-virtualizer-host.ts";
import {
  installTranscriptDomMocks,
  resetTranscriptTestDom,
  resizeObservers,
} from "./chat-transcript.test-support.ts";

function readerScroll(
  scrollTop: number,
  delta: number,
  clientHeight = 200,
  scrollHeight = 1000,
): TranscriptNativeScroll {
  return {
    viewport: { scrollTop, clientHeight, scrollHeight },
    delta,
    programmatic: false,
    maintenance: false,
  };
}

function offsetOwner(
  state: TranscriptOffsetState,
  element: HTMLDivElement,
  overrides: Partial<Parameters<typeof observeTranscriptOffset>[0]>,
) {
  const defaults = {
    state,
    getScrollElement: () => element,
    endAnchor: new TranscriptEndAnchor(() => {}),
    prependAnchor: new TranscriptPrependAnchor(new Map(), vi.fn(), () => false),
    canFollowEnd: () => false,
    isProgrammaticScroll: () => isTranscriptProgrammaticScroll(state, element),
    isMaintenanceScroll: () => isTranscriptMaintenanceScroll(state, element),
    cancelScroll: vi.fn(),
    onLayoutCorrection: vi.fn(),
    invalidate: vi.fn(),
    onOffset: vi.fn(),
    onReaderScroll: vi.fn(),
    onComposerLayout: vi.fn(),
  };
  return Object.assign(defaults, overrides);
}

function recordOffsets<T>(
  element: HTMLDivElement,
  project: (event: Extract<TranscriptScrollObservation, { type: "offset" }>) => T,
) {
  const events: T[] = [];
  onTestFinished(
    subscribeTranscriptScroll(element, (event) => {
      if (event.type === "offset") {
        events.push(project(event));
      }
    }),
  );
  return events;
}

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
  expect(deliver).toHaveBeenCalledWith(20, true);
  expect(onOffset).toHaveBeenCalledOnce();
  expect(recordedEnd).toEqual([true]);
  expect(paneRecordedEnd).toEqual([true]);
  expect(geometryReads).toEqual([false, false, false, false]);
  expect(onReaderScroll).toHaveBeenCalledExactlyOnceWith(true);
  onReaderScroll.mockClear();
  const nested = document.createElement("div");
  element.append(nested);
  order.length = 0;
  nested.dispatchEvent(new Event("scroll"));
  expect(order).toEqual(["composer"]);
  expect(onNativeScroll).toHaveBeenCalledOnce();
  nested.addEventListener("wheel", (event) => event.preventDefault(), { once: true });
  nested.dispatchEvent(new WheelEvent("wheel", { deltaY: -240, bubbles: true, cancelable: true }));
  expect(cancelScroll).not.toHaveBeenCalled();
  expect(onReaderScroll).not.toHaveBeenCalled();
  element.scrollTop = 12;
  element.dispatchEvent(new Event("scroll"));
  onOffset.mockClear();
  state.scrollCommand = { target: "end", behavior: "smooth", offset: 20 };
  element.scrollTop = 19;
  expect(isTranscriptProgrammaticScroll(state, element)).toBe(false);
  element.dispatchEvent(new Event("scroll"));
  expect(onOffset).toHaveBeenCalledExactlyOnceWith(0);
  // Actual input retires the command before its native movement reaches the observer.
  virtualizer.scrollOffset = 19;
  element.dispatchEvent(new WheelEvent("wheel", { deltaY: 1, bubbles: true, cancelable: true }));
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
  const policy: ChatScrollHost = {
    renderLifecycle: { afterCommit: () => () => {} },
    chatScrollElement: () => element,
    chatLastScrollTop: 400,
    chatHasAutoScrolled: true,
    chatUserNearBottom: false,
    chatFollowLocked: false,
    chatReadingHistory: false,
    chatNewMessagesBelow: false,
    chatHistoryPagination: {},
    chatIsProgrammaticScroll: () => isTranscriptProgrammaticScroll(state, element),
  };
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
  installTranscriptDomMocks();
  const element = document.body.appendChild(document.createElement("div"));
  let scrollHeight = 400;
  let scrollTop = 300;
  Object.defineProperties(element, {
    clientHeight: { value: 100 },
    scrollHeight: { get: () => scrollHeight },
    scrollTop: {
      get: () => scrollTop,
      set: (value: number) => {
        scrollTop = Math.max(0, Math.min(value, scrollHeight - 100));
      },
    },
    scrollTo: {
      value: (options: ScrollToOptions) => {
        element.scrollTop = options.top ?? element.scrollTop;
      },
    },
  });
  const heights = [100, 100, 100, 100];
  const rows = Array.from({ length: 4 }, (_, index) => {
    const row = element.appendChild(document.createElement("div"));
    row.dataset.index = String(index);
    Object.defineProperty(row, "offsetHeight", { get: () => heights[index]! });
    return row;
  });
  const state = new TranscriptOffsetState();
  const host = { layout: new TranscriptLayoutOwner(vi.fn()), contentElement: null };
  const virtualizer = new Virtualizer<HTMLDivElement, HTMLElement>({
    count: rows.length,
    initialOffset: 300,
    overscan: 3,
    getScrollElement: () => element,
    estimateSize: () => 100,
    scrollToFn: (offset, options, instance) =>
      scrollTranscriptOffset(state, host, 0, offset, options, instance),
    observeElementRect: (_, callback) => callback({ width: 800, height: 100 }),
    observeElementOffset: (instance, callback) =>
      observeTranscriptOffset(offsetOwner(state, element, {}), instance, callback),
    measureElement: (row, entry) => presentation.measureElement(row, entry),
  });
  const presentation = createTranscriptPresentation(
    () => element,
    virtualizer,
    () => rows,
    () => state.syncNativeOffset?.(),
  );
  const { _didMount: mount, _willUpdate: update } = virtualizer;
  const dispose = mount();
  onTestFinished(() => {
    dispose();
    resetTranscriptTestDom();
  });
  update();
  for (const row of rows) {
    virtualizer.measureElement(row);
  }
  heights[0] = 200;
  for (const observer of resizeObservers) {
    observer.emitTarget(rows[0]!, 800, 200);
  }
  expect(virtualizer.scrollOffset).toBe(400);
  expect(element.scrollTop).toBe(300);

  // Separate observer deliveries must retain compensation until the sizer commits.
  await Promise.resolve();
  if (command) {
    virtualizer.scrollToOffset(300, { behavior: "instant" });
    state.syncNativeOffset?.();
  } else {
    heights[1] = 200;
    for (const observer of resizeObservers) {
      observer.emitTarget(rows[1]!, 800, 200);
    }
  }
  expect.soft(virtualizer.scrollOffset).toBe(expected);
  if (!command) {
    scrollHeight = 600;
    update();
    expect(element.scrollTop).toBe(expected);
  }
});

function observedMaintenance(useScrollendEvent = false) {
  vi.useFakeTimers();
  const state = new TranscriptOffsetState();
  const element = document.createElement("div");
  let maximum = 800;
  let viewportHeight = 200;
  let contentHeight = 1000;
  Object.defineProperties(element, {
    clientHeight: { get: () => viewportHeight },
    scrollHeight: { get: () => contentHeight },
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
  const owner = Object.assign(offsetOwner(state, element, {}), {
    isProgrammaticScroll: programmatic,
    onNativeScroll: vi.fn(),
  });
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
      contentHeight = maximum + viewportHeight;
    },
    resizeViewport: (next: number) => {
      viewportHeight = next;
      maximum = contentHeight - viewportHeight;
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

it.each(["none", "before capture", "after capture"] as const)(
  "preserves upward native policy through measurement synchronization: %s",
  (synchronization) => {
    const observed = observedMaintenance();
    observed.native();
    observed.owner.onNativeScroll.mockClear();
    observed.element.scrollTop = 160;
    const synchronize = () => {
      observed.state.syncNativeOffset?.(true);
      expect(observed.virtualizer.scrollOffset).toBe(160);
      expect(observed.owner.onNativeScroll).not.toHaveBeenCalled();
    };
    if (synchronization === "before capture") {
      synchronize();
    } else if (synchronization === "after capture") {
      observed.owner.onComposerLayout.mockImplementationOnce(synchronize);
    }
    observed.native();
    expect(observed.owner.onNativeScroll).toHaveBeenCalledExactlyOnceWith(readerScroll(160, -640));
    observed.native();
    expect(observed.owner.onNativeScroll.mock.calls.map(([scroll]) => scroll.delta)).toEqual([
      -640, 0,
    ]);
    vi.runAllTimers();
    expect(observed.owner.onNativeScroll).toHaveBeenCalledTimes(2);
  },
);

it.each(["native clamp", "capped editor"] as const)(
  "preserves the captured viewport and acknowledges the real composer correction: %s",
  (change) => {
    const observed = observedMaintenance();
    observed.native();
    const { owner, element } = observed;
    owner.canFollowEnd = () => true;
    owner.endAnchor.invalidateComposerResize(true);
    owner.onComposerLayout.mockImplementation((changed) => {
      owner.endAnchor.commitComposerResize(element, changed, true, false);
    });
    if (change === "native clamp") {
      observed.resizeViewport(300);
    }
    owner.onOffset.mockClear();
    owner.onNativeScroll.mockClear();
    observed.deliveries.length = 0;
    observed.native(700);
    const corrected = change === "native clamp" ? 700 : 800;
    expect(owner.onOffset).toHaveBeenCalledExactlyOnceWith(0);
    expect(owner.onNativeScroll).toHaveBeenCalledExactlyOnceWith({
      viewport: {
        scrollTop: 700,
        clientHeight: change === "native clamp" ? 300 : 200,
        scrollHeight: 1000,
      },
      delta: -100,
      programmatic: true,
      maintenance: true,
    });
    expect(element.scrollTop).toBe(corrected);
    expect(observed.deliveries).toEqual([
      { offset: corrected, scrolling: true, programmatic: true },
    ]);
    vi.advanceTimersToNextFrame();
    observed.native();
    expect(observed.deliveries.at(-1)?.programmatic).toBe(true);
  },
);

it("keeps genuine reader movement when an unrelated composer write follows it", () => {
  const observed = observedMaintenance();
  observed.native(100);
  observed.owner.onOffset.mockClear();
  observed.owner.onNativeScroll.mockClear();
  observed.owner.onComposerLayout.mockImplementationOnce(() => observed.write(300));
  observed.native(200);
  expect(observed.owner.onNativeScroll).toHaveBeenCalledExactlyOnceWith(readerScroll(200, 100));
  expect(observed.element.scrollTop).toBe(300);
  expect(observed.owner.onOffset).toHaveBeenCalledExactlyOnceWith(0);
});

it("accepts a newer nested root delivery without replaying the outer movement", () => {
  const observed = observedMaintenance();
  observed.native(100);
  observed.owner.onOffset.mockClear();
  observed.owner.onNativeScroll.mockClear();
  observed.deliveries.length = 0;
  observed.owner.onComposerLayout.mockImplementationOnce(() => observed.native(300));
  observed.native(200);
  expect(observed.owner.onNativeScroll).toHaveBeenCalledExactlyOnceWith(readerScroll(300, 200));
  expect(observed.owner.onOffset).toHaveBeenCalledExactlyOnceWith(200);
  expect(observed.deliveries).toEqual([{ offset: 300, scrolling: true, programmatic: false }]);
});

it("keeps the root viewport through child scrolling and synchronous composer remapping", () => {
  const observed = observedMaintenance();
  const child = observed.element.appendChild(document.createElement("div"));
  observed.native(100);
  observed.owner.onNativeScroll.mockClear();
  observed.owner.onComposerLayout.mockImplementationOnce(() => {
    child.dispatchEvent(new Event("scroll"));
    observed.element.scrollTop = 300;
    observed.resize(1000);
  });
  observed.native(200);
  expect(observed.owner.onNativeScroll).toHaveBeenCalledExactlyOnceWith(readerScroll(200, 100));
  expect(observed.owner.onComposerLayout).toHaveBeenCalledTimes(3);
  expect(observed.deliveries.at(-1)?.offset).toBe(300);
});

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
  expect(observed.owner.onOffset).toHaveBeenLastCalledWith(-200);
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
  const events = recordOffsets(observed.element, ({ delta, programmatic }) => ({
    delta,
    programmatic,
  }));
  observed.element.scrollTop = 780;
  observed.write(40);
  expect(events).toEqual([{ delta: -20, programmatic: false }]);
  expect(observed.programmatic()).toBe(true);
});

it.each(
  [
    {
      name: "owned clamp",
      maximum: 20,
      before: 20,
      after: 5,
      delta: -20,
      owned: true,
    },
    {
      name: "reader returning to old target",
      maximum: 800,
      before: 60,
      after: 40,
      delta: 20,
      owned: false,
    },
  ].flatMap((testCase) =>
    [false, true].map((retired) => ({
      ...testCase,
      name: retired ? "late " + testCase.name : testCase.name,
      retired,
    })),
  ),
)("classifies preceding movement at its pre-write coordinate: $name", (testCase) => {
  const observed = observedMaintenance();
  observed.write(40);
  observed.native();
  if (testCase.retired) {
    vi.advanceTimersToNextFrame();
    expect(observed.programmatic()).toBe(false);
  }
  observed.resize(testCase.maximum);
  observed.element.scrollTop = testCase.before;
  const events = recordOffsets(observed.element, ({ delta, programmatic }) => ({
    delta,
    programmatic,
  }));
  observed.write(testCase.after);
  expect(events).toEqual([{ delta: testCase.delta, programmatic: testCase.owned }]);
  expect(observed.programmatic()).toBe(true);
});

it.each([
  { before: 780, after: 800, owned: true },
  { before: 800, after: 780, owned: false },
])("classifies the command threshold before writing $before to $after", (testCase) => {
  const observed = observedMaintenance();
  observed.native(600);
  observed.state.scrollCommand = { target: "end", behavior: "smooth" };
  observed.element.scrollTop = testCase.before;
  const events = recordOffsets(observed.element, ({ delta, programmatic }) => ({
    delta,
    programmatic,
  }));
  observed.write(testCase.after);
  expect(events).toEqual([{ delta: testCase.before - 600, programmatic: testCase.owned }]);
});

it("keeps the latest correction when a preceding-movement subscriber writes again", () => {
  const observed = observedMaintenance();
  const events: Array<{ delta: number; programmatic: boolean }> = [];
  onTestFinished(
    subscribeTranscriptScroll(observed.element, (event) => {
      if (event.type === "offset") {
        events.push({ delta: event.delta, programmatic: event.programmatic });
        if (events.length === 1) {
          observed.write(60);
        }
      }
    }),
  );
  observed.element.scrollTop = 780;
  observed.write(40);
  expect(events).toEqual([
    { delta: -20, programmatic: false },
    { delta: 0, programmatic: true },
  ]);
  expect(observed.state.maintenanceScrollOffset).toBe(60);
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
  const events = recordOffsets(observed.element, ({ delta, scrolling }) => ({ delta, scrolling }));
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
  // Synchronizing at 60 must not discard movement after the actual write to 40.
  expect(observed.owner.onNativeScroll).toHaveBeenCalledExactlyOnceWith(readerScroll(80, 40));
  vi.runAllTimers();
  expect(events.at(-1)?.scrolling).toBe(false);
  expect(observed.owner.onNativeScroll).toHaveBeenCalledOnce();
});

it.each([false, true])(
  "restores native end anchoring only at the true tail (detached: %s)",
  (detached) => {
    const observed = observedMaintenance();
    const policy = makeChatHost({
      chatHasAutoScrolled: true,
      chatScrollElement: () => observed.element,
      chatIsProgrammaticScroll: observed.programmatic,
      chatIsMaintenanceScroll: () =>
        isTranscriptMaintenanceScroll(observed.state, observed.element),
    });
    if (detached) {
      policy.chatHistoryPagination = {
        hasMore: true,
        olderCursor: "older",
        hasNewer: true,
        newerCursor: "newer",
      };
    }
    observed.owner.canFollowEnd = () => canAutoFollowChat(policy);
    observed.owner.onReaderScroll.mockImplementation((towardEnd) =>
      handleChatScrollTakeover(policy, towardEnd),
    );
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

it.each(
  [-1, 1].flatMap((direction) =>
    ["none", "before capture", "after capture"].map((sync) => ({ direction, sync })),
  ),
)(
  "retires unissued preparation before boundary policy ($direction, $sync)",
  ({ direction, sync }) => {
    const observed = observedMaintenance();
    observed.native(400);
    const { pane, state } = createNativeShowEarlierPane(vi.fn());
    pane.visuallyPresented = true;
    state.chatHistoryPagination.hasNewer = true;
    pane.historyAutoLoadBlocked = true;
    const armOlder = vi.spyOn(pane, "syncHistoryObserver").mockImplementation(() => {});
    const loadNewer = vi.spyOn(pane, "loadNewerMessages").mockResolvedValue(true);
    pane.historyObserverArmed = false;
    observed.owner.onNativeScroll.mockImplementation((scroll) =>
      pane.handleTranscriptScroll(scroll),
    );
    observed.owner.onNativeScroll.mockClear();
    observed.owner.cancelScroll.mockImplementation(() => {
      observed.state.scrollCommand = null;
    });
    observed.state.scrollCommand = { target: "end", behavior: "smooth" };
    observed.element.scrollTop = direction < 0 ? 100 : 700;
    if (sync === "before capture") {
      observed.state.syncNativeOffset?.(true);
    } else if (sync === "after capture") {
      observed.owner.onComposerLayout.mockImplementationOnce(() =>
        observed.state.syncNativeOffset?.(true),
      );
    }
    observed.native();
    expect(observed.owner.cancelScroll).toHaveBeenCalledExactlyOnceWith();
    expect(observed.owner.onNativeScroll).toHaveBeenCalledExactlyOnceWith(
      readerScroll(direction < 0 ? 100 : 700, direction * 300),
    );
    expect(armOlder).toHaveBeenCalledTimes(direction < 0 ? 1 : 0);
    expect(loadNewer).toHaveBeenCalledTimes(direction > 0 ? 1 : 0);
  },
);

it.each(["no write", "new target", "inverse write", "post-cancel clamp"] as const)(
  "keeps the original reader fact through cancellation: %s",
  (change) => {
    const observed = observedMaintenance();
    observed.native(400);
    observed.owner.onNativeScroll.mockClear();
    observed.state.scrollCommand = { target: "end", behavior: "smooth" };
    observed.owner.cancelScroll.mockImplementation(() => {
      observed.state.scrollCommand = null;
      if (change === "post-cancel clamp") {
        observed.resize(200);
      } else if (change !== "no write") {
        observed.write(change === "inverse write" ? 400 : 300);
      }
    });
    observed.native(200);
    expect(observed.owner.onNativeScroll).toHaveBeenCalledExactlyOnceWith(readerScroll(200, -200));
    observed.native();
    const written = change === "new target" || change === "inverse write";
    expect(observed.owner.onNativeScroll.mock.calls.at(-1)?.[0]).toMatchObject({
      delta: 0,
      programmatic: written,
      maintenance: written,
    });
  },
);

it("keeps an OLD clamped maintenance target owned while end preparation is unissued", () => {
  const observed = observedMaintenance();
  observed.write(600);
  observed.native();
  observed.owner.onNativeScroll.mockClear();
  observed.state.scrollCommand = { target: "end", behavior: "smooth" };
  observed.resize(200);
  observed.native(200);
  expect(observed.owner.cancelScroll).toHaveBeenCalledExactlyOnceWith(true);
  expect(observed.owner.onNativeScroll).toHaveBeenCalledExactlyOnceWith({
    viewport: { scrollTop: 200, clientHeight: 200, scrollHeight: 400 },
    delta: -400,
    programmatic: true,
    maintenance: true,
  });
});

it.each(["nested", "disconnect", "replacement observer"] as const)(
  "lets %s win a cancellation's native capture",
  (change) => {
    const observed = observedMaintenance();
    observed.native(100);
    observed.owner.onNativeScroll.mockClear();
    observed.state.scrollCommand = { target: "end", behavior: "smooth" };
    observed.owner.cancelScroll.mockImplementation(() => {
      observed.state.scrollCommand = null;
      if (change === "nested") {
        observed.native(300);
      } else {
        observed.stop();
        if (change === "replacement observer") {
          onTestFinished(observed.connect());
        }
      }
    });
    observed.native(200);
    expect(observed.owner.onNativeScroll).toHaveBeenCalledTimes(change === "nested" ? 1 : 0);
    if (change === "nested") {
      expect(observed.owner.onNativeScroll.mock.calls[0]?.[0]).toMatchObject({
        viewport: { scrollTop: 300 },
        delta: 200,
        programmatic: false,
        maintenance: false,
      });
    } else if (change === "replacement observer") {
      observed.native(250);
      expect(observed.owner.onNativeScroll.mock.calls[0]?.[0]).toMatchObject({
        delta: 50,
        programmatic: false,
        maintenance: false,
      });
    }
  },
);

it("does not retire a command installed by composer layout", () => {
  const observed = observedMaintenance();
  observed.native(100);
  observed.state.scrollCommand = { target: "end", behavior: "smooth" };
  const replacement = { target: "end", behavior: "auto", offset: 700 } as const;
  observed.owner.onComposerLayout.mockImplementationOnce(() => {
    observed.state.scrollCommand = replacement;
  });
  observed.native(200);
  expect(observed.owner.cancelScroll).not.toHaveBeenCalled();
  expect(observed.state.scrollCommand).toBe(replacement);
});

it.each([false, true])("physically stops only an issued smooth command (issued: %s)", (issued) => {
  installTranscriptDomMocks();
  const host = new ChatSessionVirtualizerHost(vi.fn());
  onTestFinished(() => {
    host.dispose();
    resetTranscriptTestDom();
  });
  const element = document.createElement("div");
  element.scrollTop = 100;
  vi.spyOn(host, "scrollElement", "get").mockReturnValue(element);
  const stop = vi.spyOn(host.virtualizer, "scrollToOffset").mockImplementation(() => {});
  const cancel = vi.spyOn(host.virtualizer, "cancelScroll");
  host.offsetState.scrollCommand = {
    target: "end",
    behavior: "smooth",
    ...(issued ? { offset: 700 } : {}),
  };
  host.cancelScroll();
  expect(host.offsetState.scrollCommand).toBeNull();
  expect(cancel).toHaveBeenCalledTimes(issued ? 0 : 1);
  expect(stop).toHaveBeenCalledTimes(issued ? 1 : 0);
  if (issued) {
    expect(stop).toHaveBeenCalledExactlyOnceWith(100, { behavior: "instant" });
  }
});

it("does not stop a reconnected host at the same native element", () => {
  installTranscriptDomMocks();
  const host = new ChatSessionVirtualizerHost(vi.fn());
  onTestFinished(() => {
    host.dispose();
    resetTranscriptTestDom();
  });
  const element = document.createElement("div");
  vi.spyOn(host, "scrollElement", "get").mockReturnValue(element);
  host.connect();
  const stop = vi.spyOn(host.virtualizer, "scrollToOffset").mockImplementation(() => {});
  host.offsetState.scrollCommand = { target: "end", behavior: "smooth", offset: 700 };
  vi.spyOn(host.initialRange, "finishEnd").mockImplementationOnce(() => {
    host.disconnect();
    host.connect();
  });
  host.cancelScroll();
  expect(host.connected).toBe(true);
  expect(stop).not.toHaveBeenCalled();
});
