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
          ? { available: true, controlled: held, byYou: held }
          : { available: true, controlled: true, byYou: true },
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

  it.each([
    [false, "default routing resolves to a browser node"],
    [true, "the browser is on the Gateway host"],
  ])("offers Take control only when the Gateway confirms it (%s: %s)", async (available) => {
    stubScreenshotMedia();
    // No preferred tab: the panel has no route of its own and follows default routing.
    const { controller } = panelScenario(undefined, undefined, {
      "/tabs": async () => ({ running: true, tabs: [makeTab("stable-tab", FIRST_URL, "Page")] }),
      "/control": async () => ({ available, controlled: false, byYou: false }),
      "/screenshot": async () => ({ path: "/fresh.png", targetId: "raw-stable", url: FIRST_URL }),
      "/act": async () => metrics(FIRST_URL),
    });
    expect(controller.operations.route).toBeUndefined();

    await controller.refreshAll();
    await vi.waitFor(() => expect(controller.activeTargetId).toBe("stable-tab"));
    await Promise.resolve();

    expect(controller.controlAvailable).toBe(available);
  });

  it.each([
    [{ target: "host", profile: "openclaw" } as const, true],
    [{ target: "node", node: "browser-node", profile: "openclaw" } as const, false],
  ])("offers Take control after following a preferred tab on %o: %s", async (route, available) => {
    stubScreenshotMedia();
    // A node-routed request reaches the routes without the panel's Control UI connection.
    const { controller } = panelScenario(undefined, undefined, {
      "/tabs": async () => ({ running: true, tabs: [makeTab("stable-tab", FIRST_URL, "Page")] }),
      "/tabs/focus": async () => ({ ok: true }),
      "/control": async (request) => ({
        available: request.target !== "node",
        controlled: false,
        byYou: false,
      }),
      "/screenshot": async () => ({ path: "/fresh.png", targetId: "raw-stable", url: FIRST_URL }),
      "/act": async () => metrics(FIRST_URL),
    });

    // The panel follows an agent's tab through selectTab, without refreshAll.
    await controller.selectTab("stable-tab", route);
    await vi.waitFor(() => expect(controller.activeTargetId).toBe("stable-tab"));
    await Promise.resolve();

    expect(controller.operations.route).toEqual(route);
    expect(controller.controlAvailable).toBe(available);
  });
});
