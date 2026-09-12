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
      await vi.waitFor(() => expect(store.snapshot.result).toEqual(scoped));
      stale.resolve(result("Wrong query"));
      await stale.promise;
      expect(store.snapshot.result).toEqual(scoped);
      expect(load).toHaveBeenCalledTimes(2);
      expect(request).toHaveBeenLastCalledWith(
        "sessions.list",
        expect.objectContaining({ archived: "all", involvingMe: true, limit: 100 }),
        expect.anything(),
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
