import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import {
  createBrowserClient,
  createBrowserPanelTestController,
  createBrowserPanelTestMetrics,
  setupBrowserPanelTestCleanup,
  stubScreenshotMedia,
} from "./browser-panel-controller-test-support.ts";

setupBrowserPanelTestCleanup();
beforeEach(() => vi.useFakeTimers());

const latestUrl = "https://example.test/latest";
const latestCapture = { path: "/latest.png", targetId: "raw-a", url: latestUrl };

describe("Browser panel input feedback", () => {
  it("refreshes fallback feedback during continuous input instead of waiting for idle", async () => {
    stubScreenshotMedia();
    let captures = 0;
    const { client } = createBrowserClient(async (envelope) => {
      if (envelope.path === "/screenshot") {
        captures += 1;
        return { ...latestCapture };
      }
      return createBrowserPanelTestMetrics(latestUrl, "Latest");
    });
    const controller = createBrowserPanelTestController(client, "tab-a");

    for (let index = 0; index < 4; index += 1) {
      controller.input.handleViewportKeydown(new KeyboardEvent("keydown", { key: "a" }));
      await vi.advanceTimersByTimeAsync(100);
    }

    expect(captures).toBe(1);
    expect(controller.view?.url).toBe("https://example.test/latest");
    controller.input.handleViewportKeydown(new KeyboardEvent("keydown", { key: "b" }));
    await vi.advanceTimersByTimeAsync(350);
    expect(captures).toBe(2);
    controller.suspendView();
  });

  it("keeps a slow fallback capture and delivers trailing input feedback", async () => {
    stubScreenshotMedia();
    const capture = createDeferred<unknown>();
    let captures = 0;
    const { client } = createBrowserClient(async (envelope) => {
      if (envelope.path === "/screenshot") {
        captures += 1;
        if (captures === 1) {
          return await capture.promise;
        }
        return { ...latestCapture };
      }
      return createBrowserPanelTestMetrics(latestUrl, "Latest");
    });
    const controller = createBrowserPanelTestController(client, "tab-a");
    controller.input.handleViewportKeydown(new KeyboardEvent("keydown", { key: "a" }));
    await vi.advanceTimersByTimeAsync(350);
    expect(captures).toBe(1);

    for (let index = 0; index < 8; index += 1) {
      controller.input.handleViewportKeydown(new KeyboardEvent("keydown", { key: "b" }));
      await vi.advanceTimersByTimeAsync(100);
    }
    expect(captures).toBe(1);
    capture.resolve({ path: "/first.png", targetId: "raw-a", url: "https://example.test/first" });
    await vi.advanceTimersByTimeAsync(0);
    expect(controller.view?.url).toBe("https://example.test/first");

    await vi.advanceTimersByTimeAsync(350);
    expect(captures).toBe(2);
    expect(controller.view?.url).toBe("https://example.test/latest");
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
    expect(request.mock.calls[0]?.[1]).toMatchObject({
      path: "/act",
      body: {
        targetId: "tab-a",
        kind: "evaluate",
        fn: expect.stringContaining("window.scrollBy(12, 100)"),
      },
    });
    controller.suspendView();
  });
});
