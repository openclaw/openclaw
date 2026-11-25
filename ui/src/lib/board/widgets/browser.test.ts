import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../../test/helpers/promise.js";
import type { ApplicationContext } from "../../../app/context.ts";
import {
  createBrowserClient,
  openBrowserActions,
} from "../../../components/browser/browser-panel-controller-test-support.ts";
import { createApplicationGatewaySnapshot } from "../../../test-helpers/application-context-fixtures.ts";
import {
  createApplicationContextProvider,
  createApplicationGateway,
} from "../../../test-helpers/application-context.ts";
import { gatewayHelloForMethods } from "../../../test-helpers/gateway-methods.ts";
import { createBoardWidget } from "../widget.test-support.ts";
import "./browser.tsx";

const sessionKey = "agent:main:dashboard-test";
const dashboardIdentity = { sessionKey, name: "status", instanceId: "first" };
const browserMethods = ["browser.request", "browser.dashboard.request"];
const widget = (instanceId: string) => createBoardWidget({ name: "status", instanceId });
function response(instanceId = "first", paused = false, targetId = instanceId) {
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
function mount(
  handle: RequestHandler,
  active = true,
  scopes: readonly string[] = ["operator.admin"],
  advertised: readonly string[] = browserMethods,
) {
  const handler = vi.fn(handle);
  const { client, request } = createBrowserClient(handler, {
    sessionScoped: !scopes.includes("operator.admin"),
  });
  const { gateway, publish, publishEvent } = createApplicationGateway(
    createApplicationGatewaySnapshot({
      phase: "connected",
      client,
      hello: gatewayHelloForMethods(advertised, scopes),
      assistantAgentId: "main",
      sessionKey,
    }),
  );
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
  const actions = () =>
    handler.mock.calls.map(([entry]) => entry).filter((entry) => entry.path === "/dashboard");
  return {
    element,
    request,
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
    actions,
    methods: () => actions().map((entry) => entry.method),
    waitForMethods: (methods: string[]) =>
      vi.waitFor(() => expect(actions().map((entry) => entry.method)).toEqual(methods)),
    waitForTarget: (targetId: string) =>
      vi.waitFor(() => expect(panel()?.fixedTab?.targetId).toBe(targetId)),
    waitForText: (text: string, present = true) =>
      vi.waitFor(() => expect(element.textContent?.includes(text)).toBe(present)),
    waitForPanel: () => vi.waitFor(() => expect(panel()).not.toBeNull()),
  };
}
const dashboard =
  (handle: RequestHandler): RequestHandler =>
  async (envelope) =>
    envelope.path === "/dashboard" ? handle(envelope) : { running: false, tabs: [] };
const mountDashboard = (
  handle: RequestHandler,
  ...options: [active?: boolean, scopes?: readonly string[], advertised?: readonly string[]]
) => mount(dashboard(handle), ...options);
afterEach(() => document.body.replaceChildren());

describe("Browser dashboard presentation", () => {
  it.each([false, true])("routes dashboard access and transfers for admin=%s", async (admin) => {
    const h = mountDashboard(async () => response(), true, [
      admin ? "operator.admin" : "operator.sessions.write",
    ]);
    await h.waitForPanel();
    const panel = h.panel()!;
    await panel.updateComplete;
    expect(h.request.mock.calls[0]?.[0]).toBe(browserMethods[admin ? 0 : 1]);
    expect(panel.dashboardTarget?.sessionScoped).toBe(admin ? undefined : true);
    expect(panel.dashboardTarget?.instanceId).toBe("first");
    expect(panel.querySelector('[aria-label="New tab"], [aria-label^="Close tab"]')).toBeNull();
    const menu = await openBrowserActions(panel);
    const download = menu.querySelector('[role="menuitem"][aria-label="Download file"]');
    expect(download === null).toBe(!admin);
    if (!admin) {
      expect(menu.querySelector('[role="menuitem"][aria-label="New tab"]')).toBeNull();
      expect(h.element.textContent).toContain("isolated session browser");
    }
  });

  it.each([
    [["operator.sessions.read"], ["browser.dashboard.request"]],
    [["operator.write"], ["browser.request"]],
  ])("rejects unavailable browser access (%j)", async (scopes, methods) => {
    const { element, request } = mount(async () => response(), true, scopes, methods);
    await element.updateComplete;
    expect(request).not.toHaveBeenCalled();
    expect(element.textContent).toContain("Connect to a Gateway with browser access");
  });

  it("retries session admission without global fallback", async () => {
    const retrying = createDeferred<ReturnType<typeof response>>();
    const handler = vi
      .fn<RequestHandler>()
      .mockRejectedValueOnce(new Error("Session browser requires a supported sandbox backend"))
      .mockReturnValue(retrying.promise);
    const h = mount(handler, true, ["operator.write"]);
    await h.waitForText("supported sandbox backend");
    expect(h.panel()).toBeNull();
    expect(h.request).toHaveBeenCalledOnce();
    h.button("Retry")!.click();
    await vi.waitFor(() => expect(h.request).toHaveBeenCalledTimes(2));
    await h.waitForText("supported sandbox backend", false);
    expect(h.panel()).toBeNull();
    expect(h.request.mock.calls.map(([method]) => method)).toEqual([
      "browser.dashboard.request",
      "browser.dashboard.request",
    ]);
    retrying.resolve(response());
    await h.waitForPanel();
  });

  it.each(["DELETE", "GET"] as const)("keeps the panel through failed %s", async (method) => {
    const pending = createDeferred<ReturnType<typeof response>>();
    const retrying = createDeferred<ReturnType<typeof response>>();
    let attempts = 0;
    const h = mountDashboard(async (envelope) => {
      if (envelope.method === method) {
        return ++attempts === 1 ? pending.promise : retrying.promise;
      }
      return response();
    });
    await h.waitForPanel();
    const panel = h.panel();
    if (method === "DELETE") {
      h.element.active = false;
      await h.element.updateComplete;
      expect(h.panel()).toBe(panel);
      expect(panel?.presented).toBe(false);
      expect(h.methods()).toEqual(["POST"]);
      h.element.active = true;
      await h.element.updateComplete;
      h.button("Stop browser")!.click();
      await vi.waitFor(() => expect(h.button("Stop browser")?.disabled).toBe(true));
    } else {
      h.changed();
      await h.waitForMethods(["POST", "GET"]);
      h.element.active = false;
      await vi.waitFor(() => expect(panel?.presented).toBe(false));
    }
    expect(h.panel()).toBe(panel);

    pending.reject(new Error("Browser request failed"));
    await h.waitForText("Browser request failed");
    expect(h.panel()).toBe(panel);
    if (method === "GET") {
      expect(panel?.presented).toBe(false);
      expect(h.methods()).toEqual(["POST", "GET"]);
      return;
    }
    await vi.waitFor(() => expect(h.button("Stop browser")?.disabled).toBe(false));
    h.button("Stop browser")!.click();
    await vi.waitFor(() => expect(attempts).toBe(2));
    await h.waitForText("Browser request failed", false);
    expect(h.button("Stop browser")?.disabled).toBe(true);
    retrying.resolve(response("first", true));
    await h.waitForText("browser is stopped");
    expect(h.element.textContent).not.toContain("Browser request failed");
    expect(h.panel()).toBeNull();
    h.button("Resume browser")!.click();
    await h.waitForPanel();
    expect(h.methods()).toEqual(["POST", "DELETE", "DELETE", "POST"]);
    expect(h.actions().at(-1)?.body).toMatchObject({ ...dashboardIdentity, resume: true });
  });

  it("keeps an unfinished Stop visible until closure is confirmed", async () => {
    let state = response();
    const { element, methods, changed, button, waitForText } = mountDashboard(async (envelope) => {
      if (envelope.method === "DELETE") {
        state = { ...response("first", true), stopping: true };
        changed();
        throw new Error("Temporary browser close failure");
      }
      return state;
    });
    await vi.waitFor(() => expect(button("Stop browser")).toBeDefined());
    button("Stop browser")!.click();
    await waitForText("Browser stop is pending");
    expect(element.textContent).not.toContain("browser is stopped");
    expect(button("Resume browser")).toBeUndefined();
    button("Retry stop")!.click();
    await vi.waitFor(() =>
      expect(methods().filter((method) => method === "DELETE")).toHaveLength(2),
    );
    state.stopping = false;
    changed();
    await waitForText("browser is stopped");
    expect(button("Retry stop")).toBeUndefined();
    expect(button("Resume browser")).toBeDefined();
    expect(methods().filter((method) => method === "POST")).toHaveLength(1);
  });

  it("observes agent stop/resume and reopens only a missing browser tab", async () => {
    const opening = createDeferred<ReturnType<typeof response>>();
    let paused = false;
    let targetId: string | undefined = "first";
    let opens = 0;
    const h = mountDashboard(async (envelope) => {
      if (envelope.method === "POST") {
        return ++opens === 1 ? opening.promise : response("first", false, "reopened");
      }
      const result = response("first", paused, targetId);
      return targetId ? result : { ...result, browserTab: undefined };
    });
    await h.waitForText("Loading page…");
    expect(h.button("Reconnect")?.disabled).toBe(true);
    paused = true;
    h.changed();
    opening.resolve(response());
    await h.waitForText("browser is stopped");
    expect(h.panel()).toBeNull();
    paused = false;
    targetId = "resumed-target";
    h.changed();
    await h.waitForTarget("resumed-target");
    h.changed("retired-instance");
    await h.element.updateComplete;
    expect(h.methods()).toEqual(["POST", "GET", "GET"]);
    targetId = undefined;
    h.changed();
    await h.waitForTarget("reopened");
    expect(h.methods()).toEqual(["POST", "GET", "GET", "GET", "POST"]);
  });

  it.each(["widget", "client", "auth", "command"] as const)(
    "retires %s results",
    async (identity) => {
      const old = createDeferred<ReturnType<typeof response>>();
      const replacedWidget = identity === "widget" || identity === "command";
      const instanceId = replacedWidget ? "current" : "first";
      const handle = vi
        .fn<RequestHandler>()
        .mockResolvedValue(response(instanceId, false, "current"));
      if (identity === "command") {
        handle.mockResolvedValueOnce(response());
      }
      handle.mockReturnValueOnce(old.promise);
      const h = mountDashboard(handle, false);
      await h.element.updateComplete;
      expect(h.request).not.toHaveBeenCalled();
      h.element.active = true;
      await h.waitForMethods(["POST"]);
      if (identity === "command") {
        await h.waitForTarget("first");
        h.button("Stop browser")!.click();
        await h.waitForMethods(["POST", "DELETE"]);
      }
      if (replacedWidget) {
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
      old.resolve(response("first", identity === "command", "retired"));
      await old.promise;
      await vi.dynamicImportSettled();
      await h.element.updateComplete;
      const panel = h.panel()!;
      expect(panel.fixedTab?.targetId).toBe("current");
      expect(panel.dashboardTarget?.instanceId).toBe(instanceId);
    },
  );
});
