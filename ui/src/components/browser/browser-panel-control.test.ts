import { describe, expect, it, vi } from "vitest";
import {
  createBrowserPanelTestMetrics as metrics,
  createBrowserPanelTestTab as makeTab,
  setupBrowserPanelTestCleanup,
  stubScreenshotMedia,
} from "./browser-panel-controller-test-support.ts";
import { panelScenario } from "./browser-panel-stream.test-support.ts";

setupBrowserPanelTestCleanup();
const FIRST_URL = "https://example.test/first";
const NEXT_URL = "https://example.test/next";

describe("BrowserPanel take control", () => {
  it("keeps checking control across navigation and shows when the Gateway released it", async () => {
    vi.useFakeTimers();
    stubScreenshotMedia();
    let url = FIRST_URL;
    let held = true;
    const { controller } = panelScenario("stable-tab", FIRST_URL, {
      "/control": async (request) =>
        request.method === "GET"
          ? { controlled: held, byYou: held }
          : { controlled: true, byYou: true },
      "/navigate": async (request) => {
        url = String(request.body?.url);
        return { ok: true };
      },
      "/tabs": async () => ({ running: true, tabs: [makeTab("stable-tab", url, "Page")] }),
      "/screenshot": async () => ({ path: "/fresh.png", targetId: "raw-stable", url }),
      "/act": async () => metrics(url),
    });

    controller.toggleControl();
    await vi.advanceTimersByTimeAsync(0);
    expect(controller.controlling).toBe(true);

    // Navigation renews the panel's view operations; the control check must survive it.
    await controller.openUrl(NEXT_URL, { newTab: false });
    held = false;
    await vi.advanceTimersByTimeAsync(30_000);

    expect(controller.controlling).toBe(false);
    expect(controller.noticeText).toBe(
      "Control was released after 5 minutes without input, or from another window. The agent can use this browser again.",
    );
  });
});
