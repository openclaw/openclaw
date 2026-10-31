/* @vitest-environment jsdom */
import { Virtualizer } from "@tanstack/virtual-core";
import { expect, it, onTestFinished, vi } from "vitest";
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
  observeTranscriptOffset,
  scrollTranscriptOffset,
  TranscriptOffsetState,
} from "./chat-transcript-offset-observer.ts";
import { TranscriptPrependAnchor } from "./chat-transcript-prepend-anchor.ts";
import { createTranscriptPresentation } from "./chat-transcript-session.ts";
import {
  installTranscriptDomMocks,
  resetTranscriptTestDom,
  resizeObservers,
} from "./chat-transcript.test-support.ts";

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
  const onNativeScroll = vi.fn((event: Event) => {
    expect(event.currentTarget).toBe(element);
    expect(event.target).toBe(element);
    paneRecordedEnd.push(endAnchor.isRecordedEnd(element.scrollTop));
    order.push("pane");
  });
  onTestFinished(
    observeTranscriptOffset(
      {
        state,
        getScrollElement: () => element,
        endAnchor,
        prependAnchor: new TranscriptPrependAnchor(new Map(), vi.fn()),
        canFollowEnd: () => false,
        isProgrammaticScroll: () => isTranscriptProgrammaticScroll(state, element),
        cancelScroll,
        onLayoutCorrection: vi.fn(),
        invalidate: vi.fn(),
        onOffset,
        onReaderScroll,
        onComposerLayout: () => order.push("composer"),
        onNativeScroll,
      },
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
  expect(order).toEqual(["composer", "virtualizer", "pane"]);
  expect(deliver).toHaveBeenCalledWith(20, true);
  expect(onOffset).toHaveBeenCalledOnce();
  expect(recordedEnd).toEqual([true]);
  expect(paneRecordedEnd).toEqual([true]);
  expect(geometryReads).toEqual([false, false]);
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
  state.scrollCommand = { target: "end", behavior: "smooth" };
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
  { position: "end", offset: 800, expected: 870, following: true },
  { position: "history", offset: 600, expected: 600, following: false },
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
        {
          state,
          getScrollElement: () => element,
          endAnchor,
          prependAnchor: new TranscriptPrependAnchor(new Map(), vi.fn()),
          canFollowEnd: () => canAutoFollowChat(policy),
          isProgrammaticScroll: () => isTranscriptProgrammaticScroll(state, element),
          cancelScroll: vi.fn(),
          onLayoutCorrection: (before, after) => endAnchor.recordLayoutCorrection(before, after),
          invalidate: vi.fn(),
          onOffset: vi.fn(),
          onReaderScroll: (towardEnd) => handleChatScrollTakeover(policy, towardEnd),
          onComposerLayout: vi.fn(),
        },
        instance,
        callback,
      ),
  });
  const { _didMount: mount, _willUpdate: update } = virtualizer;
  onTestFinished(mount());
  update();
  const onScroll = (event: Event) => handleChatScroll(policy, event);
  element.addEventListener("scroll", onScroll);
  onTestFinished(() => element.removeEventListener("scroll", onScroll));
  element.dispatchEvent(new Event("scroll"));

  // ResizeObserver can synchronize physical movement before the native scroll event.
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
  const rows = Array.from({ length: 4 }, (_, index) => {
    const row = element.appendChild(document.createElement("div"));
    row.dataset.index = String(index);
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
      observeTranscriptOffset(
        {
          state,
          getScrollElement: () => element,
          endAnchor: new TranscriptEndAnchor(() => {}),
          prependAnchor: new TranscriptPrependAnchor(new Map(), vi.fn()),
          canFollowEnd: () => false,
          isProgrammaticScroll: () => isTranscriptProgrammaticScroll(state, element),
          cancelScroll: vi.fn(),
          onLayoutCorrection: vi.fn(),
          invalidate: vi.fn(),
          onOffset: vi.fn(),
          onReaderScroll: vi.fn(),
          onComposerLayout: vi.fn(),
        },
        instance,
        callback,
      ),
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
