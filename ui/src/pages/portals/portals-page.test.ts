/* @vitest-environment jsdom */

import type {
  EnvironmentSummary,
  PortalListResult,
  PortalSummary,
} from "@openclaw/gateway-protocol";
import { createComponent } from "solid-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { GatewayBrowserClient, GatewayEventFrame } from "../../api/gateway.ts";
import type { ApplicationContext, ApplicationGatewaySnapshot } from "../../app/context.ts";
import { createApplicationContextProvider } from "../../test-helpers/application-context.ts";
import { gatewayHelloForMethods } from "../../test-helpers/gateway-methods.ts";
import { cleanupSolid as cleanup, mountSolid } from "../../test-helpers/mount-solid.ts";
import { createSolidApplicationContextProvider } from "../../test-helpers/solid-application-context.tsx";
import { flush, waitForSolid } from "../../test-helpers/solid-settle.ts";

const probePortalReachable = vi.hoisted(() =>
  vi.fn<() => Promise<"reachable" | "unreachable" | "blocked">>(),
);

vi.mock("./portal-reachability.ts", () => ({ probePortalReachable }));

import { PortalsPage } from "./portals-page.tsx";

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
  methods: string[] | null,
  request: (method: string, params: Record<string, unknown>) => Promise<unknown>,
  scopes = ["operator.write"],
) {
  const requestMock = vi.fn(request);
  const client = { request: requestMock } as unknown as GatewayBrowserClient;
  const snapshot: ApplicationGatewaySnapshot = {
    client,
    phase: "connected",
    offlineStable: false,
    canvasPluginSurfaceUrl: null,
    hello: methods
      ? gatewayHelloForMethods(methods, scopes)
      : { ...gatewayHelloForMethods([], scopes), features: undefined },
    assistantAgentId: null,
    sessionKey: "main",
    lastError: null,
    lastErrorCode: null,
  };
  const eventListeners = new Set<(event: GatewayEventFrame) => void>();
  const snapshotListeners = new Set<(snapshot: ApplicationGatewaySnapshot) => void>();
  const gateway = {
    snapshot,
    connection: {
      gatewayUrl: "wss://gateway.example.test:18789/control",
      token: "",
      bootstrapToken: "",
      password: "",
    },
    subscribe(listener: (snapshot: ApplicationGatewaySnapshot) => void) {
      snapshotListeners.add(listener);
      return () => snapshotListeners.delete(listener);
    },
    subscribeEvents(listener: (event: GatewayEventFrame) => void) {
      eventListeners.add(listener);
      return () => eventListeners.delete(listener);
    },
  } as unknown as ApplicationContext["gateway"];
  return {
    context: { gateway } as unknown as ApplicationContext,
    updateSnapshot(update: Partial<ApplicationGatewaySnapshot>) {
      Object.assign(snapshot, update);
      for (const listener of snapshotListeners) {
        listener(snapshot);
      }
    },
    emitPortals(portals: PortalSummary[]) {
      for (const listener of eventListeners) {
        listener({ type: "event", event: "portal.changed", payload: { portals } });
      }
    },
    request: requestMock,
  };
}

async function mountPage(context: ApplicationContext, portalId?: string, environmentId?: string) {
  const provider = createSolidApplicationContextProvider(context);
  const { container } = mountSolid(
    () =>
      createComponent(PortalsPage, {
        embedded: Boolean(portalId || environmentId),
        requestedPortalId: portalId ?? null,
        requestedEnvironmentId: environmentId ?? null,
      }),
    { wrapper: provider.wrapper },
  );
  flush();
  const page = container.querySelector("openclaw-portals-page")!;
  await page.updateComplete;
  return page;
}

afterEach(() => {
  cleanup();
  document.body.replaceChildren();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

beforeEach(() => {
  probePortalReachable.mockReset().mockResolvedValue("reachable");
});

describe("PortalsPage", () => {
  it.each([undefined, "pending-machine"])(
    "does not read portal state without operator.read (environment: %s)",
    async (environmentId) => {
      const source = createContext(
        ["portal.list", "environments.status"],
        async () => {
          throw new Error("unauthorized portal read");
        },
        ["operator.sessions.read", "operator.sessions.write"],
      );
      const page = await mountPage(source.context, undefined, environmentId);
      await page.updateComplete;
      expect(source.request).not.toHaveBeenCalled();
      expect(page.textContent).toContain("This action requires operator.read access.");
      expect(page.textContent).not.toContain("unauthorized portal read");
      expect(page.textContent).not.toContain("This gateway does not support portals.");
      expect(page.textContent).not.toContain("Starting your machine");
    },
  );

  it.each([undefined, "pending-machine"])(
    "retains read access without a method catalog (environment: %s)",
    async (environmentId) => {
      const source = createContext(
        null,
        async () =>
          environmentId
            ? { id: environmentId, type: "worker", status: "available" }
            : { portals: [] },
        ["operator.read"],
      );
      await mountPage(source.context, undefined, environmentId);
      await waitForSolid(() =>
        expect(source.request).toHaveBeenCalledWith(
          environmentId ? "environments.status" : "portal.list",
          environmentId ? { environmentId } : {},
        ),
      );
    },
  );

  it.each([undefined, "pending-machine"])(
    "drops portal state and stops reads after reconnect without read scope (environment: %s)",
    async (environmentId) => {
      vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
      const methods = ["portal.list", "environments.status"];
      const source = createContext(methods, async () =>
        environmentId
          ? { id: environmentId, type: "worker", status: "starting" }
          : { portals: [portal] },
      );
      const page = await mountPage(source.context, undefined, environmentId);
      await waitForSolid(() => expect(source.request).toHaveBeenCalledTimes(1));
      source.updateSnapshot({ phase: "reconnecting" });
      await page.updateComplete;
      expect(page.textContent).not.toContain("This action requires operator.read access.");
      source.updateSnapshot({
        phase: "connected",
        hello: gatewayHelloForMethods(methods, ["operator.sessions.read"]),
      });
      await page.updateComplete;
      source.emitPortals([portal]);
      await vi.advanceTimersByTimeAsync(6_000);
      expect(source.request).toHaveBeenCalledTimes(1);
      expect(page.textContent).toContain("This action requires operator.read access.");
      expect(page.querySelector("iframe")).toBeNull();
      expect(page.textContent).not.toContain("Starting your machine");
    },
  );

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
    await waitForSolid(() =>
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
    await waitForSolid(() =>
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
    await waitForSolid(() =>
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
    await waitForSolid(() => expect(page.textContent).toContain("The machine could not start"));
    expect(page.querySelector("iframe")).toBeNull();
    page.remove();
    const finalReads = source.request.mock.calls.length;
    await vi.advanceTimersByTimeAsync(6_000);
    expect(source.request).toHaveBeenCalledTimes(finalReads);
  });

  it("keeps polling the selected environment after a previous target fails", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const retired = createDeferred<EnvironmentSummary>();
    let replacement: EnvironmentSummary = { id: "new-machine", type: "worker", status: "starting" };
    const source = createContext(["environments.status"], async (_method, params) =>
      params.environmentId === "old-machine" ? retired.promise : replacement,
    );
    const page = await mountPage(source.context, undefined, "old-machine");
    page.requestedEnvironmentId = replacement.id;
    await page.updateComplete;
    await waitForSolid(() => expect(source.request).toHaveBeenCalledTimes(2));
    await source.request.mock.results[1]?.value;
    await waitForSolid(() => expect(page.textContent).toContain("Starting your machine"));

    retired.reject(new Error("Previous machine failed"));
    await retired.promise.catch(() => undefined);
    await page.updateComplete;
    expect(page.textContent).not.toContain("Previous machine failed");

    replacement = { ...replacement, status: "available" };
    await vi.advanceTimersByTimeAsync(2_000);
    await page.updateComplete;
    expect(page.textContent).toContain("Waiting for your application");
  });

  it("opens the requested portal in the sidebar and never substitutes another app", async () => {
    const selected = { ...portal, id: "selected-app", title: "Selected app", path: "/selected" };
    let portals = [portal, selected];
    const source = createContext(["portal.list", "portal.close"], async () => ({ portals }));
    const page = await mountPage(source.context, selected.id);

    await waitForSolid(() => {
      expect(page.querySelector("iframe")?.getAttribute("title")).toBe(
        "Selected app portal preview",
      );
    });
    expect(page.querySelector(".content-header")).toBeNull();
    expect(page.querySelector(".portals-rail")).toBeNull();

    portals = [portal];
    source.emitPortals(portals);

    await waitForSolid(() => {
      expect(page.querySelector("iframe")).toBeNull();
      expect(page.textContent).toContain("This portal is no longer available.");
    });
  });

  it.each(["reachable", "blocked"] as const)(
    "renders %s previews and refetches the portal list after replacement events",
    async (reachability) => {
      probePortalReachable.mockResolvedValue(reachability);
      const source = createContext(["portal.list", "portal.close"], async (method) => {
        if (method === "portal.list") {
          return { portals: [portal] } satisfies PortalListResult;
        }
        return { closed: true };
      });
      const page = await mountPage(source.context);

      await waitForSolid(() => {
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
      expect(page.textContent).not.toContain("Portal not reachable from this browser");

      source.emitPortals([{ ...portal, url: "https://event.example.test/untrusted" }]);

      await waitForSolid(() => {
        expect(source.request).toHaveBeenCalledTimes(2);
      });
      expect(source.request).toHaveBeenLastCalledWith("portal.list", {});
      expect(page.querySelector(".portals-rail__title")?.textContent).toBe("Seeded app");
      expect(page.querySelector("iframe")?.getAttribute("src")).toBe(portal.url);
    },
  );

  it.each(["solid", "custom element"] as const)(
    "retains the embedded iframe document through %s presentation changes",
    async (entry) => {
      let title = portal.title;
      const source = createContext(["portal.list"], async () => ({
        portals: [{ ...portal, title }],
      }));
      let page: HTMLElementTagNameMap["openclaw-portals-page"];
      if (entry === "solid") {
        page = await mountPage(source.context, portal.id);
      } else {
        page = document.createElement("openclaw-portals-page");
        page.embedded = true;
        page.requestedPortalId = portal.id;
        const provider = createApplicationContextProvider(source.context);
        provider.append(page);
        mountSolid(() => provider);
        await page.updateComplete;
      }
      await waitForSolid(() => expect(page.querySelector("iframe")).not.toBeNull());
      const frame = page.querySelector("iframe")!;
      const writes = vi.spyOn(frame, "setAttribute");
      const sourceWrites = vi.spyOn(frame, "src", "set");

      page.presented = false;
      await page.updateComplete;
      expect(page.querySelector("iframe"), "frame after hiding").toBe(frame);
      title = "Refreshed app";
      page.handleToggleRequest(
        new CustomEvent("openclaw:portal-toggle", { detail: { open: true, portalId: portal.id } }),
      );
      page.presented = true;
      await page.updateComplete;
      await waitForSolid(() =>
        expect(page.querySelector("iframe")?.title).toBe("Refreshed app portal preview"),
      );

      expect(page.querySelector("iframe")).toBe(frame);
      expect(writes.mock.calls.filter(([name]) => name === "src")).toEqual([]);
      expect(sourceWrites).not.toHaveBeenCalled();
    },
  );

  it.each(["success", "failure"] as const)(
    "keeps a replacement portal close locked after the old request's %s",
    async (outcome) => {
      const retired = createDeferred<{ closed: boolean }>();
      const current = createDeferred<{ closed: boolean }>();
      const source = createContext(["portal.list", "portal.close"], async (method) =>
        method === "portal.list" ? { portals: [portal] } : retired.promise,
      );
      const replacement = createContext(["portal.list", "portal.close"], async (method) =>
        method === "portal.list" ? { portals: [portal] } : current.promise,
      );
      const page = await mountPage(source.context);
      const closeButton = () => page.querySelector<HTMLButtonElement>(".portals-preview__close")!;
      await waitForSolid(() => expect(closeButton()).not.toBeNull());
      closeButton().click();
      await waitForSolid(() => expect(closeButton().disabled).toBe(true));
      source.updateSnapshot({ client: replacement.context.gateway.snapshot.client });
      await waitForSolid(() => expect(closeButton()?.disabled).toBe(false));
      closeButton().click();
      await waitForSolid(() => expect(closeButton().disabled).toBe(true));
      try {
        if (outcome === "success") {
          retired.resolve({ closed: true });
        } else {
          retired.reject(new Error("Retired close failed"));
        }
        await retired.promise.catch(() => undefined);
        await page.updateComplete;
        expect(closeButton().disabled).toBe(true);
        expect(page.textContent).not.toContain("Retired close failed");
        closeButton().click();
        expect(
          replacement.request.mock.calls.filter(([method]) => method === "portal.close"),
        ).toHaveLength(1);
      } finally {
        current.resolve({ closed: true });
        await current.promise;
      }
      await waitForSolid(() => expect(closeButton().disabled).toBe(false));
    },
  );

  it("requires write access instead of opening a portal without credentials", async () => {
    const { tokenQuery: _tokenQuery, url: _url, ...redactedPortal } = portal;
    const source = createContext(
      ["portal.list"],
      async () => ({ portals: [redactedPortal as PortalSummary] }),
      ["operator.read"],
    );
    const page = await mountPage(source.context);

    await waitForSolid(() => {
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

    await waitForSolid(() => {
      expect(page.textContent).toContain("Portal not reachable from this browser");
    });
    expect(page.querySelector("iframe")).toBeNull();

    page.querySelector<HTMLButtonElement>(".portals-preview__close")?.click();
    await waitForSolid(() => {
      expect(source.request).toHaveBeenCalledWith("portal.close", { id: portal.id });
    });

    const retry = [...page.querySelectorAll("button")].find(
      (button) => button.textContent?.trim() === "Retry",
    );
    expect(retry).toBeDefined();
    retry?.click();

    await waitForSolid(() => expect(page.querySelector("iframe")).not.toBeNull());
    expect(probePortalReachable).toHaveBeenCalledTimes(2);
  });

  it.each([
    {
      controlUi: "http://localhost:18789/portals",
      gateway: "wss://gateway.example.test/control",
      ingress: true,
    },
    {
      controlUi: "http://localhost:18789/portals",
      gateway: "ws://127.0.0.1:18789/control",
      ingress: false,
    },
    {
      controlUi: "https://127.0.0.1:18789/portals",
      gateway: "ws://127.0.0.1:18789/control",
      ingress: false,
    },
  ])(
    "explains HTTP portal access from $controlUi via $gateway without probing",
    async ({ controlUi, gateway, ingress }) => {
      vi.stubGlobal("location", new URL(controlUi));
      const localPortal = {
        ...portal,
        url: "http://127.0.0.1:43123/app?openclaw_portal=secret-token",
        publicUrl: "http://127.0.0.1:43123/app",
      };
      const source = createContext(["portal.list", "portal.close"], async () => ({
        portals: [localPortal],
      }));
      source.context.gateway.connection.gatewayUrl = gateway;
      const page = await mountPage(source.context);
      await waitForSolid(() =>
        expect(page.textContent).toContain(
          ingress ? "Remote portal ingress required" : "Open this HTTP portal in a new tab",
        ),
      );
      if (ingress) {
        expect(page.textContent).toContain("gateway.portals.ingress");
      }
      expect(page.querySelector("iframe")).toBeNull();
      expect(probePortalReachable).not.toHaveBeenCalled();
      expect(page.querySelector(".portals-preview__url")?.getAttribute("href")).toBe(
        localPortal.url,
      );
      const link = page.querySelector(".portals-preview__notice-url");
      expect(link?.getAttribute("href")).toBe(localPortal.url);
      expect(link?.getAttribute("target")).toBe("_blank");
    },
  );

  it.each([
    { host: "127.0.0.1", gateway: "wss://localhost:18789/control" },
    { host: "192.168.1.20", gateway: "ws://192.168.1.20:18789/control" },
  ])(
    "preserves the service-published HTTP URL on $host via $gateway",
    async ({ host, gateway }) => {
      vi.stubGlobal("location", new URL(`http://${host}:18789/portals`));
      const localPortal = {
        ...portal,
        url: `http://${host}:43123/app?openclaw_portal=secret-token`,
        publicUrl: `http://${host}:43123/app`,
      };
      const source = createContext(["portal.list"], async () => ({ portals: [localPortal] }));
      source.context.gateway.connection.gatewayUrl = gateway;
      const page = await mountPage(source.context);
      await waitForSolid(() =>
        expect(page.querySelector("iframe")?.getAttribute("src")).toBe(localPortal.url),
      );
      expect(probePortalReachable).toHaveBeenCalledWith(localPortal.url);
      expect(page.querySelector(".portals-preview__url")?.getAttribute("href")).toBe(
        localPortal.url,
      );
      expect(page.textContent).not.toContain("Remote portal ingress required");
    },
  );

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
    const provider = createSolidApplicationContextProvider(first.context);
    const { container } = mountSolid(() => createComponent(PortalsPage, {}), {
      wrapper: provider.wrapper,
    });
    flush();
    let page = container.querySelector("openclaw-portals-page")!;
    await page.updateComplete;
    await waitForSolid(() => expect(probePortalReachable).toHaveBeenCalledTimes(1));

    const second = createContext(["portal.list"], async () => ({ portals: [portal] }));
    provider.setContext(second.context);
    flush();
    page = container.querySelector("openclaw-portals-page")!;
    await waitForSolid(() =>
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
