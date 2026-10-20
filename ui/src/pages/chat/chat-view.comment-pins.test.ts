import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChatAttachment } from "../../lib/chat/chat-types.ts";
import { flush, waitForSolid } from "../../test-helpers/solid-settle.ts";
import { createComposerContainer } from "./chat-composer.test-support.ts";
import { createChatViewFrame } from "./chat-view-frame.ts";
import { createChatProps, renderChatPropsInto } from "./chat-view.test-helpers.ts";
import { getTranscriptState } from "./components/chat-thread-interactions.ts";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

function comment(id: string): ChatAttachment {
  return {
    id,
    mimeType: "text/plain",
    selectionAnnotation: {
      text: "Selected passage",
      comment: "Check this",
      sessionKey: "main",
      entryId: "entry-1",
      start: 0,
      end: 16,
    },
  };
}

describe("chat comment pins", () => {
  it("resolves saved sources from the transcript registry instead of unrelated matching DOM", async () => {
    const container = createComposerContainer();
    document.body.append(container);
    const props = createChatProps({
      messages: [{ role: "assistant", content: [{ type: "text", text: "Selected passage" }] }],
    });
    renderChatPropsInto(container, props);
    await waitForSolid(() =>
      expect(props.transcript.messageElements?.elements.size).toBeGreaterThan(0),
    );
    const bubble = [...props.transcript.messageElements!.elements.values()][0]!;
    const source = {
      messageId: bubble.dataset.messageId!,
      entryId: bubble.dataset.entryId,
      start: 0,
      end: 16,
      text: "Selected passage",
    };
    const unrelated = document.createElement("div");
    unrelated.className = "chat-bubble";
    unrelated.dataset.messageId = source.messageId;
    if (source.entryId) {
      unrelated.dataset.entryId = source.entryId;
    }
    unrelated.textContent = "Different source";
    container.querySelector(".chat-thread")!.prepend(unrelated);

    const frame = createChatViewFrame(props, () => container);
    const range = frame.resolveCommentSource(source);
    expect(range?.toString()).toBe("Selected passage");
    expect(bubble.contains(range!.startContainer)).toBe(true);

    renderChatPropsInto(container, { ...props, messages: [] });
    await waitForSolid(() => expect(bubble.isConnected).toBe(false));
    expect(frame.resolveCommentSource(source)).toBeUndefined();
  });

  it("exposes only connected pins fully inside the transcript and viewport, then retires its handle", async () => {
    vi.stubGlobal("requestAnimationFrame", () => 1);
    vi.stubGlobal("cancelAnimationFrame", () => {});
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    );
    const container = createComposerContainer();
    document.body.append(container);
    const props = createChatProps({ attachments: [comment("visible")], loading: true });
    renderChatPropsInto(container, props);
    const state = getTranscriptState(props.paneId);
    await waitForSolid(() => expect(state.commentPins).toBeDefined());
    const handle = state.commentPins!;
    const thread = container.querySelector<HTMLElement>(".chat-thread")!;
    const pin = container.querySelector<HTMLButtonElement>(".chat-comment-pin")!;
    const threadBounds = vi
      .spyOn(thread, "getBoundingClientRect")
      .mockReturnValue(new DOMRect(0, 0, 200, 200));
    const pinBounds = vi
      .spyOn(pin, "getBoundingClientRect")
      .mockReturnValue(new DOMRect(10, 10, 24, 24));
    pin.hidden = false;

    expect(handle.visiblePin("visible")).toBe(pin);
    expect(handle.visiblePin("missing")).toBeUndefined();
    pin.hidden = true;
    expect(handle.visiblePin("visible")).toBeUndefined();
    pin.hidden = false;
    pinBounds.mockReturnValue(new DOMRect(190, 10, 24, 24));
    expect(handle.visiblePin("visible")).toBeUndefined();
    threadBounds.mockReturnValue(new DOMRect(0, 0, window.innerWidth + 100, 200));
    pinBounds.mockReturnValue(new DOMRect(window.innerWidth - 5, 10, 24, 24));
    expect(handle.visiblePin("visible")).toBeUndefined();
    pinBounds.mockReturnValue(new DOMRect(10, 10, 0, 0));
    expect(handle.visiblePin("visible")).toBeUndefined();
    pinBounds.mockReturnValue(new DOMRect(10, 10, 24, 24));
    container.remove();
    expect(handle.visiblePin("visible")).toBeUndefined();
    document.body.append(container);

    renderChatPropsInto(container, { ...props, attachments: [] });
    await waitForSolid(() => expect(state.commentPins).toBeUndefined());
  });

  it("relayouts for pin and geometry changes but not unrelated pane renders", async () => {
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) =>
      frames.push(callback),
    );
    const resizes: Array<() => void> = [];
    vi.stubGlobal(
      "ResizeObserver",
      class {
        callback: ResizeObserverCallback;
        constructor(callback: ResizeObserverCallback) {
          this.callback = callback;
        }
        observe(target: Element) {
          if (target.classList.contains("chat-thread")) {
            resizes.push(() => this.callback([], this as unknown as ResizeObserver));
          }
        }
        unobserve() {}
        disconnect() {}
      },
    );
    const container = createComposerContainer();
    document.body.append(container);
    // A loading transcript stays static, so only pin inputs and observers vary.
    const props = createChatProps({ attachments: [comment("first")], loading: true });
    renderChatPropsInto(container, props);
    const pins = container.querySelector<HTMLElement & { updateComplete: Promise<unknown> }>(
      "openclaw-chat-comment-pins",
    )!;
    const layouts = vi.spyOn(pins, "getBoundingClientRect");
    await waitForSolid(() => expect(resizes.length).toBeGreaterThan(0));
    const settle = async () => {
      await pins.updateComplete;
      // Observer callbacks run as microtasks after the committed render.
      await Promise.resolve();
      flush();
      for (const frame of frames.splice(0)) {
        frame(0);
      }
      const count = layouts.mock.calls.length;
      layouts.mockClear();
      return count;
    };
    expect(await settle()).toBe(1);

    // Streaming frames and composer edits rebuild the pane props object.
    renderChatPropsInto(container, { ...props, draft: "Typing in the composer" });
    expect(await settle()).toBe(0);

    renderChatPropsInto(container, {
      ...props,
      attachments: [comment("first"), comment("second")],
    });
    expect(await settle()).toBe(1);

    const thread = container.querySelector(".chat-thread")!;
    thread.dispatchEvent(new Event("scroll"));
    expect(await settle()).toBe(1);
    for (const resize of resizes) {
      resize();
    }
    expect(await settle()).toBe(1);
    thread.querySelector(".chat-thread-inner")!.append(document.createElement("p"));
    expect(await settle()).toBe(1);

    // Retained transcripts can reattach pins without new inputs.
    pins.remove();
    thread.append(pins);
    expect(await settle()).toBe(1);
    thread.dispatchEvent(new Event("scroll"));
    expect(await settle()).toBe(1);
  });
});
