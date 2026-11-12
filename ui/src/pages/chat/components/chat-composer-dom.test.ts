import { afterEach, expect, it, vi } from "vitest";
import {
  adjustTextareaHeight,
  disconnectTextareaOverflowObserver,
  handleTextareaOverflowInteraction,
  observeTextareaOverflow,
  scheduleTextareaHeightAdjustment,
} from "./chat-composer-dom.ts";

afterEach(() => vi.restoreAllMocks());

it("returns a programmatically measured capped draft to native content sizing on input", () => {
  vi.spyOn(CSS, "supports").mockReturnValue(true);
  const combobox = document.createElement("div");
  combobox.className = "agent-chat__composer-combobox";
  const textarea = document.createElement("textarea");
  combobox.append(textarea);
  textarea.style.cssText = "max-height:156px;min-height:36px;line-height:24px;border:0";
  textarea.value = "A long draft\n".repeat(3000);
  Object.defineProperties(textarea, {
    scrollHeight: { value: 72_000 },
    clientHeight: { value: 156 },
  });
  observeTextareaOverflow(textarea);
  try {
    adjustTextareaHeight(textarea);
    expect(textarea.style.height).toBe("156px");
    textarea.value += "Still growing";
    adjustTextareaHeight(textarea, { nativeInput: true });
    expect(textarea.style.height).toBe("");
  } finally {
    disconnectTextareaOverflowObserver(textarea);
  }
});

it.each([156, 288])("does not measure a growing draft already capped at %ipx", (cap) => {
  const textarea = document.createElement("textarea");
  textarea.style.cssText = `max-height:${cap}px;min-height:36px;line-height:24px;padding:6px;box-sizing:border-box;border:0`;
  textarea.value = "A long draft\n".repeat(3000);
  let draftHeight = 72_000;
  const scrollHeight = vi.fn(() => draftHeight);
  Object.defineProperties(textarea, {
    scrollHeight: { get: scrollHeight },
    clientHeight: { get: () => Math.min(draftHeight, cap) },
    offsetHeight: { get: () => Math.min(draftHeight, cap) },
  });
  observeTextareaOverflow(textarea);
  try {
    adjustTextareaHeight(textarea);
    expect(textarea.style.height).toBe(`${cap}px`);
    expect(textarea.style.overflowY).toBe("auto");
    scrollHeight.mockClear();

    textarea.value += "Still growing";
    handleTextareaOverflowInteraction({ type: "input", currentTarget: textarea } as Event & {
      currentTarget: HTMLTextAreaElement;
    });
    adjustTextareaHeight(textarea, { nativeInput: true });

    expect(scrollHeight).not.toHaveBeenCalled();
    expect(textarea.style.height).toBe(`${cap}px`);
    expect(textarea.hasAttribute("data-scroll-fade-bottom")).toBe(false);

    draftHeight = 36;
    textarea.value = "Short again";
    adjustTextareaHeight(textarea, { nativeInput: true });
    expect(scrollHeight).toHaveBeenCalled();
    expect(textarea.style.height).toBe("36px");
    expect(textarea.style.overflowY).toBe("hidden");
  } finally {
    disconnectTextareaOverflowObserver(textarea);
  }
});

it("remeasures a capped draft after replacement or a scheduled layout change", async () => {
  const textarea = document.createElement("textarea");
  textarea.style.cssText = "max-height:156px;min-height:36px;line-height:24px;padding:6px;border:0";
  textarea.value = "A long draft\n".repeat(3000);
  let draftHeight = 72_000;
  const scrollHeight = vi.fn(() => draftHeight);
  Object.defineProperties(textarea, {
    scrollHeight: { get: scrollHeight },
    clientHeight: { get: () => Math.min(draftHeight, 156) },
  });
  document.body.append(textarea);
  observeTextareaOverflow(textarea);
  try {
    adjustTextareaHeight(textarea);
    draftHeight = 36;
    textarea.value = "\u200b".repeat(textarea.value.length);
    adjustTextareaHeight(textarea, { nativeInput: true });
    expect(textarea.style.height).toBe("36px");

    draftHeight = 72_000;
    textarea.value = "Long again\n".repeat(3000);
    adjustTextareaHeight(textarea);
    scrollHeight.mockClear();
    textarea.style.maxHeight = "288px";
    scheduleTextareaHeightAdjustment(textarea);
    await Promise.resolve();
    expect(scrollHeight).toHaveBeenCalled();
    expect(textarea.style.height).toBe("288px");
  } finally {
    disconnectTextareaOverflowObserver(textarea);
    textarea.remove();
  }
});
