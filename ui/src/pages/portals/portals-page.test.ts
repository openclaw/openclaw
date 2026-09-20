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
import { resolvePortalUrl } from "./portal-url.ts";

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
  url: "http://127.0.0.1:43123/app?openclaw_portal=secret-token",
  publicUrl: "http://127.0.0.1:43123/app",
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
    expect(frame?.getAttribute("src")).toBe(
      "https://gateway.example.test:43123/app?openclaw_portal=secret-token",
    );
    expect(frame?.getAttribute("referrerpolicy")).toBe("no-referrer");
    expect(frame?.getAttribute("sandbox")).toBe(
      "allow-forms allow-popups allow-popups-to-escape-sandbox allow-same-origin allow-scripts",
    );
    expect(probePortalReachable).toHaveBeenCalledWith(
      "https://gateway.example.test:43123/app?openclaw_portal=secret-token",
    );

    source.emitPortals([]);

    await vi.waitFor(() => {
      expect(source.request).toHaveBeenCalledTimes(2);
    });
    expect(source.request).toHaveBeenLastCalledWith("portal.list", {});
    expect(page.querySelector(".portals-rail__title")?.textContent).toBe("Seeded app");
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

describe("resolvePortalUrl", () => {
  it("uses the resolved gateway host and scheme with the portal listener port", () => {
    expect(
      resolvePortalUrl(
        portal,
        "wss://gateway.example.test:18789/control",
        "http://control-ui.example.test",
      ),
    ).toBe("https://gateway.example.test:43123/app?openclaw_portal=secret-token");
  });
});
