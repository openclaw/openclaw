import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../../test/helpers/promise.js";
import type { ApplicationContext } from "../../../app/context.ts";
import {
  createBrowserClient,
  type BrowserRequestEnvelope,
} from "../../../components/browser/browser-panel-controller-test-support.ts";
import {
  createApplicationContextProvider,
  createApplicationGateway,
} from "../../../test-helpers/application-context.ts";
import { gatewayHelloForMethods } from "../../../test-helpers/gateway-methods.ts";
import type { BoardWidget } from "../types.ts";
import "./browser.tsx";

const sessionKey = "agent:main:dashboard-test";
const dashboardIdentity = { sessionKey, name: "status", instanceId: "first" };
const browserMethods = ["browser.request", "browser.dashboard.request"];
function widget(instanceId: string): BoardWidget {
  return {
    name: "status",
    instanceId,
    tabId: "main",
    contentKind: "plugin",
    pluginKind: "browser:dashboard",
    props: { url: "http://status.example" },
    sizeW: 12,
    sizeH: 8,
    position: 0,
    revision: 1,
    grantState: "none",
  };
}
function response(instanceId: string, paused = false, targetId = instanceId) {
  return {
    ...dashboardIdentity,
    instanceId,
    revision: 1,
    paused,
    stopping: false,
    url: "http://status.example",
    ...(paused ? {} : { browserTab: { target: "host", profile: "openclaw", targetId } }),
  };
}
type RequestHandler = Parameters<typeof createBrowserClient>[0];
const dashboard =
  (handle: RequestHandler): RequestHandler =>
  async (envelope) =>
    envelope.path === "/dashboard" ? handle(envelope) : { running: false, tabs: [] };
function mount(
  handle: RequestHandler,
  active = true,
  scopes: readonly string[] = ["operator.admin"],
  advertised: readonly string[] = browserMethods,
) {
  const requests: BrowserRequestEnvelope[] = [];
  const { client, request } = createBrowserClient(
    async (envelope) => {
      requests.push(envelope);
      return await handle(envelope);
    },
    { sessionScoped: !scopes.includes("operator.admin") },
  );
  const { gateway, publish, publishEvent } = createApplicationGateway({
    phase: "connected",
    client,
    hello: gatewayHelloForMethods(advertised, scopes),
    offlineStable: false,
    canvasPluginSurfaceUrl: null,
    assistantAgentId: "main",
    sessionKey,
    lastError: null,
    lastErrorCode: null,
  });
  const provider = createApplicationContextProvider({
    resourceBasePath: "",
    gateway,
  } as unknown as ApplicationContext);
  const element = document.createElement("openclaw-browser-dashboard-widget");
  element.session = { sessionKey };
  element.widget = widget("first");
  element.active = active;
  provider.append(element);
  document.body.append(provider);
  const panel = () => element.querySelector("openclaw-browser-panel");
  return {
    element,
    request,
    requests,
    gateway,
    publish,
    panel,
    button: (text: string) =>
      [...element.querySelectorAll("button")].find((entry) => entry.textContent?.trim() === text),
    changed: (instanceId = "first") =>
      publishEvent({
        type: "event",
        event: "plugin.browser.dashboard_changed",
        payload: { ...dashboardIdentity, instanceId },
      }),
    actions: () => requests.filter((entry) => entry.path === "/dashboard"),
    waitForTarget: (targetId: string) =>
      vi.waitFor(() => expect(panel()?.fixedTab?.targetId).toBe(targetId)),
    waitForText: (text: string) => vi.waitFor(() => expect(element.textContent).toContain(text)),
    waitForPanel: () => vi.waitFor(() => expect(panel()).not.toBeNull()),
  };
}
afterEach(() => document.body.replaceChildren());

describe("Browser dashboard presentation", () => {
  it.each([false, true])("routes dashboard access and transfers for admin=%s", async (admin) => {
    const h = mount(
      dashboard(async () => response("first")),
      true,
      [admin ? "operator.admin" : "operator.sessions.write"],
    );
    await h.waitForPanel();
    const panel = h.panel()!;
    await panel.updateComplete;
    expect(h.request).toHaveBeenCalledWith(
      admin ? "browser.request" : "browser.dashboard.request",
      expect.objectContaining(
        admin
          ? { target: "host", path: "/dashboard" }
          : {
              sessionKey,
              dashboard: { name: "status", instanceId: "first" },
              method: "POST",
              path: "/dashboard",
            },
      ),
      { timeoutMs: 150_000 },
    );
    expect(panel.dashboardTarget?.sessionScoped).toBe(admin ? undefined : true);
    const download = panel.querySelector('[aria-label="Download file"]');
    if (admin) {
      expect(download).not.toBeNull();
    } else {
      expect(download).toBeNull();
      expect(panel.querySelector('[aria-label="New tab"]')).toBeNull();
      expect(h.element.textContent).toContain("isolated session browser");
    }
  });

  it.each([
    [["operator.sessions.read"], ["browser.dashboard.request"]],
    [["operator.write"], ["browser.request"]],
  ])(
    "does not dispatch without scoped write access and advertised capability (%j)",
    async (scopes, methods) => {
      const { element, request } = mount(async () => response("first"), true, scopes, methods);
      await element.updateComplete;
      expect(request).not.toHaveBeenCalled();
      expect(element.textContent).toContain("Connect to a Gateway with browser access");
    },
  );

  it("shows a session admission rejection without falling back to global browser access", async () => {
    const { request, panel, waitForText } = mount(
      async () => {
        throw new Error("Session browser requires a supported sandbox backend");
      },
      true,
      ["operator.write"],
    );
    await waitForText("supported sandbox backend");
    expect(panel()).toBeNull();
    expect(request).toHaveBeenCalledOnce();
    expect(request.mock.calls[0]?.[0]).toBe("browser.dashboard.request");
  });

  it("keeps an unfinished Stop visible until closure is confirmed", async () => {
    let stopping = false;
    let paused = false;
    const { element, requests, changed, button, waitForText } = mount(
      dashboard(async (envelope) => {
        if (envelope.method === "DELETE") {
          stopping = true;
          paused = true;
          changed();
          throw new Error("Temporary browser close failure");
        }
        return { ...response("first", paused), stopping };
      }),
    );
    await vi.waitFor(() => expect(button("Stop browser")).toBeDefined());
    button("Stop browser")!.click();
    await waitForText("Browser stop is pending");
    expect(element.textContent).not.toContain("browser is stopped");
    expect(button("Resume browser")).toBeUndefined();
    button("Retry stop")!.click();
    await vi.waitFor(() =>
      expect(requests.filter((entry) => entry.method === "DELETE")).toHaveLength(2),
    );
    stopping = false;
    changed();
    await waitForText("browser is stopped");
    expect(button("Retry stop")).toBeUndefined();
    expect(button("Resume browser")).toBeDefined();
    expect(requests.filter((entry) => entry.method === "POST")).toHaveLength(1);
  });

  it("observes an agent stop/resume without reopening or replacing the dashboard", async () => {
    const opening = createDeferred<ReturnType<typeof response>>();
    let paused = false;
    let targetId = "first";
    const h = mount(
      dashboard(async (envelope) => {
        if (envelope.method === "POST") {
          return opening.promise;
        }
        return response("first", paused, targetId);
      }),
    );
    await vi.waitFor(() => expect(h.requests).toHaveLength(1));
    paused = true;
    h.changed();
    opening.resolve(response("first"));
    await h.waitForText("browser is stopped");
    expect(h.panel()).toBeNull();
    paused = false;
    targetId = "resumed-target";
    h.changed();
    await h.waitForTarget("resumed-target");
    h.changed("retired-instance");
    await h.element.updateComplete;
    expect(h.actions().map((entry) => entry.method)).toEqual(["POST", "GET", "GET"]);
    expect(h.element.widget?.instanceId).toBe("first");
  });

  it.each(["widget", "client", "auth"] as const)(
    "stays passive until opened and ignores materialization from a retired %s identity",
    async (identity) => {
      const old = createDeferred<ReturnType<typeof response>>();
      const instanceId = identity === "widget" ? "current" : "first";
      let initial = true;
      const h = mount(
        dashboard(async () => {
          if (initial) {
            initial = false;
            return old.promise;
          }
          return response(instanceId, false, "current");
        }),
        false,
      );
      await h.element.updateComplete;
      expect(h.request).not.toHaveBeenCalled();
      h.element.active = true;
      await vi.waitFor(() => expect(h.request).toHaveBeenCalledOnce());
      if (identity === "widget") {
        h.element.widget = widget("current");
      } else if (identity === "client") {
        const replacement = createBrowserClient(
          dashboard(async () => response(instanceId, false, "current")),
        );
        h.publish({ ...h.gateway.snapshot, client: replacement.client });
      } else {
        h.publish({
          ...h.gateway.snapshot,
          hello: gatewayHelloForMethods(browserMethods, ["operator.admin", "operator.read"]),
        });
      }
      await h.waitForTarget("current");
      old.resolve(response("first", false, "retired"));
      await old.promise;
      await vi.dynamicImportSettled();
      await h.element.updateComplete;
      const panel = h.panel()!;
      expect(panel.fixedTab?.targetId).toBe("current");
      expect(panel.dashboardTarget?.instanceId).toBe(instanceId);
      await panel.updateComplete;
      expect(panel.querySelector('[aria-label="New tab"]')).toBeNull();
      expect(panel.querySelector('[aria-label^="Close tab"]')).toBeNull();
    },
  );

  it("reopens a dashboard when inspection finds no live browser tab", async () => {
    let opens = 0;
    const { changed, actions, waitForTarget } = mount(
      dashboard(async (envelope) => {
        if (envelope.method === "GET") {
          return { ...response("first", true), paused: false };
        }
        opens += 1;
        return response("first", false, opens === 1 ? "initial" : "reopened");
      }),
    );
    await waitForTarget("initial");
    changed();
    await waitForTarget("reopened");
    expect(actions().map((entry) => entry.method)).toEqual(["POST", "GET", "POST"]);
  });

  it("hides without closing and stops/resumes through the dashboard owner", async () => {
    const h = mount(dashboard(async (envelope) => response("first", envelope.method === "DELETE")));
    await h.waitForPanel();
    const panel = h.panel();
    h.element.active = false;
    await h.element.updateComplete;
    expect(h.panel()).toBe(panel);
    expect(panel?.presented).toBe(false);
    expect(h.requests.filter((value) => value.method === "DELETE")).toEqual([]);
    h.element.active = true;
    await h.element.updateComplete;
    h.button("Stop browser")!.click();
    await h.waitForText("browser is stopped");
    expect(h.panel()).toBeNull();
    h.button("Resume browser")!.click();
    await h.waitForPanel();
    expect(h.actions().map((value) => value.method)).toEqual(["POST", "DELETE", "POST"]);
    expect(h.actions()[2]?.body).toMatchObject({
      ...dashboardIdentity,
      resume: true,
    });
  });
});
