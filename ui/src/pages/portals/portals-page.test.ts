/* @vitest-environment jsdom */

import type {
  EnvironmentSummary,
  PortalListResult,
  PortalSummary,
} from "@openclaw/gateway-protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { GatewayBrowserClient, GatewayEventFrame } from "../../api/gateway.ts";
import type { ApplicationContext, ApplicationGatewaySnapshot } from "../../app/context.ts";
import { createApplicationContextProvider } from "../../test-helpers/application-context.ts";
import { gatewayHelloForMethods } from "../../test-helpers/gateway-methods.ts";
import { portalNeedsNewTab, portalNeedsRemoteIngress } from "./portal-url.ts";

const probePortalReachable = vi.hoisted(() =>
  vi.fn<() => Promise<"reachable" | "unreachable" | "blocked">>(),
);

vi.mock("./portal-reachability.ts", () => ({ probePortalReachable }));

import "./portals-page.ts";

const portal = {
  id: "p3000",
  title: "Seeded app",
  port: 3000,
  listenPort: 43_123,
  tokenQuery: "openclaw_portal=secret-token",
  url: "https://preview.example.test:8443/context/app?view=one%2Ftwo&openclaw_portal=secret-token#section",
  publicUrl: "https://preview.example.test:8443/context/app?view=one%2Ftwo#section",
  path: "/app",
  description: "Use the seeded test account.",
  createdAtMs: 1_000,
} satisfies PortalSummary;

function createContext(
  methods: string[],
  request: (method: string, params: Record<string, unknown>) => Promise<unknown>,
) {
  const requestMock = vi.fn(request);
  const client = { request: requestMock } as unknown as GatewayBrowserClient;
  const snapshot: ApplicationGatewaySnapshot = {
    client,
    phase: "connected",
    offlineStable: false,
    canvasPluginSurfaceUrl: null,
    hello: gatewayHelloForMethods(methods, ["operator.write"]),
    assistantAgentId: null,
    sessionKey: "main",
    lastError: null,
    lastErrorCode: null,
  };
  const eventListeners = new Set<(event: GatewayEventFrame) => void>();
  const gateway = {
    snapshot,
    connection: {
      gatewayUrl: "wss://gateway.example.test:18789/control",
      token: "",
      bootstrapToken: "",
      password: "",
    },
    subscribe: () => () => undefined,
    subscribeEvents(listener: (event: GatewayEventFrame) => void) {
      eventListeners.add(listener);
      return () => eventListeners.delete(listener);
    },
  } as unknown as ApplicationContext["gateway"];
  return {
    context: { gateway } as unknown as ApplicationContext,
    emitPortals(portals: PortalSummary[]) {
      for (const listener of eventListeners) {
        listener({ type: "event", event: "portal.changed", payload: { portals } });
      }
    },
    request: requestMock,
  };
}

async function mountPage(context: ApplicationContext, portalId?: string, environmentId?: string) {
  const page = document.createElement("openclaw-portals-page");
  const provider = createApplicationContextProvider(context);
  if (portalId || environmentId) {
    page.embedded = true;
    page.requestedPortalId = portalId ?? null;
    page.requestedEnvironmentId = environmentId ?? null;
  }
  provider.append(page);
  document.body.append(provider);
  await page.updateComplete;
  return page;
}

afterEach(() => {
  document.body.replaceChildren();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

beforeEach(() => {
  probePortalReachable.mockReset().mockResolvedValue("reachable");
});

describe("PortalsPage", () => {
  it("shows machine startup before selecting only the portal explicitly opened for its app", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    let environment: EnvironmentSummary = {
      id: "pending-machine",
      type: "worker",
      status: "starting",
    };
    const source = createContext(["environments.status", "portal.list"], async (method) =>
      method === "environments.status" ? environment : { portals: [portal] },
    );
    const page = await mountPage(source.context, undefined, environment.id);
    await vi.waitFor(() =>
      expect(source.request).toHaveBeenCalledWith("environments.status", {
        environmentId: environment.id,
      }),
    );
    expect(page.textContent).toContain("Starting your machine");
    expect(page.querySelector("iframe")).toBeNull();
    expect(source.request.mock.calls.some(([method]) => method === "portal.list")).toBe(false);

    environment = { ...environment, status: "available" };
    await vi.advanceTimersByTimeAsync(2_000);
    await page.updateComplete;
    expect(page.textContent).toContain("Waiting for your application");
    const reads = source.request.mock.calls.length;
    await vi.advanceTimersByTimeAsync(6_000);
    expect(source.request).toHaveBeenCalledTimes(reads);
    expect(page.querySelector("iframe")).toBeNull();

    page.handleToggleRequest(
      new CustomEvent("openclaw:portal-toggle", { detail: { open: true, portalId: portal.id } }),
    );
    await vi.waitFor(() =>
      expect(page.querySelector("iframe")?.getAttribute("title")).toBe("Seeded app portal preview"),
    );
    expect(page.requestedEnvironmentId).toBeNull();
  });

  it("ignores retired startup targets and stops reading while hidden or disposed", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const retired = createDeferred<EnvironmentSummary>();
    let replacement: EnvironmentSummary = { id: "new-machine", type: "worker", status: "starting" };
    const source = createContext(["environments.status", "portal.list"], async (method, params) =>
      method === "environments.status"
        ? params.environmentId === "old-machine"
          ? retired.promise
          : replacement
        : { portals: [portal] },
    );
    const page = await mountPage(source.context, undefined, "old-machine");
    page.requestedEnvironmentId = replacement.id;
    await page.updateComplete;
    await vi.waitFor(() =>
      expect(source.request).toHaveBeenLastCalledWith("environments.status", {
        environmentId: replacement.id,
      }),
    );
    page.presented = false;
    await page.updateComplete;
    const reads = source.request.mock.calls.length;
    retired.resolve({ id: "old-machine", type: "worker", status: "available" });
    await vi.advanceTimersByTimeAsync(6_000);
    expect(source.request).toHaveBeenCalledTimes(reads);
    expect(page.textContent).toContain("Starting your machine");
    replacement = { ...replacement, status: "error" };
    page.presented = true;
    await page.updateComplete;
    await vi.waitFor(() => expect(page.textContent).toContain("The machine could not start"));
    expect(page.querySelector("iframe")).toBeNull();
    page.remove();
    const finalReads = source.request.mock.calls.length;
    await vi.advanceTimersByTimeAsync(6_000);
    expect(source.request).toHaveBeenCalledTimes(finalReads);
  });

  it("opens the requested portal in the sidebar and never substitutes another app", async () => {
    const selected = { ...portal, id: "selected-app", title: "Selected app", path: "/selected" };
    let portals = [portal, selected];
    const source = createContext(["portal.list", "portal.close"], async () => ({ portals }));
    const page = await mountPage(source.context, selected.id);

    await vi.waitFor(() => {
      expect(page.querySelector("iframe")?.getAttribute("title")).toBe(
        "Selected app portal preview",
      );
    });
    expect(page.querySelector(".content-header")).toBeNull();
    expect(page.querySelector(".portals-rail")).toBeNull();

    portals = [portal];
    source.emitPortals(portals);

    await vi.waitFor(() => {
      expect(page.querySelector("iframe")).toBeNull();
      expect(page.textContent).toContain("This portal is no longer available.");
    });
  });

  it("renders the portal list and refetches it after replacement events", async () => {
    const source = createContext(["portal.list", "portal.close"], async (method) => {
      if (method === "portal.list") {
        return { portals: [portal] } satisfies PortalListResult;
      }
      return { closed: true };
    });
    const page = await mountPage(source.context);

    await vi.waitFor(() => {
      expect(page.querySelector(".portals-rail__title")?.textContent).toBe("Seeded app");
    });
    expect(page.querySelector(".portals-rail__item")?.textContent).toContain("Port 3000");
    expect(page.querySelector(".portals-rail__item")?.textContent).toContain(
      "Use the seeded test account.",
    );
    const frame = page.querySelector("iframe");
    expect(frame?.getAttribute("src")).toBe(portal.url);
    expect(page.querySelector(".portals-preview__url")?.getAttribute("href")).toBe(portal.url);
    expect(frame?.getAttribute("referrerpolicy")).toBe("no-referrer");
    expect(frame?.getAttribute("sandbox")).toBe(
      "allow-forms allow-popups allow-popups-to-escape-sandbox allow-same-origin allow-scripts",
    );
    expect(probePortalReachable).toHaveBeenCalledWith(portal.url);

    source.emitPortals([{ ...portal, url: "https://event.example.test/untrusted" }]);

    await vi.waitFor(() => {
      expect(source.request).toHaveBeenCalledTimes(2);
    });
    expect(source.request).toHaveBeenLastCalledWith("portal.list", {});
    expect(page.querySelector(".portals-rail__title")?.textContent).toBe("Seeded app");
    expect(page.querySelector("iframe")?.getAttribute("src")).toBe(portal.url);
  });

  it("requires write access instead of opening a portal without credentials", async () => {
    const { tokenQuery: _tokenQuery, url: _url, ...redactedPortal } = portal;
    const source = createContext(["portal.list"], async () => ({
      portals: [redactedPortal as PortalSummary],
    }));
    const page = await mountPage(source.context);

    await vi.waitFor(() => {
      expect(page.textContent).toContain("This portal requires an operator with write access.");
    });
    expect(page.querySelector("iframe")).toBeNull();
    expect(page.querySelector(".portals-preview__url")).toBeNull();
    expect(probePortalReachable).not.toHaveBeenCalled();
  });

  it("shows an unreachable notice without mounting the iframe and retries", async () => {
    probePortalReachable.mockResolvedValueOnce("unreachable").mockResolvedValueOnce("reachable");
    const source = createContext(["portal.list", "portal.close"], async (method) => {
      if (method === "portal.list") {
        return { portals: [portal] } satisfies PortalListResult;
      }
      return { closed: true };
    });
    const page = await mountPage(source.context);

    await vi.waitFor(() => {
      expect(page.textContent).toContain("Portal not reachable from this browser");
    });
    expect(page.querySelector("iframe")).toBeNull();

    page.querySelector<HTMLButtonElement>(".portals-preview__close")?.click();
    await vi.waitFor(() => {
      expect(source.request).toHaveBeenCalledWith("portal.close", { id: portal.id });
    });

    const retry = [...page.querySelectorAll("button")].find(
      (button) => button.textContent?.trim() === "Retry",
    );
    expect(retry).toBeDefined();
    retry?.click();

    await vi.waitFor(() => expect(page.querySelector("iframe")).not.toBeNull());
    expect(probePortalReachable).toHaveBeenCalledTimes(2);
  });

  it("still mounts the preview when policy blocks the probe", async () => {
    // A CSP-refused probe never reached the network, so it must not be reported
    // as an unreachable portal: frames obey frame-src and can still load.
    probePortalReachable.mockResolvedValue("blocked");
    const source = createContext(["portal.list", "portal.close"], async () => ({
      portals: [portal],
    }));
    const page = await mountPage(source.context);

    await vi.waitFor(() => expect(page.querySelector("iframe")).not.toBeNull());
    expect(page.textContent).not.toContain("Portal not reachable from this browser");
  });

  it("explains missing remote ingress without probing the browser's loopback services", async () => {
    const localPortal = {
      ...portal,
      url: "http://127.0.0.1:43123/app?openclaw_portal=secret-token",
      publicUrl: "http://127.0.0.1:43123/app",
    };
    const source = createContext(["portal.list", "portal.close"], async () => ({
      portals: [localPortal],
    }));
    const page = await mountPage(source.context);
    await vi.waitFor(() => expect(page.textContent).toContain("Remote portal ingress required"));
    expect(page.textContent).toContain("gateway.portals.ingress");
    expect(page.querySelector("iframe")).toBeNull();
    expect(probePortalReachable).not.toHaveBeenCalled();
    expect(page.querySelector(".portals-preview__url")?.getAttribute("href")).toBe(localPortal.url);
  });

  it("offers the canonical HTTP URL in a new tab when the Control UI is on another host", async () => {
    vi.stubGlobal("location", new URL("http://localhost:18789/portals"));
    const localPortal = {
      ...portal,
      url: "http://127.0.0.1:43123/app?openclaw_portal=secret-token",
    };
    const source = createContext(["portal.list"], async () => ({ portals: [localPortal] }));
    source.context.gateway.connection.gatewayUrl = "ws://127.0.0.1:18789/control";
    const page = await mountPage(source.context);
    await vi.waitFor(() =>
      expect(page.textContent).toContain("Open this HTTP portal in a new tab"),
    );
    expect(page.querySelector("iframe")).toBeNull();
    expect(probePortalReachable).not.toHaveBeenCalled();
    const link = page.querySelector(".portals-preview__notice-url");
    expect(link?.getAttribute("href")).toBe(localPortal.url);
    expect(link?.getAttribute("target")).toBe("_blank");
  });

  it("preserves the actual HTTP scheme for a local listener even with an HTTPS Gateway", async () => {
    vi.stubGlobal("location", new URL("http://127.0.0.1:18789/portals"));
    const localPortal = {
      ...portal,
      url: "http://127.0.0.1:43123/app?openclaw_portal=secret-token",
    };
    const source = createContext(["portal.list"], async () => ({ portals: [localPortal] }));
    source.context.gateway.connection.gatewayUrl = "wss://localhost:18789/control";
    const page = await mountPage(source.context);
    await vi.waitFor(() =>
      expect(page.querySelector("iframe")?.getAttribute("src")).toBe(localPortal.url),
    );
    expect(probePortalReachable).toHaveBeenCalledWith(localPortal.url);
  });

  it("opens a service-published direct LAN URL unchanged without requiring ingress", async () => {
    vi.stubGlobal("location", new URL("http://192.168.1.20:18789/portals"));
    const lanPortal = {
      ...portal,
      url: "http://192.168.1.20:43123/app?openclaw_portal=secret-token",
      publicUrl: "http://192.168.1.20:43123/app",
    };
    const source = createContext(["portal.list"], async () => ({ portals: [lanPortal] }));
    source.context.gateway.connection.gatewayUrl = "ws://192.168.1.20:18789/control";
    const page = await mountPage(source.context);

    await vi.waitFor(() =>
      expect(page.querySelector("iframe")?.getAttribute("src")).toBe(lanPortal.url),
    );
    expect(page.querySelector(".portals-preview__url")?.getAttribute("href")).toBe(lanPortal.url);
    expect(probePortalReachable).toHaveBeenCalledWith(lanPortal.url);
    expect(page.textContent).not.toContain("Remote portal ingress required");
  });

  it("does not publish a late probe from the previous Gateway", async () => {
    let completeOldProbe!: (result: "reachable") => void;
    probePortalReachable
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            completeOldProbe = resolve;
          }),
      )
      .mockResolvedValueOnce("unreachable");
    const first = createContext(["portal.list"], async () => ({ portals: [portal] }));
    const provider = createApplicationContextProvider(first.context);
    const page = document.createElement("openclaw-portals-page");
    provider.append(page);
    document.body.append(provider);
    await page.updateComplete;
    await vi.waitFor(() => expect(probePortalReachable).toHaveBeenCalledTimes(1));

    const second = createContext(["portal.list"], async () => ({ portals: [portal] }));
    provider.setContext(second.context);
    await vi.waitFor(() =>
      expect(page.textContent).toContain("Portal not reachable from this browser"),
    );
    completeOldProbe("reachable");
    await page.updateComplete;
    expect(page.querySelector("iframe")).toBeNull();
    expect(page.textContent).toContain("Portal not reachable from this browser");
    expect(probePortalReachable).toHaveBeenCalledTimes(2);
  });

  it("shows the empty prompts and an unsupported note without calling the method", async () => {
    const source = createContext([], async () => ({ portals: [] }));
    const page = await mountPage(source.context);

    expect(page.textContent).toContain("Ask the agent to start a portal:");
    expect(page.textContent).toContain("Show me in a portal.");
    expect(page.textContent).toContain("Start the application in a portal.");
    expect(page.textContent).toContain("Make the server available in a portal.");
    expect(page.textContent).toContain("This gateway does not support portals.");
    expect(source.request).not.toHaveBeenCalled();
  });
});

describe("portalNeedsNewTab", () => {
  it.each([
    ["http://127.0.0.1:43123/app", "http://localhost:18789", true],
    ["http://127.0.0.1:43123/app", "https://127.0.0.1:18789", true],
    ["http://192.168.1.20:43123/app", "http://192.168.1.20:18789", false],
    ["https://preview.example.test/app", "http://localhost:18789", false],
  ])("classifies %s from the actual Control UI %s", (url, controlUiUrl, expected) => {
    expect(portalNeedsNewTab(url, controlUiUrl)).toBe(expected);
  });
});

describe("portalNeedsRemoteIngress", () => {
  it.each(["localhost", "127.0.0.1", "127.2.3.4", "[::1]"])(
    "identifies %s as browser-local for a remote Gateway",
    (host) => {
      expect(
        portalNeedsRemoteIngress(`http://${host}:43123/app`, "wss://gateway.example.test/control"),
      ).toBe(true);
      expect(portalNeedsRemoteIngress(`http://${host}:43123/app`, "ws://localhost:18789")).toBe(
        false,
      );
    },
  );
  it("does not label authoritative external or direct network endpoints as loopback", () => {
    expect(portalNeedsRemoteIngress(portal.url, "wss://gateway.example.test/control")).toBe(false);
    expect(
      portalNeedsRemoteIngress(
        "http://192.168.1.2:43123/app",
        "wss://gateway.example.test/control",
      ),
    ).toBe(false);
  });
});
