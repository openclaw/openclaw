/* @vitest-environment jsdom */

import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, expect, it, onTestFinished, vi } from "vitest";
import { cleanupSolid } from "../../test-helpers/mount-solid.ts";
import { resetChatViewState } from "./chat-view-state.ts";
import {
  getComposerTextarea,
  inputDraft,
  renderChatView,
  stubAnimationFrames,
} from "./chat-view.test-helpers.ts";
import { subscribeTranscriptScroll } from "./components/chat-transcript-scroll-events.ts";
import {
  installTranscriptDomMocks,
  requireElement,
  resizeObservers,
  resetTranscriptTestDom,
} from "./components/chat-transcript.test-support.ts";

beforeEach(() => {
  installTranscriptDomMocks();
  vi.spyOn(CSS, "supports").mockReturnValue(false);
});

afterEach(() => {
  resetChatViewState();
  resetTranscriptTestDom();
});

function measure(element: HTMLElement, values: Record<string, number | (() => number)>) {
  for (const [key, value] of Object.entries(values)) {
    Object.defineProperty(element, key, {
      configurable: true,
      get: () => (typeof value === "function" ? value() : value),
    });
  }
}
const expectSize = (textarea: HTMLTextAreaElement, height: string, overflowY: string) =>
  expect(textarea.style).toMatchObject({ height, overflowY });

it("settles native overflow without synchronous input layout reads", async () => {
  const flushFrames = stubAnimationFrames();
  vi.mocked(CSS.supports).mockReturnValue(true);
  const container = renderChatView({});
  const textarea = getComposerTextarea(container);
  const thread = requireElement(container, ".chat-thread");
  document.body.append(container);
  await Promise.resolve();
  flushFrames();
  let scrollHeight = 200;
  const textareaLayout = vi.fn(() => scrollHeight);
  const transcriptLayout = vi.fn(() => 200);
  measure(textarea, { clientHeight: 150, scrollHeight: textareaLayout });
  measure(thread, { scrollHeight: transcriptLayout });
  textarea.style.height = "42px";

  textarea.value = "responsive draft";
  textarea.dispatchEvent(new InputEvent("input", { bubbles: true }));

  expect([textareaLayout.mock.calls, transcriptLayout.mock.calls]).toEqual([[], []]);
  expect(textarea.style.height).toBe("");
  flushFrames();
  expect(textarea.style.overflowY).toBe("auto");

  scrollHeight = 42;
  measure(textarea, { clientHeight: 42 });
  textarea.value = "Short draft";
  textarea.dispatchEvent(new InputEvent("input", { bubbles: true }));
  flushFrames();
  expect(textarea.style.overflowY).toBe("hidden");
  expect(textarea.hasAttribute("data-scroll-fade-bottom")).toBe(false);
  cleanupSolid();
});

it.each(["end", "history"] as const)("preserves %s reading during composer resize", (position) => {
  const container = renderChatView({ draft: "Short draft" });
  const textarea = getComposerTextarea(container);
  const thread = requireElement(container, ".chat-thread");
  let draftHeight = 42;
  let scrollTop = position === "end" ? 642 : 100;
  textarea.style.height = "42px";
  const cappedHeight = () => Math.min(draftHeight, 150);
  measure(textarea, {
    scrollHeight: () => draftHeight,
    clientHeight: cappedHeight,
    offsetHeight: cappedHeight,
  });
  measure(thread, {
    scrollHeight: 1200,
    clientHeight: () => 600 - (Number.parseFloat(textarea.style.height) || 42),
  });
  Object.defineProperty(thread, "scrollTop", {
    configurable: true,
    get: () => Math.min(scrollTop, thread.scrollHeight - thread.clientHeight),
    set: (value: number) => {
      scrollTop = Math.max(0, Math.min(value, thread.scrollHeight - thread.clientHeight));
    },
  });
  const onTranscriptScroll = vi.fn();
  const resized = (clientHeight: number, top: number, before?: number) => {
    expect(thread).toMatchObject({ clientHeight, scrollTop: top });
    expect(onTranscriptScroll).toHaveBeenCalledExactlyOnceWith({
      type: "resize",
      viewport: { clientHeight, scrollHeight: 1200, scrollTop: top },
      ...(before === undefined ? {} : { scrollCorrection: { before, after: top } }),
    });
    onTranscriptScroll.mockClear();
  };
  const unsubscribe = subscribeTranscriptScroll(thread, (observation) => {
    if (observation.type === "resize") {
      onTranscriptScroll(observation);
    }
  });
  onTestFinished(unsubscribe);

  inputDraft(container, "Short draft edited");
  expect(onTranscriptScroll).not.toHaveBeenCalled();
  expectSize(textarea, "42px", "hidden");

  draftHeight = 180;
  inputDraft(container, "A long draft\n".repeat(10));
  expectSize(textarea, "150px", "auto");
  resized(450, position === "end" ? 750 : 100, position === "end" ? 642 : undefined);

  draftHeight = 220;
  inputDraft(container, "A longer capped draft\n".repeat(12));
  expect(onTranscriptScroll).not.toHaveBeenCalled();

  if (position === "end") {
    thread.scrollTop -= 4;
    inputDraft(container, "Another capped draft\n".repeat(12));
    resized(450, 750, 746);
  }

  draftHeight = 42;
  inputDraft(container, "Short again");
  resized(558, position === "end" ? 642 : 100, position === "end" ? 750 : undefined);
});

it("sizes restored drafts after the rendered value is committed", async () => {
  const container = renderChatView({ draft: "A restored long draft" });
  const textarea = getComposerTextarea(container);
  measure(textarea, { scrollHeight: 180, clientHeight: 150 });
  document.body.append(container);
  await Promise.resolve();

  expectSize(textarea, "150px", "auto");
});

it("resizes the draft when responsive layout changes the textarea width", () => {
  let animationFrameCallback: FrameRequestCallback | undefined;
  let nextAnimationFrameId = 0;
  const requestAnimationFrameMock = vi.fn((callback: FrameRequestCallback) => {
    animationFrameCallback = callback;
    return ++nextAnimationFrameId;
  });
  vi.stubGlobal("requestAnimationFrame", requestAnimationFrameMock);
  vi.stubGlobal("cancelAnimationFrame", vi.fn());

  const size = { width: 320, scrollHeight: 42, clientHeight: 42 };
  vi.spyOn(HTMLTextAreaElement.prototype, "getBoundingClientRect").mockImplementation(
    () => new DOMRect(0, 0, size.width, size.clientHeight),
  );

  const textarea = getComposerTextarea(renderChatView({}));
  measure(textarea, {
    scrollHeight: () => size.scrollHeight,
    clientHeight: () => size.clientHeight,
  });
  textarea.dispatchEvent(new InputEvent("input", { bubbles: true }));
  expectSize(textarea, "42px", "hidden");
  const observed = [...resizeObservers].find((observer) => observer.observes(textarea));
  const observer = expectDefined(observed, "textarea resize observer");
  const resizeTextarea = () => observer.emitTarget(textarea, size.width, size.clientHeight);
  requestAnimationFrameMock.mockClear();

  Object.assign(size, { scrollHeight: 180, clientHeight: 150 });
  resizeTextarea();
  expect(textarea.style.overflowY).toBe("auto");
  expect(requestAnimationFrameMock).not.toHaveBeenCalled();

  Object.assign(size, { width: 180, scrollHeight: 120, clientHeight: 120 });
  resizeTextarea();
  expect(requestAnimationFrameMock).toHaveBeenCalledOnce();
  expect(textarea.style.height).toBe("42px");

  animationFrameCallback?.(0);
  expectSize(textarea, "120px", "hidden");

  size.width = 160;
  resizeTextarea();
  expect(requestAnimationFrameMock).toHaveBeenCalledTimes(2);
  const pendingAdjustmentFrame = nextAnimationFrameId;
  cleanupSolid();
  expect(cancelAnimationFrame).toHaveBeenCalledWith(pendingAdjustmentFrame);
});
