/* @vitest-environment jsdom */

import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { GatewayRequestError } from "../../api/gateway.ts";
import type { GatewaySessionRow, SessionsListResult } from "../../api/types.ts";
import { createContext } from "../../test-helpers/app-sidebar.ts";
import { createApplicationGateway } from "../../test-helpers/application-context.ts";
import {
  createGatewayRequestMock,
  createTestGatewayClient,
} from "../../test-helpers/gateway-client.ts";
import { filterSessionRows } from "../sessions/navigation.ts";
import { createTestSessionCapability } from "../sessions/session-capability.test-support.ts";
import { rosterActivityStore } from "./roster-activity-store.ts";

function result(preview: string, hasMore = false): SessionsListResult {
  return {
    ts: 1,
    path: "",
    count: 1,
    defaults: { model: null, modelProvider: null, contextTokens: null },
    sessions: [{ key: "agent:main:main", kind: "direct", lastMessagePreview: preview }],
    hasMore,
  };
}

function createStore(
  load: (params: unknown) => Promise<SessionsListResult>,
  subscribe = async () => ({ subscribed: true }),
) {
  const request = createGatewayRequestMock(async (method, params) => {
    if (method === "sessions.subscribe") {
      return subscribe();
    }
    if (method === "sessions.groups.list") {
      return { names: [], sectionOrder: [] };
    }
    if (method === "sessions.list") {
      return (params as { archived?: string })?.archived === "all"
        ? load(params)
        : { ...result(""), sessions: [], count: 0 };
    }
    throw new Error(`Unexpected RPC: ${method}`);
  });
  return createStoreForRequest(request);
}

function createStoreForRequest(request: ReturnType<typeof createGatewayRequestMock>) {
  const source = createApplicationGateway({
    client: createTestGatewayClient(request),
    phase: "connected",
    hello: null,
    offlineStable: false,
    canvasPluginSurfaceUrl: null,
    assistantAgentId: "main",
    sessionKey: "agent:main:main",
    lastError: null,
    lastErrorCode: null,
  });
  const sessions = createTestSessionCapability(source.gateway);
  const context = createContext(source.gateway, sessions, {
    agents: [{ id: "main" }, { id: "ember" }],
    defaultId: "main",
    mainKey: "main",
    scope: "per-sender",
  });
  return {
    store: rosterActivityStore(context),
    context,
    request,
    source,
    sessions,
    emit: source.publishEvent,
  };
}

describe("roster activity lifecycle", () => {
  it("completes the current membership window while agent metadata is pending", async () => {
    vi.useFakeTimers();
    const page = createDeferred<SessionsListResult>();
    const load = vi.fn(async () => page.promise);
    const { store, context, sessions } = createStore(load);
    const agents = createDeferred<typeof context.agents.state.agentsList>();
    const identity = createDeferred();
    context.agents.ensureList = () => agents.promise;
    context.agentIdentity.ensure = () => identity.promise;
    const stop = store.subscribe(() => {});
    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(load).toHaveBeenCalledTimes(1);
      expect(store.snapshot.membershipReady).toBe(false);
      page.resolve(result("Membership before identity"));
      await vi.advanceTimersByTimeAsync(0);
      expect(store.snapshot.membershipReady).toBe(true);
      expect(store.snapshot.loading).toBe(true);

      agents.resolve(context.agents.state.agentsList);
      await vi.advanceTimersByTimeAsync(0);
      expect(store.snapshot.membershipReady).toBe(true);
      expect(load).toHaveBeenCalledTimes(1);

      const filtered = createDeferred<SessionsListResult>();
      load.mockImplementationOnce(() => filtered.promise);
      store.setInvolvingMe(true);
      expect(store.snapshot.membershipReady).toBe(false);
      expect(store.snapshot.involvingMe).toBe(true);
      await vi.advanceTimersByTimeAsync(0);
      expect(load).toHaveBeenCalledTimes(2);
      filtered.resolve(result("Current filter"));
      await vi.advanceTimersByTimeAsync(0);
      expect(store.snapshot.membershipReady).toBe(true);
      expect(store.snapshot.result?.sessions[0]?.lastMessagePreview).toBe("Current filter");
      identity.resolve();
      await store.refresh();
      expect(load).toHaveBeenCalledTimes(2);
      expect(store.snapshot.loading).toBe(false);
    } finally {
      agents.resolve(context.agents.state.agentsList);
      identity.resolve();
      page.resolve(result(""));
      stop();
      sessions.dispose();
      vi.useRealTimers();
    }
  });

  it("publishes committed archive and restore receipts without events", async () => {
    vi.useFakeTimers();
    const key = "agent:ember:receipt-only";
    let row: GatewaySessionRow = {
      key,
      sessionId: "receipt-only-session",
      kind: "direct",
      archived: false,
      updatedAt: 1,
    };
    const request = createGatewayRequestMock(async (method, params) => {
      if (method === "sessions.subscribe") {
        return { subscribed: true };
      }
      if (method === "sessions.groups.list") {
        return { names: [], sectionOrder: [] };
      }
      if (method === "sessions.list") {
        return { ...result(""), sessions: [row] };
      }
      if (method === "sessions.patch") {
        const archived = (params as { archived: boolean }).archived;
        row = { ...row, archived, updatedAt: row.updatedAt! + 1 };
        return {
          ok: true,
          key,
          path: "",
          entry: {
            sessionId: row.sessionId,
            updatedAt: row.updatedAt,
            ...(archived ? { archivedAt: row.updatedAt } : {}),
          },
        };
      }
      throw new Error(`Unexpected RPC: ${method}`);
    });
    const { store, sessions } = createStoreForRequest(request);
    const detach = store.subscribe(() => {});
    try {
      await store.refresh();
      expect(store.snapshot.result?.sessions[0]?.archived).toBe(false);
      const listReads = request.mock.calls.filter(([method]) => method === "sessions.list").length;
      for (const archived of [true, false]) {
        await sessions.patch(
          key,
          { archived },
          { agentId: "ember", expectedSessionId: row.sessionId, deferListRefresh: true },
        );
        // The second operation is Undo. No event or list read may supply either receipt.
        expect(store.snapshot.result?.sessions[0]?.archived).toBe(archived);
        expect(
          filterSessionRows(store.snapshot.result!, { archivedFilter: "all" }).sessions,
        ).toHaveLength(1);
        expect(
          filterSessionRows(store.snapshot.result!, { archivedFilter: "archived" }).sessions,
        ).toHaveLength(archived ? 1 : 0);
        expect(request.mock.calls.filter(([method]) => method === "sessions.list")).toHaveLength(
          listReads,
        );
      }
    } finally {
      detach();
      sessions.dispose();
      vi.useRealTimers();
    }
  });
  it.each(["sessions.changed", "session.message"])(
    "patches a paged tree window through %s without rereading it",
    async (event) => {
      vi.useFakeTimers();
      const rows: GatewaySessionRow[] = Array.from({ length: 300 }, (_, index) => ({
        key: `agent:main:row-${index}`,
        sessionId: `session-${index}`,
        kind: "direct",
        updatedAt: 300 - index,
        ...(index === 0 ? { pinned: true, pinnedAt: 1 } : {}),
      }));
      const parent = { ...rows[1]!, childSessions: ["agent:main:subagent:child"] };
      const child = {
        ...rows[200]!,
        key: parent.childSessions[0]!,
        spawnedBy: parent.key,
        parentSessionKey: parent.key,
      };
      rows[1] = parent;
      rows[200] = child;
      const load = vi.fn(async (params: unknown) => {
        const limit = Number(Reflect.get(params as object, "limit"));
        const offset = Number(Reflect.get(params as object, "offset") ?? 0);
        expect(limit).toBe(100);
        return {
          ...result(""),
          sessions: rows.slice(offset, offset + limit),
          count: limit,
          totalCount: 400,
          hasMore: true,
          nextOffset: offset + limit,
        };
      });
      const { store, emit } = createStore(load);
      const detach = store.subscribe(() => {});
      try {
        await vi.advanceTimersByTimeAsync(0);
        expect(load).toHaveBeenCalledTimes(3);
        for (const terminal of [false, true]) {
          const status = terminal ? "done" : "running";
          const nextChild = {
            ...child,
            updatedAt: terminal ? 700 : 600,
            hasActiveRun: !terminal,
            status,
          };
          const nextParent = {
            ...parent,
            swarm: {
              groups: [
                {
                  groupId: "fixture-swarm",
                  createdAt: 1,
                  children: [{ sessionKey: child.key, status }],
                  queued: 0,
                  running: terminal ? 0 : 1,
                  done: terminal ? 1 : 0,
                  failed: 0,
                },
              ],
              otherActiveGroups: 0,
            },
          };
          emit({
            type: "event",
            event,
            payload: {
              sessionKey: child.key,
              ...(event === "sessions.changed" ? { reason: "patch" } : {}),
              session: nextChild,
              ancestorSessions: [nextParent],
            },
          });
          expect(store.snapshot.result?.sessions[0]).toEqual(rows[0]);
          expect(store.snapshot.result?.sessions[1]).toEqual(nextChild);
          expect(store.snapshot.result?.sessions.find((row) => row.key === parent.key)).toEqual(
            nextParent,
          );
          await vi.advanceTimersByTimeAsync(20_000);
          expect(load).toHaveBeenCalledTimes(3);
        }
      } finally {
        detach();
        vi.useRealTimers();
      }
    },
  );

  it.each(["groups", "stores", "catalogChanged", "unpin", "archive", "restore", "involvingMe"])(
    "coalesces uncertain %s membership into one authoritative window refresh",
    async (change) => {
      vi.useFakeTimers();
      const row: GatewaySessionRow = {
        key: "agent:main:main",
        kind: "direct",
        sessionId: "held",
        updatedAt: 10,
        ...(change === "unpin" ? { pinned: true, pinnedAt: 1 } : {}),
        ...(change === "restore" ? { archived: true } : {}),
      };
      const next = {
        ...row,
        updatedAt: 20,
        ...(change === "archive" ? { archived: true, pinned: false } : {}),
        ...(change === "restore" ? { archived: false } : {}),
        ...(change === "unpin" ? { pinned: false, pinnedAt: undefined } : {}),
      };
      const load = vi
        .fn()
        .mockResolvedValueOnce({ ...result(""), sessions: [row] })
        .mockResolvedValue({ ...result(""), sessions: [next] });
      const { store, emit } = createStore(load);
      store.setInvolvingMe(change === "involvingMe");
      const stop = store.subscribe(() => {});
      try {
        await vi.advanceTimersByTimeAsync(0);
        expect(load).toHaveBeenCalledWith(
          expect.objectContaining({
            excludeDock: true,
            ...(change === "involvingMe" ? { involvingMe: true } : {}),
          }),
        );
        const payload = ["groups", "stores"].includes(change)
          ? { reason: change }
          : {
              reason: "patch",
              sessionKey: next.key,
              session: next,
              ...(change === "catalogChanged" ? { catalogChanged: true } : {}),
            };
        for (let index = 0; index < 10; index += 1) {
          emit({ type: "event", event: "sessions.changed", payload });
        }
        await vi.advanceTimersByTimeAsync(20_000);
        expect(load).toHaveBeenCalledTimes(2);
        expect(store.snapshot.result?.sessions).toEqual([next]);
      } finally {
        stop();
        vi.useRealTimers();
      }
    },
  );

  it("does not let an in-flight window replace a newer broadcast row", async () => {
    vi.useFakeTimers();
    const row: GatewaySessionRow = {
      key: "agent:main:main",
      kind: "direct",
      sessionId: "held",
      updatedAt: 1,
    };
    const updated = { ...row, updatedAt: 2, lastMessagePreview: "Current" };
    const stale = createDeferred<SessionsListResult>();
    const load = vi
      .fn()
      .mockResolvedValueOnce({ ...result(""), sessions: [row] })
      .mockReturnValueOnce(stale.promise)
      .mockResolvedValue({ ...result(""), sessions: [updated] });
    const { store, emit } = createStore(load);
    const stop = store.subscribe(() => {});
    try {
      await vi.advanceTimersByTimeAsync(0);
      const refresh = store.refresh();
      await vi.advanceTimersByTimeAsync(0);
      emit({
        type: "event",
        event: "sessions.changed",
        payload: {
          reason: "patch",
          sessionKey: row.key,
          session: updated,
        },
      });
      expect(store.snapshot.result?.sessions[0]).toEqual(updated);
      await vi.advanceTimersByTimeAsync(200);
      stale.resolve({ ...result("Stale"), sessions: [row] });
      await refresh;
      await vi.advanceTimersByTimeAsync(20_000);
      expect(load).toHaveBeenCalledTimes(3);
      expect(store.snapshot.result?.sessions[0]).toEqual(updated);
      expect(store.snapshot.loading).toBe(false);
    } finally {
      stale.resolve(result(""));
      stop();
      vi.useRealTimers();
    }
  });

  it.each([false, true])(
    "does not admit unknown active events into the shared window (involvingMe=%s)",
    async (involvingMe) => {
      const load = vi.fn(async () => result("Listed session"));
      const { store, emit } = createStore(load);
      store.setInvolvingMe(involvingMe);
      const detach = store.subscribe(() => {});
      try {
        await vi.waitFor(() => expect(store.snapshot.result?.sessions).toHaveLength(1));
        const window = store.snapshot.result;
        emit({
          type: "event",
          event: "session.message",
          payload: {
            agentId: "ember",
            session: {
              key: "agent:ember:unlisted",
              kind: "direct",
              updatedAt: 10,
              hasActiveRun: true,
              status: "running",
            },
          },
        });
        expect(store.snapshot.result).toBe(window);
        expect(store.snapshot.cards.find((card) => card.id === "ember")?.activeNow).toBe(false);
        expect(load).toHaveBeenCalledTimes(1);
      } finally {
        detach();
      }
    },
  );

  it("retains usable agent identities and the last activity window when an activity refresh fails", async () => {
    const load = vi
      .fn()
      .mockRejectedValueOnce(new Error("Activity temporarily unavailable"))
      .mockResolvedValueOnce(result("Recovered activity"))
      .mockRejectedValueOnce(new Error("Refresh failed"));
    const { store } = createStore(load);
    const detach = store.subscribe(() => {});
    try {
      await vi.waitFor(() => expect(store.snapshot.error).toBe("Activity temporarily unavailable"));
      expect(store.snapshot.cards.map((card) => card.id)).toEqual(["main", "ember"]);
      expect(store.snapshot.result).toBeNull();
      await store.refresh();
      expect(store.snapshot.error).toBeNull();
      expect(store.snapshot.cards[0]?.preview).toBe("Recovered activity");
      const previous = store.snapshot.result;
      await store.refresh();
      expect(store.snapshot.error).toBe("Refresh failed");
      expect(store.snapshot.result).toBe(previous);
      expect(store.snapshot.cards[0]?.preview).toBe("Recovered activity");
    } finally {
      detach();
    }
  });

  it("shows canonical observer failure and recovery independently of primary errors", async () => {
    vi.useFakeTimers();
    const firstSubscription = createDeferred<{ subscribed: boolean }>();
    const recoveryList = createDeferred<SessionsListResult>();
    const subscribe = vi
      .fn()
      .mockReturnValueOnce(firstSubscription.promise)
      .mockResolvedValue({ subscribed: true });
    const { store, sessions, source, request } = createStore(
      async () => result("Usable roster"),
      subscribe,
    );
    const notify = vi.fn();
    const detach = store.subscribe(notify);
    const operationError = "Another agent's primary list failed";
    try {
      source.publish(source.gateway.snapshot);
      await vi.advanceTimersByTimeAsync(0);
      const previous = store.snapshot.result;
      expect(previous?.sessions[0]?.lastMessagePreview).toBe("Usable roster");
      request.mockRejectedValueOnce(new Error(operationError));
      await sessions.refresh({ agentId: "ember", force: true });
      expect(sessions.state.error).toBe(operationError);
      notify.mockClear();
      firstSubscription.reject(
        new GatewayRequestError({
          code: "UNAVAILABLE",
          message: "Session updates unavailable",
          retryable: true,
          retryAfterMs: 100,
        }),
      );
      await vi.advanceTimersByTimeAsync(0);
      expect(store.snapshot.error ?? store.snapshot.subscriptionError).toBe(
        "Session updates unavailable",
      );
      expect(notify).toHaveBeenCalled();
      expect(store.snapshot.result).toBe(previous);
      expect(subscribe).toHaveBeenCalledTimes(1);

      // An unrelated failed read must neither replace nor hide the observer outage.
      request.mockRejectedValueOnce(new Error(operationError));
      await sessions.refresh({ agentId: "ember", force: true });
      expect(sessions.state.error).toBe(operationError);
      expect(store.snapshot.error).toBeNull();
      expect(store.snapshot.subscriptionError).toBe("Session updates unavailable");
      request.mockImplementationOnce(async (method) => {
        expect(method).toBe("sessions.subscribe");
        request.mockReturnValueOnce(recoveryList.promise);
        return subscribe();
      });
      notify.mockClear();
      await vi.advanceTimersByTimeAsync(100);
      // Recovery is visible before any gap-closing list response can publish.
      expect(subscribe).toHaveBeenCalledTimes(2);
      expect(sessions.state.error).toBe(operationError);
      expect(store.snapshot.subscriptionError).toBeNull();
      expect(notify).toHaveBeenCalled();
      expect(store.snapshot.result).toBe(previous);
      recoveryList.resolve({ ...result(""), sessions: [], count: 0 });
      await vi.advanceTimersByTimeAsync(5_000);
      expect(store.snapshot.error ?? store.snapshot.subscriptionError).toBeNull();
      expect(store.snapshot.cards[0]?.preview).toBe("Usable roster");
      expect(subscribe).toHaveBeenCalledTimes(2);
    } finally {
      firstSubscription.resolve({ subscribed: true });
      recoveryList.resolve(result(""));
      detach();
      sessions.dispose();
      vi.useRealTimers();
    }
  });

  it("follows agent and identity changes without a session event or a second activity load", async () => {
    const load = vi.fn(async () => result("Existing activity"));
    const { store, context } = createStore(load);
    const agentListeners = new Set<() => void>();
    const identityListeners = new Set<() => void>();
    context.agents.subscribe = (listener) => {
      const notify = () => listener(context.agents.state);
      agentListeners.add(notify);
      return () => agentListeners.delete(notify);
    };
    context.agentIdentity.subscribe = (listener) => {
      identityListeners.add(listener);
      return () => identityListeners.delete(listener);
    };
    const detach = store.subscribe(() => {});
    try {
      await vi.waitFor(() => expect(store.snapshot.loading).toBe(false));
      await vi.waitFor(() => expect(store.snapshot.cards).toHaveLength(2));
      context.agents.state.agentsList = {
        ...context.agents.state.agentsList!,
        agents: [{ id: "main", name: "Renamed" }, { id: "new-agent" }],
      };
      agentListeners.forEach((notify) => notify());
      expect(store.snapshot.cards.map(({ id, name }) => ({ id, name }))).toEqual([
        { id: "main", name: "Renamed" },
        { id: "new-agent", name: "new-agent" },
      ]);
      context.agentIdentity.get = (id) =>
        id === "new-agent" ? { agentId: id, name: "New identity", emoji: "🌻", avatar: "" } : null;
      identityListeners.forEach((notify) => notify());
      expect(store.snapshot.cards.find(({ id }) => id === "new-agent")).toMatchObject({
        name: "New identity",
        textAvatar: "🌻",
      });
      expect(load).toHaveBeenCalledTimes(1);
    } finally {
      detach();
    }
    expect(agentListeners.size).toBe(0);
    expect(identityListeners.size).toBe(0);
  });

  it("shares cross-agent rows and reconciles activity, unread, and new membership", async () => {
    vi.useFakeTimers();
    let rows: GatewaySessionRow[] = [
      { key: "agent:main:pinned", kind: "direct", pinned: true, updatedAt: 1 },
      { key: "agent:ember:task", kind: "direct", updatedAt: 2 },
      { key: "agent:ember:old", kind: "direct", updatedAt: 3, archived: true },
    ];
    const load = vi.fn(async () => ({ ...result(""), sessions: rows, count: rows.length }));
    const { store, emit } = createStore(load);
    const detach = store.subscribe(() => {});
    const detachSecond = store.subscribe(() => {});
    try {
      await vi.waitFor(() => expect(store.snapshot.result?.sessions).toEqual(rows));
      expect(load).toHaveBeenCalledTimes(1);
      expect(store.snapshot.cards[1]?.id).toBe("ember");
      expect(store.snapshot.cards[1]?.lastActiveAt).toBe(2);
      emit({
        type: "event",
        event: "session.message",
        payload: {
          agentId: "ember",
          session: { key: "agent:ember:task", updatedAt: 4, hasActiveRun: true },
        },
      });
      expect(store.snapshot.cards[1]?.activeNow).toBe(true);
      emit({
        type: "event",
        event: "session.message",
        payload: {
          agentId: "ember",
          session: { key: "agent:ember:task", updatedAt: 5, hasActiveRun: false, unread: true },
        },
      });
      expect(store.snapshot.result?.sessions.find((row) => row.key === rows[1]?.key)).toMatchObject(
        {
          unread: true,
          hasActiveRun: false,
        },
      );
      await vi.advanceTimersByTimeAsync(5_000);
      expect(load).toHaveBeenCalledTimes(1);
      rows = [...rows, { key: "agent:main:new", kind: "direct", updatedAt: 6 }];
      emit({ type: "event", event: "sessions.changed", payload: { session: rows[3] } });
      await vi.advanceTimersByTimeAsync(5_000);
      expect(store.snapshot.result?.sessions).toHaveLength(4);
      expect(load).toHaveBeenCalledTimes(2);
    } finally {
      detach();
      detachSecond();
      vi.useRealTimers();
    }
  });

  it("retires an old window when the client changes without publishing its late result", async () => {
    vi.useFakeTimers();
    const stale = createDeferred<SessionsListResult>();
    const load = vi
      .fn()
      .mockReturnValueOnce(stale.promise)
      .mockResolvedValue(result("Current activity"));
    const { store, source, request } = createStore(load);
    const notify = vi.fn();
    const detach = store.subscribe(notify);
    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(load).toHaveBeenCalledTimes(1);
      source.publish({ ...source.gateway.snapshot, client: createTestGatewayClient(request) });
      const refreshed = store.refresh();
      await vi.advanceTimersByTimeAsync(0);
      await refreshed;
      expect(store.snapshot.cards[0]?.preview).toBe("Current activity");
      const reads = load.mock.calls.length;
      expect(reads).toBe(2);
      notify.mockClear();
      stale.resolve(result("Retired activity", true));
      await stale.promise;
      await vi.advanceTimersByTimeAsync(0);
      expect(load).toHaveBeenCalledTimes(reads);
      expect(store.snapshot.cards[0]?.preview).toBe("Current activity");
      expect(notify).not.toHaveBeenCalled();
    } finally {
      stale.resolve(result("Retired activity"));
      detach();
      vi.useRealTimers();
    }
  });
});
