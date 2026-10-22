import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { GatewayRequestError } from "../../api/gateway.ts";
import { waitForFast } from "../../test-helpers/wait-for.ts";
import type { BrowserAnnotationEvent } from "./browser-annotation.ts";
import { setupAnnotationCapture } from "./browser-panel-capture.test-support.ts";
import {
  createBrowserClient,
  createBrowserPanelTestController,
  createBrowserPanelTestMetrics as metrics,
  createBrowserPanelTestTab as makeTab,
  createInspectedNode,
  createPointer,
  createView,
  flushBrowserResponses,
  setupBrowserPanelTestCleanup,
  stubScreenshotMedia,
  TestBrowserPanelHost,
} from "./browser-panel-controller-test-support.ts";
import { panelScenario } from "./browser-panel-stream.test-support.ts";

setupBrowserPanelTestCleanup();
const { receive, stubCanvas } = setupAnnotationCapture();
const INITIAL_URL = "https://example.test/initial";
const REJECTED_URL = "https://example.test/rejected";
const stableTab = (url: string) => makeTab("stable-tab", url, "Page");
function documentRoutes(read: () => ReturnType<typeof stableTab>) {
  return {
    "/tabs": async () => ({ running: true, tabs: [read()] }),
    "/screenshot": async () => ({ path: "/fresh.png", targetId: read().targetId, url: read().url }),
    "/act": async () => metrics(read().url, read().title),
  };
}

describe("BrowserPanel tab and lifecycle ownership", () => {
  it("keeps rejected capture state and replaces stale feedback with the limit error", async () => {
    stubCanvas(["beginPath", "moveTo", "lineTo", "stroke"]);
    const { client } = createBrowserClient(async () => ({ running: true, tabs: [] }));
    const controller = createBrowserPanelTestController(client, "tab-a");
    controller.setMode("annotate");
    controller.strokes = [{ points: [{ x: 0.25, y: 0.5 }] }];
    controller.errorText = "Stale error";
    controller.noticeText = "Previously sent";
    receive.mockImplementation((event) => {
      (event as BrowserAnnotationEvent).rejection = "limit";
    });
    await controller.input.sendAnnotation({});

    expect(controller.mode).toBe("annotate");
    expect(controller.strokes).toHaveLength(1);
    expect(controller.noticeText).toBeNull();
    expect(controller.errorText).toContain("maximum 4 cards and 8,000 characters");
  });

  it.each(["reject", "resolve"] as const)(
    "preserves pending new-tab ownership when the previous capture %ss",
    async (completion) => {
      stubScreenshotMedia();
      const previousCapture = createDeferred<unknown>();
      const captureStarted = createDeferred();
      const openedTab = createDeferred<ReturnType<typeof makeTab>>();
      const activeUrl = "https://example.test/active";
      const newUrl = "https://example.test/new";
      const tabs = [makeTab("active-tab", activeUrl, "Active")];
      const { controller } = panelScenario("active-tab", activeUrl, {
        "/tabs": async () => ({ running: true, tabs: [...tabs] }),
        "/tabs/open": async () => {
          const tab = await openedTab.promise;
          tabs.push(tab);
          return tab;
        },
        "/screenshot": async (envelope) => {
          if (envelope.body?.targetId === "active-tab") {
            captureStarted.resolve();
            return await previousCapture.promise;
          }
          return { path: "/fresh.png", targetId: "raw-new", url: newUrl };
        },
        "/act": async () => metrics(newUrl, "New"),
      });
      const previousView = controller.view;

      const capture = controller.refreshAll();
      await captureStarted.promise;
      const opening = controller.openUrl(newUrl, { newTab: true });
      expect(controller.loading).toBe(true);
      expect(controller.view).toBe(previousView);

      if (completion === "reject") {
        previousCapture.reject(new Error("Superseded capture failed"));
      } else {
        previousCapture.resolve({ path: "/old.png", targetId: "raw-active", url: activeUrl });
      }
      await capture;

      expect(controller.loading).toBe(true);
      expect(controller.errorText).toBeNull();
      expect(controller.view).toBe(previousView);

      openedTab.resolve(makeTab("new-tab", newUrl, "New"));
      await opening;

      expect(controller.activeTargetId).toBe("new-tab");
      expect(controller.view?.url).toBe(newUrl);
      expect(controller.loading).toBe(false);
      expect(controller.errorText).toBeNull();
    },
  );

  it("preserves the current screenshot when same-tab navigation is rejected", async () => {
    const previousCapture = createDeferred<unknown>();
    const navigation = createDeferred<unknown>();
    const initialUrl = "https://example.test/initial";
    const { controller } = panelScenario("stable-tab", initialUrl, {
      "/tabs": async () => ({
        running: true,
        tabs: [stableTab(initialUrl)],
      }),
      "/screenshot": async () => await previousCapture.promise,
      "/navigate": async () => await navigation.promise,
    });
    const previousView = controller.view;
    const pendingCapture = controller.refreshAll();
    await flushBrowserResponses();

    const pendingNavigation = controller.openUrl("https://example.test/rejected", {
      newTab: false,
    });
    navigation.reject(
      new GatewayRequestError({
        code: "UNAVAILABLE",
        message: "Navigation rejected",
        details: { reason: "navigation_blocked" },
      }),
    );
    await pendingNavigation;
    previousCapture.resolve({ path: "/old.png", targetId: "raw-stable", url: initialUrl });
    await pendingCapture;

    expect(controller.activeTargetId).toBe("stable-tab");
    expect(controller.view).toBe(previousView);
    expect(controller.errorText).toBe(
      "Browser request failed: The current browser navigation rules block this address. Select another tab or enter an allowed address.",
    );
    expect(controller.loading).toBe(false);
  });

  it("keeps the newest document when overlapping same-tab navigations complete", async () => {
    stubScreenshotMedia();
    const initialUrl = "https://example.test/initial";
    const previousUrl = "https://example.test/previous";
    const latestUrl = "https://example.test/latest";
    const previous = createDeferred<{ targetId: string; url: string }>();
    const latest = createDeferred<{ targetId: string; url: string }>();
    let documentUrl = initialUrl;
    const { calls, controller } = panelScenario("stable-tab", initialUrl, {
      "/navigate": async (envelope) => {
        const result = await (envelope.body?.url === latestUrl ? latest : previous).promise;
        documentUrl = result.url;
        return result;
      },
      ...documentRoutes(() => stableTab(documentUrl)),
    });

    const previousNavigation = controller.openUrl(previousUrl, { newTab: false });
    await flushBrowserResponses();
    const latestNavigation = controller.openUrl(latestUrl, { newTab: false });
    latest.resolve({ targetId: "raw-stable", url: latestUrl });
    await flushBrowserResponses();
    previous.resolve({ targetId: "raw-stable", url: previousUrl });
    await Promise.all([previousNavigation, latestNavigation]);

    expect(documentUrl).toBe(latestUrl);
    expect(controller.activeTargetId).toBe("stable-tab");
    expect(controller.view?.url).toBe(latestUrl);
    expect(controller.tabs[0]?.url).toBe(latestUrl);
    expect(calls("/navigate")).toHaveLength(2);
    expect(controller.loading).toBe(false);
  });

  it.each([
    { outcome: "changed URL", url: "https://example.test/committed" },
    { outcome: "same URL", url: "https://example.test/initial" },
    { outcome: "tabs failure", url: "https://example.test/committed" },
    { outcome: "screenshot failure", url: "https://example.test/committed" },
    { outcome: "removed target", url: "https://example.test/committed" },
  ])(
    "reconciles a committed document after rejected navigation: $outcome",
    async ({ outcome, url }) => {
      const succeeds = outcome.endsWith("URL");
      if (succeeds) {
        stubScreenshotMedia();
      }
      const committed = createDeferred<{ targetId: string; url: string }>();
      const error = succeeds ? "Latest navigation rejected" : "Original navigation rejected";
      let documentUrl = INITIAL_URL;
      const { controller, calls } = panelScenario("stable-tab", INITIAL_URL, {
        "/navigate": async (request) => {
          if (request.body?.url === REJECTED_URL) {
            throw new Error(error);
          }
          const result = await committed.promise;
          documentUrl = result.url;
          return result;
        },
        "/tabs": async () => {
          if (outcome === "tabs failure") {
            throw new Error("Best-effort tab recovery failed");
          }
          return {
            running: true,
            tabs: outcome === "removed target" ? [] : [stableTab(documentUrl)],
          };
        },
        "/screenshot": async () => {
          if (!succeeds) {
            throw new Error("Best-effort screenshot recovery failed");
          }
          return { path: "/fresh.png", targetId: "raw-stable", url: documentUrl };
        },
        "/act": async () => {
          if (!succeeds) {
            throw new Error("Unexpected evaluation during failed recovery");
          }
          return metrics(documentUrl);
        },
      });
      const previous = controller.openUrl(url, { newTab: false });
      await flushBrowserResponses();
      const latest = controller.openUrl(REJECTED_URL, { newTab: false });
      committed.resolve({ targetId: "raw-stable", url });
      await expect(Promise.all([previous, latest])).resolves.toEqual([undefined, undefined]);
      expect(controller).toMatchObject({
        errorText: "Browser request failed: " + error,
        loading: false,
      });
      if (succeeds) {
        expect(controller).toMatchObject({
          activeTargetId: "stable-tab",
          tabs: [expect.objectContaining({ url })],
          view: { url, dataUrl: expect.stringContaining(btoa("fresh screenshot")) },
        });
        expect(calls("/navigate")).toHaveLength(2);
      } else if (outcome === "removed target") {
        expect(controller.tabs).toEqual([]);
        expect(calls("/screenshot")).toEqual([]);
      } else {
        expect(controller).toMatchObject({ activeTargetId: null, view: null, urlDraft: "" });
      }
    },
  );

  it("recovers a committed document after its predecessor leaves the navigation queue", async () => {
    stubScreenshotMedia();
    const initialUrl = "https://example.test/initial";
    const committedUrl = "https://example.test/committed";
    const previousSnapshot = createDeferred<unknown>();
    let documentUrl = initialUrl;
    let snapshotCount = 0;
    const { controller } = panelScenario("stable-tab", initialUrl, {
      ...documentRoutes(() => stableTab(documentUrl)),
      "/navigate": async (envelope) => {
        if (envelope.body?.url === "https://example.test/rejected") {
          throw new Error("Latest navigation rejected");
        }
        documentUrl = committedUrl;
        return { targetId: "raw-stable", url: committedUrl };
      },
      "/tabs": async () => {
        snapshotCount += 1;
        if (snapshotCount === 1) {
          return await previousSnapshot.promise;
        }
        return {
          running: true,
          tabs: [stableTab(documentUrl)],
        };
      },
    });

    const previous = controller.openUrl(committedUrl, { newTab: false });
    await flushBrowserResponses();
    expect(snapshotCount).toBe(1);
    const latest = controller.openUrl("https://example.test/rejected", { newTab: false });
    await latest;

    expect(controller.view?.url).toBe(committedUrl);
    expect(controller.view?.dataUrl).toContain(btoa("fresh screenshot"));
    expect(controller.errorText).toBe("Browser request failed: Latest navigation rejected");

    previousSnapshot.resolve({ running: true, tabs: [] });
    await previous;
    expect(controller.loading).toBe(false);
  });

  it.each(["before", "after"] as const)(
    "keeps the newest new-tab invocation when the older open resolves %s it",
    async (order) => {
      stubScreenshotMedia();
      const previousOpen = createDeferred<ReturnType<typeof makeTab>>();
      const latestOpen = createDeferred<ReturnType<typeof makeTab>>();
      const latestUrl = "https://example.test/latest";
      const visibleTabs = [makeTab("initial-tab", "https://example.test/initial", "Initial")];
      const { calls, controller } = panelScenario(
        "initial-tab",
        order === "before" ? visibleTabs[0]!.url : undefined,
        {
          "/tabs/open": async (envelope) => {
            const tab = await (envelope.body?.url === latestUrl ? latestOpen : previousOpen)
              .promise;
            visibleTabs.push(tab);
            return tab;
          },
          "/tabs": async () => ({
            running: true,
            tabs: order === "before" ? visibleTabs.slice(-1) : [...visibleTabs],
          }),
          "/screenshot": async () => {
            const tab = visibleTabs.at(-1)!;
            return {
              path: tab.tabId === "latest-tab" ? "/fresh.png" : "/old.png",
              targetId: tab.targetId,
              url: tab.url,
            };
          },
          "/act": async () => {
            const tab = visibleTabs.at(-1)!;
            return metrics(tab.url, tab.title);
          },
        },
      );
      const previousNavigation = controller.openUrl("https://example.test/previous", {
        newTab: true,
      });
      const latestNavigation = controller.openUrl(latestUrl, { newTab: true });
      const resolvePrevious = async () => {
        previousOpen.resolve(makeTab("previous-tab", "https://example.test/previous", "Previous"));
        await previousNavigation;
      };
      if (order === "before") {
        await resolvePrevious();
        expect(controller.loading).toBe(true);
      }
      latestOpen.resolve(makeTab("latest-tab", latestUrl, "Latest"));
      await latestNavigation;
      const latestView = controller.view;
      if (order === "after") {
        await resolvePrevious();
        expect(controller.view).toBe(latestView);
      }
      expect(controller.tabs.map((tab) => tab.id)).toEqual(
        order === "before" ? ["latest-tab"] : ["initial-tab", "latest-tab", "previous-tab"],
      );
      expect(controller).toMatchObject({
        activeTargetId: "latest-tab",
        loading: false,
        errorText: null,
        view: { url: latestUrl, dataUrl: expect.stringContaining(btoa("fresh screenshot")) },
      });
      expect(calls("/screenshot")).toHaveLength(1);
      expect(calls("/tabs/open")).toHaveLength(2);
    },
  );

  it.each([false, true])(
    "rejects a stale snapshot during new-tab creation (same active tab: %s)",
    async (sameTab) => {
      stubScreenshotMedia();
      const activeUrl = "https://example.test/active";
      const nextUrl = "https://example.test/new";
      const activeTab = makeTab("active-tab", activeUrl, "Active");
      const tabs = [activeTab];
      const snapshot = createDeferred<unknown>();
      const opened = createDeferred<ReturnType<typeof makeTab>>();
      let snapshotCount = 0;
      const { controller, calls } = panelScenario("active-tab", activeUrl, {
        "/tabs": async () =>
          ++snapshotCount === 1
            ? await snapshot.promise
            : { running: true, tabs: sameTab ? [...tabs] : tabs.slice(-1) },
        "/tabs/open": async () => {
          const next = await opened.promise;
          tabs.push(next);
          return next;
        },
        "/screenshot": async (envelope) => {
          if (sameTab && envelope.body?.targetId === "active-tab") {
            throw new Error("Superseded snapshot capture failed");
          }
          const latest = envelope.body?.targetId === "new-tab";
          return {
            path: latest ? "/fresh.png" : "/old.png",
            targetId: latest ? "raw-new" : "raw-previous",
            url: latest ? nextUrl : "https://example.test/previous",
          };
        },
        "/act": async () =>
          metrics(sameTab ? nextUrl : tabs.at(-1)!.url, sameTab ? "New" : tabs.at(-1)!.title),
      });
      const previousView = controller.view;
      const refresh = controller.refreshAll();
      if (sameTab) {
        await flushBrowserResponses();
      }
      const opening = controller.openUrl(nextUrl, { newTab: true });
      snapshot.resolve({
        running: true,
        tabs: [
          sameTab
            ? activeTab
            : makeTab("previous-tab", "https://example.test/previous", "Previous"),
        ],
      });
      await refresh;
      expect(controller.loading).toBe(true);
      if (sameTab) {
        expect(controller.errorText).toBeNull();
        expect(controller.view).toBe(previousView);
        expect(
          calls("/screenshot").some((request) => request.body?.targetId === "active-tab"),
        ).toBe(false);
      }
      opened.resolve(makeTab("new-tab", nextUrl, "New"));
      await opening;
      expect(controller).toMatchObject({
        activeTargetId: "new-tab",
        loading: false,
        view: { url: nextUrl, dataUrl: expect.stringContaining(btoa("fresh screenshot")) },
      });
      if (sameTab) {
        expect(controller.errorText).toBeNull();
      } else {
        expect(controller.tabs.map((entry) => entry.id)).toEqual(["new-tab"]);
      }
    },
  );

  it("invalidates old-document inspection and wheel input before same-tab navigation", async () => {
    vi.useFakeTimers({ now: 1_000 });
    const previousInspection = createDeferred<unknown>();
    const firstNavigation = createDeferred<unknown>();
    const { request, controller: inspectedController } = panelScenario("stable-tab", undefined, {
      "/act": async () => await previousInspection.promise,
      "/navigate": async () => await firstNavigation.promise,
    });
    inspectedController.setMode("inspect");

    inspectedController.handleOverlayPointerMove(createPointer(10, 20));
    void inspectedController.openUrl("https://example.test/destination", { newTab: false });
    previousInspection.resolve({ result: createInspectedNode("previous-document") });
    await flushBrowserResponses();

    expect(request).toHaveBeenCalledWith(
      "browser.request",
      expect.objectContaining({
        method: "POST",
        path: "/navigate",
        body: { url: "https://example.test/destination", targetId: "stable-tab" },
      }),
    );
    expect(inspectedController.activeTargetId).toBe("stable-tab");
    expect(inspectedController.inspected).toBeNull();

    const secondNavigation = createDeferred<unknown>();
    const { calls, controller: wheeledController } = panelScenario("stable-tab", undefined, {
      "/navigate": async () => await secondNavigation.promise,
      "/act": async () => ({ result: true }),
    });
    wheeledController.input.handleWheel(new WheelEvent("wheel", { deltaY: 60, cancelable: true }));

    void wheeledController.openUrl("https://example.test/destination", { newTab: false });
    await vi.advanceTimersByTimeAsync(150);

    expect(wheeledController.activeTargetId).toBe("stable-tab");
    expect(calls("/act")).toHaveLength(0);
  });

  it("clears loading and rejects an in-flight refresh after disconnection", async () => {
    const previousCapture = createDeferred<unknown>();
    const url = "https://example.test/previous";
    const { host, controller } = panelScenario("stable-tab", url, {
      "/tabs": async () => ({
        running: true,
        tabs: [{ ...stableTab(url), targetId: "raw-tab", title: "Previous" }],
      }),
      "/screenshot": async () => await previousCapture.promise,
    });
    const previousView = controller.view;

    const pendingRefresh = controller.refreshAll();
    await flushBrowserResponses();
    expect(controller.loading).toBe(true);

    host.isConnected = false;
    controller.suspendView();
    expect(controller.loading).toBe(false);

    host.isConnected = true;
    previousCapture.resolve({
      path: "/old.png",
      targetId: "raw-tab",
      url: "https://example.test/previous",
    });
    await pendingRefresh;

    expect(controller.activeTargetId).toBe("stable-tab");
    expect(controller.view).toBe(previousView);
    expect(controller.loading).toBe(false);
  });

  it("keeps the latest tab capture when an older focus resolves afterward", async () => {
    stubScreenshotMedia();
    const previousFocus = createDeferred<unknown>();
    const latestFocus = createDeferred<unknown>();
    const latestCapture = createDeferred<unknown>();
    const latestUrl = "https://example.test/latest";
    const { calls, controller } = panelScenario("tab-initial", undefined, {
      "/tabs/focus": async (envelope) =>
        await (envelope.body?.targetId === "tab-a" ? previousFocus : latestFocus).promise,
      "/screenshot": async (envelope) => {
        if (envelope.body?.targetId === "tab-b") {
          return await latestCapture.promise;
        }
        return {
          path: "/old.png",
          targetId: "raw-a",
          url: "https://example.test/old",
        };
      },
      "/act": async () => metrics(latestUrl, "Latest"),
    });

    const previousSelection = controller.selectTab("tab-a");
    const latestSelection = controller.selectTab("tab-b");
    latestFocus.resolve({ ok: true });
    await flushBrowserResponses();
    previousFocus.resolve({ ok: true });
    await previousSelection;
    latestCapture.resolve({ path: "/fresh.png", targetId: "raw-b", url: latestUrl });
    await latestSelection;

    expect(controller.activeTargetId).toBe("tab-b");
    expect(controller.view?.targetId).toBe("tab-b");
    expect(controller.view?.dataUrl).toContain(btoa("fresh screenshot"));
    expect(controller.loading).toBe(false);
    const screenshots = calls("/screenshot");
    expect(screenshots).toHaveLength(1);
    expect(screenshots[0]).toMatchObject({ body: { targetId: "tab-b" } });
  });

  it.each(["browser evaluateEnabled=false"])(
    "ignores a stale inspection rejection after gateway replacement: %s",
    async (failure) => {
      vi.useFakeTimers({ now: 1_000 });
      const previousInspection = createDeferred<unknown>();
      const previous = createBrowserClient(async () => await previousInspection.promise);
      const replacement = createBrowserClient(async () => ({ running: true, tabs: [] }));
      const host = new TestBrowserPanelHost(previous.client);
      const controller = host.createPanel();
      controller.activeTargetId = "tab-a";
      controller.view = createView("tab-a");
      controller.setMode("inspect");
      controller.handleOverlayPointerMove(createPointer(10, 20));

      host.open = false;
      host.client = replacement.client;
      controller.synchronizeClient();
      host.open = true;
      controller.activeTargetId = "tab-b";
      controller.view = createView("tab-b");
      controller.setMode("inspect");
      previousInspection.reject(new Error(failure));
      await flushBrowserResponses();

      expect(controller.evaluateUnavailable).toBe(false);
      expect(controller.mode).toBe("inspect");
      expect(controller.errorText).toBeNull();
    },
  );
});

describe("BrowserPanel superseded tab snapshots", () => {
  it("reads page geometry while the screenshot body is downloading", async () => {
    stubScreenshotMedia();
    const body = createDeferred<Blob>();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true, blob: () => body.promise })),
    );
    const url = "https://example.test/page";
    const { request, controller } = panelScenario("tab-a", url, {
      "/screenshot": async () => ({ path: "/fresh.png", targetId: "tab-a", url }),
      "/act": async () => metrics(url),
    });
    const previousView = controller.view;
    const capture = controller.refreshView("tab-a");
    try {
      await waitForFast(() =>
        expect(request).toHaveBeenCalledWith(
          "browser.request",
          expect.objectContaining({ path: "/act" }),
        ),
      );
      expect(controller.view).toBe(previousView);
      expect(controller.loading).toBe(true);
    } finally {
      body.resolve(new Blob(["fresh screenshot"], { type: "image/png" }));
      await capture;
    }
    expect(controller.view?.dataUrl).toContain(btoa("fresh screenshot"));
    expect(controller.view?.metrics).toEqual(metrics(url).result);
    expect(controller.loading).toBe(false);
  });

  it.each([true, false])(
    "never reselects a closed active tab when refreshing the remaining tabs fails (fallback: %s)",
    async (hasFallback) => {
      stubScreenshotMedia();
      const activeUrl = "https://example.test/active";
      const fallbackUrl = "https://example.test/fallback";
      const { client, request } = createBrowserClient(async (envelope) => {
        if (envelope.method === "DELETE" && envelope.path === "/tabs/active-tab") {
          return { ok: true };
        }
        if (envelope.path === "/tabs") {
          throw new Error("Tab refresh failed after the active tab was closed");
        }
        if (envelope.path === "/screenshot" && envelope.body?.targetId === "fallback-tab") {
          return { path: "/fresh.png", targetId: "raw-fallback", url: fallbackUrl };
        }
        if (envelope.path === "/act") {
          return metrics(fallbackUrl, "Fallback");
        }
        throw new Error(`Unexpected browser route: ${envelope.method} ${envelope.path}`);
      });
      const controller = createBrowserPanelTestController(client, "active-tab", activeUrl);
      controller.tabs = [
        {
          kind: "remote" as const,
          id: "active-tab",
          targetId: "raw-active",
          title: "Active",
          url: activeUrl,
        },
        ...(hasFallback
          ? [
              {
                kind: "remote" as const,
                id: "fallback-tab",
                targetId: "raw-fallback",
                title: "Fallback",
                url: fallbackUrl,
              },
            ]
          : []),
      ];

      await controller.closeTab("active-tab");

      expect(controller.tabs.map((tab) => tab.id)).toEqual(hasFallback ? ["fallback-tab"] : []);
      expect(controller.activeTargetId).toBe(hasFallback ? "fallback-tab" : null);
      expect(controller.view?.targetId ?? null).toBe(hasFallback ? "fallback-tab" : null);
      expect(controller.loading).toBe(false);
      expect(
        request.mock.calls.some(([, envelope]) => {
          const browserRequest = envelope as { path?: string; body?: { targetId?: string } };
          return (
            browserRequest.path === "/screenshot" && browserRequest.body?.targetId === "active-tab"
          );
        }),
      ).toBe(false);
    },
  );

  it("rejects old-gateway snapshots before the replacement client synchronizes", async () => {
    const activeUrl = "https://example.test/active";
    const snapshot = createDeferred<{
      running: boolean;
      tabs: ReturnType<typeof makeTab>[];
    }>();
    const old = createBrowserClient(async (envelope) => {
      if (envelope.path === "/tabs") {
        return await snapshot.promise;
      }
      throw new Error(`Unexpected old browser route: ${envelope.path}`);
    });
    const replacement = createBrowserClient(async (envelope) => {
      throw new Error(`Unexpected replacement browser route: ${envelope.path}`);
    });
    const host = new TestBrowserPanelHost(old.client);
    const controller = host.createPanel();
    const originalView = createView("active-tab", activeUrl);
    controller.activeTargetId = "active-tab";
    controller.view = originalView;

    const refresh = controller.refreshAll();
    await flushBrowserResponses();
    host.client = replacement.client;
    snapshot.resolve({
      running: true,
      tabs: [makeTab("active-tab", activeUrl, "Active")],
    });
    await refresh;

    expect(controller.running).toBeNull();
    expect(controller.tabs).toEqual([]);
    expect(controller.view).toBe(originalView);
    expect(replacement.request).not.toHaveBeenCalled();
  });
});
