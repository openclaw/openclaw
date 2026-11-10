/* @vitest-environment jsdom */
import { Virtualizer } from "@tanstack/virtual-core";
import { expect, it, onTestFinished, vi } from "vitest";
import { makeChatHost } from "../chat-host.test-support.ts";
import { createNativeShowEarlierPane } from "../chat-pane-history.test-support.ts";
import { canAutoFollowChat, handleChatScroll, handleChatScrollTakeover } from "../scroll.ts";
import { TranscriptLayoutOwner } from "./chat-transcript-layout-owner.ts";
import { readerScroll, recordOffsets } from "./chat-transcript-offset-observer.test-support.ts";
import {
  isTranscriptMaintenanceScroll,
  observeTranscriptOffset,
  scrollTranscriptOffset,
  TranscriptOffsetState,
} from "./chat-transcript-offset-observer.ts";
import { subscribeTranscriptScroll } from "./chat-transcript-scroll-events.ts";
import { offsetOwner } from "./chat-transcript.test-support.ts";

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
  const deliveries: Array<{ offset: number; scrolling: boolean; programmatic: boolean }> = [];
  const owner = offsetOwner(state, element, { onNativeScroll: vi.fn() });
  const programmatic = owner.isProgrammaticScroll;
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
  ].flatMap((testCase) => [
    Object.assign({}, testCase, { retired: false }),
    Object.assign({}, testCase, { name: "late " + testCase.name, retired: true }),
  ]),
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
  "publishes fresh reader takeover before boundary policy ($direction, $sync)",
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
    observed.element.dispatchEvent(
      new WheelEvent("wheel", { deltaY: direction, cancelable: true }),
    );
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

it.each(
  (["auto", "instant"] as const).flatMap((behavior) =>
    [false, true].flatMap((issued) =>
      ["none", "before capture", "after capture"].map((sync) => ({ behavior, issued, sync })),
    ),
  ),
)(
  "retires backward $behavior movement before policy (issued: $issued, sync: $sync)",
  ({ behavior, issued, sync }) => {
    const observed = observedMaintenance();
    observed.native(400);
    observed.owner.onNativeScroll.mockClear();
    observed.owner.cancelScroll.mockImplementation(() => {
      observed.state.scrollCommand = null;
    });
    observed.state.scrollCommand = { target: "end", behavior, ...(issued ? { offset: 800 } : {}) };
    observed.element.scrollTop = 200;
    if (sync === "before capture") {
      observed.state.syncNativeOffset?.(true);
    } else if (sync === "after capture") {
      observed.owner.onComposerLayout.mockImplementationOnce(() =>
        observed.state.syncNativeOffset?.(true),
      );
    }
    observed.native();
    expect(observed.owner.cancelScroll).toHaveBeenCalledExactlyOnceWith();
    expect(observed.state.scrollCommand).toBeNull();
    expect(observed.owner.onNativeScroll).toHaveBeenCalledExactlyOnceWith(readerScroll(200, -200));
  },
);

it.each([
  { behavior: "smooth", issued: false, next: 200 },
  { behavior: "smooth", issued: true, next: 200 },
  { behavior: "auto", issued: false, next: 700 },
  { behavior: "instant", issued: true, next: 700 },
] as const)(
  "retains $behavior native movement without fresh input (issued: $issued)",
  ({ behavior, issued, next }) => {
    const observed = observedMaintenance();
    observed.native(400);
    observed.owner.onNativeScroll.mockClear();
    const command = (observed.state.scrollCommand = {
      target: "end",
      behavior,
      ...(issued ? { offset: 800 } : {}),
    });
    observed.native(next);
    expect(observed.owner.cancelScroll).not.toHaveBeenCalled();
    expect(observed.state.scrollCommand).toBe(command);
    expect(observed.owner.onNativeScroll).toHaveBeenCalledExactlyOnceWith({
      ...readerScroll(next, next - 400),
      programmatic: true,
    });
  },
);

it.each(["no write", "new target", "inverse write", "post-cancel clamp"] as const)(
  "keeps the original reader fact through cancellation: %s",
  (change) => {
    const observed = observedMaintenance();
    observed.native(400);
    observed.owner.onNativeScroll.mockClear();
    observed.state.scrollCommand = { target: "end", behavior: "auto" };
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
  const command = (observed.state.scrollCommand = { target: "end", behavior: "auto" });
  observed.resize(200);
  observed.native(200);
  expect(observed.owner.cancelScroll).not.toHaveBeenCalled();
  expect(observed.state.scrollCommand).toBe(command);
  expect(observed.state.scrollCommand?.offset).toBeUndefined();
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
    observed.native(400);
    observed.owner.onNativeScroll.mockClear();
    observed.state.scrollCommand = { target: "end", behavior: "auto" };
    observed.owner.cancelScroll.mockImplementation(() => {
      observed.state.scrollCommand = null;
      if (change === "nested") {
        observed.native(100);
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
        viewport: { scrollTop: 100 },
        delta: -300,
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
  observed.native(400);
  observed.state.scrollCommand = { target: "end", behavior: "auto" };
  const replacement = { target: "end", behavior: "auto", offset: 700 } as const;
  observed.owner.onComposerLayout.mockImplementationOnce(() => {
    observed.state.scrollCommand = replacement;
  });
  observed.native(200);
  expect(observed.owner.cancelScroll).not.toHaveBeenCalled();
  expect(observed.state.scrollCommand).toBe(replacement);
});
