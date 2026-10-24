import { afterEach, expect, it, vi } from "vitest";
import type { ChatAttachment } from "../../lib/chat/chat-types.ts";
import { flush, waitForSolid } from "../../test-helpers/solid-settle.ts";
import { createComposerContainer } from "./chat-composer.test-support.ts";
import { createChatViewFrame } from "./chat-view-frame.ts";
import { createChatProps, renderChatPropsInto } from "./chat-view.test-helpers.ts";
import { createAsyncQuestionPresentation } from "./components/chat-async-question.ts";
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
function mount(overrides: Parameters<typeof createChatProps>[0]) {
  const container = createComposerContainer();
  document.body.append(container);
  const props = createChatProps(overrides);
  const draw = (next: Partial<typeof props> = {}) =>
    renderChatPropsInto(container, { ...props, ...next });
  draw();
  return { container, props, draw };
}
function stubResize(observed: (notify: () => void) => void = () => {}) {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(private callback: ResizeObserverCallback) {}
      observe(target: Element) {
        if (target.classList.contains("chat-thread")) {
          observed(() => this.callback([], this as unknown as ResizeObserver));
        }
      }
      unobserve() {}
      disconnect() {}
    },
  );
}

it("resolves saved sources from the transcript registry instead of unrelated matching DOM", async () => {
  const { container, props, draw } = mount({
    messages: [{ role: "assistant", content: [{ type: "text", text: "Selected passage" }] }],
  });
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

  const frame = createChatViewFrame(
    props,
    () => container,
    createAsyncQuestionPresentation(getTranscriptState(props.paneId), props),
  );
  const range = frame.resolveCommentSource(source);
  expect(range?.toString()).toBe("Selected passage");
  expect(bubble.contains(range!.startContainer)).toBe(true);

  draw({ messages: [] });
  await waitForSolid(() => expect(bubble.isConnected).toBe(false));
  expect(frame.resolveCommentSource(source)).toBeUndefined();
});

it("exposes only connected pins fully inside the transcript and viewport, then retires its handle", async () => {
  vi.stubGlobal("requestAnimationFrame", () => 1);
  vi.stubGlobal("cancelAnimationFrame", () => {});
  stubResize();
  const { container, props, draw } = mount({ attachments: [comment("visible")], loading: true });
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

  draw({ attachments: [] });
  await waitForSolid(() => expect(state.commentPins).toBeUndefined());
});

it("relayouts for pin and geometry changes but not unrelated pane renders", async () => {
  const frames: FrameRequestCallback[] = [];
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => frames.push(callback));
  const resizes: Array<() => void> = [];
  stubResize((notify) => resizes.push(notify));
  // A loading transcript stays static, so only pin inputs and observers vary.
  const { container, draw } = mount({ attachments: [comment("first")], loading: true });
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

  draw({ draft: "Typing in the composer" });
  expect(await settle()).toBe(0);

  const thread = container.querySelector(".chat-thread")!;
  for (const mutate of [
    () => draw({ attachments: [comment("first"), comment("second")] }),
    () => thread.dispatchEvent(new Event("scroll")),
    () => resizes.forEach((resize) => resize()),
    () => thread.querySelector(".chat-thread-inner")!.append(document.createElement("p")),
    () => {
      pins.remove();
      thread.append(pins);
    },
    () => thread.dispatchEvent(new Event("scroll")),
  ]) {
    mutate();
    expect(await settle()).toBe(1);
  }
});
