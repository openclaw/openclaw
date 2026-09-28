/* @vitest-environment jsdom */

import { expectDefined } from "@openclaw/normalization-core";
import { html, nothing, render } from "lit";
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

  it("does not follow a captured end anchor while end anchoring is suspended", () => {
    const element = document.createElement("div");
    Object.defineProperties(element, {
      clientHeight: { configurable: true, value: 400 },
      scrollHeight: { configurable: true, value: 1000 },
    });
    element.scrollTop = 600;
    const anchor = new TranscriptEndAnchor();
    anchor.capture(element);
    Object.defineProperty(element, "scrollHeight", { configurable: true, value: 1200 });
    expect(anchor.isResizeAnchor(element)).toBe(true);
    const follow = vi.fn();

    anchor.reconcile(element, true, true, follow);

    expect(follow).not.toHaveBeenCalled();
  });

  it("does not override native movement with an unchanged scroll range", () => {
    const element = document.createElement("div");
    Object.defineProperties(element, {
      clientHeight: { configurable: true, value: 400 },
      scrollHeight: { configurable: true, value: 1000 },
    });
    element.scrollTop = 600;
    const anchor = new TranscriptEndAnchor();
    anchor.capture(element);
    element.scrollTop -= 8;
    const follow = vi.fn();

    anchor.reconcile(element, true, false, follow);

    expect(follow).not.toHaveBeenCalled();
    expect(element.scrollTop).toBe(592);
  });

  it("preserves native movement after row growth changes the scroll range", () => {
    const element = document.createElement("div");
    Object.defineProperties(element, {
      clientHeight: { configurable: true, value: 400 },
      scrollHeight: { configurable: true, value: 1000 },
    });
    element.scrollTop = 600;
    const anchor = new TranscriptEndAnchor();
    anchor.capture(element);
    Object.defineProperty(element, "scrollHeight", { configurable: true, value: 1100 });
    element.scrollTop -= 8;
    const movedPosition = element.scrollTop;
    const follow = vi.fn();

    expect(anchor.isResizeAnchor(element)).toBe(false);
    anchor.reconcile(element, true, false, follow);

    expect(follow).not.toHaveBeenCalled();
    expect(element.scrollTop).toBe(movedPosition);
  });

  it("does not reacquire following from a cancelled reader anchor", () => {
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
    Object.defineProperty(element, "scrollHeight", { configurable: true, value: 1200 });
    const follow = vi.fn();
    anchor.reconcile(element, true, false, follow);
    expect(follow).not.toHaveBeenCalled();
    expect(element.scrollTop).toBe(600);
  });

  it("does not treat a native end clamp as an observed follower", () => {
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
    expect(anchor.isResizeAnchor(element)).toBe(false);
    Object.defineProperty(element, "scrollHeight", { configurable: true, value: 950 });
    const follow = vi.fn();
    anchor.reconcile(element, true, false, follow);
    expect(follow).not.toHaveBeenCalled();
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
      const transcript = new ChatTranscriptController(
        {
          addController: vi.fn(),
          removeController: vi.fn(),
          requestUpdate: () => {
            updateRequested = true;
          },
          updateComplete: Promise.resolve(true),
        },
        () => `composer-reader-${movement}`,
        { canFollowEnd: () => false, onReaderScroll },
      );
      const rows: TestContentRow[] = [
        { kind: "content", key: "long-run", content: html`<div>Long transcript run</div>` },
      ];
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
                (row) => (row.kind === "content" ? row.content : nothing),
                null,
                false,
              );
            }),
            container,
          );
          transcript.hostUpdated();
        }
        // Connected row refs measure after their two owned microtask checkpoints.
        await Promise.resolve();
        await Promise.resolve();
        flushFrames();
      };
      transcript.hostConnected();
      try {
        await commitRequestedUpdate();
        await commitRequestedUpdate();
        transcript.scrollToOffset(100);
        await commitRequestedUpdate();
        await commitRequestedUpdate();

        container.scrollTop = 200;
        container.dispatchEvent(new Event("scroll"));
        await commitRequestedUpdate();
        // Both offsets stay in one long row and away from the physical end.
        container.scrollTop = 550;
        container.dispatchEvent(new Event("scroll"));
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
      } finally {
        transcript.hostDisconnected();
        vi.useRealTimers();
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
      const total = transcriptSize(container);
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
