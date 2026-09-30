/* @vitest-environment jsdom */
import { nothing, render } from "lit";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { renderMessageImages } from "./chat-message-images.ts";
import { releaseChatMediaResourceSubscriber } from "./chat-message-media.ts";

let container: HTMLDivElement;
let rerender: () => void;

beforeEach(() => {
  vi.useFakeTimers();
  container = document.createElement("div");
});

afterEach(() => {
  render(nothing, container);
  releaseChatMediaResourceSubscriber(rerender);
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it.each(["render", "click"] as const)(
  "does not replay an automatic image retry already claimed by %s",
  async (trigger) => {
    const source = "/api/chat/media/outgoing/agent%3Amain%3Amain/" + crypto.randomUUID() + "/full";
    const fetch = vi.fn(async () => new Response(null, { status: 503 }));
    vi.stubGlobal("fetch", fetch);
    rerender = () =>
      render(renderMessageImages([{ url: source }], { onRequestUpdate: rerender }), container);
    rerender();
    await vi.advanceTimersByTimeAsync(0);
    expect(fetch).toHaveBeenCalledTimes(1);

    if (trigger === "render") {
      // A render can see the elapsed retry window before the queued timer runs.
      vi.setSystemTime(Date.now() + 5_000);
      rerender();
    } else {
      const retry = container.querySelector<HTMLButtonElement>("button");
      expect(retry?.textContent).toContain("Retry");
      retry?.click();
    }
    await vi.advanceTimersByTimeAsync(0);
    expect(fetch).toHaveBeenCalledTimes(2);

    // A failed claimed retry must not let the original timer start a third fetch.
    await vi.advanceTimersByTimeAsync(10_000);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  },
);
