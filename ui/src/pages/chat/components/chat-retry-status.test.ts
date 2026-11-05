// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mountSolid } from "../../../test-helpers/solid-render.tsx";
import { flush } from "../../../test-helpers/solid-settle.ts";
import { ChatRetryStatus } from "./chat-retry-status.tsx";
let view: ReturnType<typeof mountSolid<{ retryAt: number | null }>>;
let element: HTMLElement;
beforeEach(() => {
  vi.useFakeTimers({ now: 10_000 });
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
  const container = document.body.appendChild(document.createElement("div"));
  view = mountSolid(ChatRetryStatus, { retryAt: null }, container);
  element = container.querySelector("openclaw-chat-retry-status")!;
});
afterEach(() => {
  view.dispose();
  view.container.remove();
  vi.restoreAllMocks();
  vi.useRealTimers();
});
it("counts down the actual retry deadline, then stops without claiming success", async () => {
  view.update({ retryAt: 18_000 });
  expect(element.textContent).toBe("Retrying in 8s");
  await vi.advanceTimersByTimeAsync(8_000);
  expect(element.textContent).toBe("Retrying…");
  expect(vi.getTimerCount()).toBe(0);
  await vi.advanceTimersByTimeAsync(20_000);
  view.update({ retryAt: Date.now() + 3_000 });
  expect(element.textContent).toBe("Retrying in 3s");
  view.dispose();
  expect(vi.getTimerCount()).toBe(0);
});
it("does not invent a countdown without a deadline", async () => {
  flush();
  expect(element.textContent).toBe("Retrying…");
  expect(vi.getTimerCount()).toBe(0);
});
