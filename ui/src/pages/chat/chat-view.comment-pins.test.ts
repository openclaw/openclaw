import { nothing, render } from "lit";
import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import type { ChatAttachment } from "../../lib/chat/chat-types.ts";
import { createChatProps } from "./chat-view.test-helpers.ts";
import { renderChat } from "./chat-view.ts";

afterEach(() => {
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
    const container = document.createElement("div");
    onTestFinished(() => {
      render(nothing, container);
    });
    document.body.append(container);
    // A loading transcript stays static, so only pin inputs and observers vary.
    const props = createChatProps({ attachments: [comment("first")], loading: true });
    render(renderChat(props), container);
    const pins = container.querySelector<HTMLElement & { updateComplete: Promise<unknown> }>(
      "openclaw-chat-comment-pins",
    )!;
    const layouts = vi.spyOn(pins, "getBoundingClientRect");
    const settle = async () => {
      await pins.updateComplete;
      // Observer callbacks run as microtasks after the committed render.
      await Promise.resolve();
      for (const frame of frames.splice(0)) {
        frame(0);
      }
      const count = layouts.mock.calls.length;
      layouts.mockClear();
      return count;
    };
    expect(await settle()).toBe(1);

    // Streaming frames and composer edits rebuild the pane props object.
    render(renderChat({ ...props, draft: "Typing in the composer" }), container);
    expect(await settle()).toBe(0);

    render(renderChat({ ...props, attachments: [comment("first"), comment("second")] }), container);
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
