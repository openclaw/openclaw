/* @vitest-environment jsdom */

import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { GatewayEventListener } from "../../api/gateway.ts";
import type { GatewaySessionRow, SessionsListResult } from "../../api/types.ts";
import { createContext, createSessionsHarness } from "../../test-helpers/app-sidebar.ts";
import { createApplicationGateway } from "../../test-helpers/application-context.ts";
import {
  createGatewayRequestMock,
  createTestGatewayClient,
} from "../../test-helpers/gateway-client.ts";
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

function createStore(load: (params: unknown) => Promise<SessionsListResult>) {
  const request = createGatewayRequestMock(async (method, params) => {
    if (method === "sessions.subscribe") {
      return { subscribed: true };
    }
    if (method === "sessions.list") {
      return load(params);
    }
    throw new Error(`Unexpected RPC: ${method}`);
  });
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
  const listeners = new Set<GatewayEventListener>();
  source.gateway.subscribeEvents = (listener) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  };
  const context = createContext(source.gateway, createSessionsHarness("main", []).sessions, {
    agents: [{ id: "main" }, { id: "ember" }],
    defaultId: "main",
    mainKey: "main",
    scope: "per-sender",
  });
  return {
    store: rosterActivityStore(context),
    context,
    request,
    emit: (event: Parameters<GatewayEventListener>[0]) => {
      for (const listener of listeners) {
        listener(event);
      }
    },
  };
}

describe("roster activity lifecycle", () => {
  it("recovers failed membership refreshes on the next keyed snapshot", async () => {
    vi.useFakeTimers();
    const held: GatewaySessionRow = {
      key: "agent:main:main",
      kind: "direct",
      sessionId: "held",
      updatedAt: 1,
    };
    const updated = { ...held, updatedAt: 2 };
    const added: GatewaySessionRow = {
      key: "agent:main:new",
      kind: "direct",
      sessionId: "new",
      updatedAt: 3,
    };
    const load = vi
      .fn()
      .mockResolvedValueOnce({ ...result(""), sessions: [held] })
      .mockRejectedValueOnce(new Error("List unavailable"))
      .mockResolvedValue({ ...result(""), count: 2, sessions: [added, updated] });
    const { store, emit } = createStore(load);
    const stop = store.subscribe(() => {});
    try {
      await vi.advanceTimersByTimeAsync(0);
      emit({ type: "event", event: "sessions.changed", payload: { reason: "stores" } });
      await vi.advanceTimersByTimeAsync(200);
      expect(store.snapshot.error).toBe("List unavailable");
      emit({
        type: "event",
        event: "sessions.changed",
        payload: { reason: "patch", session: updated },
      });
      await vi.advanceTimersByTimeAsync(20_000);
      expect(load).toHaveBeenCalledTimes(3);
      expect(store.snapshot.error).toBeNull();
      expect(store.snapshot.result?.sessions).toEqual([added, updated]);
    } finally {
      stop();
      vi.useRealTimers();
    }
  });

  it("attributes window reads across 28 viewers to initial and membership changes", async () => {
    vi.useFakeTimers();
    const rows: GatewaySessionRow[] = Array.from({ length: 300 }, (_, index) => ({
      key: `agent:main:row-${index}`,
      sessionId: `session-${index}`,
      kind: "direct",
      updatedAt: 300 - index,
      ...(index === 0 ? { pinned: true, pinnedAt: 1 } : {}),
    }));
    const parent: GatewaySessionRow = {
      ...rows[1]!,
      childSessions: ["agent:main:subagent:child", "agent:main:subagent:sibling"],
    };
    const child: GatewaySessionRow = {
      ...rows[200]!,
      key: "agent:main:subagent:child",
      spawnedBy: parent.key,
      parentSessionKey: parent.key,
    };
    rows[1] = parent;
    rows[200] = child;
    rows[201] = {
      ...rows[201]!,
      key: "agent:main:subagent:sibling",
      spawnedBy: parent.key,
      parentSessionKey: parent.key,
    };
    let reason = "initial";
    const readsByReason: Record<string, number> = {};
    const load = vi.fn(async (params: unknown) => {
      readsByReason[reason] = (readsByReason[reason] ?? 0) + 1;
      const offset = Number(Reflect.get(params as object, "offset") ?? 0);
      return {
        ...result(""),
        sessions: rows.slice(offset, offset + 100),
        count: 100,
        totalCount: 400,
        hasMore: true,
        nextOffset: offset + 100,
      };
    });
    const viewers = Array.from({ length: 28 }, () => createStore(load));
    const detach = viewers.map(({ store }) => store.subscribe(() => {}));
    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(readsByReason).toEqual({ initial: 84 });
      const updated = { ...rows[199]!, updatedAt: 500, lastMessagePreview: "New activity" };
      for (reason of ["patch", "terminal-message"]) {
        readsByReason[reason] = 0;
        for (let iteration = 0; iteration < 4; iteration += 1) {
          for (const { emit } of viewers) {
            emit({
              type: "event",
              event: reason === "terminal-message" ? "session.message" : "sessions.changed",
              payload: {
                sessionKey: updated.key,
                ...(reason === "terminal-message" ? {} : { reason }),
                session:
                  reason === "terminal-message"
                    ? { ...updated, hasActiveRun: false, status: "done" }
                    : updated,
              },
            });
          }
          await vi.advanceTimersByTimeAsync(2_000);
        }
        expect(readsByReason[reason]).toBe(0);
        for (const { store } of viewers) {
          expect(store.snapshot.result?.sessions[0]).toEqual(rows[0]);
          expect(store.snapshot.result?.sessions[1]).toMatchObject(updated);
        }
      }
      for (reason of ["child-change", "terminal-child-message"]) {
        readsByReason[reason] = 0;
        for (let iteration = 0; iteration < 4; iteration += 1) {
          const terminal = reason === "terminal-child-message";
          const status = terminal ? "done" : "running";
          const nextChild: GatewaySessionRow = {
            ...child,
            updatedAt: (terminal ? 700 : 600) + iteration,
            hasActiveRun: !terminal,
            status,
          };
          const nextParent: GatewaySessionRow = {
            ...parent,
            childSessions: [rows[201]!.key, child.key],
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
          for (const { emit } of viewers) {
            emit({
              type: "event",
              event: terminal ? "session.message" : "sessions.changed",
              payload: {
                sessionKey: child.key,
                ...(terminal ? {} : { reason: "patch" }),
                session: nextChild,
                ancestorSessions: [nextParent],
              },
            });
          }
          const shown = viewers[0]!.store.snapshot.result?.sessions;
          expect.soft(shown?.find((row) => row.key === parent.key)).toEqual(nextParent);
          expect.soft(shown?.find((row) => row.key === child.key)).toEqual(nextChild);
          await vi.advanceTimersByTimeAsync(2_000);
        }
        expect.soft(readsByReason[reason]).toBe(0);
      }
      reason = "activity-summary";
      readsByReason[reason] = 0;
      for (let iteration = 0; iteration < 4; iteration += 1) {
        for (const { emit } of viewers) {
          emit({
            type: "event",
            event: "sessions.changed",
            payload: { sessionKey: updated.key, reason, session: updated },
          });
        }
        await vi.advanceTimersByTimeAsync(2_000);
      }
      expect.soft(readsByReason[reason]).toBe(0);
      for (reason of ["archive", "groups", "cleanup", "catalogChanged"]) {
        for (let iteration = 0; iteration < 10; iteration += 1) {
          for (const { emit } of viewers) {
            emit({
              type: "event",
              event: "sessions.changed",
              payload:
                reason === "catalogChanged"
                  ? { reason: "patch", session: updated, catalogChanged: true }
                  : { reason },
            });
          }
        }
        await vi.advanceTimersByTimeAsync(20_000);
        expect(readsByReason[reason]).toBe(84);
      }
      console.info(
        `28-viewer activity roster sessions.list reads: ${JSON.stringify(readsByReason)}`,
      );
    } finally {
      detach.forEach((stop) => stop());
      vi.useRealTimers();
    }
  });

  it.each([
    "groups",
    "cleanup",
    "stores",
    "catalogChanged",
    "missing",
    "enter",
    "unpin",
    "archive",
    "restore",
    "older",
    "involvingMe",
  ])("coalesces uncertain %s membership into one authoritative window refresh", async (change) => {
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
      updatedAt: change === "older" ? 5 : 20,
      ...(change === "enter" ? { key: "agent:main:new", sessionId: "new" } : {}),
      ...(change === "archive" ? { archived: true } : {}),
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
      const broad = ["groups", "cleanup", "stores"].includes(change);
      const payload = broad
        ? { reason: change }
        : {
            reason: "patch",
            sessionKey: next.key,
            ...(change === "missing" ? {} : { session: next }),
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
  });

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

  it("paces sustained invalidation from actual roster read settlement", async () => {
    vi.useFakeTimers();
    let reads = 0;
    const load = vi.fn(async () => {
      reads += 1;
      if (reads > 1) {
        await new Promise<void>((resolve) => {
          setTimeout(resolve, 1_000);
        });
      }
      return result("Current activity");
    });
    const { store, emit } = createStore(load);
    const detach = store.subscribe(() => {});
    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(reads).toBe(1);
      for (let index = 0; index < 600; index += 1) {
        emit({
          type: "event",
          event: "sessions.changed",
          payload: { sessionKey: "agent:main:main", reason: "patch" },
        });
        await vi.advanceTimersByTimeAsync(100);
      }
      console.info(`activity roster events/s=10 fetchMs=1000 requests/min=${reads - 1}`);
      expect(reads - 1).toBeGreaterThan(1);
      expect(reads - 1).toBeLessThanOrEqual(15);
    } finally {
      detach();
      await vi.advanceTimersByTimeAsync(1_000);
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
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 250);
      });
      expect(load).toHaveBeenCalledTimes(1);
      rows = [...rows, { key: "agent:main:new", kind: "direct", updatedAt: 6 }];
      emit({ type: "event", event: "sessions.changed", payload: { session: rows[3] } });
      await vi.waitFor(() => expect(store.snapshot.result?.sessions).toHaveLength(4));
      expect(load).toHaveBeenCalledTimes(2);
    } finally {
      detach();
      detachSecond();
    }
  });

  it("loads involvement across all agents once and retires an older query response", async () => {
    const stale = createDeferred<SessionsListResult>();
    const scoped = { ...result("Only my session"), owners: [] };
    const load = vi.fn().mockReturnValueOnce(stale.promise).mockResolvedValue(scoped);
    const { store, request } = createStore(load);
    const detach = store.subscribe(() => {});
    try {
      await vi.waitFor(() => expect(load).toHaveBeenCalledTimes(1));
      store.setInvolvingMe(true);
      store.setInvolvingMe(true);
      expect(store.snapshot.result).toBeNull();
      expect(store.snapshot.involvingMe).toBe(true);
      expect(load).toHaveBeenCalledTimes(1);
      stale.resolve(result("Wrong query"));
      await vi.waitFor(() => expect(store.snapshot.result).toEqual(scoped));
      expect(store.snapshot.result).toEqual(scoped);
      expect(load).toHaveBeenCalledTimes(2);
      expect(request).toHaveBeenLastCalledWith(
        "sessions.list",
        expect.objectContaining({ archived: "all", involvingMe: true, limit: 100 }),
      );
      expect(request.mock.calls.filter(([method]) => method === "sessions.subscribe")).toHaveLength(
        1,
      );
    } finally {
      detach();
    }
  });

  it.each(["reconnect", "replace client", "detach"] as const)(
    "retires in-flight pagination on %s and loads a fresh snapshot on return",
    async (transition) => {
      const stale = createDeferred<SessionsListResult>();
      const list = vi
        .fn()
        .mockImplementationOnce(() => stale.promise)
        .mockResolvedValue(result("Current activity"));
      const request = createGatewayRequestMock(async (method) => {
        if (method === "sessions.subscribe") {
          return { subscribed: true };
        }
        if (method === "sessions.list") {
          return list();
        }
        throw new Error(`Unexpected RPC: ${method}`);
      });
      const client = createTestGatewayClient(request);
      const source = createApplicationGateway({
        client,
        phase: "connected",
        hello: null,
        offlineStable: false,
        canvasPluginSurfaceUrl: null,
        assistantAgentId: "main",
        sessionKey: "agent:main:main",
        lastError: null,
        lastErrorCode: null,
      });
      const stopEvents = vi.fn();
      source.gateway.subscribeEvents = vi.fn(() => stopEvents);
      const context = createContext(source.gateway, createSessionsHarness("main", []).sessions, {
        agents: [{ id: "main" }],
        defaultId: "main",
        mainKey: "main",
        scope: "per-sender",
      });
      const store = rosterActivityStore(context);
      const notify = vi.fn();
      let detach = store.subscribe(notify);
      try {
        await vi.waitFor(() => expect(list).toHaveBeenCalledTimes(1));
        if (transition === "detach") {
          detach();
          expect(stopEvents).toHaveBeenCalledTimes(1);
          expect(store.snapshot.cards).toEqual([]);
          detach = store.subscribe(notify);
        } else if (transition === "reconnect") {
          source.publish({ ...source.gateway.snapshot, phase: "reconnecting" });
          expect(store.snapshot.cards).toEqual([]);
          source.publish({ ...source.gateway.snapshot, phase: "connected" });
        } else {
          source.publish({ ...source.gateway.snapshot, client: createTestGatewayClient(request) });
        }
        if (transition !== "replace client") {
          expect(list).toHaveBeenCalledTimes(1);
          stale.resolve(result("Retired activity", true));
        }
        await vi.waitFor(() => expect(store.snapshot.cards[0]?.preview).toBe("Current activity"));
        expect(
          request.mock.calls.filter(([method]) => method === "sessions.subscribe"),
        ).toHaveLength(2);
        notify.mockClear();
        // Even a transport that resolves after abort must not publish or fetch another page.
        stale.resolve(result("Retired activity", true));
        await stale.promise;
        await new Promise<void>((resolve) => {
          setTimeout(resolve, 0);
        });
        expect(list).toHaveBeenCalledTimes(2);
        expect(store.snapshot.cards[0]?.preview).toBe("Current activity");
        expect(notify).not.toHaveBeenCalled();
      } finally {
        detach();
      }
    },
  );
});
