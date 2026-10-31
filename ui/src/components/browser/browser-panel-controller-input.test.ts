import { runInNewContext } from "node:vm";
import { createSignal, createComponent } from "solid-js";
import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { GatewayRequestError } from "../../api/gateway-connect-errors.ts";
import { mountSolid } from "../../test-helpers/mount-solid.ts";
import { flush } from "../../test-helpers/solid-settle.ts";
import {
  createBrowserClient,
  createBrowserPanelTestController,
  createBrowserPanelTestMetrics as metrics,
  createBrowserPanelTestTab as makeTab,
  createInspectedNode,
  createPointer,
  createView,
  flushBrowserResponses,
  openBrowserActions,
  setupBrowserPanelTestCleanup,
  stubScreenshotMedia,
  type BrowserRequestEnvelope,
} from "./browser-panel-controller-test-support.ts";
import { BrowserPanelChrome } from "./browser-panel-render.tsx";

setupBrowserPanelTestCleanup();

const initialUrl = "https://example.test/initial";
const destinationUrl = "https://example.test/destination";
const activeUrl = "https://example.test/active";
const fallbackUrl = "https://example.test/fallback";
const selectedUrl = "https://example.test/selected";
const backgroundUrl = "https://example.test/background";

function scenario(
  targetId: string,
  url: string | undefined,
  routes: Record<string, (request: BrowserRequestEnvelope) => unknown>,
  hasView = true,
) {
  const gateway = createBrowserClient(async (request) => {
    const route = routes[`${request.method} ${request.path}`] ?? routes[request.path];
    if (!route) {
      throw new Error(`Unexpected browser route: ${request.method} ${request.path}`);
    }
    return await route(request);
  });
  const controller = createBrowserPanelTestController(gateway.client, targetId, url);
  if (!hasView) {
    controller.view = null;
  }
  const calls = (path: string) =>
    gateway.request.mock.calls
      .map(([, envelope]) => envelope as BrowserRequestEnvelope)
      .filter((envelope) => envelope.path === path);
  return { ...gateway, controller, calls };
}

function remoteTab(id: string, targetId: string, title: string, url: string) {
  return { kind: "remote" as const, id, targetId, title, url };
}

function captureRoutes(
  read: (request: BrowserRequestEnvelope) => ReturnType<typeof makeTab>,
  path: (request: BrowserRequestEnvelope) => string = () => "/fresh.png",
) {
  return {
    "/screenshot": (request: BrowserRequestEnvelope) => {
      const { targetId, url } = read(request);
      return { path: path(request), targetId, url };
    },
    "/act": (request: BrowserRequestEnvelope) => {
      const { url, title } = read(request);
      return metrics(url, title);
    },
  };
}

function expectRequest(
  request: ReturnType<typeof createBrowserClient>["request"],
  envelope: Partial<BrowserRequestEnvelope>,
) {
  expect(request).toHaveBeenCalledWith("browser.request", expect.objectContaining(envelope));
}

describe("BrowserPanel capture and input ownership", () => {
  it("restores the prior selected screenshot when tab focus is rejected", async () => {
    const previousCapture = createDeferred<unknown>();
    const focus = createDeferred<unknown>();
    const { controller } = scenario("active-tab", initialUrl, {
      "/tabs": () => ({
        running: true,
        tabs: [makeTab("active-tab", initialUrl, "Page")],
      }),
      "/screenshot": () => previousCapture.promise,
      "/tabs/focus": () => focus.promise,
    });
    const previousView = controller.view;
    const pendingCapture = controller.refreshAll();
    await flushBrowserResponses();

    const pendingSelection = controller.selectTab("next-tab");
    focus.reject(new Error("Tab focus rejected"));
    await pendingSelection;
    previousCapture.resolve({ path: "/old.png", targetId: "raw-active", url: initialUrl });
    await pendingCapture;

    expect(controller.activeTargetId).toBe("active-tab");
    expect(controller.view).toBe(previousView);
    expect(controller.errorText).toBe("Browser request failed: Tab focus rejected");
    expect(controller.loading).toBe(false);
  });

  it.each(["navigation", "focus rejection"] as const)(
    "does not restore a stale view when %s settles first",
    async (first) => {
      const navigation = createDeferred<{ ok: boolean }>();
      const focus = createDeferred<{ ok: boolean }>();
      const { controller, calls } = scenario("tab-a", initialUrl, {
        "/navigate": () => navigation.promise,
        "/tabs/focus": () => focus.promise,
      });
      controller.tabs = [
        remoteTab("tab-a", "raw-a", "Initial", initialUrl),
        remoteTab("tab-b", "raw-b", "Selected", "https://example.test/selected"),
      ];

      const pendingNavigation = controller.openUrl(destinationUrl, { newTab: false });
      await flushBrowserResponses();
      const pendingSelection = controller.selectTab("tab-b");
      if (first === "navigation") {
        navigation.resolve({ ok: true });
        await pendingNavigation;
        focus.reject(new Error("Tab focus rejected"));
        await pendingSelection;
      } else {
        focus.reject(new Error("Tab focus rejected"));
        await pendingSelection;
        navigation.resolve({ ok: true });
        await pendingNavigation;
      }

      expect(controller.activeTargetId).toBeNull();
      expect(controller.view).toBeNull();
      expect(controller.urlDraft).toBe("");
      expect(controller.errorText).toBe("Browser request failed: Tab focus rejected");
      expect(calls("/tabs")).toEqual([]);
    },
  );

  it("retains a newly opened tab after its original active tab closes", async () => {
    stubScreenshotMedia();
    const newUrl = "https://example.test/new";
    const openedTab = createDeferred<ReturnType<typeof makeTab>>();
    let visibleTabs = [
      makeTab("active-tab", activeUrl, "Active"),
      makeTab("fallback-tab", fallbackUrl, "Fallback"),
    ];
    let screenshotCount = 0;
    const { controller } = scenario("active-tab", activeUrl, {
      "/tabs/open": async () => {
        const tab = await openedTab.promise;
        visibleTabs.push(tab);
        return tab;
      },
      "DELETE /tabs/active-tab": () => {
        visibleTabs = visibleTabs.filter((tab) => tab.tabId !== "active-tab");
        return { ok: true };
      },
      "/tabs": () => ({ running: true, tabs: [...visibleTabs] }),
      "/screenshot": () => {
        screenshotCount += 1;
        return { path: "/fresh.png", targetId: "raw-fallback", url: fallbackUrl };
      },
      "/act": () => metrics(fallbackUrl, "Fallback"),
    });

    const opening = controller.openUrl(newUrl, { newTab: true });
    await flushBrowserResponses();
    await controller.closeTab("active-tab");
    const fallbackView = controller.view;
    openedTab.resolve(makeTab("new-tab", newUrl, "New"));
    await opening;

    expect(controller.tabs.map((tab) => tab.id)).toEqual(["fallback-tab", "new-tab"]);
    expect(controller.activeTargetId).toBe("fallback-tab");
    expect(controller.view).toBe(fallbackView);
    expect(screenshotCount).toBe(1);
    expect(controller.loading).toBe(false);
  });

  it("reconciles a background tab closed while it becomes selected", async () => {
    stubScreenshotMedia();
    const closing = createDeferred<{ ok: boolean }>();
    const activeTab = makeTab("active-tab", activeUrl, "Active");
    const backgroundTab = makeTab("background-tab", backgroundUrl, "Background");
    let closed = false;
    const { controller } = scenario("active-tab", activeUrl, {
      "DELETE /tabs/background-tab": async () => {
        const result = await closing.promise;
        closed = true;
        return result;
      },
      "/tabs/focus": () => ({ ok: true }),
      "/tabs": () => ({ running: true, tabs: closed ? [activeTab] : [activeTab, backgroundTab] }),
      ...captureRoutes((request) =>
        request.body?.targetId === "background-tab" ? backgroundTab : activeTab,
      ),
    });

    const pendingClose = controller.closeTab("background-tab");
    await flushBrowserResponses();
    await controller.selectTab("background-tab");
    closing.resolve({ ok: true });
    await pendingClose;

    expect(closed).toBe(true);
    expect(controller.tabs.map((tab) => tab.id)).toEqual(["active-tab"]);
    expect(controller.activeTargetId).toBe("active-tab");
    expect(controller.view?.url).toBe(activeUrl);
    expect(controller.loading).toBe(false);
  });

  it("captures a successfully navigated document when its tab snapshot fails", async () => {
    stubScreenshotMedia();
    const navigation = createDeferred<{ ok: boolean }>();
    const { controller, request } = scenario("stable-tab", initialUrl, {
      "/navigate": () => navigation.promise,
      "/tabs": () => {
        throw new Error("Temporary tab-list failure");
      },
      ...captureRoutes(() => makeTab("stable-tab", destinationUrl, "Page")),
    });

    const pendingNavigation = controller.openUrl(destinationUrl, { newTab: false });
    await flushBrowserResponses();
    navigation.resolve({ ok: true });
    await pendingNavigation;

    expectRequest(request, {
      method: "POST",
      path: "/screenshot",
      body: expect.objectContaining({ targetId: "stable-tab" }),
    });
    expect(controller.activeTargetId).toBe("stable-tab");
    expect(controller.view?.url).toBe(destinationUrl);
    expect(controller.view?.dataUrl).toContain(btoa("fresh screenshot"));
    expect(controller.loading).toBe(false);
  });

  it.each(["snapshot", "capture"] as const)(
    "settles only unowned loading when closing a background tab during %s",
    async (phase) => {
      const capturing = phase === "capture";
      if (capturing) {
        stubScreenshotMedia();
      }
      const pending = createDeferred<unknown>();
      const activeTab = makeTab("active-tab", activeUrl, "Active");
      let snapshots = 0;
      const { controller, request } = scenario("active-tab", activeUrl, {
        "DELETE /tabs/background-tab": () => ({ ok: true }),
        "/tabs": () => {
          snapshots += 1;
          if (snapshots === 1 && !capturing) {
            return pending.promise;
          }
          return {
            running: true,
            tabs:
              snapshots === 1
                ? [activeTab, makeTab("background-tab", backgroundUrl, "Background")]
                : [activeTab],
          };
        },
        ...(capturing
          ? {
              "/screenshot": () => pending.promise,
              "/act": () => metrics(activeUrl, "Active"),
            }
          : {}),
      });
      const activeView = controller.view;
      if (!capturing) {
        controller.tabs = [
          remoteTab("active-tab", "raw-active", "Active", activeUrl),
          remoteTab("background-tab", "raw-background", "Background", backgroundUrl),
        ];
      }
      const refresh = controller.refreshAll();
      await flushBrowserResponses();
      expect(controller.loading).toBe(true);
      await controller.closeTab("background-tab");
      expect(controller.loading).toBe(capturing);
      if (!capturing) {
        expectRequest(request, { method: "DELETE", path: "/tabs/background-tab" });
        expect(controller.activeTargetId).toBe("active-tab");
        expect(controller.tabs.map((tab) => tab.id)).toEqual(["active-tab"]);
        expect(controller.view).toBe(activeView);
      }
      pending.resolve(
        capturing
          ? { path: "/fresh.png", targetId: "raw-active", url: activeUrl }
          : { running: true, tabs: [activeTab] },
      );
      await refresh;
      expect(controller.loading).toBe(false);
      if (capturing) {
        expect(controller.view?.url).toBe(activeUrl);
        expect(controller.view?.dataUrl).toContain(btoa("fresh screenshot"));
      } else {
        expect(controller.view).toBe(activeView);
      }
    },
  );

  it.each([false, true])(
    "finishes navigation after a passive refresh (new tab: %s)",
    async (newTab) => {
      stubScreenshotMedia();
      const navigation = createDeferred<unknown>();
      const initialTab = makeTab(
        newTab ? "initial-tab" : "stable-tab",
        initialUrl,
        newTab ? "Initial" : "Page",
      );
      const destinationTab = makeTab(
        newTab ? "destination-tab" : "stable-tab",
        destinationUrl,
        newTab ? "Destination" : "Page",
      );
      let visibleTabs = [initialTab];
      let screenshotCount = 0;
      const path = newTab ? "/tabs/open" : "/navigate";
      const { controller, request } = scenario(initialTab.tabId, initialUrl, {
        [path]: async () => {
          const result = await navigation.promise;
          visibleTabs = newTab ? [initialTab, destinationTab] : [destinationTab];
          return result;
        },
        "/tabs": () => ({ running: true, tabs: [...visibleTabs] }),
        ...captureRoutes(
          (envelope) => visibleTabs.find((tab) => tab.tabId === envelope.body?.targetId)!,
          () => {
            screenshotCount += 1;
            return visibleTabs.includes(destinationTab) ? "/fresh.png" : "/old.png";
          },
        ),
      });
      const pendingNavigation = controller.openUrl(destinationUrl, { newTab });
      await flushBrowserResponses();
      await controller.refreshAll();
      navigation.resolve(newTab ? destinationTab : { ok: true });
      await pendingNavigation;

      expectRequest(request, {
        method: "POST",
        path,
        body: newTab ? { url: destinationUrl } : { targetId: "stable-tab", url: destinationUrl },
      });
      expect(controller.activeTargetId).toBe(destinationTab.tabId);
      if (newTab) {
        expect(controller.tabs.map((tab) => tab.id)).toEqual(["initial-tab", "destination-tab"]);
      } else {
        expect(controller.tabs[0]?.url).toBe(destinationUrl);
      }
      expect(controller.view?.url).toBe(destinationUrl);
      expect(controller.view?.dataUrl).toContain(btoa("fresh screenshot"));
      expect(screenshotCount).toBe(2);
      expect(controller.loading).toBe(false);
    },
  );

  it("does not poll tab metadata after a committed background navigation", async () => {
    stubScreenshotMedia();
    const navigation = createDeferred<{ ok: boolean }>();
    const { controller, calls } = scenario("tab-a", initialUrl, {
      "/navigate": () => navigation.promise,
      "/tabs/focus": () => ({ ok: true }),
      ...captureRoutes(
        () => ({ ...makeTab("tab-b", selectedUrl, "Selected"), targetId: "raw-b" }),
        () => "/selected.png",
      ),
    });
    controller.tabs = [
      remoteTab("tab-a", "raw-a", "Initial", initialUrl),
      remoteTab("tab-b", "raw-b", "Selected", selectedUrl),
    ];

    const pendingNavigation = controller.openUrl(destinationUrl, { newTab: false });
    await flushBrowserResponses();
    await controller.selectTab("tab-b");
    navigation.resolve({ ok: true });
    await pendingNavigation;

    expect(controller.activeTargetId).toBe("tab-b");
    expect(controller.view?.targetId).toBe("tab-b");
    expect(controller.view?.url).toBe(selectedUrl);
    expect(controller.tabs.find((tab) => tab.id === "tab-a")).toMatchObject({
      title: "Initial",
      url: initialUrl,
    });
    expect(calls("/tabs")).toEqual([]);
    expect(calls("/screenshot").filter((request) => request.body?.targetId === "tab-a")).toEqual(
      [],
    );
  });

  it("clears stale inspected elements and owned errors across a failed inspection retry", async () => {
    vi.useFakeTimers({ now: 1_000 });
    let inspections = 0;
    const initialNode = createInspectedNode("initial");
    const recoveredNode = createInspectedNode("recovered");
    const { client } = createBrowserClient(async () => {
      inspections += 1;
      if (inspections === 2) {
        throw new Error("Browser connection temporarily unavailable");
      }
      return { result: inspections === 1 ? initialNode : recoveredNode };
    });
    const controller = createBrowserPanelTestController(client, "tab-a");
    controller.setMode("inspect");

    controller.handleOverlayPointerMove(createPointer(10, 20));
    await flushBrowserResponses();
    expect(controller.inspected).toEqual(initialNode);

    await vi.advanceTimersByTimeAsync(120);
    controller.handleOverlayPointerMove(createPointer(30, 40));
    expect(controller.inspected).toBeNull();
    await flushBrowserResponses();

    expect(controller.errorText).toBe(
      "Browser request failed: Browser connection temporarily unavailable",
    );
    expect(controller.mode).toBe("inspect");
    expect(controller.evaluateUnavailable).toBe(false);
    expect(controller.inspected).toBeNull();
    const [revision, setRevision] = createSignal(0);
    const { container: renderedPanel } = mountSolid(() =>
      createComponent(BrowserPanelChrome, {
        get controller() {
          revision();
          return controller;
        },
        dock: "right",
        height: 400,
        width: 400,
        onDockChange() {},
        onClose() {},
        embedded: false,
        tabsInHeader: false,
      }),
    );
    flush();
    vi.spyOn(renderedPanel.querySelector(".bp-stage")!, "getBoundingClientRect").mockReturnValue(
      controller.host.renderRoot.firstElementChild!.getBoundingClientRect(),
    );
    expect(renderedPanel.querySelector('[role="alert"]')?.textContent).toBe(
      "Browser request failed: Browser connection temporarily unavailable",
    );

    await vi.advanceTimersByTimeAsync(120);
    controller.handleOverlayPointerMove(createPointer(70, 80));
    await flushBrowserResponses();

    expect(controller.inspected).toEqual(recoveredNode);
    expect(controller.errorText).toBeNull();
    expect(controller.inspectPointer).toEqual({ x: 0.7, y: 0.8 });
    setRevision((value) => value + 1);
    flush();
    expect(renderedPanel.querySelector('[role="alert"]')).toBeNull();
    const inspect = (await openBrowserActions(renderedPanel)).querySelector(
      '[role="menuitem"][aria-label="Inspect element"]',
    );
    expect(inspect).not.toBeNull();
    expect(inspect?.getAttribute("aria-disabled")).not.toBe("true");
  });

  it.each([
    {
      name: "legacy Browser node message without an action code",
      message: "403: act:evaluate is disabled by config (browser.evaluateEnabled=false).",
      details: { nodeError: { message: "legacy Browser node" } },
      expected: true,
    },
    {
      name: "sanitized unknown action code with matching prose",
      message: "act:evaluate is disabled by config (browser.evaluateEnabled=false).",
      details: { unrecognizedCode: true },
      expected: false,
    },
  ])(
    "classifies $name without reinterpreting structured errors",
    async ({ message, details, expected }) => {
      const { client } = createBrowserClient(async () => {
        throw new GatewayRequestError({
          code: "INVALID_REQUEST",
          message,
          details,
        });
      });
      const controller = createBrowserPanelTestController(client, "tab-a");
      controller.setMode("inspect");

      controller.handleOverlayPointerMove(createPointer(10, 20));
      await flushBrowserResponses();

      expect(controller.evaluateUnavailable).toBe(expected);
      expect(controller.mode).toBe(expected ? "interact" : "inspect");
      expect(controller.errorText).toBeTruthy();
      expect(controller.errorText?.includes("Browser request failed")).toBe(!expected);
    },
  );

  it("keeps the newest inspected element when pointer responses finish out of order", async () => {
    vi.useFakeTimers({ now: 1_000 });
    const first = createDeferred<unknown>();
    const second = createDeferred<unknown>();
    const evaluations = [first, second];
    const { controller, request } = scenario("tab-a", undefined, {
      "/act": async (envelope) => {
        expect(envelope.body?.kind).toBe("evaluate");
        const evaluation = evaluations.shift();
        if (!evaluation) {
          throw new Error("Unexpected browser inspection");
        }
        return await evaluation.promise;
      },
    });
    controller.setMode("inspect");

    controller.handleOverlayPointerMove(createPointer(10, 20));
    await vi.advanceTimersByTimeAsync(120);
    controller.handleOverlayPointerMove(createPointer(70, 80));
    expect(request).toHaveBeenCalledTimes(2);

    const latestNode = createInspectedNode("latest");
    second.resolve({ result: latestNode });
    await flushBrowserResponses();
    expect(controller.inspected).toEqual(latestNode);

    first.resolve({ result: createInspectedNode("stale") });
    await flushBrowserResponses();

    expect(controller.inspected).toEqual(latestNode);
    expect(controller.inspectPointer).toEqual({ x: 0.7, y: 0.8 });
  });

  it("inspects the latest pointer after coalescing throttled moves", async () => {
    vi.useFakeTimers({ now: 1_000 });
    const latestInspection = createDeferred<unknown>();
    let inspectionCount = 0;
    const elementFromPoint = vi.fn(() => null);
    const { controller } = scenario("tab-a", undefined, {
      "/act": async (envelope) => {
        if (envelope.body?.kind !== "evaluate") {
          throw new Error("Unexpected browser inspection");
        }
        runInNewContext(`(${String(envelope.body.fn)})()`, { document: { elementFromPoint } });
        inspectionCount += 1;
        if (inspectionCount === 1) {
          return { result: createInspectedNode("initial") };
        }
        return await latestInspection.promise;
      },
    });
    controller.setMode("inspect");

    controller.handleOverlayPointerMove(createPointer(10, 20));
    await flushBrowserResponses();
    controller.handleOverlayPointerMove(createPointer(30, 40));
    controller.handleOverlayPointerMove(createPointer(70, 80));
    expect(inspectionCount).toBe(1);

    await vi.advanceTimersByTimeAsync(120);

    expect(inspectionCount).toBe(2);
    expect(elementFromPoint).toHaveBeenLastCalledWith(70, 80);
    const latestNode = createInspectedNode("latest-coalesced");
    latestInspection.resolve({ result: latestNode });
    await flushBrowserResponses();

    expect(controller.inspected).toEqual(latestNode);
    expect(controller.inspectPointer).toEqual({ x: 0.7, y: 0.8 });
  });

  it.each(["in-flight", "throttled"] as const)(
    "invalidates an old tab's %s inspection after a tab switch",
    async (phase) => {
      vi.useFakeTimers({ now: 1_000 });
      const inspection = createDeferred<unknown>();
      const { controller, calls } = scenario("tab-a", undefined, {
        "/act": () => inspection.promise,
        "/tabs/focus": () => ({ ok: true }),
        "/screenshot": () => new Promise<never>(() => {}),
      });
      controller.setMode("inspect");
      controller.handleOverlayPointerMove(createPointer(10, 20));
      if (phase === "throttled") {
        controller.handleOverlayPointerMove(createPointer(30, 40));
      }
      void controller.selectTab("tab-b");
      controller.view = createView("tab-b");
      controller.setMode("inspect");
      if (phase === "in-flight") {
        inspection.resolve({ result: createInspectedNode("foreign-tab") });
        await flushBrowserResponses();
        expect(controller.activeTargetId).toBe("tab-b");
        expect(controller.inspected).toBeNull();
      } else {
        await vi.advanceTimersByTimeAsync(120);
        const inspections = calls("/act").filter((request) => request.body?.kind === "evaluate");
        expect(inspections).toHaveLength(1);
        expect(inspections[0]).toMatchObject({ body: { targetId: "tab-a" } });
      }
    },
  );

  it("reconciles selected tab metadata from the captured history document", async () => {
    vi.useFakeTimers();
    stubScreenshotMedia();
    const currentUrl = "https://example.test/current";
    const previousUrl = "https://example.test/previous";
    const { controller, calls } = scenario("tab-a", currentUrl, {
      "/act": (envelope) => {
        const fn = typeof envelope.body?.fn === "string" ? envelope.body.fn : "";
        return fn.includes("history.go") ? { result: true } : metrics(previousUrl, "Previous");
      },
      "/screenshot": () => ({ path: "/fresh.png", targetId: "raw-a", url: previousUrl }),
    });
    const background = remoteTab("tab-b", "raw-b", "Background", backgroundUrl);
    const expectedBackground = { ...background };
    controller.tabs = [remoteTab("tab-a", "raw-a", "Current", currentUrl), background];

    controller.goHistory(-1);
    await flushBrowserResponses();
    await vi.advanceTimersByTimeAsync(350);
    await flushBrowserResponses();
    await vi.runAllTimersAsync();
    await flushBrowserResponses();

    expect(controller.tabs).toEqual([
      remoteTab("tab-a", "raw-a", "Previous", previousUrl),
      expectedBackground,
    ]);
    expect(controller.urlDraft).toBe(previousUrl);
    expect(calls("/tabs")).toEqual([]);
  });

  it("scrolls at the remote point under the wheel pointer", async () => {
    vi.useFakeTimers();
    const scroll = vi.fn();
    const hitTest = vi.fn(() => null);
    const { controller, calls } = scenario("tab-a", undefined, {
      "/act": (envelope) => {
        const fn = envelope.body?.fn;
        if (typeof fn !== "string") {
          throw new Error("Expected a browser evaluate script");
        }
        return {
          result: runInNewContext(`(${fn})()`, {
            document: { elementFromPoint: hitTest },
            window: { scrollBy: scroll },
          }),
        };
      },
    });

    controller.input.handleWheel(
      new WheelEvent("wheel", { deltaY: 60, clientX: 30, clientY: 40, cancelable: true }),
    );
    controller.input.handleWheel(
      new WheelEvent("wheel", { deltaY: 40, clientX: 32, clientY: 44, cancelable: true }),
    );
    await vi.advanceTimersByTimeAsync(150);

    expect(calls("/act")).toHaveLength(1);
    expect(hitTest).toHaveBeenCalledExactlyOnceWith(32, 44);
    expect(scroll).toHaveBeenCalledExactlyOnceWith(0, 100);
  });

  it("never forwards a queued wheel action to a newly selected tab", async () => {
    vi.useFakeTimers();
    const { controller, calls } = scenario("tab-a", undefined, {
      "/tabs/focus": () => ({ ok: true }),
      "/screenshot": () => new Promise<never>(() => {}),
      "/act": () => ({ result: true }),
    });

    controller.input.handleWheel(new WheelEvent("wheel", { deltaY: 60, cancelable: true }));
    void controller.selectTab("tab-b");
    await vi.advanceTimersByTimeAsync(150);

    expect(calls("/act")).toEqual([]);
  });

  it("keeps the latest screenshot when same-tab captures finish out of order", async () => {
    stubScreenshotMedia();
    const oldCapture = createDeferred<unknown>();
    const freshCapture = createDeferred<unknown>();
    const captures = [oldCapture, freshCapture];
    const oldStarted = createDeferred();
    const freshStarted = createDeferred();
    const url = "https://example.test/page";
    const { controller, calls } = scenario(
      "tab-a",
      url,
      {
        "/tabs": () => ({
          running: true,
          tabs: [{ tabId: "tab-a", targetId: "raw-a", title: "Page", url }],
        }),
        "/screenshot": async () => {
          const capture = captures.shift();
          if (!capture) {
            throw new Error("Unexpected screenshot capture");
          }
          (capture === oldCapture ? oldStarted : freshStarted).resolve();
          return await capture.promise;
        },
        "/act": () => metrics(url),
      },
      false,
    );

    const oldRefresh = controller.refreshAll();
    await oldStarted.promise;
    const freshRefresh = controller.refreshAll();
    await freshStarted.promise;
    expect(calls("/screenshot")).toHaveLength(2);

    freshCapture.resolve({ path: "/fresh.png", targetId: "raw-a", url });
    await freshRefresh;
    expect(controller.view?.dataUrl).toContain(btoa("fresh screenshot"));

    oldCapture.resolve({ path: "/old.png", targetId: "raw-a", url });
    await oldRefresh;

    expect(controller.view?.dataUrl).toContain(btoa("fresh screenshot"));
    expect(controller.view?.targetId).toBe("tab-a");
  });

  it("does not combine a screenshot with another document's metrics", async () => {
    stubScreenshotMedia();
    const capturedUrl = "https://example.test/captured";
    const navigatedUrl = "https://example.test/navigated";
    const { controller } = scenario(
      "tab-a",
      capturedUrl,
      {
        "/tabs": () => ({
          running: true,
          tabs: [{ tabId: "tab-a", targetId: "raw-a", title: "Captured", url: capturedUrl }],
        }),
        "/screenshot": () => ({ path: "/fresh.png", targetId: "raw-a", url: capturedUrl }),
        "/act": () => ({
          result: { cssWidth: 200, cssHeight: 300, title: "Different document", url: navigatedUrl },
        }),
      },
      false,
    );

    await controller.refreshAll();

    expect(controller.view?.url).toBe(capturedUrl);
    expect(controller.view?.metrics).toBeNull();
  });
});
