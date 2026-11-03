import { afterEach, describe, expect, it, vi } from "vitest";
// @vitest-environment node
import { SIDEBAR_SESSION_ROSTER_LIMIT } from "../../../src/shared/session-list-limits.ts";
import { createDeferred } from "../../../test/helpers/promise.ts";
import type { GatewayBrowserClient } from "../api/gateway.ts";
import { createConnectionBootstrapCoordinator } from "../app/connection-bootstrap.ts";
import type { ApplicationContext } from "../app/context.ts";
import { createSessionCapability, type SessionCapability } from "../lib/sessions/index.ts";
import {
  createGatewayHarness,
  sessionsResult,
} from "../lib/sessions/session-capability.test-support.ts";
import type { SessionGateway } from "../lib/sessions/session-capability.ts";
import { createFrameClock } from "../test-helpers/animation-frame-clock.ts";
import { createSessionDataHost } from "./session-data-controller.test-support.ts";
import { SessionDataOwner } from "./session-data.ts";

const cleanups: Array<() => void> = [];
const pageSize = SIDEBAR_SESSION_ROSTER_LIMIT;
type ListOptions = Parameters<SessionCapability["list"]>[0];
const sessionPage = (keys: string[], ts = 1) =>
  sessionsResult(
    keys.map((key) => ({ key, kind: "direct", updatedAt: ts })),
    ts,
  );

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) {
    cleanup();
  }
  vi.restoreAllMocks();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function createFilteredSessionController(
  statusFilter: "active" | "archived" | "all",
  rowCount = 1,
  includeActiveRows = false,
) {
  vi.stubGlobal("document", {
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    visibilityState: "visible",
  });
  vi.stubGlobal("addEventListener", vi.fn());
  vi.stubGlobal("removeEventListener", vi.fn());

  const rows = Array.from({ length: rowCount }, (_, index) => ({
    key: index === 0 ? "agent:main:remote-change" : `agent:main:session-${index}`,
    kind: "direct" as const,
    updatedAt: index + 1,
  }));
  const list = vi.fn(async (options?: Parameters<SessionCapability["list"]>[0]) => {
    const offset = options?.offset ?? 0;
    const limit = options?.limit ?? 60;
    const matchingRows =
      options?.involvingMe || options?.ownerId ? rows.filter((_, index) => index % 2 === 0) : rows;
    const sessions = matchingRows.slice(offset, offset + limit);
    const nextOffset = offset + sessions.length;
    const hasMore = nextOffset < matchingRows.length;
    return {
      ...sessionsResult(sessions),
      totalCount: matchingRows.length,
      nextOffset: hasMore ? nextOffset : null,
      hasMore,
    };
  });
  const client = {
    request: <T>(method: string, params?: unknown): Promise<T> => {
      if (method === "sessions.groups.list") {
        return Promise.resolve({ groups: [], sectionOrder: [] } as T);
      }
      if (method === "sessions.subscribe") {
        return Promise.resolve({ subscribed: true } as T);
      }
      const { archived, ...options } = (params ?? {}) as NonNullable<
        Parameters<SessionCapability["list"]>[0]
      > & { archived?: true | "all" };
      if (!includeActiveRows && !archived && !options.spawnedBy) {
        return Promise.resolve(sessionsResult([]) as T);
      }
      return list({
        ...options,
        ...(archived ? { archivedFilter: archived === true ? "archived" : "all" } : {}),
      }) as Promise<T>;
    },
  } as GatewayBrowserClient;
  const { gateway, update, emitEvent } = createGatewayHarness(client);
  let selectedAgentId = "main";
  const agentSelection = {
    get state() {
      return { selectedId: selectedAgentId, scopeId: selectedAgentId };
    },
    subscribe: () => () => undefined,
  };
  const connectionBootstrap = createConnectionBootstrapCoordinator();
  const synchronizeBootstrap = (next: SessionGateway["snapshot"]) =>
    connectionBootstrap.synchronize({ client: next.client, connected: next.phase === "connected" });
  synchronizeBootstrap(gateway.snapshot);
  const stopBootstrap = gateway.subscribe(synchronizeBootstrap);
  const sessions = createSessionCapability(gateway, agentSelection, { connectionBootstrap });
  cleanups.push(() => {
    stopBootstrap();
    sessions.dispose();
    connectionBootstrap.reset();
  });
  let selectedStatusFilter = statusFilter;
  let membership = { ownerId: null as string | null, involvingMe: false };
  const agentsState = {
    connected: true,
    client,
    agentsList: {
      defaultId: "main",
      agents: [{ id: "main" }, { id: "research" }],
    } as ApplicationContext["agents"]["state"]["agentsList"],
  };
  const agentListeners = new Set<(state: ApplicationContext["agents"]["state"]) => void>();
  const context = {
    connectionBootstrap,
    gateway,
    sessions,
    agents: {
      state: agentsState,
      subscribe(listener: (state: ApplicationContext["agents"]["state"]) => void) {
        agentListeners.add(listener);
        return () => agentListeners.delete(listener);
      },
    },
    agentSelection,
  } as unknown as ApplicationContext;
  const host = createSessionDataHost(context, {
    connected: true,
    expandedAgentId: () => selectedAgentId,
    selectedAgentIdForSessions: () => selectedAgentId,
    sidebarSessionStatusFilter: () => selectedStatusFilter,
    sidebarSessionOwnerFilter: () => membership,
  });
  const notify = vi.fn();
  const controller = new SessionDataOwner(host, notify);
  cleanups.unshift(() => controller.disconnect());

  return {
    notify,
    client,
    context,
    host,
    disconnectHost: () => {
      host.isConnected = false;
      controller.disconnect();
    },
    controller,
    list,
    publishPresence: (instanceId: string) =>
      emitEvent({
        type: "event",
        event: "presence",
        payload: { presence: [{ instanceId, ts: 1 }] },
      }),
    expectRows: (count: number) => expect(controller.sessionsResult?.sessions).toHaveLength(count),
    expectQuery: (query: ListOptions) =>
      expect(list).toHaveBeenLastCalledWith(expect.objectContaining(query)),
    refreshError: async (failure?: string, expected: string | null = failure ?? null) => {
      if (failure) {
        list.mockRejectedValueOnce(new Error(failure));
      }
      await controller.refreshSidebarSessions();
      expect(controller.sessionMutationError).toBe(expected);
    },
    reconnect: () => {
      for (const phase of ["reconnecting", "connected"] as const) {
        update({ phase });
      }
    },
    selectMembership: async (filter: typeof membership) => {
      membership = filter;
      await controller.refreshSidebarSessions();
    },
    selectAgent: (agentId: string) => {
      selectedAgentId = agentId;
      controller.synchronizeSessionScope();
    },
    selectStatusFilter: (nextStatusFilter: "active" | "archived" | "all") => {
      selectedStatusFilter = nextStatusFilter;
      controller.resetSessionList();
    },
    publishSessionChanged: (payload: Record<string, unknown> = {}) =>
      emitEvent({
        type: "event" as const,
        event: "sessions.changed",
        payload: {
          sessionKey: "agent:main:remote-change",
          agentId: "main",
          reason: "archive",
          ...payload,
        },
      }),
    publishAgentRoster: (agentIds: string[] | null) => {
      agentsState.agentsList = agentIds
        ? {
            defaultId: "main",
            mainKey: "main",
            scope: "global",
            agents: agentIds.map((id) => ({ id })),
          }
        : null;
      for (const listener of agentListeners) {
        listener(agentsState as ApplicationContext["agents"]["state"]);
      }
    },
  };
}

async function readyController(...args: Parameters<typeof createFilteredSessionController>) {
  const harness = createFilteredSessionController(...args);
  harness.controller.connect();
  await harness.controller.refreshSidebarSessions();
  harness.list.mockClear();
  return harness;
}

describe("filtered sidebar session event refresh", () => {
  it.each(["active", "all"] as const)(
    "coalesces %s session and presence publications while preserving immediate state",
    async (statusFilter) => {
      const { controller, notify, publishPresence, disconnectHost } =
        createFilteredSessionController(statusFilter, 300, true);
      const framesClock = createFrameClock();

      vi.stubGlobal("requestAnimationFrame", framesClock.request);
      vi.stubGlobal("cancelAnimationFrame", framesClock.cancel);
      const flushFrame = () => {
        framesClock.flush(0);
      };
      controller.connect();
      await controller.refreshSidebarSessions();
      flushFrame();
      notify.mockClear();

      for (let index = 0; index < 30; index += 1) {
        publishPresence(`profile-${index}`);
        await Promise.resolve();
      }
      await controller.refreshSidebarSessions();

      expect(controller.presencePayload?.presence?.[0]?.instanceId).toBe("profile-29");
      expect(controller.sessionsResult?.sessions).toHaveLength(SIDEBAR_SESSION_ROSTER_LIMIT);
      expect(notify).not.toHaveBeenCalled();
      flushFrame();
      expect(notify).toHaveBeenCalledOnce();

      notify.mockClear();
      Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
      publishPresence("hidden-profile");
      expect(controller.presencePayload?.presence?.[0]?.instanceId).toBe("hidden-profile");
      expect(notify).toHaveBeenCalledOnce();

      Object.defineProperty(document, "visibilityState", {
        configurable: true,
        value: "visible",
      });
      notify.mockClear();
      publishPresence("retired-profile");
      disconnectHost();
      flushFrame();
      expect(notify).not.toHaveBeenCalled();
    },
  );

  it("keeps shared group hydration when its first sidebar presenter disconnects", async () => {
    const { controller, context, host, disconnectHost } = createFilteredSessionController("active");
    const bootstrap = context.connectionBootstrap;
    const client = context.gateway.snapshot.client;
    bootstrap.setForegroundRoute("agent:main:pending");
    const load = vi.spyOn(context.sessions, "groupsLoad");
    const replacement = new SessionDataOwner({ ...host, isConnected: true }, () => undefined);
    cleanups.unshift(() => replacement.disconnect());
    controller.connect();
    replacement.connect();
    expect(load).not.toHaveBeenCalled();
    disconnectHost();
    bootstrap.setForegroundPane({}, { sessionKey: "agent:main:pending", client, ready: true });
    await bootstrap.run(context.sessions.groupsLoad, async () => {});
    expect(load).toHaveBeenCalledOnce();
  });

  it("releases a retired sidebar's held bootstrap refresh before the foreground becomes ready", async () => {
    const { controller, context, disconnectHost } = createFilteredSessionController("archived");
    const bootstrap = context.connectionBootstrap;
    bootstrap.setForegroundRoute("agent:main:pending");
    controller.connect();
    const settled = vi.fn();
    void controller.scheduleSidebarSessions().then(settled);
    await Promise.resolve();
    expect(settled).not.toHaveBeenCalled();

    disconnectHost();
    await Promise.resolve();

    expect(settled).toHaveBeenCalledOnce();
    expect(bootstrap.foregroundReady).toBe(false);
  });

  it("keeps an owner-filtered refresh pending when the catalog agent changes", async () => {
    const { controller, context, list, selectMembership, selectAgent } =
      createFilteredSessionController("archived", 4, true);
    controller.connect();
    const release = Promise.withResolvers<void>();
    cleanups.unshift(() => release.resolve());
    await selectMembership({ ownerId: "profile-ada", involvingMe: false });
    const query = controller.sessionListQuery("main");
    const listRows = list.getMockImplementation()!;
    list.mockImplementationOnce(async (options) => {
      await release.promise;
      return listRows(options);
    });
    const refreshing = controller.refreshSidebarSessions();
    expect(context.sessions.listSnapshot(query).loading).toBe(true);
    expect(controller.sessionsLoading).toBe(true);

    selectAgent("research");

    expect(controller.sessionListQuery("research")).toEqual(query);
    expect(context.sessions.listSnapshot(query).loading).toBe(true);
    expect(controller.sessionsLoading).toBe(true);
    release.resolve();
    await refreshing;
    expect(controller.sessionsLoading).toBe(false);
  });

  it.each(["archived", "all"] as const)(
    "automatically rebinds the restored %s filter across controller reconnect",
    async (statusFilter) => {
      vi.useFakeTimers();
      const { controller, list } = createFilteredSessionController(statusFilter);
      controller.connect();
      await vi.advanceTimersByTimeAsync(0);
      expect(list).toHaveBeenCalledOnce();
      expect(controller.sessionsResult?.sessions).toHaveLength(1);
      controller.disconnect();
      controller.connect();
      await vi.advanceTimersByTimeAsync(0);
      expect(list).toHaveBeenCalledTimes(2);
      expect(controller.sessionsResult?.sessions).toHaveLength(1);
    },
  );

  it.each(["active", "archived", "all"] as const)(
    "keeps membership in the displayed %s query across refresh, pagination, and agent changes",
    async (statusFilter) => {
      vi.useFakeTimers();
      const {
        controller,
        context,
        list,
        expectRows,
        expectQuery,
        selectMembership,
        selectAgent,
        selectStatusFilter,
        reconnect,
        publishSessionChanged,
      } = createFilteredSessionController(statusFilter, SIDEBAR_SESSION_ROSTER_LIMIT * 4, true);
      controller.connect();
      await selectMembership({ ownerId: null, involvingMe: true });
      expectRows(pageSize);
      expectQuery({ involvingMe: true, excludeDock: true });
      expect(controller.sessionsResult?.sessions.every((row) => row.updatedAt! % 2 === 1)).toBe(
        true,
      );

      await controller.loadMoreSidebarSessions();
      expectRows(pageSize * 2);
      expectQuery({ involvingMe: true, offset: pageSize });
      await controller.refreshSidebarSessions();
      expectRows(pageSize * 2);

      list.mockClear();
      publishSessionChanged();
      await vi.advanceTimersByTimeAsync(5_000);
      expect(list.mock.calls.some(([query]) => query?.involvingMe === true)).toBe(true);
      expectRows(pageSize * 2);

      list.mockClear();
      reconnect();
      await controller.refreshSidebarSessions();
      expect(list.mock.calls.some(([query]) => query?.involvingMe === true)).toBe(true);
      expectRows(pageSize * 2);

      selectStatusFilter(statusFilter === "all" ? "archived" : "all");
      await controller.refreshSidebarSessions();
      expectQuery({ involvingMe: true });
      expectRows(pageSize);

      selectAgent("research");
      await controller.refreshSidebarSessions();
      expectQuery({ agentId: "research", involvingMe: true });
      expectRows(pageSize);

      // A mutation of the previous agent can settle after this selection.
      const outcome = await context.sessions.reconcileMutation("main");
      expect(outcome.status).toBe("refreshed");
      expectQuery({ agentId: "main" });
      const readsAfterMutation = list.mock.calls.length;
      await controller.refreshSidebarSessions("main");
      controller.refreshPresentation();
      expect(list).toHaveBeenCalledTimes(readsAfterMutation);
      expect(controller.sessionsAgentId).toBe("research");
      await controller.loadMoreSidebarSessions();
      expectQuery({ agentId: "research", involvingMe: true, offset: pageSize });
      expectRows(pageSize * 2);

      await selectMembership({ ownerId: "profile-ada", involvingMe: false });
      expectQuery({ ownerId: "profile-ada" });
      expect(list.mock.lastCall?.[0]?.involvingMe).toBeUndefined();
      expectRows(pageSize);

      await selectMembership({ ownerId: null, involvingMe: false });
      expect(list.mock.lastCall?.[0]?.ownerId).toBeUndefined();
      expect(list.mock.lastCall?.[0]?.involvingMe).toBeUndefined();
    },
  );
  it("does not replay a hidden primary list failure after its filter retires", async () => {
    const { controller, context, list, selectStatusFilter } = await readyController(
      "archived",
      1,
      true,
    );
    await context.sessions.refresh({ agentId: "main", force: true });
    list.mockRejectedValueOnce(new Error("Hidden primary list failed"));
    await context.sessions.refresh({ agentId: "main", force: true });
    expect(context.sessions.state.error).toBe("Hidden primary list failed");
    expect(controller.sessionMutationError).toBeNull();

    selectStatusFilter("active");
    context.sessions.patchRowLocal("agent:main:remote-change", { label: "Current title" });

    expect(controller.sessionMutationError).toBeNull();
  });

  it("keeps a failed session mutation with its caller instead of the sidebar list", async () => {
    const { controller, client, context } = await readyController("active", 1, true);
    const request = client.request.bind(client);
    vi.spyOn(client, "request").mockImplementation(
      <T>(method: string, params?: unknown): Promise<T> =>
        method === "sessions.patch"
          ? Promise.reject(new Error("Duplicate session name"))
          : request<T>(method, params),
    );

    await expect(
      context.sessions.patch("agent:main:remote-change", { label: "Duplicate" }),
    ).rejects.toThrow("Duplicate session name");

    expect(context.sessions.state.error).toBe("Duplicate session name");
    expect(controller.sessionMutationError).toBeNull();
  });

  it.each(["active", "archived", "all"] as const)(
    "clears a recovered %s list failure without erasing a same-text action failure",
    async (statusFilter) => {
      const { controller, selectStatusFilter, refreshError, expectRows } = await readyController(
        statusFilter,
        1,
        true,
      );
      await refreshError("Session request failed");
      await refreshError();
      expectRows(1);
      await refreshError("Session request failed");
      const mutation = controller.beginSessionMutation();
      expect(mutation).not.toBeNull();
      controller.publishSessionMutationError(mutation!, new Error("Session request failed"));
      await refreshError("Background session list failed", "Session request failed");
      await refreshError(undefined, "Session request failed");
      selectStatusFilter(statusFilter === "archived" ? "all" : "archived");
      expect(controller.sessionMutationError).toBe("Session request failed");

      controller.disconnect();
      expect(controller.sessionMutationError).toBeNull();
    },
  );

  it.each(["archived", "all"] as const)(
    "retires the %s list failure when its selected filter changes",
    async (statusFilter) => {
      const { controller, refreshError, selectStatusFilter } =
        createFilteredSessionController(statusFilter);
      controller.connect();
      await refreshError("Retired session list failed");
      selectStatusFilter("active");

      expect(controller.sessionMutationError).toBeNull();
      controller.disconnect();
    },
  );

  it("dismisses a filtered list failure without restoring it on recovery", async () => {
    const { controller, refreshError } = createFilteredSessionController("archived");
    controller.connect();
    await refreshError("Dismissed session list failed");
    controller.dismissSessionMutationError();
    expect(controller.sessionMutationError).toBeNull();

    await refreshError();
  });

  it("ignores a retired filter's delayed failure after the replacement scope binds", async () => {
    const { controller, list, selectStatusFilter } = await readyController("archived");
    const delayedList = createDeferred<Awaited<ReturnType<typeof list>>>();
    list.mockImplementationOnce(async () => await delayedList.promise);

    const retiredRefresh = controller.refreshSidebarSessions();
    expect(list).toHaveBeenCalledOnce();
    selectStatusFilter("all");
    delayedList.reject(new Error("Retired archived request failed"));
    await retiredRefresh;

    expect(controller.sessionMutationError).toBeNull();
  });

  it("evicts removed-agent caches while retaining current results owned by the roster", () => {
    const { controller, publishAgentRoster } = createFilteredSessionController("all");
    controller.connect();
    controller.sessionResultsByAgent = {
      main: sessionPage(["agent:main:kept"]),
      research: sessionPage(["agent:research:removed"]),
    };
    controller.sessionsResult = controller.sessionResultsByAgent.research ?? null;
    controller.sessionsAgentId = "research";

    publishAgentRoster(null);
    expect(Object.keys(controller.sessionResultsByAgent)).toEqual(["main", "research"]);

    publishAgentRoster(["main"]);
    expect(Object.keys(controller.sessionResultsByAgent)).toEqual(["main"]);
    expect(controller).toMatchObject({ sessionsResult: null, sessionsAgentId: null });

    const current = sessionPage(["agent:main:current"]);
    controller.sessionsResult = current;
    controller.sessionsAgentId = "main";
    controller.sessionResultsByAgent = {};
    publishAgentRoster(["main"]);
    expect(controller.sessionsAgentId).toBe("main");
    expect(controller.sessionsResult).toBe(current);
  });

  it.each(["other agent", "changed selection", "disconnected"] as const)(
    "does not refresh a retired event scope: %s",
    async (scope) => {
      vi.useFakeTimers();
      const { controller, list, publishSessionChanged, selectAgent } =
        await readyController("archived");
      publishSessionChanged(
        scope === "other agent"
          ? { sessionKey: "agent:research:remote-change", agentId: "research" }
          : {},
      );
      if (scope === "changed selection") {
        selectAgent("research");
        list.mockClear();
      } else if (scope === "disconnected") {
        controller.disconnect();
      }
      await vi.advanceTimersByTimeAsync(5_000);
      expect(list).not.toHaveBeenCalled();
    },
  );

  it("retires an in-flight child snapshot when the status filter changes", async () => {
    const { controller, host, list, selectStatusFilter } = await readyController("archived");
    const parents = vi
      .spyOn(host, "childSessionParents")
      .mockReturnValue(new Set(["agent:main:parent"]));
    const childPage = createDeferred<Awaited<ReturnType<typeof list>>>();
    list.mockImplementationOnce(async () => await childPage.promise);

    const pendingChildren = controller.loadChildSessions("agent:main:parent");
    expect(controller.loadingChildSessionKeys.has("agent:main:parent")).toBe(true);

    parents.mockReturnValue(new Set());
    selectStatusFilter("all");
    childPage.resolve({
      ...sessionPage(["agent:main:stale-child"], 2),
      totalCount: 1,
      nextOffset: null,
      hasMore: false,
    });
    await pendingChildren;

    expect(controller.childSessionRowsByParent).toEqual({});
    expect(controller.loadedChildSessionKeys.has("agent:main:parent")).toBe(false);
    expect(controller.loadingChildSessionKeys.has("agent:main:parent")).toBe(false);
  });
});
