// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import "./chat-retry-status.tsx";
let element: HTMLElementTagNameMap["openclaw-chat-retry-status"];
beforeEach(() => {
  vi.useFakeTimers({ now: 10_000 });
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
  element = document.createElement("openclaw-chat-retry-status");
});
afterEach(() => {
  element.remove();
  vi.restoreAllMocks();
  vi.useRealTimers();
});
it("counts down the actual retry deadline, then stops without claiming success", async () => {
  element.retryAt = 18_000;
  document.body.append(element);
  await element.updateComplete;
  expect(element.textContent).toBe("Retrying in 8s");
  await vi.advanceTimersByTimeAsync(8_000);
  expect(element.textContent).toBe("Retrying…");
  expect(vi.getTimerCount()).toBe(0);
  await vi.advanceTimersByTimeAsync(20_000);
  element.retryAt = Date.now() + 3_000;
  await element.updateComplete;
  expect(element.textContent).toBe("Retrying in 3s");
  element.remove();
  // The bridge defers disposal one microtask to preserve synchronous reparenting.
  await Promise.resolve();
  await Promise.resolve();
  expect(vi.getTimerCount()).toBe(0);
});
it("does not invent a countdown without a deadline", async () => {
  document.body.append(element);
  await element.updateComplete;
  expect(element.textContent).toBe("Retrying…");
  expect(vi.getTimerCount()).toBe(0);
});
