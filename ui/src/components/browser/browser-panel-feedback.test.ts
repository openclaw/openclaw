import { beforeEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import {
  createBrowserClient,
  createBrowserPanelTestController,
  createBrowserPanelTestMetrics as metrics,
  setupBrowserPanelTestCleanup,
  stubScreenshotMedia,
} from "./browser-panel-controller-test-support.ts";

setupBrowserPanelTestCleanup();
beforeEach(() => vi.useFakeTimers());

const latestUrl = "https://example.test/latest";
const latestCapture = { path: "/latest.png", targetId: "raw-a", url: latestUrl };

function setupFeedback(pressMs = 0) {
  stubScreenshotMedia();
  const screenshot = vi.fn(async () => latestCapture);
  const { client } = createBrowserClient(async (envelope) => {
    if (envelope.path === "/screenshot") {
      return screenshot();
    }
    if (envelope.body?.kind === "press") {
      await new Promise((resolve) => {
        setTimeout(resolve, pressMs);
      });
    }
    return metrics(latestUrl, "Latest");
  });
  const controller = createBrowserPanelTestController(client, "tab-a");
  async function type(key: string, count = 1, delay = 350) {
    for (let index = 0; index < count; index += 1) {
      controller.input.handleViewportKeydown(new KeyboardEvent("keydown", { key }));
      await vi.advanceTimersByTimeAsync(delay);
    }
  }
  return { controller, screenshot, type };
}

it("refreshes fallback feedback during continuous input instead of waiting for idle", async () => {
  const { controller, screenshot, type } = setupFeedback();
  await type("a", 4, 100);
  expect(screenshot).toHaveBeenCalledTimes(1);
  expect(controller.view?.url).toBe(latestUrl);
  await type("b");
  expect(screenshot).toHaveBeenCalledTimes(2);
  controller.suspendView();
});

it("keeps a slow fallback capture and delivers trailing input feedback", async () => {
  const capture = createDeferred<typeof latestCapture>();
  const { controller, screenshot, type } = setupFeedback();
  screenshot.mockImplementationOnce(() => capture.promise);
  await type("a");
  expect(screenshot).toHaveBeenCalledTimes(1);
  await type("b", 8, 100);
  expect(screenshot).toHaveBeenCalledTimes(1);
  capture.resolve({ path: "/first.png", targetId: "raw-a", url: "https://example.test/first" });
  await vi.advanceTimersByTimeAsync(0);
  expect(controller.view?.url).toBe("https://example.test/first");
  await vi.advanceTimersByTimeAsync(350);
  expect(screenshot).toHaveBeenCalledTimes(2);
  expect(controller.view?.url).toBe(latestUrl);
  controller.suspendView();
});

it("counts a slow action toward the settle delay and keeps retries paced behind a pending capture", async () => {
  const capture = createDeferred<typeof latestCapture>();
  const { controller, screenshot, type } = setupFeedback(400);
  screenshot.mockImplementationOnce(() => capture.promise);
  await type("a", 1, 401);
  expect(screenshot).toHaveBeenCalledTimes(1);
  await type("b", 1, 450);
  capture.resolve(latestCapture);
  await vi.advanceTimersByTimeAsync(299);
  expect(screenshot).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(2);
  expect(screenshot).toHaveBeenCalledTimes(2);
  controller.suspendView();
});

it.each([true, false])("coalesces wheel bursts at the %s live-stream cadence", async (live) => {
  const { client, request } = createBrowserClient(async () => ({ result: true }));
  const controller = createBrowserPanelTestController(client, "tab-a");
  vi.spyOn(controller.stream, "ownsView").mockReturnValue(live);
  const delay = live ? 50 : 150;
  const wheel = (deltaX: number, deltaY: number) =>
    controller.input.handleWheel(new WheelEvent("wheel", { deltaX, deltaY, cancelable: true }));
  wheel(5, 60);
  wheel(7, 40);
  await vi.advanceTimersByTimeAsync(delay - 1);
  expect(request).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  expect(request).toHaveBeenCalledOnce();
  const action = request.mock.calls[0]?.[1];
  expect(action).toMatchObject({
    path: "/act",
    body: {
      targetId: "tab-a",
      kind: "evaluate",
      fn: expect.stringContaining("window.scrollBy(12, 100)"),
    },
  });
  controller.suspendView();
});
