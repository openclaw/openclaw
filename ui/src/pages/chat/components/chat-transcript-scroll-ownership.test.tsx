/* @vitest-environment jsdom */

import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { makeChatHost } from "../chat-host.test-support.ts";
import { stubAnimationFrames } from "../chat-view.test-helpers.ts";
import {
  handleChatScroll,
  handleChatScrollTakeover,
  lockChatScroll,
  saveChatSessionScrollPosition,
  scheduleCommittedChatScroll,
} from "../scroll.ts";
import {
  configureNativeKeyTarget,
  nativeControlNavigationCases,
} from "../test-helpers/chat-scroll-input.tsx";
import {
  contact,
  mountTestTranscript,
  numberedContentRows,
  render,
} from "../test-helpers/chat-transcript-native.tsx";
import { createChatTranscript as createTranscript } from "./chat-transcript-controller.ts";
import { TranscriptEndAnchor } from "./chat-transcript-end-anchor.ts";
import {
  publishTranscriptScroll,
  subscribeTranscriptScroll,
} from "./chat-transcript-scroll-events.ts";
import { ChatSessionVirtualizerHost } from "./chat-transcript-virtualizer-host.ts";
import {
  installTranscriptDomMocks,
  resetTranscriptTestDom,
  resizeObservers,
  transcriptDomState,
  transcriptSize,
  type TestContentRow,
} from "./chat-transcript.test-support.ts";

const cleanups: (() => void)[] = [];
function makeTranscript(...args: Parameters<typeof createTranscript>) {
  const transcript = createTranscript(...args);
  cleanups.push(transcript.dispose);
  return transcript;
}
function contentRow(key: string, label = key): TestContentRow {
  return { kind: "content", key, content: <div>{label}</div> };
}
function createPolicyTranscript(paneId: string) {
  const policy = makeChatHost({ chatHasAutoScrolled: true });
  const transcript = makeTranscript(() => paneId, {
    canFollowEnd: () => !policy.chatFollowLocked,
    onReaderScroll: (towardEnd) => handleChatScrollTakeover(policy, towardEnd),
  });
  return { policy, transcript };
}

function resize(element: Element, height: number) {
  for (const observer of resizeObservers) {
    observer.emitTarget(element, 800, height);
  }
}
function viewport(element: HTMLElement, height: number, scrollHeight: number | (() => number)) {
  Object.defineProperties(element, {
    clientHeight: { configurable: true, value: height },
    scrollHeight: {
      configurable: true,
      ...(typeof scrollHeight === "number" ? { value: scrollHeight } : { get: scrollHeight }),
    },
  });
}
function expectReader(policy: ReturnType<typeof makeChatHost>, locked: boolean) {
  expect([policy.chatFollowLocked, policy.chatReadingHistory]).toEqual([locked, locked]);
}
function recordWrites(container: HTMLElement) {
  const writes: ScrollToOptions[] = [];
  container.scrollTo = (options?: ScrollToOptions | number) => {
    if (typeof options === "object") {
      writes.push(options);
      container.scrollTop = options.top ?? container.scrollTop;
    }
  };
  return writes;
}

function nativeScroll(container: HTMLElement, offset: number) {
  container.scrollTop = offset;
  container.dispatchEvent(new Event("scroll"));
}
function connectPolicy(
  policy: ReturnType<typeof makeChatHost>,
  transcript: ReturnType<typeof createTranscript>,
  container: HTMLElement,
) {
  policy.chatScrollElement = () => container;
  policy.chatIsProgrammaticScroll = () => transcript.isProgrammaticScroll;
  policy.chatIsMaintenanceScroll = () => transcript.isMaintenanceScroll;
  const onScroll = (event: Event) => handleChatScroll(policy, event);
  container.addEventListener("scroll", onScroll);
  cleanups.push(() => container.removeEventListener("scroll", onScroll));
}
async function mountRestoration(paneId: string, height: number) {
  const flushFrames = stubAnimationFrames();
  const rows = numberedContentRows(40);
  const mounted = await mountTestTranscript(
    paneId,
    rows,
    makeTranscript(() => paneId),
  );
  const range = { height };
  viewport(mounted.container, 600, () => range.height);
  return {
    ...mounted,
    range,
    rows,
    writes: recordWrites(mounted.container),
    settled: vi.fn(),
    finishFrames: () => {
      for (let frame = 0; frame < 15; frame++) {
        flushFrames();
        mounted.renderRows(rows);
      }
    },
  };
}

beforeEach(installTranscriptDomMocks);
afterEach(() => {
  for (const cleanup of cleanups.splice(0).toReversed()) {
    cleanup();
  }
  vi.useRealTimers();
  resetTranscriptTestDom();
});

it("records a changed end edge without an extra pane render", async () => {
  const paneId = "offset-end-edge";
  saveChatSessionScrollPosition(paneId, `agent:main:${paneId}`, {
    scrollTop: 0,
    anchorToEnd: false,
  });
  transcriptDomState.measuredRowHeight = 1000;
  const invalidate = vi.fn();
  const transcript = makeTranscript(() => paneId, {
    canFollowEnd: () => false,
  });
  cleanups.push(transcript.subscribe(invalidate));
  const rows = [contentRow("long-run", "Long transcript run")];
  const { container, session, renderRows } = await mountTestTranscript(paneId, rows, transcript);
  if (!(session instanceof ChatSessionVirtualizerHost)) {
    throw new Error("Expected the session-owned transcript virtualizer");
  }
  viewport(container, 400, 1000);
  resize(container, 400);
  nativeScroll(container, 300);
  renderRows(rows);
  expect(session["endAnchor"].atEnd).toBe(false);
  const geometry = vi.spyOn(session["virtualizer"].options, "onChange");
  invalidate.mockClear();

  nativeScroll(container, 600);
  expect(session["endAnchor"].atEnd).toBe(true);
  expect(invalidate).toHaveBeenCalledTimes(geometry.mock.calls.length);
});

it.each([
  { name: "suspended following", suspended: true, steps: [[1200, 600, true]] },
  { name: "same-range native movement", steps: [[1000, 592]] },
  { name: "native movement after growth", steps: [[1100, 592, false]] },
  { name: "cancelled reader anchor", cancelled: true, steps: [[1200, 600]] },
  {
    name: "native end clamp",
    steps: [
      [1000, 400],
      [750, 350, false],
      [950, 350],
    ],
  },
] satisfies {
  name: string;
  suspended?: boolean;
  cancelled?: boolean;
  steps: [height: number, offset: number, resizeAnchor?: boolean][];
}[])("does not reacquire following after $name", ({ suspended, cancelled, steps }) => {
  const element = document.createElement("div");
  let scrollHeight = 1000;
  Object.defineProperties(element, {
    clientHeight: { value: 400 },
    scrollHeight: { get: () => scrollHeight },
  });
  element.scrollTop = 600;
  const anchor = new TranscriptEndAnchor();
  anchor.capture(element);
  if (cancelled) {
    anchor.clear();
  }
  const follow = vi.fn();
  for (const [height, offset, resizeAnchor] of steps) {
    scrollHeight = height;
    element.scrollTop = offset;
    if (resizeAnchor !== undefined) {
      expect(anchor.isResizeAnchor(element)).toBe(resizeAnchor);
    }
    anchor.reconcile(element, true, suspended ?? false, follow);
    expect(follow).not.toHaveBeenCalled();
    expect(element.scrollTop).toBe(offset);
  }
});

it.each(["resize clamp", "native return"] as const)(
  "distinguishes a %s after same-range reader scrolling before composer layout",
  async (movement) => {
    // The frame fixture must restore native rAF after the fake clock is uninstalled.
    vi.useFakeTimers({ toNotFake: ["requestAnimationFrame", "cancelAnimationFrame"] });
    const flushFrames = stubAnimationFrames();
    transcriptDomState.measuredRowHeight = 1000;
    const container = document.body.appendChild(document.createElement("div"));
    let viewportHeight = 400;
    Object.defineProperties(container, {
      clientHeight: { configurable: true, get: () => viewportHeight },
      scrollHeight: { configurable: true, value: 1000 },
    });
    container.scrollTo = (options?: ScrollToOptions | number, y?: number) => {
      const offset = typeof options === "number" ? (y ?? 0) : (options?.top ?? 0);
      container.scrollTop = Math.min(offset, 1000 - viewportHeight);
    };
    let updateRequested = true;
    const onReaderScroll = vi.fn();
    const transcript = makeTranscript(() => `composer-reader-${movement}`, {
      canFollowEnd: () => false,
      onReaderScroll,
    });
    cleanups.push(
      transcript.subscribe(() => {
        updateRequested = true;
      }),
    );
    const rows = [contentRow("long-run", "Long transcript run")];
    const commitRequestedUpdate = async () => {
      // TanStack queues its host notification behind updateComplete.
      await Promise.resolve();
      if (updateRequested) {
        updateRequested = false;
        render(
          transcript.renderSession(`agent:main:composer-reader-${movement}`, (session) => {
            session.setContentReady(true);
            return session.render(
              rows,
              (row) => (row.kind === "content" ? row.content : null),
              null,
              false,
            );
          }),
          container,
        );
        transcript.update();
      }
      // Connected row refs measure after their two owned microtask checkpoints.
      await Promise.resolve();
      await Promise.resolve();
      flushFrames();
    };
    transcript.start();
    await commitRequestedUpdate();
    await commitRequestedUpdate();
    transcript.scrollToOffset(100);
    await commitRequestedUpdate();
    await commitRequestedUpdate();

    nativeScroll(container, 200);
    await commitRequestedUpdate();
    // Both offsets stay in one long row and away from the physical end.
    nativeScroll(container, 550);
    await commitRequestedUpdate();
    onReaderScroll.mockClear();

    publishTranscriptScroll(container, { type: "composer-input" });
    if (movement === "resize clamp") {
      viewportHeight = 500;
      container.scrollTop = 500;
    } else {
      // Native movement can reach the old end before its scroll event.
      container.scrollTop = 600;
      viewportHeight = 300;
    }
    container.dispatchEvent(new Event("scroll"));

    expect(container.scrollTop).toBe(movement === "resize clamp" ? 500 : 700);
    if (movement === "resize clamp") {
      expect(onReaderScroll).not.toHaveBeenCalled();
    } else {
      expect(onReaderScroll).toHaveBeenCalledExactlyOnceWith(true);
    }
  },
);

it.each([
  ...(["following", "reading", "wheel", "key", "pointer", "touch"] as const).map((intent) => ({
    intent,
    nativeResize: "none" as const,
  })),
  ...(["following", "reading", "wheel"] as const).flatMap((intent) =>
    (["growth", "shrink"] as const).map((nativeResize) => ({ intent, nativeResize })),
  ),
])(
  "preserves $intent ownership through composer $nativeResize and row growth",
  async ({ intent, nativeResize }) => {
    const flushFrames = stubAnimationFrames();
    const { policy, transcript } = createPolicyTranscript(`footer-${intent}`);
    const rows: TestContentRow[] = numberedContentRows(12);
    const { container } = await mountTestTranscript(`footer-${intent}`, rows, transcript);
    viewport(container, 400, 2000);
    container.scrollTop = 1600;
    policy.chatLastScrollTop = 1600;
    connectPolicy(policy, transcript, container);
    transcript.scrollToEnd({ behavior: "auto" });
    if (intent === "reading") {
      policy.chatFollowLocked = true;
      policy.chatReadingHistory = true;
    }
    const corrections: Array<{ before: number; after: number }> = [];
    const stopObserving = subscribeTranscriptScroll(container, (observation) => {
      if (observation.type === "resize" && observation.scrollCorrection) {
        corrections.push(observation.scrollCorrection);
      }
    });
    if (nativeResize !== "none") {
      // beforeinput records intent without measuring. The native edit then
      // changes the viewport before either the overflow or resize observer.
      publishTranscriptScroll(container, { type: "composer-input" });
      Object.defineProperty(container, "clientHeight", {
        configurable: true,
        value: nativeResize === "growth" ? 350 : 450,
      });
      container.scrollTop = nativeResize === "growth" ? 1572 : 1550;
    }
    publishTranscriptScroll(container, { type: "composer-layout", changed: true });
    stopObserving();
    if (nativeResize !== "none") {
      const follows = intent !== "reading";
      const nativeOffset = nativeResize === "growth" ? 1572 : 1550;
      const endOffset = nativeResize === "growth" ? 1650 : 1550;
      expect(container.scrollTop).toBe(follows ? endOffset : nativeOffset);
      expect(corrections).toEqual(
        follows ? [{ before: nativeResize === "growth" ? 1572 : 1600, after: endOffset }] : [],
      );
    }
    Object.defineProperty(container, "scrollHeight", { configurable: true, value: 2087 });
    transcript.update();
    if (intent === "wheel") {
      container.dispatchEvent(new WheelEvent("wheel", { deltaY: -100 }));
    } else if (intent === "key") {
      container.dispatchEvent(new KeyboardEvent("keydown", { key: "PageUp" }));
    } else if (intent === "pointer") {
      container.dispatchEvent(new PointerEvent("pointerdown"));
    } else if (intent === "touch") {
      const touches = [contact(1, container)];
      container.dispatchEvent(new TouchEvent("touchstart", { touches, changedTouches: touches }));
    }
    container.dispatchEvent(new Event("scroll"));
    expectReader(policy, intent !== "following");
    flushFrames();
    expectReader(policy, intent !== "following");
  },
);
it.each([
  { movement: "intermediate native movement", smooth: true, finalOffset: 1170 },
  { movement: "upward retarget and no-op", smooth: false, finalOffset: 1240 },
])(
  "preserves following through $movement until reader takeover",
  async ({ smooth, finalOffset }) => {
    const flushFrames = stubAnimationFrames();
    const { policy, transcript } = createPolicyTranscript("end-retarget");
    const { container } = await mountTestTranscript(
      "end-retarget",
      numberedContentRows(20),
      transcript,
    );
    const geometry = { height: 2000 };
    viewport(container, 600, () => geometry.height);
    container.scrollTo = (options?: ScrollToOptions | number) => {
      // Smooth requests deliver native offsets later; they do not jump to the target.
      if (typeof options === "object" && !(smooth && options.behavior === "smooth")) {
        container.scrollTop = Math.min(options.top ?? container.scrollTop, geometry.height - 600);
      }
    };
    policy.chatScrollToEnd = (options) => transcript.scrollToEnd(options);
    connectPolicy(policy, transcript, container);
    resize(container, 600);
    if (smooth) {
      container.scrollTop = 1300;
      policy.chatLastScrollTop = 1300;
      transcript.scrollToEnd({ source: "auto", behavior: "smooth" });
      expect(transcript.isProgrammaticScroll).toBe(true);
      // Native offsets arrive only after retired rows and new measurements.
      geometry.height = 1800;
      container.scrollTop = 1200;
      geometry.height = 1920;
      nativeScroll(container, 1250);
    } else {
      transcript.scrollToEnd({ source: "auto" });
      container.dispatchEvent(new Event("scroll"));
      flushFrames();
      expect(container.scrollTop).toBe(1400);
      geometry.height = 1800;
      transcript.scrollToEnd({ source: "auto" });
      expect(container.scrollTop).toBe(1200);
      transcript.scrollToEnd({ source: "auto" });
      transcript.cancelScroll();
      geometry.height = 1920;
      container.dispatchEvent(new Event("scroll"));
      expect(policy.chatFollowLocked).toBe(false);
      scheduleCommittedChatScroll(policy);
      flushFrames();
      expect(container.scrollTop).toBe(1320);
      container.dispatchEvent(new Event("scroll"));
    }
    expect(policy.chatFollowLocked, "end movement must not take reader control").toBe(false);
    container.dispatchEvent(new WheelEvent("wheel", { deltaY: -80 }));
    nativeScroll(container, container.scrollTop - 80);
    expect(policy.chatFollowLocked).toBe(true);
    if (smooth) {
      expect(transcript.isProgrammaticScroll).toBe(false);
    }
    geometry.height = 2040;
    scheduleCommittedChatScroll(policy);
    flushFrames();
    expect(container.scrollTop).toBe(finalOffset);
  },
);

it("cancels the active native target when the reader locks following", async () => {
  const flushFrames = stubAnimationFrames();
  const policy = makeChatHost({ chatHasAutoScrolled: true });
  const transcript = makeTranscript(() => "retired-end-index", {
    canFollowEnd: () => !policy.chatFollowLocked,
  });
  policy.chatCancelScroll = () => transcript.cancelScroll();
  const content = numberedContentRows(12);
  const typing = contentRow("presence:typing", "Typing");
  const { container, renderRows } = await mountTestTranscript(
    "retired-end-index",
    [...content, typing],
    transcript,
  );
  viewport(container, 600, () => transcriptSize(container));
  container.scrollTo = vi.fn((options?: ScrollToOptions | number, y?: number) => {
    container.scrollTop = typeof options === "number" ? (y ?? 0) : (options?.top ?? 0);
  });
  const typingRow = expectDefined(
    container.querySelector<HTMLElement>('[data-virtual-row-key="presence:typing"]'),
    "typing row",
  );
  Object.defineProperty(typingRow, "offsetHeight", { configurable: true, value: 30 });
  for (const observer of resizeObservers) {
    observer.emitTarget(container, 800, 600);
    observer.emitTarget(typingRow, 800, 30);
  }
  renderRows([...content, typing]);
  flushFrames();
  transcript.scrollToEnd({ source: "auto", behavior: "auto" });
  container.dispatchEvent(new Event("scroll"));
  lockChatScroll(policy);
  expect(policy.chatFollowLocked).toBe(true);
  const before = container.scrollTop;
  transcriptDomState.measuredRowHeight = 120;
  const next: TestContentRow[] = [...content, contentRow("peer", "Peer"), typing];
  renderRows(next);
  await Promise.resolve();
  renderRows(next);
  flushFrames();
  expect(container.scrollTop, "retired index must not follow the peer replacing typing").toBe(
    before,
  );
});

it("preserves reader policy when row measurement clamps a positive adjustment to the end", async () => {
  transcriptDomState.measuredRowHeight = 120;
  const { policy, transcript } = createPolicyTranscript("measurement-reader");
  const rows: TestContentRow[] = numberedContentRows(12);
  const { container, renderRows } = await mountTestTranscript(
    "measurement-reader",
    rows,
    transcript,
  );
  const total = transcriptSize(container);
  let maxScrollTop = total + 84 - 600;
  viewport(container, 600, () => maxScrollTop + 600);
  container.scrollTo = (options?: ScrollToOptions | number) => {
    if (typeof options === "object") {
      container.scrollTop = Math.min(options.top ?? container.scrollTop, maxScrollTop);
    }
  };
  policy.chatScrollElement = () => container;
  policy.chatIsProgrammaticScroll = () => transcript.isProgrammaticScroll;
  container.addEventListener("scroll", (event) => handleChatScroll(policy, event));
  resize(container, 600);
  nativeScroll(container, total + 84 - 600);
  container.scrollTop -= 24;
  container.dispatchEvent(new Event("scroll"));
  expect(policy.chatReadingHistory).toBe(true);
  vi.useFakeTimers();
  container.dispatchEvent(new Event("scroll"));
  vi.advanceTimersByTime(150);
  renderRows(rows);
  await vi.advanceTimersByTimeAsync(0);
  const row = expectDefined(
    container.querySelector<HTMLElement>('[data-index="6"]'),
    "row above the viewport",
  );
  Object.defineProperty(row, "offsetHeight", { configurable: true, value: 160 });
  resize(row, 160);
  expect(container.scrollTop).toBe(total + 84 - 600);
  container.dispatchEvent(new Event("scroll"));
  expectReader(policy, true);
  // A partial sizer commit lets TanStack retry the clamped adjustment as an absolute write.
  maxScrollTop += 16;
  renderRows(rows);
  expect(container.scrollTop).toBe(maxScrollTop);
  // The dock can keep shrinking the scroll range before the native read-back arrives.
  maxScrollTop -= 8;
  nativeScroll(container, maxScrollTop);
  expectReader(policy, true);
  container.dispatchEvent(new WheelEvent("wheel", { deltaY: 1 }));
  expectReader(policy, false);
  expect(transcript.isProgrammaticScroll).toBe(false);
});

it.each([
  ["wheel", null, (): null => null, false],
  ["downward wheel", null, (): null => null, false],
  ["stationary wheel", null, (): null => null, false],
  ["pointer", null, (): null => null, false],
  ["latest", null, (): null => null, false],
  ["automatic follow", null, (): null => null, true],
  ["text input", "ArrowUp", () => <input />, true],
  ["range input", "Home", () => <input type="range" />, true],
  ["range Space", " ", () => <input type="range" />, false],
  ["select", "ArrowUp", () => <select />, true],
  [
    "editable child",
    "ArrowUp",
    () => (
      <div contenteditable="true">
        <span>Text</span>
      </div>
    ),
    true,
  ],
  ["shadow input", "ArrowUp", () => <input />, true],
  ["button", " ", () => <button>Play</button>, true],
  ["button PageUp", "PageUp", () => <button>Play</button>, false],
  ["link Space", " ", () => <a href="#">Details</a>, false],
  ["listbox", "PageUp", () => <select size={2} />, true],
  ["textarea", " ", () => <textarea>Text</textarea>, true],
  [
    "handled player",
    " ",
    () => <div onKeyDown={(event) => event.preventDefault()}>Player</div>,
    true,
  ],
  ["transcript text", "PageUp", () => <span>History</span>, false],
  ["readonly content", "End", () => <div contenteditable="false">History</div>, false],
  // The pane keyboard suite covers native-control/platform variants.
  // Retain downward nested scrolling and media boundaries in restoration.
  ["native video", "End", () => <video controls />, true],
  ["native audio paging", "PageDown", () => <audio controls />, false],
  ...nativeControlNavigationCases.filter(
    ([name, key]) => name.startsWith("Mac textarea ") && (key === "End" || key === "PageDown"),
  ),
] as const)(
  "resolves pending restoration ownership for %s",
  async (command, key, content, preservesRestore, fixture = {}) => {
    const view = await mountRestoration(`restore-${command}`, 800);
    const { container, transcript } = view;
    transcript.scrollToOffset(420, view.settled);
    view.renderRows(view.rows);
    expect(view.settled).not.toHaveBeenCalled();
    if (key) {
      const target = container.appendChild(document.createElement("div"));
      render(content(), target);
      const restorePlatform = configureNativeKeyTarget(
        expectDefined(target.firstElementChild, "native control"),
        fixture,
      );
      const keyboardTarget = expectDefined(
        target.querySelector("span") ?? target.firstElementChild,
        "keyboard target",
      );
      if (command === "shadow input") {
        target.attachShadow({ mode: "open" }).append(keyboardTarget);
      }
      keyboardTarget.dispatchEvent(
        new KeyboardEvent("keydown", {
          key,
          shiftKey: fixture.shiftKey,
          ctrlKey: fixture.ctrlKey,
          bubbles: true,
          composed: true,
          cancelable: true,
        }),
      );
      restorePlatform();
    } else if (["wheel", "downward wheel", "stationary wheel", "pointer"].includes(command)) {
      container.dispatchEvent(
        command === "pointer"
          ? new PointerEvent("pointerdown")
          : new WheelEvent("wheel", { deltaY: command === "wheel" ? -100 : 100 }),
      );
      if (command !== "stationary wheel") {
        nativeScroll(container, command === "downward wheel" ? 520 : 300);
      }
    } else if (command === "automatic follow") {
      expect(transcript.scrollToEnd({ source: "auto" })).toBe(false);
    } else {
      expect(transcript.scrollToEnd()).toBe(true);
    }
    const inputOffset = container.scrollTop;
    view.writes.length = 0;
    if (preservesRestore) {
      view.range.height = 4800;
    }
    view.finishFrames();
    if (preservesRestore) {
      expect(view.settled).toHaveBeenCalledWith({ scrollTop: 420, anchorToEnd: false });
      expect(container.scrollTop).toBe(420);
    } else {
      expect(view.settled).not.toHaveBeenCalled();
      expect(view.writes.some((write) => write.top === 420)).toBe(false);
      expect(container.scrollTop).toBe(inputOffset);
    }
  },
);

it("keeps reader input in control after a reachable restoration settles", async () => {
  const view = await mountRestoration("settled-restore-input", 4800);
  const { container, transcript } = view;
  transcript.scrollToOffset(420, view.settled);
  view.renderRows(view.rows);
  expect(view.settled).toHaveBeenCalledWith({ scrollTop: 420, anchorToEnd: false });

  view.writes.length = 0;
  container.dispatchEvent(new WheelEvent("wheel", { deltaY: -100 }));
  nativeScroll(container, 300);
  view.finishFrames();

  expect(container.scrollTop).toBe(300);
  expect(view.writes.some((write) => write.top === 420)).toBe(false);
});
