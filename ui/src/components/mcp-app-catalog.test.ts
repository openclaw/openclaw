import { createComponent, createSignal, flush } from "solid-js";
import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { GatewayPendingRequests } from "../../../packages/gateway-client/src/pending-request.js";
import type { RequestFrame } from "../../../packages/gateway-protocol/src/schema/frames.js";
import { GATEWAY_STARTUP_ADMISSION_WAIT_MS } from "../../../packages/gateway-protocol/src/startup-unavailable.js";
import type { McpAppDiscoverResult } from "../../../src/shared/mcp-app-extensions.js";
import { createDeferred } from "../../../test/helpers/promise.js";
import type { GatewayEventFrame } from "../api/gateway.ts";
import type { ApplicationContext } from "../app/context.ts";
import { t } from "../i18n/index.ts";
import { createMcpAppCatalog } from "../lib/mcp-app-catalog.ts";
import {
  createTestSessionCapability,
  sessionsResult,
} from "../lib/sessions/session-capability.test-support.ts";
import { AppsPage } from "../pages/apps/apps-page.tsx";
import { createInitializationContext } from "../pages/chat/chat-pane.test-support.ts";
import { createApplicationGateway } from "../test-helpers/application-context-fixtures.ts";
import {
  createGatewayRequestMock,
  createTestGatewayClient,
} from "../test-helpers/gateway-client.ts";
import { gatewayHelloForMethods } from "../test-helpers/gateway-methods.ts";
import { mountSolid } from "../test-helpers/mount-solid.ts";
import { createSolidApplicationContextProvider } from "../test-helpers/solid-application-context.tsx";
import { waitForSolid } from "../test-helpers/solid-settle.ts";
import { McpAppCatalog } from "./mcp-app-catalog.tsx";
import { MCP_APP_OPEN_EVENT, type McpAppOpenDetail } from "./mcp-app-launch.ts";
import { McpAppResources } from "./mcp-app-resources.tsx";

// mock-isolation: Exercise the Apps launch boundary without starting the chat runtime.
vi.mock("../pages/chat/chat-pane.tsx", async () => {
  const { defineSolidBridge } = await import("../lib/solid-bridge.ts");
  const { chatPaneProperties } = await import("../pages/chat/chat-pane-inputs.ts");
  return {
    ChatPaneView: defineSolidBridge("openclaw-chat-pane", () => null, {
      properties: chatPaneProperties,
    }),
  };
});
// mock-isolation: This suite supplies only the catalog and launch capabilities.
vi.mock("../pages/chat/route-entry.ts", () => ({}));

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
const result: McpAppDiscoverResult = {
  servers: [
    {
      serverName: "parts",
      label: "Parts plugin",
      entrypoints: [
        {
          title: "Parts tray",
          toolName: "tray",
          resourceUri: "ui://parts/tray",
          entrypoint: { type: "thread" },
        },
        {
          title: "Library",
          toolName: "library",
          resourceUri: "ui://parts/library",
          entrypoint: { type: "global" },
        },
      ],
    },
  ],
};

function createDiscoveryGateway(request: Parameters<typeof createTestGatewayClient>[0]) {
  return {
    snapshot: {
      client: { request },
      phase: "connected",
      hello: gatewayHelloForMethods(["mcp.app.discover"]),
    },
    connectionRevision: 1,
    subscribe: () => () => {},
    subscribeEvents: () => () => {},
  };
}

function discoveryContext(request: ReturnType<typeof vi.fn>, scopes = ["operator.admin"]) {
  const events = new Set<(event: GatewayEventFrame) => void>();
  return {
    events,
    context: {
      gateway: {
        snapshot: {
          client: { request },
          phase: "connected",
          hello: gatewayHelloForMethods(["mcp.app.discover"], scopes),
        },
        connectionRevision: 1,
        subscribe: () => () => {},
        subscribeEvents: (listener: (event: GatewayEventFrame) => void) => {
          events.add(listener);
          return () => events.delete(listener);
        },
      },
      agentSelection: { state: { selectedId: "main" }, subscribe: () => () => {} },
      sessions: {
        describe: async () => ({
          session: { key: "agent:main:one", kind: "direct" as const, updatedAt: 1 },
        }),
      },
    },
  };
}

function mountCatalog(context: unknown, initial: Parameters<typeof McpAppCatalog>[0] = {}) {
  const [props, setProps] = createSignal(initial);
  // SAFETY: Fixtures supply precisely the capabilities exercised by these catalog flows.
  const application = context as ApplicationContext;
  const mounted = mountSolid(
    () =>
      createComponent(McpAppCatalog, {
        get sessionKey() {
          return props().sessionKey;
        },
        get agentId() {
          return props().agentId;
        },
        get surface() {
          return props().surface;
        },
        get filePath() {
          return props().filePath;
        },
      }),
    { wrapper: createSolidApplicationContextProvider(application).wrapper },
  );
  return {
    ...mounted,
    application,
    element: mounted.container.querySelector<HTMLElement>("openclaw-mcp-app-catalog")!,
    update(next: Partial<Parameters<typeof McpAppCatalog>[0]>) {
      setProps((current) => ({ ...current, ...next }));
      flush();
    },
  };
}

describe("app launch catalog", () => {
  it("prepares a global catalog again when its session was deleted offline", async () => {
    let sessionExists = true;
    const request = createGatewayRequestMock(() =>
      sessionExists
        ? Promise.resolve(result)
        : Promise.reject(new Error("The requested session is unavailable")),
    );
    const describeSession = vi.fn(() =>
      Promise.resolve({ session: sessionExists ? { key: "agent:main:one" } : null }),
    );
    const createResult = vi.fn(() => {
      sessionExists = true;
      return Promise.resolve({ key: "agent:main:one" });
    });
    const { gateway, publish } = createApplicationGateway();
    const hello = gatewayHelloForMethods(["mcp.app.discover"]);
    publish({
      ...gateway.snapshot,
      client: createTestGatewayClient(request),
      phase: "connected",
      hello,
    });
    const { element: catalog } = mountCatalog(
      {
        ...discoveryContext(request).context,
        gateway,
        sessions: { describe: describeSession, createResult, state: { error: null } },
      },
      { sessionKey: "agent:main:one" },
    );
    await waitForSolid(() => expect(catalog.textContent).toContain("Library"));
    expect(describeSession).toHaveBeenCalledOnce();
    expect(createResult).not.toHaveBeenCalled();

    publish({ ...gateway.snapshot, phase: "reconnecting", hello: null });
    flush();
    sessionExists = false;
    expect(catalog.textContent).toContain("Library");
    publish({ ...gateway.snapshot, phase: "connected", hello });
    await waitForSolid(() => {
      expect(describeSession).toHaveBeenCalledTimes(2);
      expect(createResult).toHaveBeenCalledOnce();
      expect(request).toHaveBeenCalledTimes(2);
      expect(catalog.textContent).toContain("Library");
      expect(catalog.querySelector('[role="alert"]')).toBeNull();
    });
  });

  it("retains expanded discoveries offline, refreshes on reconnect, and clears a changed Gateway", async () => {
    const refreshed = createDeferred<McpAppDiscoverResult>();
    const request = vi.fn().mockResolvedValueOnce(result).mockReturnValue(refreshed.promise);
    const { gateway, publish } = createApplicationGateway();
    const hello = gatewayHelloForMethods(["mcp.app.discover"]);
    publish({
      ...gateway.snapshot,
      client: createTestGatewayClient(request),
      phase: "connected",
      hello,
    });
    const context = { ...discoveryContext(request).context, gateway };
    const { element: catalog } = mountCatalog(context, {
      surface: "thread",
      sessionKey: "agent:main:one",
    });
    await waitForSolid(() => expect(catalog.querySelector("button")).not.toBeNull());
    catalog.querySelector<HTMLButtonElement>("button")!.click();
    await waitForSolid(() => expect(catalog.textContent).toContain("Parts tray"));
    const entry = catalog.querySelector<HTMLButtonElement>(".mcp-app-catalog__entry button")!;
    publish({ ...gateway.snapshot, phase: "reconnecting", hello: null });
    flush();
    expect(catalog.querySelector(".mcp-app-catalog__entry button")).toBe(entry);
    expect(entry.disabled).toBe(true);
    publish({ ...gateway.snapshot, phase: "connected", hello });
    flush();
    expect(catalog.querySelector(".mcp-app-catalog__entry button")).toBe(entry);
    expect(entry.disabled).toBe(false);
    await waitForSolid(() => expect(request).toHaveBeenCalledTimes(2));
    refreshed.resolve(result);
    await refreshed.promise;
    publish({
      ...gateway.snapshot,
      client: createTestGatewayClient(vi.fn(() => new Promise(() => {}))),
    });
    flush();
    expect(catalog.textContent).not.toContain("Parts tray");
  });

  it.each(["closed", "agent changed", "conversation changed", "open"] as const)(
    "only creates a startup-waiting catalog session while its target remains open (%s)",
    async (lifetime) => {
      vi.useFakeTimers();
      let ready = false;
      const writes: RequestFrame[] = [];
      const issued = createDeferred();
      const pending = new GatewayPendingRequests({
        createRequestId: () => "catalog",
        nowMs: Date.now,
      });
      onTestFinished(() => pending.flush(new Error("test disposed")));
      const client = createTestGatewayClient((method, params, options) => {
        if (method === "sessions.create") {
          return pending.request(
            {
              send(raw) {
                // SAFETY: The production request owner serializes this frame.
                const frame = JSON.parse(raw) as RequestFrame;
                if (ready) {
                  writes.push(frame);
                }
                pending.handleResponse({
                  type: "res",
                  id: frame.id,
                  ok: ready,
                  ...(ready
                    ? { payload: { key: "agent:main:one" } }
                    : {
                        error: {
                          code: "UNAVAILABLE",
                          message: "Agent is preparing",
                          retryable: true,
                          retryAfterMs: 1_000,
                          details: { reason: "startup-sidecars", method },
                        },
                      }),
                });
                issued.resolve();
              },
            },
            method,
            params,
            options,
          );
        }
        if (method === "sessions.describe") {
          // SAFETY: The session capability constructs this typed describe target.
          const target = params as { key: string; agentId?: string };
          return {
            session:
              target.key === "agent:main:one" && target.agentId === "main"
                ? null
                : { key: target.key, kind: "direct", updatedAt: 1 },
          };
        }
        if (method === "sessions.list") {
          return sessionsResult([], 1);
        }
        return method === "mcp.app.discover" ? result : {};
      });
      const { gateway, publish } = createApplicationGateway();
      publish({
        ...gateway.snapshot,
        client,
        phase: "connected",
        hello: gatewayHelloForMethods(["mcp.app.discover"]),
      });
      const sessions = createTestSessionCapability(gateway);
      const mounted = mountCatalog(
        {
          gateway,
          sessions,
          agentSelection: { state: { selectedId: "main" }, subscribe: () => () => {} },
        },
        { sessionKey: "agent:main:one", agentId: "main" },
      );
      const catalog = mounted.element;
      await issued.promise;
      await vi.advanceTimersByTimeAsync(45_000);
      expect(writes).toHaveLength(0);
      expect(pending.hasPending).toBe(true);

      if (lifetime === "closed") {
        mounted.unmount();
      } else if (lifetime === "agent changed") {
        mounted.update({ agentId: "other" });
      } else if (lifetime === "conversation changed") {
        mounted.update({ sessionKey: "agent:main:two" });
      }
      flush();
      ready = true;
      await vi.advanceTimersByTimeAsync(GATEWAY_STARTUP_ADMISSION_WAIT_MS);
      expect(writes.map((frame) => frame.params)).toEqual(
        lifetime === "open" ? [{ key: "agent:main:one", agentId: "main" }] : [],
      );
      expect(pending.hasPending).toBe(false);
      expect(sessions.state.error).toBeNull();
      if (lifetime === "open") {
        expect(catalog.textContent).toContain("Library");
      }
    },
  );

  it("waits for the new session's discovery before retaining an Apps page launch", async () => {
    const first = createDeferred<McpAppDiscoverResult>();
    const second = createDeferred<McpAppDiscoverResult>();
    const request = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const { gateway, publish } = createApplicationGateway();
    publish({
      ...gateway.snapshot,
      client: createTestGatewayClient(request),
      phase: "connected",
      sessionKey: "agent:main:one",
      hello: gatewayHelloForMethods(["mcp.app.discover"]),
    });
    // SAFETY: This mounted page fixture supplies the discovery and launch capabilities it uses.
    const context: Pick<ApplicationContext, "gateway"> & {
      agentSelection: {
        state: Pick<ApplicationContext["agentSelection"]["state"], "selectedId">;
        subscribe: ApplicationContext["agentSelection"]["subscribe"];
      };
      sessions: Pick<ApplicationContext["sessions"], "describe">;
    } = { ...discoveryContext(request).context, gateway };
    const { container, unmount } = mountSolid(
      () => createComponent(AppsPage, { appSearch: "?server=parts&tool=library" }),
      { wrapper: createSolidApplicationContextProvider(context as ApplicationContext).wrapper },
    );
    try {
      await waitForSolid(() => expect(request).toHaveBeenCalledOnce());
      first.resolve(result);
      await waitForSolid(() =>
        expect(container.querySelector("openclaw-chat-pane")?.mcpAppLaunch).toMatchObject({
          sessionKey: "agent:main:one",
          entrypoint: { resourceUri: "ui://parts/library" },
        }),
      );
      publish({ ...gateway.snapshot, sessionKey: "agent:main:two" });
      flush();
      expect(container.querySelector("openclaw-chat-pane")).toBeNull();
      await waitForSolid(() => expect(request).toHaveBeenCalledTimes(2));
      second.resolve({
        servers: result.servers.map((server) => ({
          ...server,
          entrypoints: server.entrypoints.map((entry) => ({
            ...entry,
            resourceUri: `${entry.resourceUri}-second`,
          })),
        })),
      });
      await waitForSolid(() =>
        expect(container.querySelector("openclaw-chat-pane")?.mcpAppLaunch).toMatchObject({
          sessionKey: "agent:main:two",
          entrypoint: { resourceUri: "ui://parts/library-second" },
        }),
      );
    } finally {
      unmount();
    }
  });

  it.each([
    { scope: "operator.admin", discover: true },
    { scope: "operator.write", discover: true },
    { scope: "operator.read", discover: false },
    { scope: "operator.sessions.read", discover: false },
    { scope: "operator.sessions.write", discover: false },
  ])("admits discovery according to granted scope $scope", async ({ scope, discover }) => {
    const request = vi.fn(async () => ({ servers: [] }));
    const context = createInitializationContext(createTestGatewayClient(request));
    context.gateway.snapshot.hello = gatewayHelloForMethods(["mcp.app.discover"], [scope]);
    vi.spyOn(context.sessions, "describe").mockResolvedValue({
      session: { key: "agent:main:one", kind: "direct", updatedAt: 1 },
    });
    let catalog!: ReturnType<typeof createMcpAppCatalog>;
    mountSolid(() => {
      catalog = createMcpAppCatalog(context, () => ({
        sessionKey: "agent:main:one",
      }));
      return null;
    });
    await catalog.refresh();
    expect(catalog.available()).toBe(discover);
    expect(catalog.visible()).toBe(discover);
    expect(request).toHaveBeenCalledTimes(discover ? 1 : 0);
  });

  it("shares discovery and retains focused entries through refresh before remounting", async () => {
    const current = createDeferred<McpAppDiscoverResult>();
    const refreshed = createDeferred<McpAppDiscoverResult>();
    const failed = createDeferred<McpAppDiscoverResult>();
    const retried = createDeferred<McpAppDiscoverResult>();
    const remounted = createDeferred<McpAppDiscoverResult>();
    const request = vi
      .fn()
      .mockReturnValueOnce(current.promise)
      .mockReturnValueOnce(refreshed.promise)
      .mockReturnValueOnce(failed.promise)
      .mockReturnValueOnce(retried.promise)
      .mockReturnValueOnce(remounted.promise);
    const { context, events } = discoveryContext(request);
    const sidebarProps = {
      surface: "sidebar" as const,
      sessionKey: "agent:main:one",
      agentId: "main",
    };
    let sidebarMount = mountCatalog(context, sidebarProps);
    let sidebar = sidebarMount.element;
    const { element: thread } = mountCatalog(context, {
      surface: "thread",
      sessionKey: "agent:main:one",
      agentId: "main",
    });
    const resourcesMount = mountSolid(
      () => createComponent(McpAppResources, { sessionKey: "agent:main:one", agentId: "main" }),
      { wrapper: createSolidApplicationContextProvider(sidebarMount.application).wrapper },
    );
    onTestFinished(resourcesMount.unmount);
    const resources = resourcesMount.container;
    await waitForSolid(() => expect(request).toHaveBeenCalledOnce());
    expect(request).toHaveBeenCalledExactlyOnceWith("mcp.app.discover", {
      sessionKey: "agent:main:one",
      agentId: "main",
    });

    const event: GatewayEventFrame = { type: "event", event: "config.changed" };
    for (const listener of events) {
      listener(event);
    }
    expect(request).toHaveBeenCalledOnce();
    const server = {
      ...result.servers[0]!,
      mentionTool: "search",
      entrypoints: result.servers[0]!.entrypoints.flatMap((entry) => [
        entry,
        {
          ...entry,
          title: `${entry.title} alternate`,
          resourceUri: `${entry.resourceUri}-alternate`,
        },
      ]),
    };
    current.resolve({ servers: [server] });
    await current.promise;
    await waitForSolid(() => {
      expect(sidebar.textContent).toContain("Library");
      expect(thread.querySelector("button")).not.toBeNull();
      expect(resources.querySelector("button")).not.toBeNull();
    });

    thread.querySelector<HTMLButtonElement>("button")!.click();
    await waitForSolid(() =>
      expect(thread.querySelectorAll(".mcp-app-catalog__entry > button")).toHaveLength(2),
    );
    const sidebarEntry = sidebar.querySelectorAll<HTMLButtonElement>("button")[1]!;
    const threadEntry = thread.querySelectorAll<HTMLButtonElement>(
      ".mcp-app-catalog__entry > button",
    )[1]!;
    sidebarEntry.focus();
    for (const listener of events) {
      listener(event);
    }
    await waitForSolid(() => {
      expect(request).toHaveBeenCalledTimes(2);
      expect(sidebar.querySelectorAll("button")[1]).toBe(sidebarEntry);
      expect(document.activeElement).toBe(sidebarEntry);
      expect(thread.querySelectorAll(".mcp-app-catalog__entry > button")[1]).toBe(threadEntry);
    });
    refreshed.resolve({
      servers: [
        {
          ...server,
          label: "Updated parts plugin",
          entrypoints: server.entrypoints.map((entry) =>
            Object.assign({}, entry, {
              title: `Updated ${entry.title}`,
              resourceUri: `${entry.resourceUri}-updated`,
            }),
          ),
        },
      ],
    });
    await refreshed.promise;
    await waitForSolid(() => {
      expect(sidebar.querySelectorAll("button")).toHaveLength(2);
      expect(sidebar.querySelectorAll("button")[1]).toBe(sidebarEntry);
      expect(document.activeElement).toBe(sidebarEntry);
      expect(sidebarEntry.textContent).toBe("Updated Library alternate");
      expect(sidebarEntry.title).toBe("Updated parts plugin");
      expect(thread.querySelectorAll(".mcp-app-catalog__entry > button")).toHaveLength(2);
      expect(thread.querySelectorAll(".mcp-app-catalog__entry > button")[1]).toBe(threadEntry);
      expect(threadEntry.textContent).toContain("Updated Parts tray alternate");
    });
    for (const listener of events) {
      listener(event);
    }
    await waitForSolid(() => expect(request).toHaveBeenCalledTimes(3));
    failed.reject(new Error("Discovery refresh unavailable"));
    await failed.promise.catch(() => {});
    await waitForSolid(() =>
      expect(thread.querySelector('[role="alert"]')?.textContent).toContain(
        "Discovery refresh unavailable",
      ),
    );
    expect(sidebar.querySelectorAll("button")[1]).toBe(sidebarEntry);
    expect(document.activeElement).toBe(sidebarEntry);
    expect(thread.querySelectorAll(".mcp-app-catalog__entry > button")[1]).toBe(threadEntry);

    thread.querySelector<HTMLButtonElement>('[role="alert"] + button')!.click();
    await waitForSolid(() => {
      expect(request).toHaveBeenCalledTimes(4);
      expect(thread.querySelector('[role="alert"]')).toBeNull();
      expect(thread.querySelector('[role="status"]')?.textContent).toBe(t("mcpApp.loading"));
    });
    expect(thread.querySelectorAll(".mcp-app-catalog__entry > button")[1]).toBe(threadEntry);
    retried.resolve({ servers: [server] });
    await retried.promise;
    await waitForSolid(() => expect(threadEntry.textContent).toContain("Parts tray alternate"));
    expect(thread.querySelectorAll(".mcp-app-catalog__entry > button")[1]).toBe(threadEntry);

    const launch = vi.fn((launchEvent: Event) => launchEvent.preventDefault());
    thread.addEventListener(MCP_APP_OPEN_EVENT, launch);
    threadEntry.click();
    expect(launch).toHaveBeenCalledOnce();
    expect(launch.mock.calls[0]![0]).toMatchObject({
      detail: {
        entrypoint: {
          title: "Parts tray alternate",
          resourceUri: "ui://parts/tray-alternate",
        },
      },
    });

    sidebarMount.unmount();
    sidebarMount = mountCatalog(context, sidebarProps);
    sidebar = sidebarMount.element;
    await waitForSolid(() => expect(request).toHaveBeenCalledTimes(5));
    remounted.resolve({ servers: [] });
    await remounted.promise;
    await waitForSolid(() => expect(sidebar.querySelector("button")).toBeNull());
  });

  it("retries failed discovery through the mounted error control", async () => {
    const failed = createDeferred<McpAppDiscoverResult>();
    const retry = createDeferred<McpAppDiscoverResult>();
    const request = vi.fn().mockReturnValueOnce(failed.promise).mockReturnValueOnce(retry.promise);
    const { context } = discoveryContext(request);
    const { element: catalog } = mountCatalog(context, { sessionKey: "agent:main:one" });
    await waitForSolid(() => {
      expect(request).toHaveBeenCalledOnce();
      expect(catalog.querySelector('[role="status"]')?.textContent).toBe(t("mcpApp.loading"));
      expect(catalog.textContent).not.toContain(t("mcpApp.empty"));
    });
    failed.reject(new Error("Discovery unavailable"));
    await failed.promise.catch(() => {});
    flush();
    await waitForSolid(() =>
      expect(catalog.querySelector('[role="alert"]')?.textContent).toContain(
        "Discovery unavailable",
      ),
    );

    catalog.querySelector<HTMLButtonElement>('[role="alert"] + button')!.click();
    expect(request).toHaveBeenCalledTimes(2);
    retry.resolve(result);
    await retry.promise;
    flush();
    await waitForSolid(() => expect(catalog.textContent).toContain("Library"));
  });

  it("names each app settings button after its app", async () => {
    const request = vi.fn().mockResolvedValue({
      servers: ["Parts", "Notes"].map((title) => ({
        serverName: title.toLowerCase(),
        label: `${title} plugin`,
        settings: { readTool: "read", updateTool: "update" },
        entrypoints: [
          { title, toolName: "show", resourceUri: "ui://app/show", entrypoint: { type: "global" } },
        ],
      })),
    } satisfies McpAppDiscoverResult);
    const { element: catalog } = mountCatalog(discoveryContext(request).context, {
      sessionKey: "agent:main:one",
    });
    await waitForSolid(() =>
      expect(
        [...catalog.querySelectorAll("button")]
          .filter((button) => button.textContent === "App settings")
          .map((button) => button.getAttribute("aria-label")),
      ).toEqual(["App settings: Parts", "App settings: Notes"]),
    );
  });

  it("discovers again after creating a session while an earlier lookup is pending", async () => {
    const previous = createDeferred<McpAppDiscoverResult>();
    const current = createDeferred<McpAppDiscoverResult>();
    const created = createDeferred<{ key: string }>();
    const request = vi
      .fn()
      .mockReturnValueOnce(previous.promise)
      .mockReturnValueOnce(current.promise);
    const createResult = vi.fn(() => created.promise);
    const context = {
      ...discoveryContext(request).context,
      sessions: {
        describe: async () => ({ session: null }),
        createResult,
        state: { error: null },
      },
    };
    mountCatalog(context, {
      surface: "sidebar",
      sessionKey: "agent:main:one",
    });
    await waitForSolid(() => expect(request).toHaveBeenCalledOnce());

    const { element: apps } = mountCatalog(context, { sessionKey: "agent:main:one" });
    await waitForSolid(() => expect(createResult).toHaveBeenCalledOnce());
    created.resolve({ key: "agent:main:one" });
    await created.promise;
    await waitForSolid(() => expect(request).toHaveBeenCalledTimes(2));
    current.resolve(result);
    await current.promise;
    flush();
    await waitForSolid(() => expect(apps.textContent).toContain("Library"));

    previous.reject(new Error("The requested session is unavailable"));
    await previous.promise.catch(() => {});
    await Promise.resolve();
    flush();
    expect(apps.querySelector('[role="alert"]')).toBeNull();
    await waitForSolid(() => expect(apps.textContent).toContain("Library"));
  });

  it.each([false])(
    "prepares global discovery only for a missing session (exists: %s)",
    async (exists) => {
      let admitted = exists;
      const createResult = vi.fn(async () => {
        admitted = true;
        return { key: "agent:main:main" };
      });
      const request = vi.fn(async () => {
        if (!admitted) {
          throw new Error("The requested session is unavailable; open an existing session first.");
        }
        return result;
      });
      const configChanged = new Set<(event: { event: string }) => void>();
      const describeSession = vi.fn(async () => ({
        session: exists ? { key: "agent:main:main" } : null,
      }));
      // SAFETY: The fixture supplies the capabilities exercised by Apps and discovery.
      const context = {
        gateway: {
          snapshot: {
            sessionKey: "agent:main:main",
            client: { request },
            phase: "connected",
            hello: gatewayHelloForMethods(["mcp.app.discover"]),
          },
          connectionRevision: 1,
          connection: { gatewayUrl: "ws://gateway.example.test" },
          subscribe: () => () => {},
          subscribeEvents: (listener: (event: { event: string }) => void) => {
            configChanged.add(listener);
            return () => configChanged.delete(listener);
          },
        },
        sessions: {
          createResult,
          state: { error: null },
          describe: describeSession,
        },
        agentSelection: { state: { selectedId: "main" }, subscribe: () => () => {} },
      } as unknown as ApplicationContext;
      const { container: element } = mountSolid(() => createComponent(AppsPage, {}), {
        wrapper: createSolidApplicationContextProvider(context).wrapper,
      });
      flush();
      await waitForSolid(() => expect(element.textContent).toContain("Library"));
      if (exists) {
        expect(createResult).not.toHaveBeenCalled();
      } else {
        expect(createResult).toHaveBeenCalledExactlyOnceWith(
          { key: "agent:main:main", agentId: "main" },
          { reconciliation: "background", signal: expect.any(AbortSignal) },
        );
      }
      expect(request).toHaveBeenCalledWith("mcp.app.discover", {
        sessionKey: "agent:main:main",
        agentId: "main",
      });
      expect(element.querySelector('[role="alert"]')).toBeNull();
      for (const listener of configChanged) {
        listener({ event: "config.changed" });
      }
      await waitForSolid(() => expect(request).toHaveBeenCalledTimes(2));
      expect(describeSession).toHaveBeenCalledExactlyOnceWith({
        key: "agent:main:main",
        agentId: "main",
      });
      expect(createResult).toHaveBeenCalledTimes(exists ? 0 : 1);
      expect(request).toHaveBeenCalledTimes(2);
    },
  );
  it.each(["unchanged", "session changed", "agent changed"] as const)(
    "onboards once without crypto.randomUUID and respects the current target (%s)",
    async (target) => {
      vi.stubGlobal("crypto", { getRandomValues: crypto.getRandomValues.bind(crypto) });
      const read = createDeferred<McpAppDiscoverResult>();
      const onboarding = createDeferred<Record<string, never>>();
      const request = vi.fn((method: string) =>
        method === "mcp.app.onboard" ? onboarding.promise : read.promise,
      );
      const navigate = vi.fn();
      const mounted = mountCatalog(
        {
          gateway: createDiscoveryGateway(request),
          agentSelection: { state: { selectedId: "main" }, subscribe: () => () => {} },
          agents: { state: { agentsList: null } },
          sessions: {
            state: { result: null },
            describe: async () => ({ session: { key: "agent:main:one" } }),
          },
          basePath: "",
          navigate,
        },
        { sessionKey: "agent:main:one" },
      );
      const { element } = mounted;
      await waitForSolid(() => expect(request).toHaveBeenCalledOnce());
      read.resolve({ servers: [], onboarding: [{ pluginId: "parts", title: "Parts plugin" }] });
      const onboardingButton = () =>
        [...element.querySelectorAll<HTMLButtonElement>("button")].find((control) =>
          control.textContent?.includes("Parts plugin"),
        );
      const button = await waitForSolid(() => {
        const candidate = onboardingButton();
        expect(candidate).toBeDefined();
        return candidate!;
      });
      button.click();
      button.click();
      flush();
      expect(button.disabled).toBe(true);
      expect(request.mock.calls.filter(([method]) => method === "mcp.app.onboard")).toHaveLength(1);
      expect(request).toHaveBeenCalledWith("mcp.app.onboard", {
        sessionKey: "agent:main:one",
        agentId: "main",
        pluginId: "parts",
        idempotencyKey: expect.stringMatching(
          /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
        ),
      });
      if (target === "session changed") {
        mounted.update({ sessionKey: "agent:main:two" });
      } else if (target === "agent changed") {
        mounted.update({ agentId: "other" });
      }
      onboarding.resolve({});
      await waitForSolid(() => expect(onboardingButton()?.disabled).toBe(false));
      if (target === "unchanged") {
        await waitForSolid(() => expect(navigate).toHaveBeenCalledWith("chat", expect.any(Object)));
      } else {
        expect(navigate).not.toHaveBeenCalled();
      }
      expect(element.querySelector('[role="alert"]')).toBeNull();
    },
  );
  it("keeps onboarding failures beside the catalog and clears them for a replacement target", async () => {
    const onboarding = createDeferred<unknown>();
    const discovery = { servers: [], onboarding: [{ pluginId: "parts", title: "Parts plugin" }] };
    const request = vi.fn((method: string) =>
      method === "mcp.app.onboard" ? onboarding.promise : Promise.resolve(discovery),
    );
    const { context } = discoveryContext(request);
    const mounted = mountCatalog(context, { sessionKey: "agent:main:one" });
    const { element } = mounted;
    const button = await waitForSolid(() => {
      const control = [...element.querySelectorAll<HTMLButtonElement>("button")].find((candidate) =>
        candidate.textContent?.includes("Parts plugin"),
      );
      expect(control).toBeDefined();
      return control!;
    });
    const entries = element.querySelector(".mcp-app-catalog__entries");
    button.click();
    await waitForSolid(() => expect(button.disabled).toBe(true));
    onboarding.reject(new Error("Onboarding unavailable"));
    await waitForSolid(() => {
      expect(element.querySelector('[role="alert"]')?.textContent).toBe("Onboarding unavailable");
      expect(button.disabled).toBe(false);
    });
    expect(element.querySelector(".mcp-app-catalog__entries")).toBe(entries);
    mounted.update({ sessionKey: "agent:main:two" });
    await waitForSolid(() => expect(element.querySelector('[role="alert"]')).toBeNull());
    expect(element.querySelector(".mcp-app-catalog__entries")).toBe(entries);
  });
  it.each(["file"] as const)(
    "hides unsupported %s controls after empty discovery",
    async (surface) => {
      const read = createDeferred<McpAppDiscoverResult>();
      const { element } = mountCatalog(
        {
          gateway: createDiscoveryGateway(() => read.promise),
          agentSelection: { state: { selectedId: "main" }, subscribe: () => () => {} },
        },
        { surface, sessionKey: "agent:main:empty" },
      );
      flush();
      read.resolve({ servers: [], onboarding: [] });
      await read.promise;
      await Promise.resolve();
      flush();
      expect(element.querySelector("button")).toBeNull();
      expect(element.querySelector('[role="alert"]')).toBeNull();
    },
  );
  it("ignores discovery from a replaced conversation", async () => {
    const first = createDeferred<McpAppDiscoverResult>();
    const second = createDeferred<McpAppDiscoverResult>();
    const request = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const mounted = mountCatalog(
      {
        gateway: createDiscoveryGateway(request),
        agentSelection: { state: { selectedId: "main" }, subscribe: () => () => {} },
      },
      { surface: "sidebar", sessionKey: "agent:main:one" },
    );
    const element = mounted.element;
    await waitForSolid(() => expect(request).toHaveBeenCalledOnce());
    mounted.update({ sessionKey: "agent:main:two" });
    await waitForSolid(() => expect(request).toHaveBeenCalledTimes(2));
    second.resolve({ servers: [] });
    await second.promise;
    flush();
    first.resolve(result);
    await first.promise;
    await Promise.resolve();
    flush();
    expect(element.textContent).not.toContain("Library");
    expect(request).toHaveBeenCalledTimes(2);
  });
  it("reports an unavailable host, then launches the thread app through its owner without a prompt", async () => {
    const read = createDeferred<McpAppDiscoverResult>();
    const request = vi.fn(() => read.promise);
    const client = { request };
    const gateway = {
      snapshot: {
        client,
        phase: "connected",
        sessionKey: "agent:main:one",
        hello: gatewayHelloForMethods(["mcp.app.discover"]),
      },
      connectionRevision: 1,
      subscribe: () => () => {},
      subscribeEvents: () => () => {},
    };
    const { element } = mountCatalog(
      {
        gateway,
        agentSelection: { state: { selectedId: "main" }, subscribe: () => () => {} },
      },
      { surface: "thread", sessionKey: "agent:main:one", agentId: "main" },
    );
    await waitForSolid(() => expect(request).toHaveBeenCalledOnce());
    read.resolve(result);
    await waitForSolid(() => expect(element.querySelector("button")).not.toBeNull());
    element.querySelector<HTMLButtonElement>("button")!.click();
    flush();
    const launch = vi.fn((event: Event) => event.preventDefault());
    const button = await waitForSolid(() => {
      const candidate = [...element.querySelectorAll<HTMLButtonElement>("button")].find((control) =>
        control.textContent?.includes("Parts tray"),
      );
      expect(candidate).toBeDefined();
      return candidate!;
    });
    button.click();
    await waitForSolid(() =>
      expect(element.querySelector('[role="alert"]')?.textContent).toBe(
        t("mcpApp.errors.mountUnavailable"),
      ),
    );
    element.addEventListener(MCP_APP_OPEN_EVENT, launch);
    button.click();
    await waitForSolid(() => expect(element.querySelector('[role="alert"]')).toBeNull());
    expect(launch.mock.calls[0]![0].target).toBe(element);
    expect((launch.mock.calls[0]![0] as CustomEvent<McpAppOpenDetail>).detail).toMatchObject({
      sessionKey: "agent:main:one",
      agentId: "main",
      serverName: "parts",
      owner: client,
      entrypoint: { toolName: "tray" },
    });
    expect(request.mock.calls).toEqual([
      ["mcp.app.discover", { sessionKey: "agent:main:one", agentId: "main" }],
    ]);
  });
});
