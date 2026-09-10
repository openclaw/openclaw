import { describe, expect, it, vi } from "vitest";
import { SIDEBAR_SESSION_ROSTER_LIMIT } from "../../../../src/shared/session-list-limits.ts";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { GatewayRequestError, type GatewayBrowserClient } from "../../api/gateway.ts";
import type { SessionsListResult } from "../../api/types.ts";
import { createTestGatewayClient } from "../../test-helpers/gateway-client.ts";
import {
  createGatewayHarness,
  createSessionCapabilityHarness,
  createTestSessionCapability,
  sessionsResult,
} from "./session-capability.test-support.ts";
import type { SessionGateway } from "./session-capability.ts";

const SESSION_EVENT_REFRESH_DEBOUNCE_MS = 200;

type ListParams = {
  agentId?: string;
  archived?: true | "all";
  boardFace?: "chat" | "dashboard";
  hasBoard?: boolean;
  includeDerivedTitles?: boolean;
  includeLastMessage?: boolean;
  limit?: number;
  offset?: number;
};

function listResult(keys: string[] = [], totalCount = keys.length, offset = 0): SessionsListResult {
  const nextOffset = offset + keys.length;
  return {
    ts: 1,
    path: "",
    count: keys.length,
    totalCount,
    hasMore: nextOffset < totalCount,
    nextOffset: nextOffset < totalCount ? nextOffset : null,
    defaults: { modelProvider: null, model: null, contextTokens: null },
    sessions: keys.map((key, updatedAt) => ({ key, kind: "direct", updatedAt })),
  };
}

function sessionHarness(request: unknown) {
  const snapshot: SessionGateway["snapshot"] = {
    client: { request } as unknown as GatewayBrowserClient,
    phase: "connected" as "connected" | "reconnecting",
    sessionKey: "agent:main:main",
    assistantAgentId: "main",
    hello: null,
  };
  let listener: ((next: typeof snapshot) => void) | undefined;
  const sessions = createTestSessionCapability({
    snapshot,
    subscribe(next) {
      listener = next;
      return () => undefined;
    },
    subscribeEvents: () => () => undefined,
  });
  return {
    sessions,
    publish: (patch: Partial<SessionGateway["snapshot"]>) => {
      Object.assign(snapshot, patch);
      listener?.(snapshot);
    },
    reconnect: () => {
      for (const phase of ["reconnecting", "connected"] as const) {
        snapshot.phase = phase;
        listener?.(snapshot);
      }
    },
  };
}

describe("session list requests", () => {
  it("clears serialized start timing tombstones while the next roster read is pending", async () => {
    vi.useFakeTimers();
    const child = {
      key: "agent:main:timing-child",
      sessionId: "timing-child-session",
      spawnedBy: "agent:main:timing-parent",
      kind: "direct" as const,
      label: "Keep this child title",
      status: "done" as const,
      hasActiveRun: false,
      activeRunIds: [],
      updatedAt: 121_000,
      startedAt: 1_000,
      endedAt: 121_000,
      runtimeMs: 120_000,
    };
    const sibling = {
      ...child,
      key: "agent:main:timing-sibling",
      sessionId: "timing-sibling-session",
    };
    const initial = sessionsResult([child, sibling], 121_000);
    const nextList = createDeferred<SessionsListResult>();
    let listCalls = 0;
    const request = vi.fn(async (method: string): Promise<SessionsListResult> => {
      if (method !== "sessions.list") {
        throw new Error(`Unexpected request: ${method}`);
      }
      listCalls += 1;
      return listCalls === 1 ? initial : nextList.promise;
    });
    const { gateway, emitEvent } = createGatewayHarness(createTestGatewayClient(request));
    const sessions = createTestSessionCapability(gateway);

    try {
      await sessions.refresh({ agentId: "main", force: true });
      const wire = JSON.stringify({
        sessionKey: child.key,
        agentId: "main",
        phase: "start",
        runId: "run-b",
        ts: 200_000,
        session: {
          key: child.key,
          sessionId: child.sessionId,
          kind: "direct",
          archived: false,
          updatedAt: 200_000,
          startedAt: 200_000,
          endedAt: null,
          runtimeMs: null,
          status: "running",
          hasActiveRun: true,
          activeRunIds: ["run-b"],
        },
      });
      const payload: unknown = JSON.parse(wire);
      emitEvent({ type: "event", event: "sessions.changed", payload });
      await vi.advanceTimersByTimeAsync(SESSION_EVENT_REFRESH_DEBOUNCE_MS);

      expect(request).toHaveBeenCalledTimes(2);
      const current = sessions.state.result?.sessions.find((row) => row.key === child.key);
      expect(current).toMatchObject({
        key: child.key,
        sessionId: child.sessionId,
        spawnedBy: child.spawnedBy,
        label: child.label,
        updatedAt: 200_000,
        startedAt: 200_000,
        status: "running",
        hasActiveRun: true,
        activeRunIds: ["run-b"],
      });
      expect(current?.endedAt).toBeUndefined();
      expect(current?.runtimeMs).toBeUndefined();
      expect(sessions.state.result?.sessions.map((row) => row.key)).toEqual([
        child.key,
        sibling.key,
      ]);
      expect(sessions.state.result?.sessions.find((row) => row.key === sibling.key)).toEqual(
        sibling,
      );
    } finally {
      sessions.dispose();
      nextList.resolve(initial);
      await vi.advanceTimersByTimeAsync(0);
      vi.useRealTimers();
    }
  });

  it("keeps an observed active query independent and retires its disposed handle", async () => {
    const pending = createDeferred<SessionsListResult>();
    let holdRefresh = false;
    const request = vi.fn(async (_method: string, params?: ListParams) => {
      if (holdRefresh) {
        return pending.promise;
      }
      const keys = Array.from({ length: 3 }, (_, index) => `agent:${params?.agentId}:${index}`);
      return listResult(keys.slice(0, params?.limit ?? 3), keys.length);
    });
    const { sessions } = sessionHarness(request);
    await sessions.refresh({ agentId: "main", limit: 1, force: true });
    const primary = sessions.state.result;
    const query = { agentId: "writer", limit: 2 };
    const listener = vi.fn();
    const observation = sessions.observeList(query, listener);

    try {
      expect(listener).toHaveBeenCalledExactlyOnceWith({
        result: null,
        agentId: null,
        loading: false,
        error: null,
      });
      expect(request).toHaveBeenCalledOnce();
      query.agentId = "research";
      query.limit = 1;

      await observation.refresh();

      expect(request).toHaveBeenLastCalledWith(
        "sessions.list",
        expect.objectContaining({ agentId: "writer", limit: 2 }),
      );
      expect(listener).toHaveBeenLastCalledWith({
        result: listResult(["agent:writer:0", "agent:writer:1"], 3),
        agentId: "writer",
        loading: false,
        error: null,
      });
      expect(sessions.state.result).toEqual(primary);

      holdRefresh = true;
      const refresh = observation.refresh();
      const retired = expect(refresh).rejects.toThrow("disposed");
      observation.dispose();
      const callbacksAfterDispose = listener.mock.calls.length;
      pending.resolve(listResult(["agent:writer:late"]));
      await retired;

      expect(listener).toHaveBeenCalledTimes(callbacksAfterDispose);
      expect(sessions.state.result).toEqual(primary);
      const requestsAfterDispose = request.mock.calls.length;
      await expect(observation.refresh()).rejects.toThrow("disposed");
      expect(request).toHaveBeenCalledTimes(requestsAfterDispose);
    } finally {
      pending.resolve(listResult());
      observation.dispose();
      sessions.dispose();
    }
  });

  it.each([
    { managedAgentId: "work", expectedSource: "managed" },
    { managedAgentId: "main", expectedSource: "primary" },
  ] as const)(
    "keeps a $managedAgentId global query scoped when a newer Main observation arrives",
    async ({ managedAgentId, expectedSource }) => {
      // Explicit session IDs are scoped to agent stores, including their global rows.
      const primaryRow = {
        key: "global",
        kind: "global" as const,
        agentId: "main",
        sessionId: "operator-session",
        updatedAt: 10,
        label: "Current Main label",
        derivedTitle: "Current Main title",
        lastMessagePreview: "Current Main preview",
      };
      const managedRow = {
        ...primaryRow,
        agentId: managedAgentId,
        label: "Managed query label",
        derivedTitle: "Managed query title",
        lastMessagePreview: "Managed query preview",
      };
      const held = createDeferred<SessionsListResult>();
      const request = vi.fn(async (method: string, params?: ListParams) => {
        expect(method).toBe("sessions.list");
        return params?.archived === "all" ? held.promise : sessionsResult([primaryRow], 10);
      });
      const { sessions } = sessionHarness(request);
      const query = { agentId: managedAgentId, archivedFilter: "all" as const };
      const listener = vi.fn();
      const observation = sessions.observeList(query, listener);
      const pending = observation.refresh();

      try {
        expect(request).toHaveBeenCalledExactlyOnceWith(
          "sessions.list",
          expect.objectContaining({ agentId: managedAgentId, archived: "all" }),
        );
        await sessions.refresh({ agentId: "main", force: true });
        held.resolve(sessionsResult([managedRow], 10));
        await pending;

        const expectedRow = expectedSource === "primary" ? primaryRow : managedRow;
        expect(sessions.listSnapshot(query)).toMatchObject({
          agentId: managedAgentId,
          result: { sessions: [expectedRow] },
        });
        expect(listener).toHaveBeenLastCalledWith(
          expect.objectContaining({
            agentId: managedAgentId,
            result: expect.objectContaining({ sessions: [expectedRow] }),
          }),
        );
        expect(sessions.state.result?.sessions).toEqual([primaryRow]);
      } finally {
        held.resolve(sessionsResult([managedRow], 10));
        await Promise.allSettled([pending]);
        observation.dispose();
        sessions.dispose();
      }
    },
  );

  it("queues a reentrant observed refresh behind the current request", async () => {
    const firstResponse = createDeferred<SessionsListResult>();
    const secondResponse = createDeferred<SessionsListResult>();
    const secondStarted = createDeferred();
    const request = vi
      .fn()
      .mockImplementationOnce(async () => firstResponse.promise)
      .mockImplementationOnce(async () => {
        secondStarted.resolve();
        return secondResponse.promise;
      });
    const { sessions } = sessionHarness(request);
    let requestedAgain = false;
    let reentrant: Promise<void> | undefined;
    let observedKeys: string[] = [];
    const observation = sessions.observeList({ agentId: "writer", limit: 2 }, (snapshot) => {
      observedKeys = snapshot.result?.sessions.map((row) => row.key) ?? [];
      if (snapshot.loading && !requestedAgain) {
        requestedAgain = true;
        reentrant = observation.refresh();
      }
    });
    const initial = observation.refresh();

    try {
      expect(requestedAgain).toBe(true);
      expect(request).toHaveBeenCalledOnce();

      firstResponse.resolve(listResult(["agent:writer:first"]));
      await secondStarted.promise;
      expect(request).toHaveBeenCalledTimes(2);

      secondResponse.resolve(listResult(["agent:writer:current"]));
      await Promise.all([initial, reentrant]);
      expect(request).toHaveBeenCalledTimes(2);
      expect(observedKeys).toEqual(["agent:writer:current"]);
    } finally {
      firstResponse.resolve(listResult());
      secondResponse.resolve(listResult());
      await Promise.allSettled([initial, reentrant]);
      observation.dispose();
      sessions.dispose();
    }
  });

  it.each([false, true])(
    "settles managed-only terminals before refresh (refresh fails: %s)",
    async (refreshFails) => {
      vi.useFakeTimers();
      const key = "agent:writer:linked";
      let writerFinished = false;
      const request = vi.fn(async (method: string, params?: { agentId?: string }) => {
        if (method !== "sessions.list") {
          throw new Error(`Unexpected request: ${method}`);
        }
        const agentId = params?.agentId ?? "main";
        const done = agentId === "writer" && writerFinished;
        if (done && refreshFails) {
          throw new Error("List refresh failed");
        }
        const result = sessionsResult(
          [
            {
              key: agentId === "writer" ? key : `agent:${agentId}:main`,
              sessionId: `${agentId}-session`,
              kind: "direct",
              updatedAt: done ? 2 : 1,
              hasActiveRun: !done,
              activeRunIds: done ? [] : [`${agentId}-run`],
              status: done ? "done" : "running",
            },
          ],
          done ? 2 : 1,
        );
        return { ...result, totalCount: 3, hasMore: true, nextOffset: 1 };
      });
      const { sessions } = createSessionCapabilityHarness(
        request as unknown as GatewayBrowserClient["request"],
      );
      const writerQuery = { agentId: "writer", archivedFilter: "all" as const, limit: 2 };
      const otherWriterQuery = { ...writerQuery, ownerId: "ada" };
      const researchQuery = { ...writerQuery, agentId: "research" };
      const observed: unknown[] = [];
      const stopWriter = sessions.subscribeList(writerQuery, (snapshot) => {
        if (!snapshot.loading && !snapshot.result?.sessions[0]?.hasActiveRun) {
          observed.push(sessions.listSnapshot(otherWriterQuery).result?.sessions[0]?.status);
        }
      });
      const stopOtherWriter = sessions.subscribeList(otherWriterQuery, () => undefined);
      const stopResearch = sessions.subscribeList(researchQuery, () => undefined);

      try {
        await sessions.refresh({ agentId: "main", force: true });
        await sessions.refreshList(writerQuery);
        await sessions.refreshList(otherWriterQuery);
        await sessions.refreshList(researchQuery);
        const primary = sessions.state.result;
        expect(sessions.listSnapshot(writerQuery).result?.sessions[0]).toMatchObject({
          key,
          hasActiveRun: true,
          status: "running",
        });
        request.mockClear();
        writerFinished = true;

        sessions.reconcileRunTerminal({
          sessionKeys: [key],
          runId: "writer-run",
          status: "done",
          endedAt: 2,
        });
        expect(sessions.listSnapshot(writerQuery).result?.sessions[0]).toMatchObject({
          key,
          hasActiveRun: false,
          activeRunIds: [],
          status: "done",
        });
        expect(observed).toEqual(["done"]);
        expect(sessions.listSnapshot(writerQuery).result).toMatchObject({
          count: 1,
          totalCount: 3,
          hasMore: true,
          nextOffset: 1,
        });
        expect(request).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(SESSION_EVENT_REFRESH_DEBOUNCE_MS);

        expect(sessions.listSnapshot(writerQuery).result?.sessions[0]).toMatchObject({
          key,
          hasActiveRun: false,
          status: "done",
        });
        expect(sessions.state.result).toEqual(primary);
        expect(sessions.listSnapshot(writerQuery).error).toBe(
          refreshFails ? "List refresh failed" : null,
        );
        expect(sessions.listSnapshot(researchQuery).result?.sessions[0]).toMatchObject({
          key: "agent:research:main",
          hasActiveRun: true,
          status: "running",
        });
        expect(request.mock.calls.map(([, params]) => params?.agentId)).not.toContain("research");
      } finally {
        stopWriter();
        stopOtherWriter();
        stopResearch();
        sessions.dispose();
        vi.useRealTimers();
      }
    },
  );

  it("forwards a trimmed parent key when listing child sessions", async () => {
    const request = vi.fn(async (_method: string, _params?: unknown) => listResult());
    const { sessions } = sessionHarness(request);
    const options = { agentId: "main", limit: 20, includeGlobal: false, includeUnknown: false };
    await sessions.list({ ...options, spawnedBy: "  agent:main:parent  " });
    expect(request).toHaveBeenCalledWith("sessions.list", {
      ...options,
      configuredAgentsOnly: true,
      spawnedBy: "agent:main:parent",
    });
    sessions.dispose();
  });

  it("maps archived status filters to the tri-state wire contract", async () => {
    const request = vi.fn(async (_method: string, _params?: unknown) => listResult());
    const { sessions } = sessionHarness(request);
    await sessions.list({ archivedFilter: "active", activeMinutes: 30 });
    await sessions.list({ archivedFilter: "archived", activeMinutes: 30 });
    await sessions.list({ archivedFilter: "all", activeMinutes: 30 });
    expect(request.mock.calls[0]?.[1]).toMatchObject({ activeMinutes: 30 });
    expect(request.mock.calls[0]?.[1]).not.toHaveProperty("archived");
    expect(request.mock.calls[1]?.[1]).toMatchObject({ archived: true });
    expect(request.mock.calls[1]?.[1]).not.toHaveProperty("activeMinutes");
    expect(request.mock.calls[2]?.[1]).toMatchObject({ archived: "all" });
    expect(request.mock.calls[2]?.[1]).not.toHaveProperty("activeMinutes");
    sessions.dispose();
  });

  it("forwards the server-side face filter", async () => {
    const request = vi.fn(async () => listResult());
    const { sessions } = sessionHarness(request);
    await sessions.list({ boardFace: "dashboard" });
    expect(request).toHaveBeenCalledWith("sessions.list", {
      configuredAgentsOnly: true,
      boardFace: "dashboard",
      includeGlobal: true,
      includeUnknown: true,
      limit: SIDEBAR_SESSION_ROSTER_LIMIT,
    });
    sessions.dispose();
  });

  it("forwards the involving-me predicate", async () => {
    const request = vi.fn(async () => listResult());
    const { sessions } = sessionHarness(request);
    await sessions.list({ involvingMe: true });
    expect(request).toHaveBeenCalledWith(
      "sessions.list",
      expect.objectContaining({ involvingMe: true }),
    );
    sessions.dispose();
  });

  it("discards a list rejection from a retired same-client connection", async () => {
    let rejectStale!: (error: Error) => void;
    const staleRequest = new Promise<SessionsListResult>((_resolve, reject) => {
      rejectStale = reject;
    });
    const request = vi.fn(async () => staleRequest);
    const { sessions, reconnect } = sessionHarness(request);
    const retiredRequest = sessions.list({ boardFace: "dashboard" });
    reconnect();
    rejectStale(new Error("retired connection"));
    await expect(retiredRequest).resolves.toBeNull();
    sessions.dispose();
  });

  it("keeps filtered pages scoped without replacing the canonical active roster", async () => {
    const request = vi.fn(async (_method: string, params?: ListParams) => {
      const filter = params?.archived === true ? "archived" : params?.archived || "active";
      const offset = params?.offset ?? 0;
      const keys = Array.from({ length: 4 }, (_, index) => `agent:main:${filter}-${index}`);
      return listResult(keys.slice(offset, offset + (params?.limit ?? 50)), 4, offset);
    });
    const { sessions } = sessionHarness(request);
    const archivedScope = { agentId: "main", archivedFilter: "archived" as const, limit: 2 };
    const allScope = { agentId: "main", archivedFilter: "all" as const, limit: 1 };
    const observeSnapshot = vi.fn();
    const unsubscribe = sessions.subscribeList(archivedScope, observeSnapshot);
    await sessions.refreshList({ agentId: "main", limit: 1, force: true });
    const activeResult = sessions.state.result;
    await sessions.refreshList({ ...archivedScope, limit: 2 });
    await sessions.refreshList({ ...archivedScope, limit: 2, offset: 2, append: true });
    await sessions.refreshList({ ...allScope, limit: 1 });
    await sessions.refreshList({ ...archivedScope, limit: 2 });
    expect(request).toHaveBeenLastCalledWith(
      "sessions.list",
      expect.objectContaining({ agentId: "main", archived: true, limit: 4 }),
    );
    expect(sessions.listSnapshot(archivedScope).result?.sessions).toHaveLength(4);
    expect(sessions.listSnapshot(allScope).result?.sessions).toHaveLength(1);
    expect(sessions.state.result).toBe(activeResult);
    expect(sessions.canonicalListRevision).toBe(1);
    expect(observeSnapshot).toHaveBeenCalledWith(expect.objectContaining({ loading: true }));
    unsubscribe();
    sessions.dispose();
  });

  it("coalesces concurrent managed-list demand while preserving later forced refreshes", async () => {
    let resolveRequest!: (result: SessionsListResult) => void;
    const pendingResult = new Promise<SessionsListResult>((resolve) => {
      resolveRequest = resolve;
    });
    const request = vi
      .fn()
      .mockImplementationOnce(async () => pendingResult)
      .mockResolvedValue(listResult(["agent:main:refreshed"]));
    const { sessions } = sessionHarness(request);
    const query = { agentId: "main", archivedFilter: "all" as const, limit: 50 };
    const unsubscribe = sessions.subscribeList(query, () => undefined);

    try {
      const first = sessions.refreshList(query);
      const duplicate = sessions.refreshList(query);
      expect(duplicate).toBe(first);
      expect(request).toHaveBeenCalledOnce();

      resolveRequest(listResult(["agent:main:initial"]));
      await Promise.all([first, duplicate]);
      expect(request).toHaveBeenCalledOnce();

      await sessions.refreshList({ ...query, force: true });
      expect(request).toHaveBeenCalledTimes(2);
      expect(sessions.listSnapshot(query).result?.sessions[0]?.key).toBe("agent:main:refreshed");
    } finally {
      resolveRequest(listResult());
      unsubscribe();
      sessions.dispose();
    }
  });

  it.each([
    { description: "archived", query: { archivedFilter: "archived" as const } },
    { description: "all", query: { archivedFilter: "all" as const } },
    { description: "dashboard", query: { boardFace: "dashboard" as const } },
    { description: "involving-me", query: { involvingMe: true as const } },
  ])(
    "honors a forced $description refresh requested during an existing load",
    async ({ query }) => {
      let resolveRequest!: (result: SessionsListResult) => void;
      const pendingResult = new Promise<SessionsListResult>((resolve) => {
        resolveRequest = resolve;
      });
      const request = vi
        .fn()
        .mockImplementationOnce(async () => pendingResult)
        .mockResolvedValue(listResult(["agent:main:current"]));
      const { sessions } = sessionHarness(request);
      const scope = { agentId: "main", limit: 50, ...query };
      const unsubscribe = sessions.subscribeList(scope, () => undefined);

      try {
        const pending = sessions.refreshList(scope);
        const forced = sessions.refreshList({ ...scope, force: true });
        const repeated = sessions.refreshList({ ...scope, force: true });
        expect(forced).toBe(pending);
        expect(repeated).toBe(pending);

        resolveRequest(listResult(["agent:main:stale"]));
        await Promise.all([pending, forced, repeated]);

        expect(request).toHaveBeenCalledTimes(2);
        expect(sessions.listSnapshot(scope).result?.sessions[0]?.key).toBe("agent:main:current");
      } finally {
        resolveRequest(listResult());
        unsubscribe();
        sessions.dispose();
      }
    },
  );

  it("does not queue forced filtered pagination behind an in-flight replacement", async () => {
    let resolveRequest!: (result: SessionsListResult) => void;
    const pendingResult = new Promise<SessionsListResult>((resolve) => {
      resolveRequest = resolve;
    });
    const firstPage = listResult(["agent:main:first", "agent:main:second"], 4);
    const request = vi
      .fn()
      .mockResolvedValueOnce(firstPage)
      .mockImplementationOnce(async () => pendingResult);
    const { sessions } = sessionHarness(request);
    const scope = { archivedFilter: "archived" as const, limit: 2 };
    const unsubscribe = sessions.subscribeList(scope, () => undefined);

    try {
      await sessions.refreshList(scope);
      const pending = sessions.refreshList({ ...scope, force: true });
      const append = sessions.refreshList({ ...scope, offset: 2, append: true, force: true });
      expect(append).toBe(pending);

      resolveRequest(firstPage);
      await Promise.all([pending, append]);

      expect(request).toHaveBeenCalledTimes(2);
      expect(sessions.listSnapshot(scope).result?.sessions).toEqual(firstPage.sessions);
    } finally {
      resolveRequest(firstPage);
      unsubscribe();
      sessions.dispose();
    }
  });

  it("retains an in-flight managed query while its route subscriber is replaced", async () => {
    let resolveRequest!: (result: SessionsListResult) => void;
    const pendingResult = new Promise<SessionsListResult>((resolve) => {
      resolveRequest = resolve;
    });
    const request = vi.fn(async () => pendingResult);
    const { sessions } = sessionHarness(request);
    const query = { agentId: "main", archivedFilter: "all" as const, limit: 50 };
    let unsubscribe = sessions.subscribeList(query, () => undefined);

    try {
      const first = sessions.refreshList(query);
      unsubscribe();
      unsubscribe = sessions.subscribeList(query, () => undefined);

      expect(sessions.listSnapshot(query).loading).toBe(true);
      const replacement = sessions.refreshList(query);
      expect(replacement).toBe(first);
      expect(request).toHaveBeenCalledOnce();

      resolveRequest(listResult(["agent:main:retained"]));
      await Promise.all([first, replacement]);
      expect(sessions.listSnapshot(query).result?.sessions[0]?.key).toBe("agent:main:retained");
      expect(request).toHaveBeenCalledOnce();
    } finally {
      resolveRequest(listResult());
      unsubscribe();
      sessions.dispose();
    }
  });

  it("keeps dashboard and sidebar queries distinct without inventing a dashboard agent", async () => {
    const request = vi.fn(async (_method: string, params?: ListParams) =>
      listResult([
        params?.hasBoard === true ? "agent:main:dashboard-result" : "agent:main:sidebar-result",
      ]),
    );
    const { sessions } = sessionHarness(request);
    const dashboardQuery = {
      limit: 50,
      hasBoard: true,
      archivedFilter: "all" as const,
    };
    const sidebarQuery = {
      agentId: "main",
      limit: 60,
      includeDerivedTitles: true,
      includeLastMessage: true,
      archivedFilter: "all" as const,
    };
    const stopDashboard = sessions.subscribeList(dashboardQuery, () => undefined);
    const stopSidebar = sessions.subscribeList(sidebarQuery, () => undefined);

    await sessions.refreshList({
      ...dashboardQuery,
      includeGlobal: true,
      includeUnknown: true,
      configuredAgentsOnly: true,
      includeDerivedTitles: false,
      includeLastMessage: false,
      force: true,
    });
    await sessions.refreshList({ ...sidebarQuery, force: true });

    expect(sessions.listSnapshot(dashboardQuery).result?.sessions[0]?.key).toBe(
      "agent:main:dashboard-result",
    );
    expect(sessions.listSnapshot(sidebarQuery).result?.sessions[0]?.key).toBe(
      "agent:main:sidebar-result",
    );
    expect(request.mock.calls[0]?.[1]).toEqual({
      includeGlobal: true,
      includeUnknown: true,
      configuredAgentsOnly: true,
      limit: 50,
      archived: "all",
      hasBoard: true,
    });
    expect(request.mock.calls[0]?.[1]).not.toHaveProperty("agentId");
    expect(request.mock.calls[1]?.[1]).toMatchObject({
      agentId: "main",
      archived: "all",
      includeDerivedTitles: true,
      includeLastMessage: true,
      limit: 60,
    });
    stopDashboard();
    stopSidebar();
    sessions.dispose();
  });

  it("keeps explicit unenriched page queries independent from the primary roster", async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce(listResult(["agent:main:primary"]))
      .mockResolvedValueOnce(listResult(["agent:main:page"]));
    const { sessions } = sessionHarness(request);
    const pageQuery = {
      agentId: "main",
      limit: 50,
      includeGlobal: true,
      includeUnknown: true,
      configuredAgentsOnly: true,
      includeDerivedTitles: false,
      includeLastMessage: false,
    };
    const unsubscribe = sessions.subscribeList(pageQuery, () => undefined);

    await sessions.refreshList({ agentId: "main", limit: 50, force: true });
    const primaryResult = sessions.state.result;
    await sessions.refreshList({ ...pageQuery, force: true });

    expect(sessions.state.result).toBe(primaryResult);
    expect(sessions.listSnapshot(pageQuery).result?.sessions[0]?.key).toBe("agent:main:page");
    expect(request.mock.calls[1]?.[1]).toEqual({
      agentId: "main",
      configuredAgentsOnly: true,
      includeGlobal: true,
      includeUnknown: true,
      limit: 50,
    });
    unsubscribe();
    sessions.dispose();
  });

  it("keeps involving-me queries independent from the primary roster", async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce(listResult(["agent:main:primary"]))
      .mockResolvedValueOnce(listResult(["agent:main:involving-me"]));
    const { sessions } = sessionHarness(request);
    const involvingMeQuery = {
      agentId: "main",
      limit: 50,
      includeGlobal: true,
      includeUnknown: true,
      configuredAgentsOnly: true,
      involvingMe: true,
    };
    const unsubscribe = sessions.subscribeList(involvingMeQuery, () => undefined);

    await sessions.refreshList({ agentId: "main", limit: 50, force: true });
    const primaryResult = sessions.state.result;
    await sessions.refreshList({ ...involvingMeQuery, force: true });

    expect(sessions.state.result).toBe(primaryResult);
    expect(sessions.listSnapshot(involvingMeQuery).result?.sessions[0]?.key).toBe(
      "agent:main:involving-me",
    );
    expect(request.mock.calls[1]?.[1]).toMatchObject({ involvingMe: true });
    unsubscribe();
    sessions.dispose();
  });

  it("retires stale filtered snapshots across same-client reconnects without losing subscribers", async () => {
    let resolveStale!: (result: SessionsListResult) => void;
    const staleResult = new Promise<SessionsListResult>((resolve) => {
      resolveStale = resolve;
    });
    let archivedRequests = 0;
    const request = vi.fn(async (method: string, params?: { archived?: boolean }) => {
      if (method === "sessions.subscribe") {
        return { subscribed: true };
      }
      if (params?.archived) {
        archivedRequests += 1;
        return archivedRequests === 1 ? staleResult : listResult(["agent:main:current"]);
      }
      return listResult(["agent:main:active"]);
    });
    const { sessions, reconnect } = sessionHarness(request);
    const scope = { agentId: "main", archivedFilter: "archived" as const };
    const observed: Array<string | null> = [];
    const unsubscribe = sessions.subscribeList(scope, (next) =>
      observed.push(next.result?.sessions[0]?.key ?? null),
    );
    const retiredRequest = sessions.refreshList(scope);
    reconnect();
    resolveStale(listResult(["agent:main:stale"]));
    await retiredRequest;
    await sessions.refreshList(scope);
    expect(sessions.listSnapshot(scope).result?.sessions[0]?.key).toBe("agent:main:current");
    expect(observed).toContain(null);
    expect(observed).toContain("agent:main:current");
    expect(observed).not.toContain("agent:main:stale");
    unsubscribe();
    sessions.dispose();
  });

  it.each([
    [true, "before"],
    [false, "before"],
    [true, "during"],
    [false, "during"],
    [true, "after"],
    [false, "after"],
  ])(
    "recovers a failed managed list once when same-client admission reopens (lifecycle error: %s, failure: %s drain)",
    async (lifecycle, failureTiming) => {
      vi.useFakeTimers();
      let fail = false;
      let label = "original";
      const pending = createDeferred<SessionsListResult>();
      const error = new GatewayRequestError({
        code: "UNAVAILABLE",
        message: "Dashboard refresh unavailable",
        retryable: true,
        ...(lifecycle ? { details: { reason: "gateway-suspending", phase: "draining" } } : {}),
      });
      const request = vi.fn(async (_method: string, params?: ListParams) => {
        if (params?.hasBoard && fail) {
          return pending.promise;
        }
        return listResult([`agent:main:${label}`]);
      });
      const { sessions, publish } = sessionHarness(request);
      const query = { hasBoard: true };
      const unsubscribe = sessions.subscribeList(query, () => undefined);
      try {
        await sessions.refreshList(query);
        fail = true;
        const refresh = sessions.refreshList({ ...query, force: true });
        if (failureTiming === "during") {
          publish({ suspensionPhase: "draining" });
        }
        if (failureTiming !== "after") {
          pending.reject(error);
          await refresh;
          expect(sessions.listSnapshot(query).error).toBe(
            lifecycle ? null : "Dashboard refresh unavailable",
          );
        }
        expect(sessions.listSnapshot(query).result?.sessions[0]?.key).toBe("agent:main:original");

        if (failureTiming !== "during") {
          publish({ suspensionPhase: "draining" });
        }
        fail = false;
        label = "recovered";
        publish({ suspensionPhase: "accepting" });
        publish({ suspensionPhase: "accepting" });
        await vi.advanceTimersByTimeAsync(SESSION_EVENT_REFRESH_DEBOUNCE_MS);
        if (failureTiming === "after") {
          expect(request.mock.calls.filter(([, params]) => params?.hasBoard)).toHaveLength(2);
          pending.reject(error);
          await refresh;
        }
        expect(sessions.listSnapshot(query).result?.sessions[0]?.key).toBe("agent:main:recovered");
        expect(sessions.listSnapshot(query).error).toBeNull();
        expect(request.mock.calls.filter(([, params]) => params?.hasBoard)).toHaveLength(3);
      } finally {
        unsubscribe();
        sessions.dispose();
        vi.useRealTimers();
      }
    },
  );
});
