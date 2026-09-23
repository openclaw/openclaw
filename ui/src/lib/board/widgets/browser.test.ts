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
import "./browser.ts";

const sessionKey = "agent:main:dashboard-test";
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
function response(instanceId: string, paused = false) {
  return {
    sessionKey,
    name: "status",
    instanceId,
    revision: 1,
    paused,
    stopping: false,
    url: "http://status.example",
    ...(paused
      ? {}
      : {
          browserTab: { target: "host", profile: "openclaw", targetId: instanceId },
        }),
  };
}
function mount(handle: Parameters<typeof createBrowserClient>[0], active = true) {
  const requests: BrowserRequestEnvelope[] = [];
  const { client, request } = createBrowserClient(async (envelope) => {
    requests.push(envelope);
    return await handle(envelope);
  });
  const { gateway, publishEvent } = createApplicationGateway({
    phase: "connected",
    client,
    hello: gatewayHelloForMethods(["browser.request"]),
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
  return { element, request, requests, publishEvent };
}
afterEach(() => document.body.replaceChildren());

describe("Browser dashboard presentation", () => {
  it.each(["user", "agent"] as const)(
    "keeps an unfinished %s Stop visible until closure is confirmed",
    async (initiator) => {
      let stopping = false;
      let paused = false;
      let changed = () => {};
      const { element, requests, publishEvent } = mount(async (envelope) => {
        if (envelope.path !== "/dashboard") {
          return { running: false, tabs: [] };
        }
        if (envelope.method === "DELETE") {
          stopping = true;
          paused = true;
          changed();
          throw new Error("Temporary browser close failure");
        }
        return { ...response("first", paused), stopping };
      });
      changed = () =>
        publishEvent({
          type: "event",
          event: "plugin.browser.dashboard_changed",
          payload: { sessionKey, name: "status", instanceId: "first" },
        });
      const button = (text: string) =>
        [...element.querySelectorAll("button")].find((entry) => entry.textContent?.trim() === text);
      await vi.waitFor(() => expect(button("Stop browser")).toBeDefined());
      if (initiator === "user") {
        button("Stop browser")!.click();
      } else {
        stopping = true;
        paused = true;
        changed();
      }
      await vi.waitFor(() => expect(element.textContent).toContain("Browser stop is pending"));
      expect(element.textContent).not.toContain("browser is stopped");
      expect(button("Resume browser")).toBeUndefined();
      button("Retry stop")!.click();
      await vi.waitFor(() =>
        expect(requests.filter((entry) => entry.method === "DELETE")).toHaveLength(
          initiator === "user" ? 2 : 1,
        ),
      );
      stopping = false;
      changed();
      await vi.waitFor(() => expect(element.textContent).toContain("browser is stopped"));
      expect(button("Retry stop")).toBeUndefined();
      expect(button("Resume browser")).toBeDefined();
      expect(requests.filter((entry) => entry.method === "POST")).toHaveLength(1);
    },
  );

  it("observes an agent stop/resume without reopening or replacing the dashboard", async () => {
    const opening = createDeferred<ReturnType<typeof response>>();
    let paused = false;
    let targetId = "first";
    const { element, requests, publishEvent } = mount(async (envelope) => {
      if (envelope.path !== "/dashboard") {
        return { running: false, tabs: [] };
      }
      if (envelope.method === "POST") {
        return opening.promise;
      }
      return {
        ...response("first", paused),
        ...(paused
          ? {}
          : {
              browserTab: { target: "host", profile: "openclaw", targetId },
            }),
      };
    });
    const changed = (instanceId = "first") =>
      publishEvent({
        type: "event",
        event: "plugin.browser.dashboard_changed",
        payload: { sessionKey, name: "status", instanceId },
      });
    await vi.waitFor(() => expect(requests).toHaveLength(1));
    paused = true;
    changed();
    opening.resolve(response("first"));
    await vi.waitFor(() => expect(element.textContent).toContain("browser is stopped"));
    expect(element.querySelector("openclaw-browser-panel")).toBeNull();
    paused = false;
    targetId = "resumed-target";
    changed();
    await vi.waitFor(() =>
      expect(element.querySelector("openclaw-browser-panel")?.fixedTab?.targetId).toBe(
        "resumed-target",
      ),
    );
    changed("retired-instance");
    await element.updateComplete;
    const actions = requests.filter((entry) => entry.path === "/dashboard");
    expect(actions.map((entry) => entry.method)).toEqual(["POST", "GET", "GET"]);
    expect(element.widget?.instanceId).toBe("first");
  });

  it("stays passive until opened and ignores an old widget's materialization", async () => {
    const old = createDeferred<ReturnType<typeof response>>();
    const { element, request } = mount(async (envelope) => {
      if (envelope.path !== "/dashboard") {
        return { running: false, tabs: [] };
      }
      return envelope.body?.instanceId === "first" ? old.promise : response("current");
    }, false);
    await element.updateComplete;
    expect(request).not.toHaveBeenCalled();
    element.active = true;
    await vi.waitFor(() => expect(request).toHaveBeenCalledOnce());
    element.widget = widget("current");
    await vi.waitFor(() =>
      expect(element.querySelector("openclaw-browser-panel")?.fixedTab?.targetId).toBe("current"),
    );
    old.resolve(response("first"));
    await old.promise;
    await element.updateComplete;
    const panel = element.querySelector("openclaw-browser-panel")!;
    expect(panel.fixedTab?.targetId).toBe("current");
    expect(panel.dashboardTarget?.instanceId).toBe("current");
    await panel.updateComplete;
    expect(panel.shadowRoot?.querySelector('[aria-label="New tab"]')).toBeNull();
    expect(panel.shadowRoot?.querySelector('[aria-label^="Close tab"]')).toBeNull();
  });

  it("hides without closing and stops/resumes through the dashboard owner", async () => {
    const { element, requests } = mount(async (envelope) =>
      envelope.path === "/dashboard"
        ? response("first", envelope.method === "DELETE")
        : { running: false, tabs: [] },
    );
    await vi.waitFor(() => expect(element.querySelector("openclaw-browser-panel")).not.toBeNull());
    const panel = element.querySelector("openclaw-browser-panel");
    element.active = false;
    await element.updateComplete;
    expect(element.querySelector("openclaw-browser-panel")).toBe(panel);
    expect(panel?.presented).toBe(false);
    expect(requests.filter((value) => value.method === "DELETE")).toEqual([]);
    element.active = true;
    await element.updateComplete;
    const button = (text: string) =>
      [...element.querySelectorAll("button")].find((entry) => entry.textContent?.trim() === text)!;
    button("Stop browser").click();
    await vi.waitFor(() => expect(element.textContent).toContain("browser is stopped"));
    expect(element.querySelector("openclaw-browser-panel")).toBeNull();
    button("Resume browser").click();
    await vi.waitFor(() => expect(element.querySelector("openclaw-browser-panel")).not.toBeNull());
    const actions = requests.filter((value) => value.path === "/dashboard");
    expect(actions.map((value) => value.method)).toEqual(["POST", "DELETE", "POST"]);
    expect(actions[2]?.body).toMatchObject({
      sessionKey,
      name: "status",
      instanceId: "first",
      resume: true,
    });
  });
});
