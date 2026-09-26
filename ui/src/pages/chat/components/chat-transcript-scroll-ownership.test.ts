/* @vitest-environment jsdom */

import { expectDefined } from "@openclaw/normalization-core";
import { html, nothing, render, type ReactiveController } from "lit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeChatHost } from "../chat-host.test-support.ts";
import { stubAnimationFrames } from "../chat-view.test-helpers.ts";
import { handleChatScroll, handleChatScrollTakeover, lockChatScroll } from "../scroll.ts";
import {
  configureNativeKeyTarget,
  nativeControlNavigationCases,
} from "../test-helpers/chat-scroll-input.ts";
import { ChatTranscriptController } from "./chat-transcript-controller.ts";
import { TranscriptEndAnchor } from "./chat-transcript-end-anchor.ts";
import { createTranscriptOffsetState } from "./chat-transcript-offset-observer.ts";
import {
  publishTranscriptScroll,
  subscribeTranscriptScroll,
} from "./chat-transcript-scroll-events.ts";
import {
  installTranscriptDomMocks,
  mountTestTranscript,
  resetTranscriptTestDom,
  resizeObservers,
  transcriptDomState,
  transcriptSize,
  type TestContentRow,
} from "./chat-transcript.test-support.ts";

describe("chat transcript scroll ownership", () => {
  beforeEach(installTranscriptDomMocks);
  afterEach(resetTranscriptTestDom);

  it("does not follow a captured footer commit while end anchoring is suspended", () => {
    const element = document.createElement("div");
    Object.defineProperties(element, {
      clientHeight: { configurable: true, value: 400 },
      scrollHeight: { configurable: true, value: 1000 },
    });
    element.scrollTop = 600;
    const anchor = new TranscriptEndAnchor();
    anchor.capture(element);
    anchor.prepareUpdate(element, true, createTranscriptOffsetState());
    Object.defineProperty(element, "scrollHeight", { configurable: true, value: 1200 });
    expect(anchor.isResizingCommit(element)).toBe(true);
    const follow = vi.fn();

    anchor.releaseCommit();
    anchor.reconcile(element, true, true, follow);

    expect(follow).not.toHaveBeenCalled();
  });

  it("does not override native movement during a commit with an unchanged scroll range", () => {
    const element = document.createElement("div");
    Object.defineProperties(element, {
      clientHeight: { configurable: true, value: 400 },
      scrollHeight: { configurable: true, value: 1000 },
    });
    element.scrollTop = 600;
    const anchor = new TranscriptEndAnchor();
    anchor.capture(element);
    anchor.prepareUpdate(element, true, createTranscriptOffsetState());
    element.scrollTop -= 8;
    const follow = vi.fn();

    anchor.releaseCommit();
    anchor.reconcile(element, true, false, follow);

    expect(follow).not.toHaveBeenCalled();
    expect(element.scrollTop).toBe(592);
  });

  it("preserves a commit's native clamp when the footer restores the original scroll range", () => {
    const element = document.createElement("div");
    Object.defineProperties(element, {
      clientHeight: { configurable: true, value: 400 },
      scrollHeight: { configurable: true, value: 1000 },
    });
    element.scrollTop = 600;
    const anchor = new TranscriptEndAnchor();
    anchor.capture(element);
    anchor.prepareUpdate(element, true, createTranscriptOffsetState());
    Object.defineProperty(element, "clientHeight", { configurable: true, value: 500 });
    element.scrollTop = 500;
    anchor.commitUpdate(element);
    Object.defineProperty(element, "clientHeight", { configurable: true, value: 400 });
    const follow = vi.fn(() => {
      element.scrollTop = 600;
    });

    expect(anchor.isResizingCommit(element)).toBe(true);
    anchor.releaseCommit();
    anchor.reconcile(element, true, false, follow);

    expect(follow).toHaveBeenCalledOnce();
    expect(element.scrollTop).toBe(600);
  });

  it.each(["footer", "row"] as const)(
    "preserves native movement after an observed %s commit changes the scroll range",
    (kind) => {
      const element = document.createElement("div");
      Object.defineProperties(element, {
        clientHeight: { configurable: true, value: 400 },
        scrollHeight: { configurable: true, value: 1000 },
      });
      element.scrollTop = 600;
      const anchor = new TranscriptEndAnchor();
      anchor.capture(element);
      anchor.prepareUpdate(element, true, createTranscriptOffsetState());
      if (kind === "footer") {
        Object.defineProperty(element, "clientHeight", { configurable: true, value: 500 });
        element.scrollTop = 500;
      } else {
        Object.defineProperty(element, "scrollHeight", { configurable: true, value: 1100 });
      }
      anchor.commitUpdate(element);
      Object.defineProperty(element, "clientHeight", { configurable: true, value: 400 });
      element.scrollTop -= 8;
      const movedPosition = element.scrollTop;
      const follow = vi.fn();

      expect(anchor.isResizingCommit(element)).toBe(false);
      anchor.releaseCommit();
      anchor.reconcile(element, true, false, follow);

      expect(follow).not.toHaveBeenCalled();
      expect(element.scrollTop).toBe(movedPosition);
    },
  );

  it("does not recapture native movement when another footer commit follows before reconciliation", () => {
    const element = document.createElement("div");
    Object.defineProperties(element, {
      clientHeight: { configurable: true, value: 400 },
      scrollHeight: { configurable: true, value: 1000 },
    });
    element.scrollTop = 600;
    const anchor = new TranscriptEndAnchor();
    anchor.capture(element);
    anchor.prepareUpdate(element, true, createTranscriptOffsetState());
    anchor.commitUpdate(element);
    element.scrollTop -= 8;
    anchor.prepareUpdate(element, true, createTranscriptOffsetState());
    Object.defineProperty(element, "clientHeight", { configurable: true, value: 500 });
    element.scrollTop = 500;
    anchor.commitUpdate(element);
    Object.defineProperty(element, "clientHeight", { configurable: true, value: 400 });
    const follow = vi.fn();

    anchor.releaseCommit();
    anchor.reconcile(element, true, false, follow);

    expect(follow).not.toHaveBeenCalled();
    expect(element.scrollTop).toBe(500);
  });

  it("does not reacquire precommit following from a cancelled reader anchor", () => {
    const element = document.createElement("div");
    Object.defineProperties(element, {
      clientHeight: { configurable: true, value: 400 },
      scrollHeight: { configurable: true, value: 1000 },
    });
    element.scrollTop = 600;
    const anchor = new TranscriptEndAnchor();
    anchor.capture(element);
    // Wheel/keyboard input can precede its native offset change and the Lit update.
    anchor.clear();
    anchor.prepareUpdate(element, true, createTranscriptOffsetState());
    Object.defineProperty(element, "scrollHeight", { configurable: true, value: 1200 });
    const follow = vi.fn();
    anchor.releaseCommit();
    anchor.reconcile(element, true, false, follow);
    expect(follow).not.toHaveBeenCalled();
    expect(element.scrollTop).toBe(600);
  });

  it("does not treat a native end clamp as an observed precommit follower", () => {
    const element = document.createElement("div");
    Object.defineProperties(element, {
      clientHeight: { configurable: true, value: 400 },
      scrollHeight: { configurable: true, value: 1000 },
    });
    element.scrollTop = 600;
    const anchor = new TranscriptEndAnchor();
    anchor.capture(element);
    element.scrollTop = 400;
    anchor.reconcile(element, true, false, vi.fn());
    Object.defineProperty(element, "scrollHeight", { configurable: true, value: 750 });
    element.scrollTop = 350;
    anchor.prepareUpdate(element, true, createTranscriptOffsetState());
    expect(anchor.isResizingCommit(element)).toBe(false);
    Object.defineProperty(element, "scrollHeight", { configurable: true, value: 950 });
    const follow = vi.fn();
    anchor.releaseCommit();
    anchor.reconcile(element, true, false, follow);
    expect(follow).not.toHaveBeenCalled();
  });

  it.each([
    ...(["following", "reading", "wheel", "key", "pointer", "touch"] as const).map((intent) => ({
      intent,
      nativeResize: "none" as const,
    })),
    ...(["following", "reading", "wheel"] as const).flatMap((intent) =>
      (["growth", "shrink"] as const).map((nativeResize) => ({ intent, nativeResize })),
    ),
  ])(
    "preserves $intent ownership across native $nativeResize, a footer clamp and late row growth",
    async ({ intent, nativeResize }) => {
      const flushFrames = stubAnimationFrames();
      const policy = makeChatHost({ chatHasAutoScrolled: true });
      const transcript = new ChatTranscriptController(
        {
          addController: vi.fn(),
          removeController: vi.fn(),
          requestUpdate: vi.fn(),
          updateComplete: Promise.resolve(true),
        },
        () => `footer-${intent}`,
        {
          canFollowEnd: () => !policy.chatFollowLocked,
          onReaderScroll: (towardEnd) => handleChatScrollTakeover(policy, towardEnd),
        },
      );
      const rows: TestContentRow[] = Array.from({ length: 12 }, (_, index) => ({
        kind: "content",
        key: `row:${index}`,
        content: html`<div>row ${index}</div>`,
      }));
      const { container } = await mountTestTranscript(`footer-${intent}`, rows, transcript);
      try {
        Object.defineProperties(container, {
          clientHeight: { configurable: true, value: 400 },
          scrollHeight: { configurable: true, value: 2000 },
        });
        container.scrollTop = 1600;
        policy.chatLastScrollTop = 1600;
        policy.chatScrollElement = () => container;
        policy.chatIsProgrammaticScroll = () => transcript.isProgrammaticScroll;
        policy.chatIsMaintenanceScroll = () => transcript.isMaintenanceScroll;
        container.addEventListener("scroll", (event) => handleChatScroll(policy, event));
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
        const controller: ReactiveController = transcript;
        controller.hostUpdate?.();
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
        // The empty footer briefly enlarges the viewport. The browser clamps
        // against that geometry before the final footer and row sizes commit.
        Object.defineProperty(container, "clientHeight", { configurable: true, value: 650 });
        container.scrollTop = 1350;
        Object.defineProperties(container, {
          clientHeight: { configurable: true, value: 600 },
          scrollHeight: { configurable: true, value: 2087 },
        });
        // Native events arrive after the synchronous DOM commit hooks.
        transcript.hostUpdated();
        if (intent === "wheel") {
          container.dispatchEvent(new WheelEvent("wheel", { deltaY: -100 }));
        } else if (intent === "key") {
          container.dispatchEvent(new KeyboardEvent("keydown", { key: "PageUp" }));
        } else if (intent === "pointer") {
          container.dispatchEvent(new PointerEvent("pointerdown"));
        } else if (intent === "touch") {
          const touch: Touch = {
            identifier: 1,
            target: container,
            clientX: 0,
            clientY: 100,
            pageX: 0,
            pageY: 100,
            screenX: 0,
            screenY: 100,
            radiusX: 1,
            radiusY: 1,
            rotationAngle: 0,
            force: 1,
          };
          container.dispatchEvent(
            new TouchEvent("touchstart", {
              touches: [touch],
              changedTouches: [touch],
            }),
          );
        }
        container.dispatchEvent(new Event("scroll"));
        expect(policy.chatFollowLocked).toBe(intent !== "following");
        expect(policy.chatReadingHistory).toBe(intent !== "following");
        flushFrames();
        expect(policy.chatFollowLocked).toBe(intent !== "following");
        expect(policy.chatReadingHistory).toBe(intent !== "following");
      } finally {
        transcript.hostDisconnected();
      }
    },
  );
  it("cancels the active native target when a remote input locks following", async () => {
    const flushFrames = stubAnimationFrames();
    const policy = makeChatHost({ chatHasAutoScrolled: true });
    const transcript = new ChatTranscriptController(
      {
        addController: vi.fn(),
        removeController: vi.fn(),
        requestUpdate: vi.fn(),
        updateComplete: Promise.resolve(true),
      },
      () => "retired-end-index",
      { canFollowEnd: () => !policy.chatFollowLocked },
    );
    Object.assign(policy, {
      chatCancelScroll: () => transcript.cancelScroll(),
      chatIsManualScroll: () => transcript.isManualScroll,
    });
    const content: TestContentRow[] = Array.from({ length: 12 }, (_, index) => ({
      kind: "content",
      key: `row:${index}`,
      content: html`<div>Row</div>`,
    }));
    const typing: TestContentRow = {
      kind: "content",
      key: "presence:typing",
      content: html`<div>Typing</div>`,
    };
    const { container, renderRows } = await mountTestTranscript(
      "retired-end-index",
      [...content, typing],
      transcript,
    );
    Object.defineProperties(container, {
      clientHeight: { configurable: true, value: 600 },
      scrollHeight: { configurable: true, get: () => transcriptSize(container) },
    });
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
    try {
      transcript.scrollToEnd({ source: "auto", behavior: "auto" });
      container.dispatchEvent(new Event("scroll"));
      lockChatScroll(policy, "remote-input");
      expect(policy.chatFollowLocked).toBe(true);
      const before = container.scrollTop;
      transcriptDomState.measuredRowHeight = 120;
      const next: TestContentRow[] = [
        ...content,
        { kind: "content", key: "peer", content: html`<div>Peer</div>` },
        typing,
      ];
      renderRows(next);
      await Promise.resolve();
      renderRows(next);
      flushFrames();
      expect(container.scrollTop, "retired index must not follow the peer replacing typing").toBe(
        before,
      );
    } finally {
      transcript.hostDisconnected();
    }
  });

  it("preserves reader policy when row measurement clamps a positive adjustment to the end", async () => {
    transcriptDomState.measuredRowHeight = 120;
    const policy = makeChatHost({ chatHasAutoScrolled: true });
    const transcript = new ChatTranscriptController(
      {
        addController: vi.fn(),
        removeController: vi.fn(),
        requestUpdate: vi.fn(),
        updateComplete: Promise.resolve(true),
      },
      () => "measurement-reader",
      {
        canFollowEnd: () => !policy.chatFollowLocked,
        onReaderScroll: (towardEnd) => handleChatScrollTakeover(policy, towardEnd),
      },
    );
    const rows: TestContentRow[] = Array.from({ length: 12 }, (_, index) => ({
      kind: "content",
      key: `row:${index}`,
      content: html`<div>row ${index}</div>`,
    }));
    const { container } = await mountTestTranscript("measurement-reader", rows, transcript);
    try {
      const sizer = expectDefined(
        container.querySelector<HTMLElement>(".chat-virtual-sizer"),
        "transcript extent",
      );
      const total = Number.parseFloat(sizer.style.height);
      let maxScrollTop = total + 84 - 600;
      Object.defineProperties(container, {
        clientHeight: { configurable: true, value: 600 },
        scrollHeight: { configurable: true, get: () => maxScrollTop + 600 },
      });
      container.scrollTo = (options?: ScrollToOptions | number) => {
        if (typeof options === "object") {
          container.scrollTop = Math.min(options.top ?? container.scrollTop, maxScrollTop);
        }
      };
      policy.chatScrollElement = () => container;
      policy.chatIsProgrammaticScroll = () => transcript.isProgrammaticScroll;
      container.addEventListener("scroll", (event) => handleChatScroll(policy, event));
      for (const observer of resizeObservers) {
        observer.emitTarget(container, 800, 600);
      }
      container.scrollTop = total + 84 - 600;
      container.dispatchEvent(new Event("scroll"));
      container.scrollTop -= 24;
      container.dispatchEvent(new Event("scroll"));
      expect(policy.chatReadingHistory).toBe(true);
      vi.useFakeTimers();
      container.dispatchEvent(new Event("scroll"));
      vi.advanceTimersByTime(150);
      const row = expectDefined(
        container.querySelector<HTMLElement>('[data-index="6"]'),
        "row above the viewport",
      );
      Object.defineProperty(row, "offsetHeight", { configurable: true, value: 160 });
      for (const observer of resizeObservers) {
        observer.emitTarget(row, 800, 160);
      }
      expect(container.scrollTop).toBe(total + 84 - 600);
      container.dispatchEvent(new Event("scroll"));
      expect(policy.chatReadingHistory).toBe(true);
      expect(policy.chatFollowLocked).toBe(true);
      // A partial sizer commit lets TanStack retry the clamped adjustment as an absolute write.
      maxScrollTop += 16;
      transcript.hostUpdated();
      expect(container.scrollTop).toBe(maxScrollTop);
      // The dock can keep shrinking the scroll range before the native read-back arrives.
      maxScrollTop -= 8;
      container.scrollTop = maxScrollTop;
      container.dispatchEvent(new Event("scroll"));
      expect(policy.chatReadingHistory).toBe(true);
      expect(policy.chatFollowLocked).toBe(true);
      container.dispatchEvent(new WheelEvent("wheel", { deltaY: 1 }));
      expect(policy.chatReadingHistory).toBe(false);
      expect(policy.chatFollowLocked).toBe(false);
      expect(transcript.isProgrammaticScroll).toBe(false);
    } finally {
      transcript.hostDisconnected();
      vi.useRealTimers();
    }
  });

  it.each([
    ["wheel", null, nothing, false],
    ["downward wheel", null, nothing, false],
    ["stationary wheel", null, nothing, false],
    ["pointer", null, nothing, false],
    ["latest", null, nothing, false],
    ["automatic follow", null, nothing, true],
    ["text input", "ArrowUp", html`<input />`, true],
    ["range input", "Home", html`<input type="range" />`, true],
    ["range Space", " ", html`<input type="range" />`, false],
    [
      "select",
      "ArrowUp",
      html`<select>
        <option>One</option>
      </select>`,
      true,
    ],
    ["editable child", "ArrowUp", html`<div contenteditable="true"><span>Text</span></div>`, true],
    ["shadow input", "ArrowUp", html`<input />`, true],
    ["button", " ", html`<button>Play</button>`, true],
    ["button PageUp", "PageUp", html`<button>Play</button>`, false],
    ["link Space", " ", html`<a href="#">Details</a>`, false],
    [
      "listbox",
      "PageUp",
      html`<select size="2">
        <option>One</option>
      </select>`,
      true,
    ],
    ["textarea", " ", html`<textarea>Text</textarea>`, true],
    [
      "handled player",
      " ",
      html`<div @keydown=${(event: KeyboardEvent) => event.preventDefault()}>Player</div>`,
      true,
    ],
    ["transcript text", "PageUp", html`<span>History</span>`, false],
    ["readonly content", "End", html`<div contenteditable="false">History</div>`, false],
    // The pane keyboard suite covers native-control/platform variants.
    // Retain downward nested scrolling and media boundaries in restoration.
    ["native video", "End", html`<video controls></video>`, true],
    ["native audio paging", "PageDown", html`<audio controls></audio>`, false],
    ...nativeControlNavigationCases.filter(
      ([name, key]) => name.startsWith("Mac textarea ") && (key === "End" || key === "PageDown"),
    ),
  ] as const)(
    "resolves pending restoration ownership for %s",
    async (command, key, content, preservesRestore, fixture = {}) => {
      const flushFrames = stubAnimationFrames();
      const rows: TestContentRow[] = Array.from({ length: 40 }, (_, index) => ({
        kind: "content",
        key: `row:${index}`,
        content: html`<div>row ${index}</div>`,
      }));
      const { container, renderRows, transcript } = await mountTestTranscript(
        `restore-${command}`,
        rows,
      );
      let scrollHeight = 800;
      Object.defineProperties(container, {
        clientHeight: { configurable: true, value: 600 },
        scrollHeight: { configurable: true, get: () => scrollHeight },
      });
      const writes: ScrollToOptions[] = [];
      container.scrollTo = (options?: ScrollToOptions | number) => {
        if (typeof options === "object") {
          writes.push(options);
          container.scrollTop = options.top ?? container.scrollTop;
        }
      };
      const settled = vi.fn();
      transcript.scrollToOffset(420, settled);
      renderRows(rows);
      expect(settled).not.toHaveBeenCalled();
      if (key) {
        const target = container.appendChild(document.createElement("div"));
        render(content, target);
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
          container.scrollTop = command === "downward wheel" ? 520 : 300;
          container.dispatchEvent(new Event("scroll"));
        }
      } else if (command === "automatic follow") {
        expect(transcript.scrollToEnd({ source: "auto" })).toBe(false);
      } else {
        expect(transcript.scrollToEnd()).toBe(true);
      }
      const inputOffset = container.scrollTop;
      writes.length = 0;
      if (preservesRestore) {
        scrollHeight = 4800;
      }
      for (let frame = 0; frame < 15; frame++) {
        flushFrames();
        renderRows(rows);
      }
      if (preservesRestore) {
        expect(settled).toHaveBeenCalledWith({ scrollTop: 420, anchorToEnd: false });
        expect(container.scrollTop).toBe(420);
      } else {
        expect(settled).not.toHaveBeenCalled();
        expect(writes.some((write) => write.top === 420)).toBe(false);
        expect(container.scrollTop).toBe(inputOffset);
      }
      transcript.hostDisconnected();
    },
  );

  it("keeps reader input in control after a reachable restoration settles", async () => {
    const flushFrames = stubAnimationFrames();
    const rows: TestContentRow[] = Array.from({ length: 40 }, (_, index) => ({
      kind: "content",
      key: `row:${index}`,
      content: html`<div>row ${index}</div>`,
    }));
    const { container, renderRows, transcript } = await mountTestTranscript(
      "settled-restore-input",
      rows,
    );
    Object.defineProperties(container, {
      clientHeight: { configurable: true, value: 600 },
      scrollHeight: { configurable: true, value: 4800 },
    });
    const writes: ScrollToOptions[] = [];
    container.scrollTo = (options?: ScrollToOptions | number) => {
      if (typeof options === "object") {
        writes.push(options);
        container.scrollTop = options.top ?? container.scrollTop;
      }
    };
    const settled = vi.fn();

    try {
      transcript.scrollToOffset(420, settled);
      renderRows(rows);
      expect(settled).toHaveBeenCalledWith({ scrollTop: 420, anchorToEnd: false });

      writes.length = 0;
      container.dispatchEvent(new WheelEvent("wheel", { deltaY: -100 }));
      container.scrollTop = 300;
      container.dispatchEvent(new Event("scroll"));
      for (let frame = 0; frame < 15; frame += 1) {
        flushFrames();
        renderRows(rows);
      }

      expect(container.scrollTop).toBe(300);
      expect(writes.some((write) => write.top === 420)).toBe(false);
    } finally {
      transcript.hostDisconnected();
    }
  });
});
