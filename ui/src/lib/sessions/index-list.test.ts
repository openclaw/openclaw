import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import {
  GatewayRequestError,
  type GatewayBrowserClient,
  type GatewayEventFrame,
} from "../../api/gateway.ts";
import type { GatewaySessionRow, SessionsListResult } from "../../api/types.ts";
import { createTestGatewayClient } from "../../test-helpers/gateway-client.ts";
import {
  createGatewayHarness,
  createSessionCapabilityHarness,
  createTestSessionCapability,
  sessionsResult,
} from "./session-capability.test-support.ts";
import type {
  SessionCapability,
  SessionGateway,
  SessionListScope,
  SessionRefreshOptions,
} from "./session-capability.ts";

const SESSION_EVENT_REFRESH_DEBOUNCE_MS = 5_000;

type ListParams = {
  agentId?: string;
  archived?: true | "all";
  hasBoard?: boolean;
  limit?: number;
};

function listResult(keys: string[] = [], totalCount = keys.length): SessionsListResult {
  const nextOffset = keys.length;
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

function listView(sessions: SessionCapability, query: SessionListScope) {
  const snapshot = () => sessions.listSnapshot(query);
  const rows = () => snapshot().result?.sessions;
  return {
    snapshot,
    rows,
    first: () => rows()?.[0],
    refresh: (options: Partial<SessionRefreshOptions> = {}) =>
      sessions.refreshList({ ...query, ...options }),
    subscribe: (listener: Parameters<SessionCapability["subscribeList"]>[1] = () => undefined) =>
      sessions.subscribeList(query, listener),
    expectRow: (expected: Partial<GatewaySessionRow>) =>
      expect(rows()?.[0]).toMatchObject(expected),
  };
}

function listRequest(
  read: (params?: Record<string, unknown>) => SessionsListResult | Promise<SessionsListResult>,
) {
  return vi.fn(async (method: string, params?: unknown) => {
    if (method !== "sessions.list") {
      throw new Error(`Unexpected request: ${method}`);
    }
    return read(asOptionalRecord(params) ?? undefined);
  });
}

function finish(sessions: SessionCapability, ...cleanup: Array<() => void>) {
  onTestFinished(() => {
    cleanup.forEach((release) => release());
    sessions.dispose();
    vi.useRealTimers();
  });
}

function sessionHarness(request: unknown) {
  const harness = createGatewayHarness({ request } as unknown as GatewayBrowserClient);
  return {
    sessions: createTestSessionCapability(harness.gateway),
    publish: (patch: Partial<SessionGateway["snapshot"]>) => {
      Object.assign(harness.gateway.snapshot, patch);
      harness.publish(harness.gateway.snapshot.phase === "connected");
    },
    reconnect: () => {
      harness.publish(false);
      harness.publish(true);
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
    const request = listRequest(() => (++listCalls === 1 ? initial : nextList.promise));
    const { gateway, emitEvent } = createGatewayHarness(createTestGatewayClient(request));
    const sessions = createTestSessionCapability(gateway);

    onTestFinished(async () => {
      sessions.dispose();
      nextList.resolve(initial);
      await vi.advanceTimersByTimeAsync(0);
      vi.useRealTimers();
    });
    await sessions.refresh({ agentId: "main", force: true });
    void sessions.refresh({ agentId: "main", force: true });
    expect(sessions.state.loading).toBe(true);
    const running = {
      updatedAt: 200_000,
      startedAt: 200_000,
      status: "running",
      hasActiveRun: true,
      activeRunIds: ["run-b"],
    };
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
        ...running,
        endedAt: null,
        runtimeMs: null,
      },
    });
    const payload: unknown = JSON.parse(wire);
    emitEvent({ type: "event", event: "sessions.changed", payload });
    await vi.advanceTimersByTimeAsync(SESSION_EVENT_REFRESH_DEBOUNCE_MS);

    expect(request).toHaveBeenCalledTimes(2);
    const rows = sessions.state.result?.sessions;
    expect(rows).toEqual([
      expect.objectContaining({
        ...running,
        key: child.key,
        sessionId: child.sessionId,
        spawnedBy: child.spawnedBy,
        label: child.label,
      }),
      sibling,
    ]);
    expect(rows?.[0]?.endedAt).toBeUndefined();
    expect(rows?.[0]?.runtimeMs).toBeUndefined();
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

    finish(sessions, () => pending.resolve(listResult()), observation.dispose);
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
      readSucceeded: true,
      pagination: { count: 2, totalCount: 3, hasMore: true, nextOffset: 2 },
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
      const view = listView(sessions, query);
      const listener = vi.fn();
      const observation = sessions.observeList(query, listener);
      const pending = observation.refresh();

      onTestFinished(async () => {
        held.resolve(sessionsResult([managedRow], 10));
        await Promise.allSettled([pending]);
        observation.dispose();
        sessions.dispose();
      });
      expect(request).toHaveBeenCalledExactlyOnceWith(
        "sessions.list",
        expect.objectContaining({ agentId: managedAgentId, archived: "all" }),
      );
      await sessions.refresh({ agentId: "main", force: true });
      held.resolve(sessionsResult([managedRow], 10));
      await pending;

      const expectedRow = expectedSource === "primary" ? primaryRow : managedRow;
      expect(view.snapshot()).toMatchObject({
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
    },
  );

  it("queues a reentrant observed refresh of a loaded list behind the current request", async () => {
    const firstResponse = createDeferred<SessionsListResult>();
    const secondResponse = createDeferred<SessionsListResult>();
    const secondStarted = createDeferred();
    const request = vi
      .fn()
      .mockResolvedValueOnce(listResult(["agent:writer:seed"]))
      .mockImplementationOnce(async () => firstResponse.promise)
      .mockImplementationOnce(async () => {
        secondStarted.resolve();
        return secondResponse.promise;
      });
    const { sessions } = sessionHarness(request);
    let requestedAgain = true;
    let reentrant: Promise<void> | undefined;
    let observedKeys: string[] = [];
    const observation = sessions.observeList({ agentId: "writer", limit: 2 }, (snapshot) => {
      observedKeys = snapshot.result?.sessions.map((row) => row.key) ?? [];
      if (snapshot.loading && !requestedAgain) {
        requestedAgain = true;
        reentrant = observation.refresh();
      }
    });
    await observation.refresh();
    request.mockClear();
    requestedAgain = false;
    const initial = observation.refresh();

    onTestFinished(async () => {
      firstResponse.resolve(listResult());
      secondResponse.resolve(listResult());
      await Promise.allSettled([initial, reentrant]);
      observation.dispose();
      sessions.dispose();
    });
    expect(requestedAgain).toBe(true);
    expect(request).toHaveBeenCalledOnce();

    firstResponse.resolve(listResult(["agent:writer:first"]));
    await secondStarted.promise;
    expect(request).toHaveBeenCalledTimes(2);

    secondResponse.resolve(listResult(["agent:writer:current"]));
    await Promise.all([initial, reentrant]);
    expect(request).toHaveBeenCalledTimes(2);
    expect(observedKeys).toEqual(["agent:writer:current"]);
  });

  it.each([false, true])(
    "settles managed-only terminals before refresh (refresh fails: %s)",
    async (refreshFails) => {
      vi.useFakeTimers();
      const key = "agent:writer:linked";
      let writerFinished = false;
      const request = listRequest((params) => {
        const agentId = params?.agentId ?? "main";
        if (typeof agentId !== "string") {
          throw new Error("Expected a string agentId in the session-list fixture");
        }
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
      const writer = listView(sessions, writerQuery);
      const otherWriterQuery = { ...writerQuery, ownerId: "ada" };
      const otherWriter = listView(sessions, otherWriterQuery);
      const researchQuery = { ...writerQuery, agentId: "research" };
      const research = listView(sessions, researchQuery);
      const observed: unknown[] = [];
      const stopWriter = writer.subscribe((snapshot) => {
        if (!snapshot.loading && !snapshot.result?.sessions[0]?.hasActiveRun) {
          observed.push(otherWriter.first()?.status);
        }
      });
      const stopOtherWriter = otherWriter.subscribe(() => undefined);
      const stopResearch = research.subscribe(() => undefined);

      finish(sessions, stopWriter, stopOtherWriter, stopResearch);
      await sessions.refresh({ agentId: "main", force: true });
      await writer.refresh();
      await otherWriter.refresh();
      await research.refresh();
      const primary = sessions.state.result;
      writer.expectRow({ key, hasActiveRun: true, status: "running" });
      request.mockClear();
      writerFinished = true;

      sessions.reconcileRunTerminal({
        sessionKeys: [key],
        runId: "writer-run",
        status: "done",
        endedAt: 2,
      });
      writer.expectRow({ key, hasActiveRun: false, activeRunIds: [], status: "done" });
      expect(observed).toEqual(["done"]);
      expect(writer.snapshot().result).toMatchObject({
        count: 1,
        totalCount: 3,
        hasMore: true,
        nextOffset: 1,
      });
      expect(request).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(SESSION_EVENT_REFRESH_DEBOUNCE_MS);

      writer.expectRow({ key, hasActiveRun: false, status: "done" });
      expect(sessions.state.result).toEqual(primary);
      expect(writer.snapshot().error).toBe(refreshFails ? "List refresh failed" : null);
      research.expectRow({ key: "agent:research:main", hasActiveRun: true, status: "running" });
      expect(
        request.mock.calls.map(([, params]) => asOptionalRecord(params)?.agentId),
      ).not.toContain("research");
    },
  );

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
  });

  it("discards a list rejection from a retired same-client connection", async () => {
    const { promise: staleRequest, reject: rejectStale } = createDeferred<SessionsListResult>();
    const request = vi.fn(async () => staleRequest);
    const { sessions, reconnect } = sessionHarness(request);
    const retiredRequest = sessions.list({ boardFace: "dashboard" });
    reconnect();
    rejectStale(new Error("retired connection"));
    await expect(retiredRequest).resolves.toBeNull();
  });

  it.each(["before", "after"] as const)(
    "absorbs only invalidations preceding a queued managed replacement (%s)",
    async (eventTiming) => {
      vi.useFakeTimers();
      const first = createDeferred<SessionsListResult>();
      const second = createDeferred<SessionsListResult>();
      const secondStarted = createDeferred();
      const row = (version: number) => ({
        key: "agent:main:managed-refresh",
        sessionId: "managed-refresh",
        kind: "direct" as const,
        archived: true,
        updatedAt: version,
        label: `Read ${version}`,
      });
      let managedCalls = 0;
      const client = createTestGatewayClient(
        listRequest((params) => {
          if (params?.archived !== true) {
            return sessionsResult([], 0);
          }
          managedCalls += 1;
          if (managedCalls === 1) {
            return first.promise;
          }
          if (managedCalls === 2) {
            secondStarted.resolve();
            return second.promise;
          }
          return sessionsResult([row(3)], 3);
        }),
      );
      const { gateway, emitEvent } = createGatewayHarness(client);
      const sessions = createTestSessionCapability(gateway);
      const query = { agentId: "main", archivedFilter: "archived" as const, limit: 17 };
      const view = listView(sessions, query);
      const readThreeObserved = createDeferred();
      const unsubscribe = view.subscribe((next) => {
        if (next.result?.sessions[0]?.label === "Read 3") {
          readThreeObserved.resolve();
        }
      });
      const event = {
        type: "event",
        event: "sessions.changed",
        payload: { ...row(1), sessionKey: row(1).key, agentId: "main", reason: "update" },
      } as const satisfies GatewayEventFrame;
      finish(
        sessions,
        () => first.resolve(sessionsResult([], 1)),
        () => second.resolve(sessionsResult([], 2)),
        unsubscribe,
      );
      const initial = view.refresh();
      const forced = view.refresh({ force: true });
      if (eventTiming === "before") {
        emitEvent(event);
      }
      first.resolve(sessionsResult([row(1)], 1));
      await secondStarted.promise;
      expect(managedCalls).toBe(2);
      if (eventTiming === "after") {
        emitEvent(event);
      }
      await vi.advanceTimersByTimeAsync(SESSION_EVENT_REFRESH_DEBOUNCE_MS);
      second.resolve(sessionsResult([row(2)], 2));
      await Promise.all([initial, forced]);
      await vi.advanceTimersByTimeAsync(4_999);
      expect(managedCalls).toBe(2);
      expect(view.first()?.label).toBe("Read 2");
      await vi.advanceTimersByTimeAsync(1);
      if (eventTiming === "after") {
        expect(managedCalls).toBe(3);
        await readThreeObserved.promise;
      }
      expect.soft(managedCalls).toBe(eventTiming === "before" ? 2 : 3);
      expect(view.first()?.label).toBe(eventTiming === "before" ? "Read 2" : "Read 3");
    },
  );

  it("does not queue forced filtered pagination behind an in-flight replacement", async () => {
    const { promise: pendingResult, resolve: resolveRequest } =
      createDeferred<SessionsListResult>();
    const firstPage = listResult(["agent:main:first", "agent:main:second"], 4);
    const request = vi
      .fn()
      .mockResolvedValueOnce(firstPage)
      .mockImplementationOnce(async () => pendingResult);
    const { sessions } = sessionHarness(request);
    const scope = { archivedFilter: "archived" as const, limit: 2 };
    const view = listView(sessions, scope);
    const unsubscribe = view.subscribe(() => undefined);

    finish(sessions, () => resolveRequest(firstPage), unsubscribe);
    await view.refresh();
    const pending = view.refresh({ force: true });
    const append = view.refresh({ offset: 2, append: true, force: true });
    expect(append).toBe(pending);

    resolveRequest(firstPage);
    await Promise.all([pending, append]);

    expect(request).toHaveBeenCalledTimes(2);
    expect(view.rows()).toEqual(firstPage.sessions);
  });

  it("retains an in-flight managed query while its route subscriber is replaced", async () => {
    const { promise: pendingResult, resolve: resolveRequest } =
      createDeferred<SessionsListResult>();
    const request = vi.fn(async () => pendingResult);
    const { sessions } = sessionHarness(request);
    const query = { agentId: "main", archivedFilter: "all" as const, limit: 50 };
    const view = listView(sessions, query);
    let unsubscribe = view.subscribe(() => undefined);

    finish(
      sessions,
      () => resolveRequest(listResult()),
      () => unsubscribe(),
    );
    const first = view.refresh();
    unsubscribe();
    unsubscribe = view.subscribe(() => undefined);

    expect(view.snapshot().loading).toBe(true);
    const replacement = view.refresh();
    expect(replacement).toBe(first);
    expect(request).toHaveBeenCalledOnce();

    resolveRequest(listResult(["agent:main:retained"]));
    await Promise.all([first, replacement]);
    expect(view.first()?.key).toBe("agent:main:retained");
    expect(request).toHaveBeenCalledOnce();
  });

  it("retires stale filtered snapshots across same-client reconnects without losing subscribers", async () => {
    const { promise: staleResult, resolve: resolveStale } = createDeferred<SessionsListResult>();
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
    const view = listView(sessions, scope);
    const observed: Array<string | null> = [];
    const unsubscribe = view.subscribe((next) =>
      observed.push(next.result?.sessions[0]?.key ?? null),
    );
    const retiredRequest = view.refresh();
    reconnect();
    resolveStale(listResult(["agent:main:stale"]));
    await retiredRequest;
    await view.refresh();
    expect(view.first()?.key).toBe("agent:main:current");
    expect(observed).toContain(null);
    expect(observed).toContain("agent:main:current");
    expect(observed).not.toContain("agent:main:stale");
    unsubscribe();
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
      const view = listView(sessions, query);
      const recoveredObserved = createDeferred();
      const unsubscribe = view.subscribe((next) => {
        if (next.result?.sessions[0]?.key === "agent:main:recovered") {
          recoveredObserved.resolve();
        }
      });
      finish(sessions, unsubscribe);
      await view.refresh();
      fail = true;
      const refresh = view.refresh({ force: true });
      if (failureTiming === "during") {
        publish({ suspensionPhase: "draining" });
      }
      if (failureTiming !== "after") {
        pending.reject(error);
        await refresh;
        expect(view.snapshot().error).toBe(lifecycle ? null : "Dashboard refresh unavailable");
      }
      expect(view.first()?.key).toBe("agent:main:original");

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
        await vi.advanceTimersByTimeAsync(4_999);
        expect(request.mock.calls.filter(([, params]) => params?.hasBoard)).toHaveLength(2);
        expect(view.first()?.key).toBe("agent:main:original");
        await vi.advanceTimersByTimeAsync(1);
        expect(request.mock.calls.filter(([, params]) => params?.hasBoard)).toHaveLength(3);
      }
      await recoveredObserved.promise;
      expect(view.first()?.key).toBe("agent:main:recovered");
      expect(view.snapshot().error).toBeNull();
      expect(request.mock.calls.filter(([, params]) => params?.hasBoard)).toHaveLength(3);
    },
  );
});
