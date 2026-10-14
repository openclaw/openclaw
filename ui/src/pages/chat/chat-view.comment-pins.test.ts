import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChatAttachment } from "../../lib/chat/chat-types.ts";
import { flush, waitForSolid } from "../../test-helpers/solid-settle.ts";
import { createComposerContainer } from "./chat-composer.test-support.ts";
import { createChatProps, renderChatPropsInto } from "./chat-view.test-helpers.ts";

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
