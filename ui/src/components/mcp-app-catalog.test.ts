import { createComponent, flush } from "solid-js";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { McpAppDiscoverResult } from "../../../src/shared/mcp-app-extensions.js";
import { createDeferred } from "../../../test/helpers/promise.js";
import type { GatewayEventFrame } from "../api/gateway.ts";
import type { ApplicationContext } from "../app/context.ts";
import { AppsPage } from "../pages/apps/apps-page.tsx";
import { createApplicationGateway } from "../test-helpers/application-context-fixtures.ts";
import { createApplicationContextProvider } from "../test-helpers/application-context.ts";
import { createTestGatewayClient } from "../test-helpers/gateway-client.ts";
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
});
const server = {
  serverName: "parts",
  label: "Parts plugin",
  entrypoints: [
    makeEntry("Parts tray", "tray", "thread"),
    makeEntry("Library", "library", "global"),
  ],
};
const result: McpAppDiscoverResult = { servers: [server] };
const target = { sessionKey: "agent:main:one", agentId: "main" };
const mainTarget = { sessionKey: "agent:main:main", agentId: "main" };
const mainReference = { key: mainTarget.sessionKey, agentId: mainTarget.agentId };
function makeEntry(title: string, toolName: string, type: "thread" | "global") {
  return { title, toolName, resourceUri: `ui://parts/${toolName}`, entrypoint: { type } };
}
function reviseServer(value: typeof server, suffix: string, prefix = "") {
  return {
    ...value,
    entrypoints: value.entrypoints.map((entry) => ({
      ...entry,
      title: prefix + entry.title,
      resourceUri: entry.resourceUri + suffix,
    })),
  };
}

function gatewayContext(request: ReturnType<typeof vi.fn>, scopes = ["operator.admin"]) {
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
    },
  };
}

function discoveryContext(request: ReturnType<typeof vi.fn>, scopes?: string[]) {
  const fixture = gatewayContext(request, scopes);
  return {
    ...fixture,
    context: {
      ...fixture.context,
      sessions: {
        describe: async () => ({
          session: { key: "agent:main:one", kind: "direct" as const, updatedAt: 1 },
        }),
      },
    },
  };
}

function discoveryQueue() {
  const request = vi.fn();
  const next = () => {
    const read = createDeferred<McpAppDiscoverResult>();
    request.mockReturnValueOnce(read.promise);
    return read;
  };
  return { request, next };
}

function emitConfigChanged(events: Set<(event: GatewayEventFrame) => void>) {
  for (const listener of events) {
    listener({ type: "event", event: "config.changed" });
  }
}

const providers = new WeakMap<HTMLElement, HTMLElement>();
function appendElement(element: HTMLElement, context?: unknown) {
  // SAFETY: supplied fixtures cover these flows; remounts retain the original provider.
  const provider =
    providers.get(element) ?? createApplicationContextProvider(context as ApplicationContext);
  provider.append(element);
  providers.set(element, provider);
  document.body.append(provider);
}

function mountCatalog(
  context: unknown,
  props: Partial<HTMLElementTagNameMap["openclaw-mcp-app-catalog"]> = {},
) {
  const element = Object.assign(document.createElement("openclaw-mcp-app-catalog"), {
    sessionKey: "agent:main:one",
    ...props,
  });
  appendElement(element, context);
  return element;
}
const threadEntries = (element: HTMLElement) =>
  element.querySelectorAll<HTMLButtonElement>(".mcp-app-catalog__entry > button");
const buttons = (element: HTMLElement) => element.querySelectorAll<HTMLButtonElement>("button");
function clickButton(element: HTMLElement, text: string) {
  const button = [...buttons(element)].find((candidate) => candidate.textContent?.includes(text));
  expect(button).toBeDefined();
  button!.click();
}
const expectLaunch = (container: HTMLElement, sessionKey: string, resourceUri: string) =>
  waitForSolid(() =>
    expect(container.querySelector("openclaw-chat-pane")?.mcpAppLaunch).toMatchObject({
      sessionKey,
      entrypoint: { resourceUri },
    }),
  );

describe("app launch catalog", () => {
  it("waits for the new session's discovery before retaining an Apps page launch", async () => {
    // Observe the page-to-conversation contract without loading the conversation runtime.
    const lookup = customElements.get.bind(customElements);
    vi.spyOn(customElements, "get").mockImplementation((name) =>
      name === "openclaw-chat-pane" ? HTMLElement : lookup(name),
    );
    const { request, next } = discoveryQueue();
    const first = next();
    const second = next();
    const { gateway, publish } = createApplicationGateway();
    publish({
      ...gateway.snapshot,
      client: createTestGatewayClient(request),
      phase: "connected",
      sessionKey: "agent:main:one",
      hello: gatewayHelloForMethods(["mcp.app.discover"]),
    });
    // SAFETY: This mounted page fixture supplies the discovery and launch capabilities it uses.
    const context = { ...discoveryContext(request).context, gateway };
    const { container, unmount } = mountSolid(
      () => createComponent(AppsPage, { appSearch: "?server=parts&tool=library" }),
      { wrapper: createSolidApplicationContextProvider(context as ApplicationContext).wrapper },
    );
    try {
      await waitForSolid(() => expect(request).toHaveBeenCalledOnce());
      first.resolve(result);
      await expectLaunch(container, target.sessionKey, "ui://parts/library");
      publish({ ...gateway.snapshot, sessionKey: "agent:main:two" });
      flush();
      expect(container.querySelector("openclaw-chat-pane")).toBeNull();
      await waitForSolid(() => expect(request).toHaveBeenCalledTimes(2));
      second.resolve({ servers: [reviseServer(server, "-second")] });
      await expectLaunch(container, "agent:main:two", "ui://parts/library-second");
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
    const element = mountCatalog(context);
    await element.updateComplete;
    expect(request.mock.calls).toHaveLength(discover ? 1 : 0);
  });

  it("shares discovery and retains focused entries through refresh before remounting", async () => {
    const { request, next } = discoveryQueue();
    const current = next();
    const refreshed = next();
    const remounted = next();
    const { context, events } = discoveryContext(request);
    const sidebar = document.createElement("openclaw-mcp-app-catalog");
    sidebar.surface = "sidebar";
    const thread = document.createElement("openclaw-mcp-app-catalog");
    thread.surface = "thread";
    const resources = document.createElement("openclaw-mcp-app-resources");
    const elements = [sidebar, thread, resources];
    for (const element of elements) {
      Object.assign(element, target);
      appendElement(element, context);
      await element.updateComplete;
    }
    expect(request).toHaveBeenCalledExactlyOnceWith("mcp.app.discover", target);

    emitConfigChanged(events);
    expect(request).toHaveBeenCalledOnce();
    const alternates = {
      ...server,
      mentionTool: "search",
      entrypoints: server.entrypoints.flatMap((entry) => [
        entry,
        {
          ...entry,
          title: `${entry.title} alternate`,
          resourceUri: `${entry.resourceUri}-alternate`,
        },
      ]),
    };
    current.resolve({ servers: [alternates] });
    await current.promise;
    for (const element of elements) {
      await element.updateComplete;
    }
    await waitForSolid(() => expect(sidebar.textContent).toContain("Library"));
    expect(thread.querySelector("button")).not.toBeNull();
    expect(resources.querySelector("button")).not.toBeNull();

    thread.querySelector<HTMLButtonElement>("button")!.click();
    await waitForSolid(() => expect(threadEntries(thread)).toHaveLength(2));
    const sidebarEntry = buttons(sidebar)[1]!;
    const threadEntry = threadEntries(thread)[1]!;
    sidebarEntry.focus();
    emitConfigChanged(events);
    await waitForSolid(() => {
      expect(request).toHaveBeenCalledTimes(2);
      expect(buttons(sidebar)[1]).toBe(sidebarEntry);
      expect(document.activeElement).toBe(sidebarEntry);
      expect(threadEntries(thread)[1]).toBe(threadEntry);
    });
    refreshed.resolve({
      servers: [
        {
          ...reviseServer(alternates, "-updated", "Updated "),
          label: "Updated parts plugin",
        },
      ],
    });
    await refreshed.promise;
    await waitForSolid(() => {
      expect(buttons(sidebar)).toHaveLength(2);
      expect(buttons(sidebar)[1]).toBe(sidebarEntry);
      expect(document.activeElement).toBe(sidebarEntry);
      expect(sidebarEntry).toMatchObject({
        textContent: "Updated Library alternate",
        title: "Updated parts plugin",
      });
      expect(threadEntries(thread)).toHaveLength(2);
      expect(threadEntries(thread)[1]).toBe(threadEntry);
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
    const { request, next } = discoveryQueue();
    const failed = next();
    const retry = next();
    const { context } = discoveryContext(request);
    const element = mountCatalog(context);
    await element.updateComplete;
    await element.updateComplete;
    failed.reject(new Error("Discovery unavailable"));
    await failed.promise.catch(() => {});
    await element.updateComplete;
    await element.updateComplete;
    await waitForSolid(() =>
      expect(element.querySelector('[role="alert"]')?.textContent).toContain(
        "Discovery unavailable",
      ),
    );

    element.querySelector<HTMLButtonElement>('[role="alert"] + button')!.click();
    expect(request).toHaveBeenCalledTimes(2);
    retry.resolve(result);
    await retry.promise;
    await element.updateComplete;
    await element.updateComplete;
    await waitForSolid(() => expect(element.textContent).toContain("Library"));
  });

  it("discovers again after creating a session while an earlier lookup is pending", async () => {
    const { request, next } = discoveryQueue();
    const previous = next();
    const current = next();
    const created = createDeferred<{ key: string }>();
    const createResult = vi.fn(() => created.promise);
    const context = {
      ...discoveryContext(request).context,
      sessions: {
        describe: async () => ({ session: null }),
        createResult,
        state: { error: null },
      },
    };
    const sidebar = mountCatalog(context, { surface: "sidebar" });
    await sidebar.updateComplete;
    expect(request).toHaveBeenCalledOnce();

    const apps = mountCatalog(context, { sessionKey: sidebar.sessionKey });
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

  it("prepares global discovery for a missing session", async () => {
    let admitted = false;
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
    const { context: base, events: configChanged } = gatewayContext(request);
    const describeSession = vi.fn(async () => ({ session: null }));
    Object.assign(base.gateway.snapshot, { sessionKey: "agent:main:main" });
    Object.assign(base.gateway, { connection: { gatewayUrl: "ws://gateway.example.test" } });
    // SAFETY: The fixture supplies the capabilities exercised by Apps and discovery.
    const context = {
      ...base,
      sessions: {
        createResult,
        state: { error: null },
        describe: describeSession,
      },
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
    expect(createResult).toHaveBeenCalledExactlyOnceWith(mainReference, {
      reconciliation: "background",
    });
    expect(request).toHaveBeenCalledWith("mcp.app.discover", mainTarget);
    flush();
    await waitForSolid(() => expect(element.textContent).toContain("Library"));
    expect(element.querySelector('[role="alert"]')).toBeNull();
    emitConfigChanged(configChanged);
    await catalog.updateComplete;
    flush();
    expect(describeSession).toHaveBeenCalledExactlyOnceWith(mainReference);
    expect(createResult).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledTimes(2);
  });
  it("onboards an app without crypto.randomUUID on insecure origins", async () => {
    vi.stubGlobal("crypto", { getRandomValues: crypto.getRandomValues.bind(crypto) });
    const { request, next } = discoveryQueue();
    const read = next();
    request.mockResolvedValue({});
    const navigate = vi.fn();
    const element = mountCatalog({
      ...gatewayContext(request).context,
      agents: { state: { agentsList: null } },
      sessions: {
        state: { result: null },
        describe: async () => ({ session: { key: "agent:main:one" } }),
      },
      basePath: "",
      navigate,
    });
    await element.updateComplete;
    read.resolve({ servers: [], onboarding: [{ pluginId: "parts", title: "Parts plugin" }] });
    await read.promise;
    await element.updateComplete;
    clickButton(element, "Parts plugin");
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
  it("hides unsupported file controls after empty discovery", async () => {
    const read = createDeferred<McpAppDiscoverResult>();
    const element = mountCatalog(gatewayContext(vi.fn(() => read.promise)).context, {
      surface: "file",
      sessionKey: "agent:main:empty",
    });
    await element.updateComplete;
    read.resolve({ servers: [], onboarding: [] });
    await read.promise;
    await element.updateComplete;
    expect(element.querySelector("button")).toBeNull();
    expect(element.querySelector('[role="alert"]')).toBeNull();
  });
  it("ignores discovery from a replaced conversation", async () => {
    const { request, next } = discoveryQueue();
    const first = next();
    const second = next();
    const element = mountCatalog(gatewayContext(request).context, { surface: "sidebar" });
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
    const { context } = gatewayContext(request);
    const { client } = context.gateway.snapshot;
    Object.assign(context.gateway.snapshot, { sessionKey: target.sessionKey });
    const element = mountCatalog(context, { surface: "thread", agentId: target.agentId });
    await element.updateComplete;
    read.resolve(result);
    await read.promise;
    await element.updateComplete;
    element.querySelector<HTMLButtonElement>("button")!.click();
    await element.updateComplete;
    const launch = vi.fn((event: Event) => event.preventDefault());
    element.addEventListener(MCP_APP_OPEN_EVENT, launch);
    clickButton(element, "Parts tray");
    expect((launch.mock.calls[0]![0] as CustomEvent<McpAppOpenDetail>).detail).toMatchObject({
      ...target,
      serverName: "parts",
      owner: client,
      entrypoint: { toolName: "tray" },
    });
    expect(request.mock.calls).toEqual([["mcp.app.discover", target]]);
  });
});
