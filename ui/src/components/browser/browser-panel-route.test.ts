import { getQueriesForElement } from "@solidjs/testing-library";
import { beforeEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { GatewayRequestError } from "../../api/gateway.ts";
import { mountSolid } from "../../test-helpers/mount-solid.ts";
import { waitForSolid } from "../../test-helpers/solid-settle.ts";
import { createStorageMock } from "../../test-helpers/storage.ts";
import { BROWSER_PANEL_TOGGLE_EVENT } from "../panel-toggle-contract.ts";
import {
  createBrowserClient,
  createBrowserPanelTestMetrics as metrics,
  createBrowserPanelTestTab as makeTab,
  flushBrowserResponses as flush,
  stubScreenshotMedia,
  setupBrowserPanelTestCleanup,
  type BrowserRequestEnvelope,
} from "./browser-panel-controller-test-support.ts";
import type { BrowserTabTarget } from "./browser-target.ts";
import "./browser-panel.ts";

const hostTab = { target: "host", profile: "managed", targetId: "t1" } as const;
const nodeTab = { target: "node", node: "node-a", profile: "work", targetId: "t1" } as const;
type Panel = HTMLElementTagNameMap["openclaw-browser-panel"];

const observed = new Map<Element, (width: number, height: number) => void>();
setupBrowserPanelTestCleanup();

beforeEach(() => {
  vi.stubGlobal("localStorage", createStorageMock());
  observed.clear();
  vi.stubGlobal(
    "ResizeObserver",
    class {
      private readonly targets = new Set<Element>();
      constructor(private readonly callback: ResizeObserverCallback) {}
      observe(target: Element) {
        this.targets.add(target);
        observed.set(target, (width, height) =>
          this.callback(
            [
              {
                target,
                contentRect: new DOMRectReadOnly(0, 0, width, height),
                borderBoxSize: [],
                contentBoxSize: [],
                devicePixelContentBoxSize: [],
              },
            ],
            this,
          ),
        );
      }
      unobserve(target: Element) {
        this.targets.delete(target);
        observed.delete(target);
      }
      disconnect() {
        for (const target of this.targets) {
          this.unobserve(target);
        }
      }
    },
  );
  stubScreenshotMedia();
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
});

function pageResponse(request: BrowserRequestEnvelope, url: string, title: string) {
  return request.path === "/act" ? metrics(url, title) : { ok: true };
}

function pageGateway(handle: (request: BrowserRequestEnvelope) => unknown, screencast = false) {
  return browserGateway(handle, true, screencast);
}

function browserGateway(
  handle?: (request: BrowserRequestEnvelope) => unknown,
  single = false,
  screencast = false,
) {
  const browsers = new Map<string, ReturnType<typeof makeTab>[]>();
  return createBrowserClient(
    async (envelope) => {
      if (handle) {
        const response = await handle(envelope);
        if (response !== undefined) {
          return response;
        }
      }
      const profile = envelope.query?.profile ?? (single ? "managed" : "default");
      if (typeof profile !== "string") {
        throw new Error("Expected a string browser profile");
      }
      const url = `https://${profile}.example/`;
      const key = JSON.stringify([envelope.target, envelope.node, profile]);
      let tabs = browsers.get(key);
      if (!tabs) {
        tabs = [makeTab("t1", url, profile), ...(!single ? [makeTab("t2", url, "Other")] : [])];
        browsers.set(key, tabs);
      }
      if (!single && envelope.method === "DELETE") {
        browsers.set(
          key,
          tabs.filter((tab) => `/tabs/${tab.tabId}` !== envelope.path),
        );
        return { ok: true };
      }
      if (envelope.path === "/tabs") {
        return {
          running: true,
          ...(!single ? { canAutoResizeViewport: true } : {}),
          tabs: [...tabs],
        };
      }
      return envelope.path === "/screenshot"
        ? {
            path: single ? "/fresh.png" : `/fresh-${profile}.png`,
            targetId: single ? "raw-t1" : envelope.body?.targetId,
            url,
          }
        : pageResponse(envelope, url, profile);
    },
    { screencast },
  );
}

const disposers = new WeakMap<Panel, () => void>();
async function mountPanel(client: Panel["client"], presented = true) {
  const panel = document.createElement("openclaw-browser-panel");
  panel.embedded = true;
  panel.presented = presented;
  panel.available = true;
  panel.client = client;
  panel.sessionKey = "agent:main:first";
  panel.preferredTab = { tab: hostTab, revision: "first" };
  disposers.set(panel, mountSolid(() => panel).unmount);
  await panel.updateComplete;
  return panel;
}

function chooseCard(panel: Panel, browserTab: BrowserTabTarget) {
  panel.handleToggleRequest(
    new CustomEvent(BROWSER_PANEL_TOGGLE_EVENT, {
      detail: { open: true, browserTab },
    }),
  );
}

function pageTitle(panel: Panel) {
  return panel.querySelector<HTMLImageElement>(".bp-shot")?.alt;
}
const waitForTitle = (panel: Panel, title: string) =>
  waitForSolid(() => expect(pageTitle(panel)).toBe(title));
const reloadButton = (panel: Panel) =>
  panel.querySelector<HTMLButtonElement>('button[aria-label="Reload"]');
const requests = (gateway: ReturnType<typeof createBrowserClient>) =>
  gateway.request.mock.calls.map(([, value]) => value as BrowserRequestEnvelope);
const wheel = () => new WheelEvent("wheel", { deltaY: 60, bubbles: true, cancelable: true });
function expectWheel(target: Element, prevented: boolean) {
  const event = wheel();
  target.dispatchEvent(event);
  expect(event.defaultPrevented).toBe(prevented);
}
async function readyPanel() {
  const gateway = browserGateway();
  const panel = await mountPanel(gateway.client);
  await waitForTitle(panel, "managed");
  return { gateway, panel };
}
function expectRequest(
  gateway: ReturnType<typeof createBrowserClient>,
  request: Partial<BrowserRequestEnvelope>,
) {
  expect(gateway.request).toHaveBeenCalledWith("browser.request", expect.objectContaining(request));
}

it("owns resize observation and wheel interception with the rendered viewport", async () => {
  const { gateway, panel } = await readyPanel();
  const viewport = panel.querySelector<HTMLElement>(".bp-viewport")!;
  expect(observed.has(viewport)).toBe(true);
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  observed.get(viewport)!(640, 480);
  await vi.advanceTimersByTimeAsync(300);
  expectRequest(gateway, {
    body: { kind: "resize", targetId: "t1", width: 640, height: 480 },
  });
  expectWheel(viewport, true);

  panel.available = false;
  await panel.updateComplete;
  expect(panel.querySelector(".bp-viewport")).toBeNull();
  expect(observed.has(viewport)).toBe(false);
  panel.available = true;
  await waitForTitle(panel, "managed");
  const reopenedViewport = panel.querySelector<HTMLElement>(".bp-viewport")!;
  expect(reopenedViewport).not.toBe(viewport);
  expect(observed.has(reopenedViewport)).toBe(true);
  // A retained detached node must not send input to the reopened browser.
  expectWheel(viewport, false);
  expectWheel(reopenedViewport, true);

  panel.remove();
  await waitForSolid(() => expect(observed.has(reopenedViewport)).toBe(false));
  expectWheel(reopenedViewport, false);
  disposers.get(panel)!();
  await waitForSolid(() => expect(panel.querySelector(".bp-shot")).toBeNull());
  gateway.request.mockClear();
  mountSolid(() => panel);
  await waitForTitle(panel, "managed");
  expectRequest(gateway, { path: "/tabs" });
});

it("follows session results once on presentation, keeps card choices, and clears session/gateway ownership", async () => {
  const gateway = browserGateway();
  const focusCount = () =>
    requests(gateway).filter((request) => request.path === "/tabs/focus").length;
  const panel = await mountPanel(gateway.client, false);
  expect(gateway.request).not.toHaveBeenCalled();
  panel.presented = true;
  await waitForTitle(panel, "managed");
  expect(panel.querySelector(".bp-profile")?.textContent).toBe("managed");
  expect(focusCount()).toBe(0);

  chooseCard(panel, nodeTab);
  await waitForTitle(panel, "work");
  const afterClick = focusCount();
  expect(afterClick).toBe(1);
  panel.preferredTab = { tab: { ...hostTab }, revision: "first" };
  await panel.updateComplete;
  expect(focusCount()).toBe(afterClick);
  expect(pageTitle(panel)).toBe("work");

  panel.preferredTab = { tab: hostTab, revision: "second" };
  await waitForTitle(panel, "managed");
  expect(focusCount()).toBe(afterClick);
  panel.selectHostedTab("t2");
  await waitForSolid(() => expect(panel.querySelector(".bp-shot")).not.toBeNull());
  panel.preferredTab = { tab: { ...hostTab }, revision: "second" };
  await panel.updateComplete;
  expect(panel.activeHostedTabId).toBe("t2");

  panel.presented = false;
  panel.preferredTab = { tab: nodeTab, revision: "third" };
  await panel.updateComplete;
  const hiddenCount = gateway.request.mock.calls.length;
  await panel.updateComplete;
  expect(gateway.request).toHaveBeenCalledTimes(hiddenCount);
  panel.presented = true;
  await waitForTitle(panel, "work");

  await panel.closeHostedTab("t1");
  panel.preferredTab = { tab: { ...nodeTab }, revision: "third" };
  await panel.updateComplete;
  expect(panel.activeHostedTabId).toBe("t2");
  expect(panel.hostedTabs.some((tab) => tab.id === "t1")).toBe(false);

  panel.sessionKey = "agent:main:second";
  panel.preferredTab = undefined;
  await waitForTitle(panel, "default");
  expect(panel.querySelector(".bp-profile")).toBeNull();
  panel.sessionKey = "agent:main:first";
  panel.preferredTab = { tab: hostTab, revision: "second" };
  await waitForTitle(panel, "managed");
  gateway.request.mockClear();
  panel.preferredTab = { tab: { ...hostTab, targetId: "raw-t2" }, revision: "raw-target" };
  await waitForSolid(() => expect(panel.activeHostedTabId).toBe("t2"));
  expectRequest(gateway, {
    path: "/screenshot",
    target: "host",
    query: { profile: "managed" },
    body: { targetId: "t2", type: "png" },
  });
  const replacement = browserGateway();
  panel.client = replacement.client;
  panel.preferredTab = undefined;
  await waitForTitle(panel, "default");
});

it("defers a retained panel refresh to its pending card choice", async () => {
  const { gateway, panel } = await readyPanel();
  vi.useFakeTimers();
  observed.get(panel.querySelector(".bp-viewport")!)!(640, 480);
  panel.presented = false;
  await panel.updateComplete;
  const beforePresentation = gateway.request.mock.calls.length;

  panel.refreshOnPresentation = false;
  panel.presented = true;
  await panel.updateComplete;
  expect(gateway.request).toHaveBeenCalledTimes(beforePresentation);

  panel.querySelector(".bp-viewport")!.dispatchEvent(wheel());
  chooseCard(panel, nodeTab);
  panel.refreshOnPresentation = true;
  await waitForTitle(panel, "work");
  observed.get(panel.querySelector(".bp-viewport")!)!(700, 500);
  await vi.advanceTimersByTimeAsync(1_000);
  expect(
    requests(gateway).some((request) => String(request.body?.fn).includes("window.scrollBy")),
  ).toBe(false);
  const routedRequests = requests(gateway).slice(beforePresentation);
  expect(routedRequests.some((request) => request.body?.kind === "resize")).toBe(true);
  for (const request of routedRequests) {
    expect(request).toMatchObject({
      target: "node",
      node: "node-a",
      query: { profile: "work" },
    });
  }
  expect(pageTitle(panel)).toBe("work");
});

it("leaves a stopped browser on its Start affordance instead of focusing a historical tab", async () => {
  let running = false;
  const routedRefresh = createDeferred();
  let pauseRefresh = false;
  const gateway = pageGateway(async (request) => {
    if (request.path === "/tabs") {
      if (pauseRefresh) {
        await routedRefresh.promise;
      }
      if (!running) {
        return { running: false, tabs: [] };
      }
    }
    if (request.path === "/start") {
      running = true;
    }
    return undefined;
  });
  const panel = await mountPanel(gateway.client, false);
  panel.preferredTab = { tab: { ...hostTab, targetId: "dead-target" }, revision: "stale" };
  panel.presented = true;
  const start = () => getQueriesForElement(panel).getByRole("button", { name: "Start browser" });
  await waitForSolid(() => expect(start().textContent?.trim()).toBe("Start browser"));
  await panel.updateComplete;

  const paths = () => requests(gateway).map((request) => request.path);
  expect(paths()).toEqual(["/tabs"]);
  expect(panel.querySelector('[role="alert"]')).toBeNull();
  expect(start().textContent?.trim()).toBe("Start browser");
  const reload = reloadButton(panel);
  expect(reload?.disabled).toBe(true);

  pauseRefresh = true;
  chooseCard(panel, { ...hostTab, targetId: "dead-target" });
  try {
    await panel.updateComplete;
    expect(reload?.disabled).toBe(true);
  } finally {
    routedRefresh.resolve();
  }
  await flush();

  await waitForSolid(() => expect(start().textContent?.trim()).toBe("Start browser"));
  start().click();
  await waitForTitle(panel, "managed");
  expect(paths()).toEqual(expect.arrayContaining(["/start", "/screenshot"]));
  expect(paths()).not.toContain("/tabs/focus");
});

it("rejects a missing historical tab before capture and preserves the prior view", async () => {
  const missingTarget = "missing-history-target";
  const gateway = pageGateway(async (request) => {
    if (request.body?.targetId === missingTarget) {
      throw new GatewayRequestError({
        code: "INVALID_REQUEST",
        message: "tab not found",
      });
    }
    if (request.path === "/screencast") {
      throw new GatewayRequestError({
        code: "INVALID_REQUEST",
        message: "Screencast unavailable",
        details: { code: "SCREENCAST_UNSUPPORTED", reason: "node" },
      });
    }
  }, true);
  const panel = await mountPanel(gateway.client);
  await waitForTitle(panel, "managed");
  const previousSource = panel.querySelector(".bp-shot")?.getAttribute("src");
  vi.useFakeTimers();
  panel.preferredTab = {
    tab: { ...hostTab, targetId: missingTarget },
    revision: "missing-history",
  };
  panel.presented = true;
  await waitForSolid(() => expect(panel.querySelector('[role="alert"]')).not.toBeNull());

  const missingCaptures = () =>
    requests(gateway).filter(
      (request) =>
        request.body?.targetId === missingTarget &&
        (request.path === "/screencast" || request.path === "/screenshot"),
    );
  expect.soft(panel.activeHostedTabId).toBe("t1");
  expect.soft(panel.querySelector(".bp-shot")?.getAttribute("src")).toBe(previousSource);
  expect.soft(panel.querySelector(".bp-viewport")?.getAttribute("aria-busy")).toBe("false");
  expect.soft(missingCaptures()).toEqual([]);
  await vi.advanceTimersByTimeAsync(21_000);
  expect(missingCaptures()).toEqual([]);
});

it("discards an old route capture with the same target id before fetching or evaluating it", async () => {
  const pending = createDeferred<unknown>();
  const gateway = browserGateway(async (request) => {
    if (request.path === "/screenshot" && request.query?.profile === "managed") {
      return pending.promise;
    }
    return undefined;
  });
  const panel = await mountPanel(gateway.client);
  await waitForSolid(() =>
    expect(requests(gateway).some((request) => request.path === "/screenshot")).toBe(true),
  );
  chooseCard(panel, nodeTab);
  await waitForTitle(panel, "work");
  pending.resolve({ path: "/stale.png", targetId: "t1", url: "https://managed.example/" });
  await flush();
  expect(panel.querySelector(".bp-viewport")?.getAttribute("aria-busy")).toBe("false");
  expect(pageTitle(panel)).toBe("work");
  expect(
    vi.mocked(fetch).mock.calls.some(([input]) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      return url.includes("stale");
    }),
  ).toBe(false);
  expect(
    requests(gateway).some(
      (request) => request.path === "/act" && request.query?.profile === "managed",
    ),
  ).toBe(false);
});

it.each(["navigation_blocked", "navigation_check_failed"] as const)(
  "keeps unavailable tabs safe and recoverable: %s",
  async (reason) => {
    const allowedUrl = "https://allowed.example/";
    let blocked = true;
    let tabs = [
      { ...makeTab("t1", "", "Kept title"), urlUnavailableReason: reason },
      ...(reason === "navigation_blocked" ? [makeTab("t2", allowedUrl, "Allowed")] : []),
    ];
    const gateway = createBrowserClient(async (request) => {
      if (request.method === "DELETE") {
        tabs = tabs.filter((tab) => `/tabs/${tab.tabId}` !== request.path);
        return { ok: true };
      }
      if (request.path === "/tabs") {
        return { running: true, tabs: blocked ? tabs : [makeTab("t1", allowedUrl, "Kept title")] };
      }
      if (request.path === "/tabs/focus" && blocked) {
        throw new GatewayRequestError({
          code: "INVALID_REQUEST",
          message: "Tab address is unavailable",
          details: { reason: "navigation_blocked" },
        });
      }
      if (request.path === "/screenshot") {
        return { path: "/fresh.png", url: allowedUrl };
      }
      return pageResponse(request, allowedUrl, blocked ? "Allowed" : "Recovered");
    });
    const panel = await mountPanel(gateway.client, false);
    panel.preferredTab = reason === "navigation_blocked" ? undefined : panel.preferredTab;
    panel.presented = true;
    const status = () => panel.querySelector('.bp-viewport [role="status"]');
    if (reason === "navigation_blocked") {
      await waitForTitle(panel, "Allowed");
      const beforeBlocked = gateway.request.mock.calls.length;
      panel.selectHostedTab("t1");
      await panel.updateComplete;
      expect(status()?.textContent).toContain("Select another tab");
      expect(gateway.request).toHaveBeenCalledTimes(beforeBlocked);
      await panel.closeHostedTab("t1");
      await waitForTitle(panel, "Allowed");
      expect(panel.hostedTabs.map((tab) => tab.id)).toEqual(["t2"]);
    } else {
      await waitForSolid(() => expect(status()?.textContent).toContain("Refresh to try again."));
      expect(panel.textContent).toContain("Kept title");
      expect(panel.querySelector(".bp-shot")).toBeNull();
      expect(
        requests(gateway).some((request) =>
          ["/tabs/focus", "/screenshot", "/act"].includes(request.path),
        ),
      ).toBe(false);
      blocked = false;
      reloadButton(panel)?.click();
      await waitForTitle(panel, "Recovered");
      expect(status()).toBeNull();
    }
  },
);

it.each(["/screenshot", "/act"])(
  "clears a current capture when %s reports a navigation denial",
  async (deniedPath) => {
    const { gateway, panel } = await readyPanel();
    const respond = gateway.request.getMockImplementation()!;
    gateway.request.mockImplementation(async (method, envelope) => {
      if ((envelope as BrowserRequestEnvelope).path === deniedPath) {
        throw new GatewayRequestError({
          code: "UNAVAILABLE",
          message: "Navigation blocked",
          details: { reason: "navigation_blocked" },
        });
      }
      return await respond(method, envelope);
    });
    reloadButton(panel)!.click();
    await waitForSolid(() =>
      expect(panel.querySelector('.bp-viewport [role="status"]')).not.toBeNull(),
    );
    expect(panel.querySelector(".bp-shot")).toBeNull();
    expect(panel.querySelector('.bp-viewport [role="status"]')?.textContent).toContain(
      "Select another tab",
    );
    expect(panel.querySelector<HTMLInputElement>(".bp-url")?.value).toBe("");
    expect(panel.hostedTabs[0]?.url).toBe("");
  },
);
