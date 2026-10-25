import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { GatewayRequestError } from "../../api/gateway.ts";
import { waitForFast } from "../../test-helpers/wait-for.ts";
import type { BrowserAnnotationEvent } from "./browser-annotation.ts";
import type { BrowserPanelTab } from "./browser-client.ts";
import { setupAnnotationCapture } from "./browser-panel-capture.test-support.ts";
import {
  createBrowserClient,
  createBrowserPanelTestController,
  createBrowserPanelTestMetrics as metrics,
  createBrowserPanelTestTab as makeTab,
  createInspectedNode,
  createPointer,
  createView,
  flushBrowserResponses as flush,
  setupBrowserPanelTestCleanup,
  stubScreenshotMedia,
  TestBrowserPanelHost,
} from "./browser-panel-controller-test-support.ts";
import { panelScenario } from "./browser-panel-stream.test-support.ts";

setupBrowserPanelTestCleanup();
const { receive, stubCanvas } = setupAnnotationCapture();
const INITIAL_URL = "https://example.test/initial";
const REJECTED_URL = "https://example.test/rejected";
const ACTIVE_URL = "https://example.test/active";
const LATEST_URL = "https://example.test/latest";
const NEW_URL = "https://example.test/new";
const PREVIOUS_URL = "https://example.test/previous";
const fresh = (url: string, targetId = "raw-stable") => ({ path: "/fresh.png", targetId, url });
const remoteTab = (id: string, url: string, title: string): BrowserPanelTab => ({
  kind: "remote",
  id,
  targetId: `raw-${id.replace(/-tab$/, "")}`,
  title,
  url,
});
const stableTab = (url: string) => makeTab("stable-tab", url, "Page");
function documentRoutes(read: () => ReturnType<typeof stableTab>) {
  return {
    "/tabs": async () => ({ running: true, tabs: [read()] }),
    "/screenshot": async () => fresh(read().url, read().targetId),
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
      const tabs = [makeTab("active-tab", ACTIVE_URL, "Active")];
      const { controller } = panelScenario("active-tab", ACTIVE_URL, {
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
          return { path: "/fresh.png", targetId: "raw-new", url: NEW_URL };
        },
        "/act": async () => metrics(NEW_URL, "New"),
      });
      const previousView = controller.view;

      const capture = controller.refreshAll();
      await captureStarted.promise;
      const opening = controller.openUrl(NEW_URL, { newTab: true });
      expect(controller.loading).toBe(true);
      expect(controller.view).toBe(previousView);

      if (completion === "reject") {
        previousCapture.reject(new Error("Superseded capture failed"));
      } else {
        previousCapture.resolve({ path: "/old.png", targetId: "raw-active", url: ACTIVE_URL });
      }
      await capture;

      expect(controller.loading).toBe(true);
      expect(controller.errorText).toBeNull();
      expect(controller.view).toBe(previousView);

      openedTab.resolve(makeTab("new-tab", NEW_URL, "New"));
      await opening;

      expect(controller.activeTargetId).toBe("new-tab");
      expect(controller.view?.url).toBe(NEW_URL);
      expect(controller.loading).toBe(false);
      expect(controller.errorText).toBeNull();
    },
  );

  it("preserves the current screenshot when same-tab navigation is rejected", async () => {
    const previousCapture = createDeferred<unknown>();
    const navigation = createDeferred<unknown>();
    const { controller } = panelScenario("stable-tab", INITIAL_URL, {
      "/tabs": async () => ({ running: true, tabs: [stableTab(INITIAL_URL)] }),
      "/screenshot": async () => await previousCapture.promise,
      "/navigate": async () => await navigation.promise,
    });
    const previousView = controller.view;
    const pendingCapture = controller.refreshAll();
    await flush();

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
    previousCapture.resolve({ path: "/old.png", targetId: "raw-stable", url: INITIAL_URL });
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
    const previous = createDeferred<{ targetId: string; url: string }>();
    const latest = createDeferred<{ targetId: string; url: string }>();
    let documentUrl = INITIAL_URL;
    const { controller } = panelScenario("stable-tab", INITIAL_URL, {
      "/navigate": async (envelope) => {
        const result = await (envelope.body?.url === LATEST_URL ? latest : previous).promise;
        documentUrl = result.url;
        return result;
      },
      ...documentRoutes(() => stableTab(documentUrl)),
    });

    const previousNavigation = controller.openUrl(PREVIOUS_URL, { newTab: false });
    await flush();
    const latestNavigation = controller.openUrl(LATEST_URL, { newTab: false });
    latest.resolve({ targetId: "raw-stable", url: LATEST_URL });
    await flush();
    previous.resolve({ targetId: "raw-stable", url: PREVIOUS_URL });
    await Promise.all([previousNavigation, latestNavigation]);

    expect(documentUrl).toBe(LATEST_URL);
    expect(controller.activeTargetId).toBe("stable-tab");
    expect(controller.view?.url).toBe(LATEST_URL);
    expect(controller.tabs[0]?.url).toBe(LATEST_URL);
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
      await flush();
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
    const committedUrl = "https://example.test/committed";
    const previousSnapshot = createDeferred<unknown>();
    let documentUrl = INITIAL_URL;
    let snapshotCount = 0;
    const { controller } = panelScenario("stable-tab", INITIAL_URL, {
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
        return { running: true, tabs: [stableTab(documentUrl)] };
      },
    });

    const previous = controller.openUrl(committedUrl, { newTab: false });
    await flush();
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
      const visibleTabs = [makeTab("initial-tab", "https://example.test/initial", "Initial")];
      const { calls, controller } = panelScenario(
        "initial-tab",
        order === "before" ? visibleTabs[0]!.url : undefined,
        {
          "/tabs/open": async (envelope) => {
            const tab = await (envelope.body?.url === LATEST_URL ? latestOpen : previousOpen)
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
      const latestNavigation = controller.openUrl(LATEST_URL, { newTab: true });
      const resolvePrevious = async () => {
        previousOpen.resolve(makeTab("previous-tab", "https://example.test/previous", "Previous"));
        await previousNavigation;
      };
      if (order === "before") {
        await resolvePrevious();
        expect(controller.loading).toBe(true);
      }
      latestOpen.resolve(makeTab("latest-tab", LATEST_URL, "Latest"));
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
        view: { url: LATEST_URL, dataUrl: expect.stringContaining(btoa("fresh screenshot")) },
      });
      expect(calls("/screenshot")).toHaveLength(1);
    },
  );

  it.each([false, true])(
    "rejects a stale snapshot during new-tab creation (same active tab: %s)",
    async (sameTab) => {
      stubScreenshotMedia();
      const activeTab = makeTab("active-tab", ACTIVE_URL, "Active");
      const tabs = [activeTab];
      const snapshot = createDeferred<unknown>();
      const opened = createDeferred<ReturnType<typeof makeTab>>();
      let snapshotCount = 0;
      const { controller, calls } = panelScenario("active-tab", ACTIVE_URL, {
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
            url: latest ? NEW_URL : "https://example.test/previous",
          };
        },
        "/act": async () =>
          metrics(sameTab ? NEW_URL : tabs.at(-1)!.url, sameTab ? "New" : tabs.at(-1)!.title),
      });
      const previousView = controller.view;
      const refresh = controller.refreshAll();
      if (sameTab) {
        await flush();
      }
      const opening = controller.openUrl(NEW_URL, { newTab: true });
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
      opened.resolve(makeTab("new-tab", NEW_URL, "New"));
      await opening;
      expect(controller).toMatchObject({
        activeTargetId: "new-tab",
        loading: false,
        view: { url: NEW_URL, dataUrl: expect.stringContaining(btoa("fresh screenshot")) },
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
    await flush();

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
    await flush();
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
      "/act": async () => metrics(LATEST_URL, "Latest"),
    });

    const previousSelection = controller.selectTab("tab-a");
    const latestSelection = controller.selectTab("tab-b");
    latestFocus.resolve({ ok: true });
    await flush();
    previousFocus.resolve({ ok: true });
    await previousSelection;
    latestCapture.resolve({ path: "/fresh.png", targetId: "raw-b", url: LATEST_URL });
    await latestSelection;

    expect(controller.activeTargetId).toBe("tab-b");
    expect(controller.view?.targetId).toBe("tab-b");
    expect(controller.view?.dataUrl).toContain(btoa("fresh screenshot"));
    expect(controller.loading).toBe(false);
    const screenshots = calls("/screenshot");
    expect(screenshots).toHaveLength(1);
  });

  it("ignores a stale inspection rejection after gateway replacement", async () => {
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
    previousInspection.reject(new Error("browser evaluateEnabled=false"));
    await flush();

    expect(controller.evaluateUnavailable).toBe(false);
    expect(controller.mode).toBe("inspect");
    expect(controller.errorText).toBeNull();
  });
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
      const fallbackUrl = "https://example.test/fallback";
      const { controller, calls } = panelScenario("active-tab", ACTIVE_URL, {
        "/tabs/active-tab": async ({ method }) => {
          if (method !== "DELETE") {
            throw new Error("Only closing the active tab is expected");
          }
          return { ok: true };
        },
        "/tabs": async () => {
          throw new Error("Tab refresh failed after the active tab was closed");
        },
        "/screenshot": async (envelope) => {
          if (envelope.body?.targetId !== "fallback-tab") {
            throw new Error("Only the fallback may be captured");
          }
          return fresh(fallbackUrl, "raw-fallback");
        },
        "/act": async () => metrics(fallbackUrl, "Fallback"),
      });
      controller.tabs = [
        remoteTab("active-tab", ACTIVE_URL, "Active"),
        ...(hasFallback ? [remoteTab("fallback-tab", fallbackUrl, "Fallback")] : []),
      ];

      await controller.closeTab("active-tab");

      expect(controller.tabs.map((tab) => tab.id)).toEqual(hasFallback ? ["fallback-tab"] : []);
      expect(controller.activeTargetId).toBe(hasFallback ? "fallback-tab" : null);
      expect(controller.view?.targetId ?? null).toBe(hasFallback ? "fallback-tab" : null);
      expect(controller.loading).toBe(false);
      expect(calls("/screenshot").some((request) => request.body?.targetId === "active-tab")).toBe(
        false,
      );
    },
  );

  it("rejects old-gateway snapshots before the replacement client synchronizes", async () => {
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
    const originalView = createView("active-tab", ACTIVE_URL);
    controller.activeTargetId = "active-tab";
    controller.view = originalView;

    const refresh = controller.refreshAll();
    await flush();
    host.client = replacement.client;
    snapshot.resolve({
      running: true,
      tabs: [makeTab("active-tab", ACTIVE_URL, "Active")],
    });
    await refresh;

    expect(controller.running).toBeNull();
    expect(controller.tabs).toEqual([]);
    expect(controller.view).toBe(originalView);
    expect(replacement.request).not.toHaveBeenCalled();
  });
});
