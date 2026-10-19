import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { GATEWAY_STARTUP_ADMISSION_WAIT_MS } from "../../../packages/gateway-protocol/src/startup-unavailable.js";
import type { ControlUiSessionListSnapshot } from "../../../src/plugin-sdk/control-ui.js";
import { createDeferred } from "../../../test/helpers/promise.js";
import type { GatewayBrowserClient } from "../api/gateway.ts";
import type { AgentsListResult } from "../api/types.ts";
import { createAgentSelectionCapability } from "../app/agent-selection.ts";
import { AssistantDock, type AssistantDockOwner } from "../app/assistant-dock.ts";
import { createApplicationConfigCapability } from "../app/config.ts";
import type { ApplicationContext } from "../app/context.ts";
import { PLUGIN_PANEL_TOGGLE_EVENT } from "../components/panel-toggle-contract.ts";
import { takeSessionPanelToggle } from "../components/session-panel-toggle-buffer.ts";
import { i18n } from "../i18n/index.ts";
import { createAgentCapability } from "../lib/agents/index.ts";
import {
  createGatewayHarness,
  createTestSessionCapability,
  sessionsResult,
} from "../lib/sessions/session-capability.test-support.ts";
import { createTestGatewayClient } from "../test-helpers/gateway-client.ts";
import { createControlUiPluginHost } from "./control-ui-host.ts";
import { type ControlUiPluginOwner, ControlUiPluginRuntime } from "./control-ui-runtime.ts";
import { scopeControlUiHost } from "./control-ui-scope.ts";

const subscribe = () => () => undefined;
const subscriptions = Object.fromEntries(
  ["gateway", "sessions", "agents", "agentSelection", "theme"].map((name) => [name, { subscribe }]),
);
const sessionListener = () => vi.fn<(snapshot: ControlUiSessionListSnapshot) => void>();
const sessionList = (
  key: string,
  ts = 1,
  fields: Partial<ReturnType<typeof sessionsResult>["sessions"][number]> = {},
) => sessionsResult([{ key, kind: "direct", updatedAt: ts, ...fields }], ts);

function createHost(
  context: ApplicationContext,
  runtime?: ControlUiPluginRuntime,
  client?: GatewayBrowserClient,
) {
  const owner = {
    client,
    abort: new AbortController(),
    descriptor: { pluginId: "review" },
    disposers: new Set<() => void>(),
    contributions: { navigation: new Map(), panels: new Map() },
  } as Omit<ControlUiPluginOwner, "host">;
  const activeRuntime =
    runtime ??
    ({
      isCurrent: (current: Omit<ControlUiPluginOwner, "host">) =>
        current === owner && !current.abort.signal.aborted,
    } as ControlUiPluginRuntime);
  const dispose = () => {
    owner.abort.abort();
    owner.disposers.forEach((stop) => stop());
    owner.disposers.clear();
  };
  onTestFinished(dispose);
  return {
    owner,
    abort: owner.abort,
    dispose,
    host: createControlUiPluginHost(() => context, activeRuntime, owner),
  };
}

const sessionSnapshot = (
  result: ReturnType<typeof sessionsResult> | null,
  error: string | null = null,
) => {
  const { sessions, hasMore, nextOffset, totalCount } = result ?? {};
  return {
    result: result ? { sessions, hasMore, nextOffset, totalCount } : null,
    loading: false,
    error,
  };
};

function createRosterHost(request: GatewayBrowserClient["request"], assistantDock?: AssistantDock) {
  const client = { request } as GatewayBrowserClient;
  const { gateway } = createGatewayHarness(client);
  const agents = createAgentCapability(gateway);
  const sessions = createTestSessionCapability(gateway);
  const context = {
    ...subscriptions,
    gateway,
    agents,
    sessions,
    config: createApplicationConfigCapability({ resourceBasePath: "" }),
    assistantDock,
  } as unknown as ApplicationContext;
  const runtime = new ControlUiPluginRuntime(() => context);
  runtime.start();
  const activation = createHost(context, runtime, client);
  const dispose = () => {
    activation.dispose();
    runtime.dispose();
    agents.dispose();
    sessions.dispose();
  };
  onTestFinished(dispose);
  return {
    activate: () => createHost(context, runtime, client),
    activation,
    context,
    host: activation.host,
    runtime,
    agents,
    sessions,
    dispose,
  };
}

const globalList = (agentId: string, ts: number, fields: Parameters<typeof sessionList>[2]) =>
  sessionsResult([{ key: "global", kind: "global", agentId, ...fields }], ts);
const chatPath = (pathname: string) => expect.objectContaining({ pathname });

function scopedHost(host: ReturnType<typeof createHost>["host"]) {
  const view = new AbortController();
  onTestFinished(() => view.abort());
  return { view, host: scopeControlUiHost(host, view.signal) };
}

async function observeGlobal(
  fixture: ReturnType<typeof createRosterHost>,
  queried: ReturnType<typeof sessionsResult>,
) {
  const listener = sessionListener();
  fixture.host.sessions.observe({ agentId: "writer", includeGlobal: true }, listener);
  await vi.waitFor(() =>
    expect(listener.mock.lastCall?.[0].result?.sessions).toEqual(queried.sessions),
  );
  const session = expectDefined(listener.mock.lastCall?.[0].result?.sessions[0], "queried session");
  return { sessionKey: session.key, agentId: session.agentId };
}

describe("native UI roster refresh", () => {
  it("forwards dock conversation creation through the host to the Gateway", async () => {
    const key = "agent:main:board-agent";
    const request = vi.fn(async (method: string) => {
      if (method === "sessions.create") {
        return { key, entry: { sessionId: "board-agent", createdSurface: "plugin-dock" } };
      }
      if (method === "sessions.list") {
        return sessionsResult([], 1);
      }
      throw new Error(`Unexpected request: ${method}`);
    });
    const client = createTestGatewayClient(request);
    const fixture = createRosterHost(client.request.bind(client));
    const params = { agentId: "main", displayName: "Board agent", surface: "plugin-dock" } as const;
    await expect(fixture.host.sessions.create(params)).resolves.toBe(key);
    expect(request).toHaveBeenCalledWith("sessions.create", params, {
      timeoutMs: GATEWAY_STARTUP_ADMISSION_WAIT_MS,
      signal: fixture.host.signal,
      retainSentResultOnAbort: true,
    });
    expect(request).toHaveBeenCalledWith(
      "sessions.list",
      expect.objectContaining({ excludeDock: true }),
    );
  });

  it("observes independent session windows without replacing or exposing the application roster", async () => {
    const primary = sessionList("agent:main:current");
    const found = {
      ...sessionList("agent:writer:linked", 2, { label: "Linked session" }),
      hasMore: true,
      nextOffset: 1,
      totalCount: 2,
    };
    const research = {
      ...sessionList("agent:research:current", 3),
      hasMore: false,
      nextOffset: null,
      totalCount: 1,
    };
    const request = vi
      .fn()
      .mockResolvedValueOnce(primary)
      .mockResolvedValueOnce(found)
      .mockResolvedValueOnce(research);
    const fixture = createRosterHost(request);
    const linkedListener = sessionListener();
    const researchListener = sessionListener();
    const query = {
      search: "linked",
      archived: "all" as const,
      configuredAgentsOnly: false,
      limit: 1,
    };
    await fixture.sessions.refresh({ agentId: "main" });
    fixture.host.sessions.observe(query, linkedListener);
    fixture.host.sessions.observe({ agentId: "research", limit: 2 }, researchListener);
    await vi.waitFor(() => {
      expect(linkedListener).toHaveBeenLastCalledWith(sessionSnapshot(found));
      expect(researchListener).toHaveBeenLastCalledWith(sessionSnapshot(research));
    });
    expect(fixture.host.sessions.rows).toEqual(primary.sessions);
    expect(fixture.sessions.state.agentId).toBe("main");
    expect(request.mock.calls[1]).toEqual([
      "sessions.list",
      {
        rowMode: "compact",
        source: "chat-pane",
        ifRowsRevision: "",
        includeGlobal: true,
        includeUnknown: true,
        excludeDock: true,
        ...query,
      },
    ]);
    const delivered = expectDefined(linkedListener.mock.lastCall?.[0].result?.sessions[0], "row");
    Object.assign(delivered, { label: "Plugin-local edit" });
    const { archived, ...options } = query;
    expect(
      fixture.sessions.listSnapshot({
        ...options,
        archivedFilter: archived,
      }).result?.sessions[0]?.label,
    ).toBe("Linked session");
    expect(fixture.host.sessions.rows).toEqual(primary.sessions);
  });

  it("publishes session query errors and rejects failed refreshes while allowing recovery", async () => {
    const found = sessionList("agent:writer:linked", 1);
    const request = vi.fn().mockRejectedValueOnce(new Error("Query unavailable"));
    const fixture = createRosterHost(request);
    const listener = sessionListener();
    const observer = fixture.host.sessions.observe({ search: "linked" }, listener);
    await vi.waitFor(() => {
      expect(listener).toHaveBeenLastCalledWith(sessionSnapshot(null, "Query unavailable"));
      expect(fixture.runtime.errors).toContainEqual({
        pluginId: "review",
        message: "Query unavailable",
      });
    });
    request.mockResolvedValueOnce(found);
    await observer.refresh();
    expect(listener).toHaveBeenLastCalledWith(sessionSnapshot(found));
    request.mockRejectedValueOnce(new Error("Refresh unavailable"));
    await expect(observer.refresh()).rejects.toThrow("Refresh unavailable");
    expect(listener).toHaveBeenLastCalledWith(sessionSnapshot(found, "Refresh unavailable"));
    expect(fixture.sessions.state).toMatchObject({ result: null, error: null });
  });

  it("ends session query callbacks and refresh authority when its view is disposed", async () => {
    const first = sessionList("agent:writer:first", 1);
    const next = sessionList("agent:writer:next", 2);
    const pending = createDeferred<typeof next>();
    const request = vi
      .fn()
      .mockResolvedValueOnce(first)
      .mockImplementationOnce(() => pending.promise);
    const fixture = createRosterHost(request);
    const { view, host } = scopedHost(fixture.host);
    const listener = sessionListener();
    onTestFinished(() => pending.resolve(next));
    const observer = host.sessions.observe({ agentId: "writer", limit: 1 }, listener);
    await vi.waitFor(() => {
      expect(listener.mock.lastCall?.[0].result?.sessions).toEqual(first.sessions);
      expect(listener.mock.lastCall?.[0].loading).toBe(false);
    });
    const refresh = observer.refresh;
    const refreshing = expect(refresh()).rejects.toThrow();
    expect(request).toHaveBeenCalledTimes(2);
    const callbackCount = listener.mock.calls.length;
    view.abort();
    pending.resolve(next);
    await refreshing;
    expect(listener.mock.calls.length).toBe(callbackCount);
    expect(fixture.host.signal.aborted).toBe(false);
    expect(() => refresh()).toThrow("This plugin UI view has ended.");
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("stops notifications when an observer's initial callback disposes its view", () => {
    const request = vi.fn().mockResolvedValue(sessionsResult([], 1));
    const fixture = createRosterHost(request);
    const { view, host } = scopedHost(fixture.host);
    const callbackAbortedStates: boolean[] = [];
    expect(() =>
      host.sessions.observe({ agentId: "writer", limit: 1 }, () => {
        callbackAbortedStates.push(view.signal.aborted);
        view.abort();
      }),
    ).toThrow("This plugin UI view has ended.");
    expect(callbackAbortedStates).toEqual([false]);
  });

  it.each(["agents", "sessions"] as const)(
    "refreshes cached %s rows without discarding the current roster scope",
    async (surface) => {
      const firstAgents: AgentsListResult = {
        defaultId: "main",
        mainKey: "main",
        scope: "per-sender",
        agents: [{ id: "main" }],
      };
      const nextAgents: AgentsListResult = {
        ...firstAgents,
        agents: [...firstAgents.agents, { id: "research" }],
      };
      const firstSessions = sessionList("agent:research:old", 1);
      const nextSessions = sessionList("agent:research:new", 2);
      const request = vi
        .fn()
        .mockResolvedValueOnce(surface === "agents" ? firstAgents : firstSessions)
        .mockResolvedValueOnce(surface === "agents" ? nextAgents : nextSessions);
      const fixture = createRosterHost(request);
      if (surface === "agents") {
        await fixture.agents.ensureList();
      } else {
        await fixture.sessions.refresh({ agentId: "research", search: "draft", limit: 5 });
      }
      await fixture.host[surface].refresh();
      expect(fixture.host[surface].rows).toEqual(
        surface === "agents" ? nextAgents.agents : nextSessions.sessions,
      );
      expect(request).toHaveBeenCalledTimes(2);
      expect(request.mock.calls[1]).toEqual(request.mock.calls[0]);
    },
  );

  it.each(["agents", "sessions"] as const)(
    "rejects a failed %s refresh through the SDK",
    async (surface) => {
      const request = vi.fn().mockRejectedValue(new Error("Roster unavailable"));
      const fixture = createRosterHost(request);
      await expect(fixture.host[surface].refresh()).rejects.toThrow();
      expect(request).toHaveBeenCalledOnce();
      expect(
        surface === "agents" ? fixture.agents.state.agentsError : fixture.sessions.state.error,
      ).toBe("Roster unavailable");
    },
  );
});

describe("native UI session mutations", () => {
  it("patches a queried global owner without replacing the primary roster or its model", async () => {
    const primary = globalList("main", 1, { model: "main-model" });
    const queried = globalList("writer", 2, { model: "writer-model" });
    const patch = createDeferred<unknown>();
    const request = vi
      .fn()
      .mockResolvedValueOnce(primary)
      .mockResolvedValueOnce(queried)
      .mockImplementationOnce(() => patch.promise)
      .mockResolvedValueOnce(primary);
    const fixture = createRosterHost(request);
    onTestFinished(() => patch.resolve(null));
    await fixture.sessions.refresh({ agentId: "main", search: "current", limit: 7 });
    const session = await observeGlobal(fixture, queried);
    const updating = fixture.host.sessions.patch(session, { model: "replacement-model" });
    const completed = expect(updating).resolves.toBeUndefined();
    expect(fixture.sessions.state.modelOverrides).toEqual({});
    patch.resolve({ key: "global", entry: { model: "replacement-model" } });
    await completed;

    expect(request).toHaveBeenCalledWith("sessions.patch", {
      key: "global",
      agentId: "writer",
      model: "replacement-model",
    });
    expect(request).toHaveBeenLastCalledWith(
      "sessions.list",
      expect.objectContaining({
        agentId: "main",
        search: "current",
        limit: 7,
      }),
    );
    expect(fixture.sessions.state.agentId).toBe("main");
    expect(fixture.sessions.state.modelOverrides).toEqual({});
    expect(fixture.host.sessions.rows).toEqual(primary.sessions);
  });

  it("rejects a session patch that its session owner could not complete", async () => {
    const request = vi.fn();
    const fixture = createRosterHost(request);
    fixture.sessions.dispose();
    await expect(
      fixture.host.sessions.patch(
        { sessionKey: "global", agentId: "writer" },
        { label: "Updated" },
      ),
    ).rejects.toThrow("The session update did not complete");
    expect(request).not.toHaveBeenCalled();
  });
});

it("publishes locale changes through the host and fences notifications after activation ends", async () => {
  const original = i18n.getLocale();
  const next = original === "de" ? "en" : "de";
  const context = subscriptions as unknown as ApplicationContext;
  const { host, abort } = createHost(context);
  const notified = vi.fn(() => host.locale);
  const stop = host.subscribe(notified);
  onTestFinished(async () => {
    stop();
    await i18n.setLocale(original);
  });
  await i18n.setLocale(next);
  expect(notified).toHaveReturnedWith(next);
  expect(notified).toHaveBeenCalledOnce();
  abort.abort();
  await i18n.setLocale(original);
  expect(notified).toHaveBeenCalledOnce();
});

describe("native UI page navigation", () => {
  it("pins and unpins through saved sidebar preferences once and retires the handles", () => {
    const fixture = createRosterHost(vi.fn());
    let sidebarEntries = ["route:usage", "session:agent:main:existing"];
    const update = vi.fn((patch: { sidebarEntries: string[] }) => {
      sidebarEntries = patch.sidebarEntries;
    });
    Object.assign(fixture.context, {
      navigation: {
        get snapshot() {
          return { sidebarEntries };
        },
        update,
      },
    });
    const { view, host } = scopedHost(fixture.host);
    const { pinNavigation: pin, unpinNavigation: unpin, isNavigationPinned: isPinned } = host.ui;
    expect(isPinned("board")).toBe(false);
    pin("board");
    expect(update).not.toHaveBeenCalled();
    const unregister = fixture.host.ui.registerNavigation({
      id: "board",
      label: "Board",
      page: { id: "board" },
      defaultVisible: false,
    });
    pin("foreign/board");
    pin("board");
    pin("board");
    expect(update).toHaveBeenCalledExactlyOnceWith({
      sidebarEntries: ["route:usage", "session:agent:main:existing", "plugin:review/board"],
    });
    expect(isPinned("board")).toBe(true);
    expect(isPinned("foreign/board")).toBe(false);
    unregister();
    unpin("foreign/board");
    unpin("board");
    unpin("board");
    expect(update).toHaveBeenCalledTimes(2);
    expect(sidebarEntries).toEqual(["route:usage", "session:agent:main:existing"]);
    expect(isPinned("board")).toBe(false);
    pin("board");
    expect(update).toHaveBeenCalledTimes(2);
    view.abort();
    expect(() => pin("board")).toThrow("view has ended");
    expect(() => unpin("board")).toThrow("view has ended");
    expect(() => isPinned("board")).toThrow("view has ended");
    fixture.dispose();
    expect(() => fixture.host.ui.pinNavigation("board")).toThrow("activation has ended");
    expect(() => fixture.host.ui.unpinNavigation("board")).toThrow("activation has ended");
    expect(() => fixture.host.ui.isNavigationPinned("board")).toThrow("activation has ended");
  });

  it("opens a queried global session with its owner before changing the selected key", async () => {
    const primary = globalList("main", 1, { boardFace: "dashboard" });
    const queried = globalList("writer", 2, { boardFace: "chat" });
    const request = vi.fn().mockResolvedValueOnce(primary).mockResolvedValueOnce(queried);
    const fixture = createRosterHost(request);
    const selection = createAgentSelectionCapability(
      {
        ...fixture.context.gateway,
        connection: { gatewayUrl: "ws://localhost:18789" },
      },
      fixture.agents,
    );
    const navigate = vi.fn();
    let selectedWhenKeyChanged: string | null = null;
    const setSessionKey = vi.fn(() => {
      selectedWhenKeyChanged = selection.state.selectedId;
    });
    Object.assign(fixture.context, { basePath: "", agentSelection: selection, navigate });
    Object.assign(fixture.context.gateway, { setSessionKey });
    await fixture.sessions.refresh({ agentId: "main" });
    fixture.host.sessions.open(await observeGlobal(fixture, queried));

    expect(navigate).toHaveBeenCalledWith("chat", chatPath("/chat/writer"));
    expect(setSessionKey).toHaveBeenCalledWith("global");
    expect(selectedWhenKeyChanged).toBe("writer");
    expect(fixture.sessions.state.agentId).toBe("main");
    expect(fixture.host.sessions.rows).toEqual(primary.sessions);
  });

  it.each([
    ["native", { placement: "route:workboard" }, "/console/workboard/Team%20%2F%20One"],
    ["generic", null, "/console/plugin"],
    ["slug", { slug: "reports" }, "/console/reports"],
  ] as const)(
    "preserves scoped filters during replacement navigation (%s route)",
    (kind, tab, pathname) => {
      const originalUrl = window.location.href;
      onTestFinished(() => window.history.replaceState(null, "", originalUrl));
      window.history.replaceState(null, "", "/?agent=main&p.filter=ready");
      const navigate = vi.fn();
      const replace = vi.fn();
      const context = {
        basePath: "/console",
        gateway: {
          snapshot: {
            hello: {
              controlUiTabs: tab ? [{ pluginId: "review", id: "board", ...tab }] : [],
            },
          },
        },
        navigate,
        replace,
      } as unknown as ApplicationContext;
      const { host, abort } = createHost(context);
      const target = { id: "board", path: ["Team / One"], params: { filter: "done" } };
      const location = new URL(
        host.navigation.pageHref(target, { preserveSearch: true }),
        window.location.origin,
      );
      expect(location.pathname).toBe(pathname);
      expect(Object.fromEntries(location.searchParams)).toMatchObject({
        agent: "main",
        "p.filter": "done",
      });
      if (kind === "generic") {
        expect(Object.fromEntries(location.searchParams)).toMatchObject({
          plugin: "review",
          id: "board",
        });
      } else if (kind === "slug") {
        expect([location.searchParams.has("plugin"), location.searchParams.has("id")]).toEqual([
          false,
          false,
        ]);
      }
      host.navigation.openPage(target, { replace: true, preserveSearch: true });
      expect(replace).toHaveBeenCalledWith(
        kind === "native" ? "workboard" : "plugin",
        expect.objectContaining({ pathname, search: location.search }),
      );
      expect(navigate).not.toHaveBeenCalled();
      expect(
        new URL(host.navigation.pageHref(target), window.location.origin).searchParams.has("agent"),
      ).toBe(false);
      abort.abort();
      expect(() => host.navigation.openPage(target)).toThrow("activation has ended");
    },
  );
});

it("opens only owned panels and retires retained view and activation handles", () => {
  const navigate = vi.fn();
  const context = {
    basePath: "",
    navigate,
    gateway: { snapshot: { sessionKey: "agent:main:main", hello: null }, setSessionKey: vi.fn() },
    agents: { state: { agentsList: null } },
    agentSelection: { state: { selectedId: "main" }, set: vi.fn() },
    sessions: { state: { result: null } },
  } as unknown as ApplicationContext;
  const { host, abort, owner } = createHost(context);
  owner.contributions.panels.set("document", {
    value: { id: "document", label: "Document", mount: () => undefined },
    signal: abort.signal,
  });
  const listener = vi.fn();
  window.addEventListener(PLUGIN_PANEL_TOGGLE_EVENT, listener);
  onTestFinished(() => {
    window.removeEventListener(PLUGIN_PANEL_TOGGLE_EVENT, listener);
    abort.abort();
  });
  expect(() => host.ui.openPanel("foreign/document")).toThrow("own registered panel");
  const { view, host: scoped } = scopedHost(host);
  const open = scoped.ui.openPanel;
  open("document", { sessionKey: "global", agentId: "writer" });
  expect(navigate).toHaveBeenCalledWith("chat", chatPath("/chat/writer"));
  expect(listener).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({
      detail: {
        pluginId: "review",
        panelId: "document",
        sessionKey: "global",
        agentId: "writer",
        open: true,
      },
    }),
  );
  expect(takeSessionPanelToggle("plugin:review/document", "global", "writer")).not.toBeNull();
  const documentKey = "agent:writer:document";
  open("document", { sessionKey: documentKey });
  expect(navigate).toHaveBeenLastCalledWith("chat", chatPath("/chat/writer/document"));
  expect(context.agentSelection.set).toHaveBeenLastCalledWith("writer");
  expect(listener).toHaveBeenLastCalledWith(
    expect.objectContaining({
      detail: expect.objectContaining({
        sessionKey: documentKey,
        agentId: "writer",
      }),
    }),
  );
  expect(takeSessionPanelToggle("plugin:review/document", documentKey, "writer")).not.toBeNull();
  view.abort();
  expect(() => open("document")).toThrow("view has ended");
  abort.abort();
  expect(() => host.ui.openPanel("document")).toThrow("activation has ended");
});

it("adapts dock operations, publishes snapshots, and retires activation and view handles", () => {
  const dock = new AssistantDock();
  let session: { key: string; activation: object } | null = null;
  const panel: AssistantDockOwner = {
    openSession: vi.fn((params, activation) => {
      session = { key: params.sessionKey, activation };
      dock.notify();
    }),
    closeSession: vi.fn((activation) => {
      if (!activation || activation === session?.activation) {
        session = null;
        dock.notify();
      }
    }),
    get openSessionKey() {
      return session?.key ?? null;
    },
  };
  const detach = dock.attach(panel);
  const fixture = createRosterHost(vi.fn(), dock);
  const first = fixture.activation;
  const second = fixture.activate();
  const notified = vi.fn(() => second.host.dock?.openSessionKey);
  const stop = second.host.subscribe(notified);
  const params = {
    sessionKey: "agent:research:review",
    agentId: "research",
    label: "Review",
    context: { page: "review:board", detail: { filter: "stuck" } },
  };
  onTestFinished(() => {
    stop();
    detach();
  });
  expect(first.host.dock?.openSessionKey).toBeNull();
  first.host.dock?.openSession(params);
  expect(panel.openSession).toHaveBeenCalledWith(params, expect.any(AbortController));
  expect(notified).toHaveLastReturnedWith(params.sessionKey);
  first.host.dock?.close();
  expect(notified).toHaveLastReturnedWith(null);
  first.host.dock?.openSession(params);
  const { view, host: scoped } = scopedHost(second.host);
  const retainedOpen = scoped.dock!.openSession;
  retainedOpen({ ...params, sessionKey: "agent:research:second" });
  view.abort();
  expect(second.host.dock?.openSessionKey).toBe("agent:research:second");
  expect(() => retainedOpen(params)).toThrow("view has ended");
  first.dispose();
  expect(second.host.dock?.openSessionKey).toBe("agent:research:second");
  const close = second.host.dock!.close;
  second.dispose();
  expect(dock.openSessionKey).toBeNull();
  expect(() => close()).toThrow("activation has ended");
});
