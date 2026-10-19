import { createComponent, flush } from "solid-js";
import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { GatewayPendingRequests } from "../../../packages/gateway-client/src/pending-request.js";
import type { RequestFrame } from "../../../packages/gateway-protocol/src/schema/frames.js";
import { GATEWAY_STARTUP_ADMISSION_WAIT_MS } from "../../../packages/gateway-protocol/src/startup-unavailable.js";
import type { McpAppDiscoverResult } from "../../../src/shared/mcp-app-extensions.js";
import { createDeferred } from "../../../test/helpers/promise.js";
import type { GatewayEventFrame } from "../api/gateway.ts";
import type { ApplicationContext } from "../app/context.ts";
import {
  createTestSessionCapability,
  sessionsResult,
} from "../lib/sessions/session-capability.test-support.ts";
import { AppsPage } from "../pages/apps/apps-page.tsx";
import { createApplicationGateway } from "../test-helpers/application-context-fixtures.ts";
import { createApplicationContextProvider } from "../test-helpers/application-context.ts";
import {
  createGatewayRequestMock,
  createTestGatewayClient,
} from "../test-helpers/gateway-client.ts";
import { gatewayHelloForMethods } from "../test-helpers/gateway-methods.ts";
import { mountSolid } from "../test-helpers/mount-solid.ts";
import "./mcp-app-catalog.tsx";
import { createSolidApplicationContextProvider } from "../test-helpers/solid-application-context.tsx";
import { waitForSolid } from "../test-helpers/solid-settle.ts";
import { MCP_APP_OPEN_EVENT, type McpAppOpenDetail } from "./mcp-app-launch.ts";
import "./mcp-app-resources.tsx";

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

const providers = new WeakMap<HTMLElement, HTMLElement>();
function provide(element: HTMLElement, context: unknown) {
  // SAFETY: fixtures supply precisely the capabilities exercised by these catalog flows.
  const provider = createApplicationContextProvider(context as ApplicationContext);
  provider.append(element);
  providers.set(element, provider);
}
function appendElement(element: HTMLElement) {
  const provider = providers.get(element);
  if (provider) {
    provider.append(element);
    document.body.append(provider);
  } else {
    document.body.append(element);
  }
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
    const catalog = document.createElement("openclaw-mcp-app-catalog");
    catalog.sessionKey = "agent:main:one";
    provide(catalog, {
      ...discoveryContext(request).context,
      gateway,
      sessions: { describe: describeSession, createResult, state: { error: null } },
    });
    appendElement(catalog);
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
    const catalog = document.createElement("openclaw-mcp-app-catalog");
    catalog.surface = "thread";
    catalog.sessionKey = "agent:main:one";
    provide(catalog, context);
    appendElement(catalog);
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
      const catalog = document.createElement("openclaw-mcp-app-catalog");
      catalog.sessionKey = "agent:main:one";
      catalog.agentId = "main";
      provide(catalog, {
        gateway,
        sessions,
        agentSelection: { state: { selectedId: "main" }, subscribe: () => () => {} },
      });
      appendElement(catalog);
      await issued.promise;
      await vi.advanceTimersByTimeAsync(45_000);
      expect(writes).toHaveLength(0);
      expect(pending.hasPending).toBe(true);

      if (lifetime === "closed") {
        catalog.remove();
        await Promise.resolve();
      } else if (lifetime === "agent changed") {
        catalog.agentId = "other";
      } else if (lifetime === "conversation changed") {
        catalog.sessionKey = "agent:main:two";
      }
      await catalog.updateComplete;
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
    // Observe the page-to-conversation contract without loading the conversation runtime.
    const lookup = customElements.get.bind(customElements);
    vi.spyOn(customElements, "get").mockImplementation((name) =>
      name === "openclaw-chat-pane" ? HTMLElement : lookup(name),
    );
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
    { scope: "operator.read", discover: false },
    { scope: "operator.sessions.read", discover: false },
    { scope: "operator.sessions.write", discover: true },
  ])("admits discovery according to granted scope $scope", async ({ scope, discover }) => {
    const request = vi.fn(async () => ({ servers: [] }));
    const { context } = discoveryContext(request, [scope]);
    const catalog = document.createElement("openclaw-mcp-app-catalog");
    catalog.sessionKey = "agent:main:one";
    provide(catalog, context);
    appendElement(catalog);
    await catalog.updateComplete;
    expect(request.mock.calls).toHaveLength(discover ? 1 : 0);
  });

  it("shares discovery and retains focused entries through refresh before remounting", async () => {
    const current = createDeferred<McpAppDiscoverResult>();
    const refreshed = createDeferred<McpAppDiscoverResult>();
    const remounted = createDeferred<McpAppDiscoverResult>();
    const request = vi
      .fn()
      .mockReturnValueOnce(current.promise)
      .mockReturnValueOnce(refreshed.promise)
      .mockReturnValueOnce(remounted.promise);
    const { context, events } = discoveryContext(request);
    const sidebar = document.createElement("openclaw-mcp-app-catalog");
    sidebar.surface = "sidebar";
    const thread = document.createElement("openclaw-mcp-app-catalog");
    thread.surface = "thread";
    const resources = document.createElement("openclaw-mcp-app-resources");
    const elements = [sidebar, thread, resources];
    for (const element of elements) {
      element.sessionKey = "agent:main:one";
      element.agentId = "main";
      provide(element, context);
      appendElement(element);
      await element.updateComplete;
    }
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
    for (const element of elements) {
      await element.updateComplete;
    }
    await waitForSolid(() => expect(sidebar.textContent).toContain("Library"));
    expect(thread.querySelector("button")).not.toBeNull();
    expect(resources.querySelector("button")).not.toBeNull();

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
    const launch = vi.fn((launchEvent: Event) => launchEvent.preventDefault());
    thread.addEventListener(MCP_APP_OPEN_EVENT, launch);
    threadEntry.click();
    expect(launch).toHaveBeenCalledOnce();
    expect(launch.mock.calls[0]![0]).toMatchObject({
      detail: {
        entrypoint: {
          title: "Updated Parts tray alternate",
          resourceUri: "ui://parts/tray-alternate-updated",
        },
      },
    });

    sidebar.remove();
    await Promise.resolve();
    appendElement(sidebar);
    await sidebar.updateComplete;
    await waitForSolid(() => expect(request).toHaveBeenCalledTimes(3));
    remounted.resolve({ servers: [] });
    await remounted.promise;
    await sidebar.updateComplete;
    await sidebar.updateComplete;
    expect(sidebar.querySelector("button")).toBeNull();
  });

  it("retries failed discovery through the mounted error control", async () => {
    const failed = createDeferred<McpAppDiscoverResult>();
    const retry = createDeferred<McpAppDiscoverResult>();
    const request = vi.fn().mockReturnValueOnce(failed.promise).mockReturnValueOnce(retry.promise);
    const { context } = discoveryContext(request);
    const catalog = document.createElement("openclaw-mcp-app-catalog");
    catalog.sessionKey = "agent:main:one";
    provide(catalog, context);
    appendElement(catalog);
    await catalog.updateComplete;
    await catalog.updateComplete;
    failed.reject(new Error("Discovery unavailable"));
    await failed.promise.catch(() => {});
    await catalog.updateComplete;
    await catalog.updateComplete;
    await waitForSolid(() =>
      expect(catalog.querySelector('[role="alert"]')?.textContent).toContain(
        "Discovery unavailable",
      ),
    );

    catalog.querySelector<HTMLButtonElement>('[role="alert"] + button')!.click();
    expect(request).toHaveBeenCalledTimes(2);
    retry.resolve(result);
    await retry.promise;
    await catalog.updateComplete;
    await catalog.updateComplete;
    await waitForSolid(() => expect(catalog.textContent).toContain("Library"));
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
    const sidebar = document.createElement("openclaw-mcp-app-catalog");
    sidebar.surface = "sidebar";
    sidebar.sessionKey = "agent:main:one";
    provide(sidebar, context);
    appendElement(sidebar);
    await sidebar.updateComplete;
    expect(request).toHaveBeenCalledOnce();

    const apps = document.createElement("openclaw-mcp-app-catalog");
    apps.sessionKey = sidebar.sessionKey;
    provide(apps, context);
    appendElement(apps);
    await apps.updateComplete;
    await apps.updateComplete;
    expect(createResult).toHaveBeenCalledOnce();
    created.resolve({ key: sidebar.sessionKey });
    await created.promise;
    expect(request).toHaveBeenCalledTimes(2);
    current.resolve(result);
    await current.promise;
    await apps.updateComplete;
    await waitForSolid(() => expect(apps.textContent).toContain("Library"));

    previous.reject(new Error("The requested session is unavailable"));
    await previous.promise.catch(() => {});
    await sidebar.updateComplete;
    await apps.updateComplete;
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
      const provider = createApplicationContextProvider(context);
      document.body.append(provider);
      const { container: element } = mountSolid(() => createComponent(AppsPage, {}), {
        container: provider,
        wrapper: createSolidApplicationContextProvider(context).wrapper,
      });
      flush();
      const catalog = element.querySelector<HTMLElementTagNameMap["openclaw-mcp-app-catalog"]>(
        "openclaw-mcp-app-catalog",
      )!;
      await catalog.updateComplete;
      await catalog.updateComplete;
      await catalog.updateComplete;
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
      flush();
      await waitForSolid(() => expect(element.textContent).toContain("Library"));
      expect(element.querySelector('[role="alert"]')).toBeNull();
      for (const listener of configChanged) {
        listener({ event: "config.changed" });
      }
      await catalog.updateComplete;
      flush();
      expect(describeSession).toHaveBeenCalledExactlyOnceWith({
        key: "agent:main:main",
        agentId: "main",
      });
      expect(createResult).toHaveBeenCalledTimes(exists ? 0 : 1);
      expect(request).toHaveBeenCalledTimes(2);
    },
  );
  it("onboards an app without crypto.randomUUID on insecure origins", async () => {
    vi.stubGlobal("crypto", { getRandomValues: crypto.getRandomValues.bind(crypto) });
    const read = createDeferred<McpAppDiscoverResult>();
    const request = vi.fn().mockReturnValueOnce(read.promise).mockResolvedValue({});
    const navigate = vi.fn();
    const element = document.createElement("openclaw-mcp-app-catalog");
    element.sessionKey = "agent:main:one";
    provide(element, {
      gateway: {
        snapshot: {
          client: { request },
          phase: "connected",
          hello: gatewayHelloForMethods(["mcp.app.discover"]),
        },
        connectionRevision: 1,
        subscribe: () => () => {},
        subscribeEvents: () => () => {},
      },
      agentSelection: { state: { selectedId: "main" }, subscribe: () => () => {} },
      agents: { state: { agentsList: null } },
      sessions: {
        state: { result: null },
        describe: async () => ({ session: { key: "agent:main:one" } }),
      },
      basePath: "",
      navigate,
    });
    appendElement(element);
    await element.updateComplete;
    read.resolve({ servers: [], onboarding: [{ pluginId: "parts", title: "Parts plugin" }] });
    await read.promise;
    await element.updateComplete;
    const button = [...element.querySelectorAll<HTMLButtonElement>("button")].find((candidate) =>
      candidate.textContent?.includes("Parts plugin"),
    );
    expect(button).toBeDefined();
    button!.click();
    await element.updateComplete;
    expect(request).toHaveBeenCalledWith("mcp.app.onboard", {
      sessionKey: "agent:main:one",
      agentId: "main",
      pluginId: "parts",
      idempotencyKey: expect.stringMatching(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
      ),
    });
    await waitForSolid(() => expect(navigate).toHaveBeenCalledWith("chat", expect.any(Object)));
    expect(element.querySelector('[role="alert"]')).toBeNull();
  });
  it.each(["file"] as const)(
    "hides unsupported %s controls after empty discovery",
    async (surface) => {
      const read = createDeferred<McpAppDiscoverResult>();
      const element = document.createElement("openclaw-mcp-app-catalog");
      element.surface = surface;
      element.sessionKey = "agent:main:empty";
      provide(element, {
        gateway: {
          snapshot: {
            client: { request: () => read.promise },
            phase: "connected",
            hello: gatewayHelloForMethods(["mcp.app.discover"]),
          },
          connectionRevision: 1,
          subscribe: () => () => {},
          subscribeEvents: () => () => {},
        },
        agentSelection: { state: { selectedId: "main" }, subscribe: () => () => {} },
      });
      appendElement(element);
      await element.updateComplete;
      read.resolve({ servers: [], onboarding: [] });
      await read.promise;
      await element.updateComplete;
      expect(element.querySelector("button")).toBeNull();
      expect(element.querySelector('[role="alert"]')).toBeNull();
    },
  );
  it("ignores discovery from a replaced conversation", async () => {
    const first = createDeferred<McpAppDiscoverResult>();
    const second = createDeferred<McpAppDiscoverResult>();
    const request = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const element = document.createElement("openclaw-mcp-app-catalog");
    element.surface = "sidebar";
    provide(element, {
      gateway: {
        snapshot: {
          client: { request },
          phase: "connected",
          hello: gatewayHelloForMethods(["mcp.app.discover"]),
        },
        connectionRevision: 1,
        subscribe: () => () => {},
        subscribeEvents: () => () => {},
      },
      agentSelection: { state: { selectedId: "main" }, subscribe: () => () => {} },
    });
    element.sessionKey = "agent:main:one";
    appendElement(element);
    await element.updateComplete;
    element.sessionKey = "agent:main:two";
    await element.updateComplete;
    second.resolve({ servers: [] });
    await second.promise;
    await element.updateComplete;
    first.resolve(result);
    await first.promise;
    await element.updateComplete;
    expect(element.textContent).not.toContain("Library");
    expect(request).toHaveBeenCalledTimes(2);
  });
  it("launches the selected thread app through its conversation owner without sending a prompt", async () => {
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
    const element = document.createElement("openclaw-mcp-app-catalog");
    provide(element, {
      gateway,
      agentSelection: { state: { selectedId: "main" }, subscribe: () => () => {} },
    });
    element.surface = "thread";
    element.sessionKey = "agent:main:one";
    element.agentId = "main";
    appendElement(element);
    await element.updateComplete;
    read.resolve(result);
    await read.promise;
    await element.updateComplete;
    element.querySelector<HTMLButtonElement>("button")!.click();
    await element.updateComplete;
    const launch = vi.fn((event: Event) => event.preventDefault());
    element.addEventListener(MCP_APP_OPEN_EVENT, launch);
    const button = [...element.querySelectorAll<HTMLButtonElement>("button")].find((candidate) =>
      candidate.textContent?.includes("Parts tray"),
    );
    expect(button).toBeDefined();
    button!.click();
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
