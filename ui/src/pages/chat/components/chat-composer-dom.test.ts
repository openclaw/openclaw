/* @vitest-environment jsdom */

import { afterEach, describe, expect, it, vi } from "vitest";
import { adjustTextareaHeight, COMPOSER_MEASUREMENT_MAX_CHARS } from "./chat-composer-dom.ts";

function createCountingTextarea(scrollHeight: number) {
  const textarea = document.createElement("textarea");
  let scrollHeightReads = 0;
  Object.defineProperty(textarea, "scrollHeight", {
    configurable: true,
    get: () => {
      scrollHeightReads += 1;
      return scrollHeight;
    },
  });
  return { textarea, reads: () => scrollHeightReads };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("composer autosize measurement cap", () => {
  it("pins an over-cap draft to the CSS cap without a measurement pass", () => {
    const { textarea, reads } = createCountingTextarea(50_000);
    textarea.value = "x".repeat(COMPOSER_MEASUREMENT_MAX_CHARS + 1);
    vi.spyOn(window, "getComputedStyle").mockReturnValue({
      maxHeight: "156px",
    } as CSSStyleDeclaration);

    adjustTextareaHeight(textarea);

    expect(textarea.style.height).toBe("156px");
    expect(textarea.style.overflowY).toBe("auto");
    expect(reads()).toBe(0);
  });

  it("keeps the shared fallback for non-pixel CSS caps beyond the cap", () => {
    const { textarea, reads } = createCountingTextarea(50_000);
    textarea.value = "x".repeat(COMPOSER_MEASUREMENT_MAX_CHARS + 1);
    vi.spyOn(window, "getComputedStyle").mockReturnValue({
      maxHeight: "50vh",
    } as CSSStyleDeclaration);

    adjustTextareaHeight(textarea);

    expect(textarea.style.height).toBe("150px");
    expect(reads()).toBe(0);
  });

  it("still measures drafts at the cap boundary", () => {
    const { textarea, reads } = createCountingTextarea(42);
    textarea.value = "x".repeat(COMPOSER_MEASUREMENT_MAX_CHARS);
    vi.spyOn(window, "getComputedStyle").mockReturnValue({
      maxHeight: "156px",
    } as CSSStyleDeclaration);

    adjustTextareaHeight(textarea);

    expect(reads()).toBeGreaterThan(0);
    expect(textarea.style.height).toBe("42px");
  });

  it("resumes measuring after the draft shrinks below the cap", () => {
    const { textarea, reads } = createCountingTextarea(42);
    vi.spyOn(window, "getComputedStyle").mockReturnValue({
      maxHeight: "156px",
    } as CSSStyleDeclaration);

    textarea.value = "x".repeat(COMPOSER_MEASUREMENT_MAX_CHARS + 1);
    adjustTextareaHeight(textarea);
    expect(reads()).toBe(0);
    expect(textarea.style.height).toBe("156px");

    textarea.value = "shrunk back";
    adjustTextareaHeight(textarea);
    expect(reads()).toBeGreaterThan(0);
    expect(textarea.style.height).toBe("42px");
  });

  it("clears inherited fade masks when a draft is programmatically replaced past the cap", () => {
    const { textarea, reads } = createCountingTextarea(50_000);
    textarea.value = "short overflowing draft";
    textarea.setAttribute("data-scroll-fade-top", "");
    textarea.setAttribute("data-scroll-fade-bottom", "");
    textarea.value = "x".repeat(COMPOSER_MEASUREMENT_MAX_CHARS + 1);
    vi.spyOn(window, "getComputedStyle").mockReturnValue({
      maxHeight: "156px",
    } as CSSStyleDeclaration);

    adjustTextareaHeight(textarea);

    expect(textarea.hasAttribute("data-scroll-fade-top")).toBe(false);
    expect(textarea.hasAttribute("data-scroll-fade-bottom")).toBe(false);
    expect(textarea.style.overflowY).toBe("auto");
    expect(reads()).toBe(0);
  });

  it("preserves the transcript anchor when first pinning an oversized draft", () => {
    const { textarea, reads } = createCountingTextarea(50_000);
    const chat = document.createElement("div");
    chat.className = "chat";
    const thread = document.createElement("div");
    thread.className = "chat-thread";
    Object.defineProperty(thread, "scrollHeight", { configurable: true, get: () => 900 });
    thread.scrollTop = 895;
    chat.append(thread, textarea);
    document.body.append(chat);
    textarea.style.height = "36px";
    textarea.value = "x".repeat(COMPOSER_MEASUREMENT_MAX_CHARS + 1);
    vi.spyOn(window, "getComputedStyle").mockReturnValue({
      maxHeight: "156px",
    } as CSSStyleDeclaration);

    adjustTextareaHeight(textarea);

    expect(textarea.style.height).toBe("156px");
    expect(thread.scrollTop).toBe(900);
    expect(reads()).toBe(0);
    chat.remove();
  });

  it("does not recapture the transcript on a repeated over-cap edit", () => {
    const { textarea, reads } = createCountingTextarea(50_000);
    const chat = document.createElement("div");
    chat.className = "chat";
    const thread = document.createElement("div");
    thread.className = "chat-thread";
    let scrollHeightReads = 0;
    Object.defineProperty(thread, "scrollHeight", {
      configurable: true,
      get: () => {
        scrollHeightReads += 1;
        return 900;
      },
    });
    chat.append(thread, textarea);
    document.body.append(chat);
    thread.scrollTop = 895;
    textarea.value = "x".repeat(COMPOSER_MEASUREMENT_MAX_CHARS + 1);
    vi.spyOn(window, "getComputedStyle").mockReturnValue({
      maxHeight: "156px",
    } as CSSStyleDeclaration);

    adjustTextareaHeight(textarea);
    const readsAfterPin = scrollHeightReads;
    textarea.value = `${textarea.value}y`;
    adjustTextareaHeight(textarea);

    expect(scrollHeightReads).toBe(readsAfterPin);
    expect(reads()).toBe(0);
    chat.remove();
  });

  it("leaves the single-line layout branch untouched for over-cap values", () => {
    const { textarea, reads } = createCountingTextarea(50_000);
    const host = document.createElement("div");
    host.setAttribute("data-composer-layout", "single-line");
    host.append(textarea);
    textarea.value = "x".repeat(COMPOSER_MEASUREMENT_MAX_CHARS + 1);

    adjustTextareaHeight(textarea);

    expect(textarea.style.height).toBe("");
    expect(textarea.style.overflowY).toBe("");
    expect(reads()).toBe(0);
  });
});
