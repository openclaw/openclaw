import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { GatewayRequestError } from "../../api/gateway.ts";
import { mountSolid } from "../../test-helpers/mount-solid.ts";
import { waitForSolid } from "../../test-helpers/solid-settle.ts";
import { createStorageMock } from "../../test-helpers/storage.ts";
import { BROWSER_PANEL_TOGGLE_EVENT } from "../panel-toggle-contract.ts";
import {
  createBrowserClient,
  createBrowserPanelTestMetrics,
  createBrowserPanelTestTab,
  flushBrowserResponses,
  stubScreenshotMedia,
  type BrowserRequestEnvelope,
} from "./browser-panel-controller-test-support.ts";
import type { BrowserPanel } from "./browser-panel-owner.ts";
import type { BrowserTabTarget } from "./browser-target.ts";
import "./browser-panel.ts";

const hostTab = { target: "host", profile: "managed", targetId: "t1" } as const;
const nodeTab = { target: "node", node: "node-a", profile: "work", targetId: "t1" } as const;
type Panel = HTMLElementTagNameMap["openclaw-browser-panel"];

beforeEach(() => {
  vi.stubGlobal("localStorage", createStorageMock());
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  stubScreenshotMedia();
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
});
afterEach(() => {
  document.body.replaceChildren();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function browserGateway() {
  const browsers = new Map<string, ReturnType<typeof createBrowserPanelTestTab>[]>();
  return createBrowserClient(async (envelope) => {
    const profile = envelope.query?.profile ?? "default";
    if (typeof profile !== "string") {
      throw new Error("Expected a string browser profile");
    }
    const url = `https://${profile}.example/`;
    const key = JSON.stringify([envelope.target, envelope.node, profile]);
    let tabs = browsers.get(key);
    if (!tabs) {
      tabs = [
        createBrowserPanelTestTab("t1", url, profile),
        createBrowserPanelTestTab("t2", url, "Other"),
      ];
      browsers.set(key, tabs);
    }
    if (envelope.method === "DELETE") {
      browsers.set(
        key,
        tabs.filter((tab) => `/tabs/${tab.tabId}` !== envelope.path),
      );
      return { ok: true };
    }
    if (envelope.path === "/tabs") {
      return { running: true, canAutoResizeViewport: true, tabs: [...tabs] };
    }
    if (envelope.path === "/screenshot") {
      return { path: `/fresh-${profile}.png`, targetId: envelope.body?.targetId, url };
    }
    if (envelope.path === "/act") {
      return createBrowserPanelTestMetrics(url, profile);
    }
    if (envelope.path === "/tabs/open") {
      const tab = createBrowserPanelTestTab("t3", url, "New");
      tabs.push(tab);
      return tab;
    }
    return { ok: true };
  });
}

async function mountPanel(client: Panel["client"], presented = true) {
  const panel = document.createElement("openclaw-browser-panel");
  panel.embedded = true;
  panel.presented = presented;
  panel.available = true;
  panel.client = client;
  panel.sessionKey = "agent:main:first";
  panel.preferredTab = { tab: hostTab, revision: "first" };
  mountSolid(() => panel);
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
  return panel.renderRoot?.querySelector<HTMLImageElement>(".bp-shot")?.alt;
}

function controllerFor(panel: Panel): BrowserPanel {
  return (panel as unknown as { browserPanelController: BrowserPanel }).browserPanelController;
}

describe("browser panel route handoff", () => {
  it("owns resize observation and wheel interception with the rendered viewport", async () => {
    const observed = new Map<Element, (width: number, height: number) => void>();
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
    const gateway = browserGateway();
    const panel = await mountPanel(gateway.client);
    await waitForSolid(() => expect(pageTitle(panel)).toBe("managed"));
    const viewport = panel.querySelector<HTMLElement>(".bp-viewport")!;
    expect(observed.has(viewport)).toBe(true);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    observed.get(viewport)!(640, 480);
    await vi.advanceTimersByTimeAsync(300);
    expect(gateway.request).toHaveBeenCalledWith(
      "browser.request",
      expect.objectContaining({
        body: { kind: "resize", targetId: "t1", width: 640, height: 480 },
      }),
    );
    const wheel = () => new WheelEvent("wheel", { deltaY: 60, bubbles: true, cancelable: true });
    const liveWheel = wheel();
    viewport.dispatchEvent(liveWheel);
    expect(liveWheel.defaultPrevented).toBe(true);

    panel.available = false;
    await panel.updateComplete;
    expect(panel.querySelector(".bp-viewport")).toBeNull();
    expect(observed.has(viewport)).toBe(false);
    panel.available = true;
    await waitForSolid(() => expect(pageTitle(panel)).toBe("managed"));
    const reopenedViewport = panel.querySelector<HTMLElement>(".bp-viewport")!;
    expect(reopenedViewport).not.toBe(viewport);
    expect(observed.has(reopenedViewport)).toBe(true);
    // A retained detached node must not send input to the reopened browser.
    const retiredWheel = wheel();
    viewport.dispatchEvent(retiredWheel);
    expect(retiredWheel.defaultPrevented).toBe(false);
    const reopenedWheel = wheel();
    reopenedViewport.dispatchEvent(reopenedWheel);
    expect(reopenedWheel.defaultPrevented).toBe(true);

    panel.remove();
    await waitForSolid(() => expect(observed.has(reopenedViewport)).toBe(false));
    const detachedWheel = wheel();
    reopenedViewport.dispatchEvent(detachedWheel);
    expect(detachedWheel.defaultPrevented).toBe(false);
  });

  it("follows session results once on presentation, keeps card choices, and clears session/gateway ownership", async () => {
    const gateway = browserGateway();
    const focusCount = () =>
      gateway.request.mock.calls.filter(
        ([, value]) => (value as BrowserRequestEnvelope).path === "/tabs/focus",
      ).length;
    const panel = await mountPanel(gateway.client, false);
    expect(gateway.request).not.toHaveBeenCalled();
    panel.presented = true;
    await waitForSolid(() => expect(pageTitle(panel)).toBe("managed"));
    expect(panel.renderRoot?.querySelector(".bp-profile")?.textContent).toBe("managed");
    expect(focusCount()).toBe(0);

    chooseCard(panel, nodeTab);
    await waitForSolid(() => expect(pageTitle(panel)).toBe("work"));
    const afterClick = focusCount();
    expect(afterClick).toBe(1);
    panel.preferredTab = { tab: { ...hostTab }, revision: "first" };
    panel.requestUpdate();
    await panel.updateComplete;
    expect(focusCount()).toBe(afterClick);
    expect(pageTitle(panel)).toBe("work");

    panel.preferredTab = { tab: hostTab, revision: "second" };
    await waitForSolid(() => expect(pageTitle(panel)).toBe("managed"));
    expect(focusCount()).toBe(afterClick);
    await controllerFor(panel).selectTab("t2");
    panel.preferredTab = { tab: { ...hostTab }, revision: "second" };
    await panel.updateComplete;
    expect(controllerFor(panel).activeTargetId).toBe("t2");

    panel.presented = false;
    panel.preferredTab = { tab: nodeTab, revision: "third" };
    await panel.updateComplete;
    const hiddenCount = gateway.request.mock.calls.length;
    panel.requestUpdate();
    await panel.updateComplete;
    expect(gateway.request).toHaveBeenCalledTimes(hiddenCount);
    panel.presented = true;
    await waitForSolid(() => expect(pageTitle(panel)).toBe("work"));

    await controllerFor(panel).closeTab("t1");
    panel.preferredTab = { tab: { ...nodeTab }, revision: "third" };
    await panel.updateComplete;
    expect(controllerFor(panel).activeTargetId).toBe("t2");
    expect(controllerFor(panel).tabs.some((tab) => tab.id === "t1")).toBe(false);

    panel.sessionKey = "agent:main:second";
    panel.preferredTab = undefined;
    await waitForSolid(() => expect(pageTitle(panel)).toBe("default"));
    expect(panel.renderRoot?.querySelector(".bp-profile")).toBeNull();
    panel.sessionKey = "agent:main:first";
    panel.preferredTab = { tab: hostTab, revision: "second" };
    await waitForSolid(() => expect(pageTitle(panel)).toBe("managed"));
    const replacement = browserGateway();
    panel.client = replacement.client;
    panel.preferredTab = undefined;
    await waitForSolid(() => expect(pageTitle(panel)).toBe("default"));
    expect(
      [...gateway.request.mock.calls, ...replacement.request.mock.calls].every(
        ([method]) => method === "browser.request",
      ),
    ).toBe(true);
  });

  it("defers a retained panel refresh to its pending card choice", async () => {
    const gateway = browserGateway();
    const panel = await mountPanel(gateway.client);
    await waitForSolid(() => expect(pageTitle(panel)).toBe("managed"));
    vi.useFakeTimers();
    const controller = controllerFor(panel);
    controller.handleViewportResize(640, 480);
    panel.presented = false;
    await panel.updateComplete;
    const beforePresentation = gateway.request.mock.calls.length;

    // The current preference was already consumed; reopening must also defer
    // the fallback refresh while the pane is handing off an explicit card.
    panel.refreshOnPresentation = false;
    panel.presented = true;
    await panel.updateComplete;
    expect(gateway.request).toHaveBeenCalledTimes(beforePresentation);

    chooseCard(panel, nodeTab);
    panel.refreshOnPresentation = true;
    await waitForSolid(() => expect(pageTitle(panel)).toBe("work"));
    controller.handleViewportResize(700, 500);
    await vi.advanceTimersByTimeAsync(1_000);
    const requests = gateway.request.mock.calls
      .slice(beforePresentation)
      .map(([, value]) => value as BrowserRequestEnvelope);
    expect(requests.some((request) => request.body?.kind === "resize")).toBe(true);
    for (const request of requests) {
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
    const gateway = createBrowserClient(async (request) => {
      if (request.path === "/tabs") {
        if (pauseRefresh) {
          await routedRefresh.promise;
        }
        return running
          ? {
              running: true,
              tabs: [createBrowserPanelTestTab("t1", "https://managed.example/", "managed")],
            }
          : { running: false, tabs: [] };
      }
      if (request.path === "/start") {
        running = true;
        return { ok: true };
      }
      if (request.path === "/screenshot") {
        return { path: "/fresh.png", targetId: "raw-t1", url: "https://managed.example/" };
      }
      if (request.path === "/act") {
        return createBrowserPanelTestMetrics("https://managed.example/", "managed");
      }
      return { ok: true };
    });
    const panel = await mountPanel(gateway.client, false);
    panel.preferredTab = { tab: { ...hostTab, targetId: "dead-target" }, revision: "stale" };
    panel.presented = true;
    await waitForSolid(() => expect(controllerFor(panel).running).toBe(false));
    await panel.updateComplete;

    const paths = () =>
      gateway.request.mock.calls.map(([, value]) => (value as BrowserRequestEnvelope).path);
    expect(paths()).toEqual(["/tabs"]);
    expect(controllerFor(panel).errorText).toBeNull();
    const start = panel.renderRoot?.querySelector<HTMLButtonElement>(".bp-btn");
    expect(start?.textContent?.trim()).toBe("Start browser");
    const reload = panel.renderRoot?.querySelector<HTMLButtonElement>(
      'button[aria-label="Reload"]',
    );
    expect(reload?.disabled).toBe(true);

    pauseRefresh = true;
    chooseCard(panel, { ...hostTab, targetId: "dead-target" });
    try {
      await panel.updateComplete;
      expect(reload?.disabled).toBe(true);
    } finally {
      routedRefresh.resolve();
    }
    await flushBrowserResponses();

    start?.click();
    await waitForSolid(() => expect(pageTitle(panel)).toBe("managed"));
    expect(paths()).toEqual(expect.arrayContaining(["/start", "/screenshot"]));
    expect(paths()).not.toContain("/tabs/focus");
  });

  it("rejects a missing historical tab before capture and preserves the prior view", async () => {
    const missingTarget = "missing-history-target";
    const gateway = createBrowserClient(
      async (request) => {
        if (request.path === "/tabs") {
          return {
            running: true,
            tabs: [createBrowserPanelTestTab("t1", "https://managed.example/", "managed")],
          };
        }
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
        if (request.path === "/screenshot") {
          return { path: "/fresh.png", targetId: "raw-t1", url: "https://managed.example/" };
        }
        if (request.path === "/act") {
          return createBrowserPanelTestMetrics("https://managed.example/", "managed");
        }
        return { ok: true };
      },
      { screencast: true },
    );
    const panel = await mountPanel(gateway.client);
    await waitForSolid(() => expect(pageTitle(panel)).toBe("managed"));
    const controller = controllerFor(panel);
    const previousView = controller.view;
    vi.useFakeTimers();
    panel.preferredTab = {
      tab: { ...hostTab, targetId: missingTarget },
      revision: "missing-history",
    };
    panel.presented = true;
    await waitForSolid(() => expect(controller.errorText).toBeTruthy());

    const missingCaptures = () =>
      gateway.request.mock.calls
        .map(([, value]) => value as BrowserRequestEnvelope)
        .filter(
          (request) =>
            request.body?.targetId === missingTarget &&
            (request.path === "/screencast" || request.path === "/screenshot"),
        );
    expect.soft(controller.activeTargetId).toBe("t1");
    expect.soft(controller.view).toBe(previousView);
    expect.soft(controller.loading).toBe(false);
    expect.soft(missingCaptures()).toEqual([]);
    await vi.advanceTimersByTimeAsync(21_000);
    expect(missingCaptures()).toEqual([]);
  });

  it("keeps a raw target selection when its stable tab alias is not the first tab", async () => {
    const gateway = browserGateway();
    const panel = await mountPanel(gateway.client, false);
    panel.preferredTab = { tab: { ...hostTab, targetId: "raw-t2" }, revision: "raw-target" };
    panel.presented = true;

    await waitForSolid(() => expect(controllerFor(panel).activeTargetId).toBe("t2"));
    expect(gateway.request).toHaveBeenCalledWith(
      "browser.request",
      expect.objectContaining({
        path: "/screenshot",
        target: "host",
        query: { profile: "managed" },
        body: { targetId: "t2", type: "png" },
      }),
    );
  });

  it("drops queued input when a card changes the browser route", async () => {
    const gateway = browserGateway();
    const panel = await mountPanel(gateway.client);
    await waitForSolid(() => expect(pageTitle(panel)).toBe("managed"));
    vi.useFakeTimers();
    controllerFor(panel).input.handleWheel(
      new WheelEvent("wheel", { deltaY: 60, cancelable: true }),
    );
    chooseCard(panel, nodeTab);
    await vi.advanceTimersByTimeAsync(150);
    expect(
      gateway.request.mock.calls.some(([, value]) =>
        String((value as BrowserRequestEnvelope).body?.fn).includes("window.scrollBy"),
      ),
    ).toBe(false);
    expect(gateway.request).toHaveBeenCalledWith(
      "browser.request",
      expect.objectContaining({
        path: "/tabs/focus",
        target: "node",
        node: "node-a",
        query: { profile: "work" },
      }),
    );
  });

  it("discards an old route capture with the same target id before fetching or evaluating it", async () => {
    const pending = createDeferred<unknown>();
    const gateway = browserGateway();
    const respond = gateway.request.getMockImplementation()!;
    gateway.request.mockImplementation(async (method, envelope) => {
      const value = envelope as BrowserRequestEnvelope;
      if (value.path === "/screenshot" && value.query?.profile === "managed") {
        return await pending.promise;
      }
      return await respond(method, envelope);
    });
    const panel = await mountPanel(gateway.client);
    await waitForSolid(() =>
      expect(
        gateway.request.mock.calls.some(
          ([, value]) => (value as BrowserRequestEnvelope).path === "/screenshot",
        ),
      ).toBe(true),
    );
    chooseCard(panel, nodeTab);
    await waitForSolid(() => expect(pageTitle(panel)).toBe("work"));
    pending.resolve({ path: "/stale.png", targetId: "t1", url: "https://managed.example/" });
    await flushBrowserResponses();
    expect(controllerFor(panel).loading).toBe(false);
    expect(pageTitle(panel)).toBe("work");
    expect(
      vi.mocked(fetch).mock.calls.some(([input]) => {
        const url =
          typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        return url.includes("stale");
      }),
    ).toBe(false);
    expect(
      gateway.request.mock.calls.some(([, value]) => {
        const request = value as BrowserRequestEnvelope;
        return request.path === "/act" && request.query?.profile === "managed";
      }),
    ).toBe(false);
  });

  it("prefers a usable default but keeps an explicitly selected blocked tab closable", async () => {
    let tabs = [
      {
        ...createBrowserPanelTestTab("t1", "", "Blocked"),
        urlUnavailableReason: "navigation_blocked",
      },
      createBrowserPanelTestTab("t2", "https://allowed.example/", "Allowed"),
    ];
    const gateway = createBrowserClient(async (request) => {
      if (request.method === "DELETE") {
        tabs = tabs.filter((tab) => `/tabs/${tab.tabId}` !== request.path);
        return { ok: true };
      }
      if (request.path === "/tabs") {
        return { running: true, tabs };
      }
      if (request.path === "/screenshot") {
        return { path: "/fresh.png", url: "https://allowed.example/" };
      }
      return createBrowserPanelTestMetrics("https://allowed.example/", "Allowed");
    });
    const panel = await mountPanel(gateway.client, false);
    panel.preferredTab = undefined;
    panel.presented = true;
    await waitForSolid(() => expect(pageTitle(panel)).toBe("Allowed"));
    const beforeBlocked = gateway.request.mock.calls.length;
    await controllerFor(panel).selectTab("t1");
    await panel.updateComplete;
    expect(panel.renderRoot?.querySelector(".bp-status")?.textContent).toContain(
      "Select another tab",
    );
    expect(gateway.request).toHaveBeenCalledTimes(beforeBlocked);
    await controllerFor(panel).closeTab("t1");
    await waitForSolid(() => expect(pageTitle(panel)).toBe("Allowed"));
    expect(controllerFor(panel).tabs.map((tab) => tab.id)).toEqual(["t2"]);
  });

  it.each(["/screenshot", "/act"])(
    "clears a current capture when %s reports a navigation denial",
    async (deniedPath) => {
      const gateway = browserGateway();
      const panel = await mountPanel(gateway.client);
      await waitForSolid(() => expect(pageTitle(panel)).toBe("managed"));
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
      await controllerFor(panel).refreshAll();
      await panel.updateComplete;
      expect(panel.renderRoot?.querySelector(".bp-shot")).toBeNull();
      expect(panel.renderRoot?.querySelector(".bp-status")?.textContent).toContain(
        "Select another tab",
      );
      expect(controllerFor(panel).urlDraft).toBe("");
      expect(controllerFor(panel).tabs[0]?.url).toBe("");
    },
  );

  it("shows navigation_check_failed without capture and recovers after refresh", async () => {
    let blocked = true;
    const gateway = createBrowserClient(async (request) => {
      if (request.path === "/tabs") {
        return {
          running: true,
          tabs: [
            {
              ...createBrowserPanelTestTab(
                "t1",
                blocked ? "" : "https://allowed.example/",
                "Kept title",
              ),
              ...(blocked ? { urlUnavailableReason: "navigation_check_failed" } : {}),
            },
          ],
        };
      }
      if (request.path === "/tabs/focus" && blocked) {
        throw new GatewayRequestError({
          code: "INVALID_REQUEST",
          message: "Tab address is unavailable",
          details: { reason: "navigation_blocked" },
        });
      }
      if (request.path === "/screenshot") {
        return { path: "/fresh.png", url: "https://allowed.example/" };
      }
      if (request.path === "/act") {
        return createBrowserPanelTestMetrics("https://allowed.example/", "Recovered");
      }
      return { ok: true };
    });
    const panel = await mountPanel(gateway.client);
    await waitForSolid(() =>
      expect(panel.renderRoot?.querySelector(".bp-status")?.textContent).toContain(
        "Refresh to try again.",
      ),
    );
    expect(panel.renderRoot?.textContent).toContain("Kept title");
    expect(panel.renderRoot?.querySelector(".bp-shot")).toBeNull();
    expect(
      gateway.request.mock.calls.some(([, value]) =>
        ["/tabs/focus", "/screenshot", "/act"].includes((value as BrowserRequestEnvelope).path),
      ),
    ).toBe(false);
    blocked = false;
    panel.renderRoot?.querySelector<HTMLButtonElement>('button[aria-label="Reload"]')?.click();
    await waitForSolid(() => expect(pageTitle(panel)).toBe("Recovered"));
    expect(controllerFor(panel).tabs[0]?.urlUnavailableReason).toBeUndefined();
    expect(panel.renderRoot?.querySelector(".bp-status")).toBeNull();
  });
});
