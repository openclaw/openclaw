import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.ts";
import type { GatewaySessionRow, SessionsListResult } from "../../api/types.ts";
import { createTestGatewayClient } from "../../test-helpers/gateway-client.ts";
import { gatewayHelloForMethods } from "../../test-helpers/gateway-methods.ts";
import { createSessionCapability } from "./index.ts";
import { sessionsResult } from "./session-capability.test-support.ts";
import type { SessionGateway } from "./session-capability.ts";

const row: GatewaySessionRow = {
  key: "agent:main:dashboard:museum",
  kind: "direct",
  sessionId: "museum-session",
  derivedTitle: "Museum itinerary",
  updatedAt: 1,
};

function harness() {
  let result = sessionsResult([row], 1);
  let pending: Promise<SessionsListResult> | undefined;
  const client = createTestGatewayClient((method) => {
    if (method === "sessions.list") {
      return pending ?? result;
    }
    if (method === "sessions.subscribe") {
      return { subscribed: true };
    }
    throw new Error(`Unexpected request: ${method}`);
  });
  let snapshot: SessionGateway["snapshot"] = {
    client,
    phase: "connected",
    hello: {
      ...gatewayHelloForMethods([]),
      auth: { method: "token", role: "operator", scopes: ["operator.admin"] },
    },
    selfUser: { id: "one" },
  };
  const listeners = new Set<Parameters<SessionGateway["subscribe"]>[0]>();
  const selectionListeners = new Set<() => void>();
  const selection = {
    state: { selectedId: "main" },
    subscribe: (listener: () => void) => {
      selectionListeners.add(listener);
      return () => {
        selectionListeners.delete(listener);
      };
    },
  };
  const gateway = {
    connection: { gatewayUrl: "ws://museum.test", token: "synthetic-test-token" },
    connectionRevision: 0,
    get snapshot() {
      return snapshot;
    },
    subscribe: (listener: Parameters<SessionGateway["subscribe"]>[0]) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    subscribeEvents: () => () => undefined,
  } satisfies SessionGateway;
  const write = vi.fn();
  const sessions = createSessionCapability(gateway, selection, {
    rosterCache: { read: async () => null, write },
  });
  return {
    sessions,
    write,
    gateway,
    client,
    setResult(next: SessionsListResult) {
      result = next;
      pending = undefined;
    },
    hold(promise: Promise<SessionsListResult>) {
      pending = promise;
    },
    publish(patch: Partial<SessionGateway["snapshot"]>) {
      snapshot = { ...snapshot, ...patch };
      for (const listener of listeners) {
        listener(snapshot);
      }
    },
    select(agentId: string) {
      selection.state.selectedId = agentId;
      for (const listener of selectionListeners) {
        listener();
      }
    },
  };
}

describe("session roster presentation", () => {
  it("presents accepted history while the first canonical roster is pending", async () => {
    const h = harness();
    const initial = createDeferred<SessionsListResult>();
    try {
      h.hold(initial.promise);
      h.publish({ phase: "reconnecting", client: null });
      h.publish({ phase: "connected", client: h.client });
      h.sessions.reconcile(row);
      expect(h.sessions.canonicalListRevision).toBe(0);
      expect(h.sessions.presentation.result?.sessions[0]?.derivedTitle).toBe(row.derivedTitle);
    } finally {
      initial.resolve(sessionsResult([row], 1));
      h.sessions.dispose();
    }
  });

  it("notifies subscribers immediately when a connected profile changes before refresh", async () => {
    const h = harness();
    const refresh = createDeferred<SessionsListResult>();
    try {
      await h.sessions.refresh({ agentId: "main" });
      h.hold(refresh.promise);
      h.write.mockClear();
      const observed: Array<SessionsListResult | null> = [];
      h.sessions.subscribe(() => observed.push(h.sessions.presentation.result));
      h.publish({ phase: "connected", selfUser: { id: "two" } });
      expect(h.write).not.toHaveBeenCalled();
      expect(observed.length).toBeGreaterThan(0);
      expect(observed.every((result) => result === null)).toBe(true);
    } finally {
      refresh.resolve(sessionsResult([], 2));
      h.sessions.dispose();
    }
  });

  it("retains the paired roster through reconnect partial reads, then accepts canonical changes", async () => {
    const h = harness();
    const reconnect = createDeferred<SessionsListResult>();
    try {
      await h.sessions.refresh({ agentId: "main" });
      const presentation = h.sessions.presentation;
      h.hold(reconnect.promise);
      h.publish({ phase: "reconnecting" });
      expect(h.sessions.state.result).toBeNull();
      expect(h.sessions.presentation).toBe(presentation);
      h.publish({ phase: "connected" });
      h.sessions.reconcile({ ...row, derivedTitle: "Partial" });
      expect(h.sessions.presentation).toBe(presentation);
      const renamed = sessionsResult([{ ...row, derivedTitle: "Renamed" }], 2);
      reconnect.resolve(renamed);
      await expect
        .poll(() => h.sessions.presentation.result?.sessions[0]?.derivedTitle)
        .toBe("Renamed");
      expect(h.sessions.presentation.agentId).toBe("main");
      h.setResult(sessionsResult([{ ...row, derivedTitle: "" }], 3));
      await h.sessions.refresh({ agentId: "main", force: true });
      expect(h.sessions.presentation.result?.sessions[0]?.derivedTitle).toBe("");
      h.setResult(sessionsResult([], 4));
      await h.sessions.refresh({ agentId: "main", force: true });
      expect(h.sessions.presentation.result?.sessions).toEqual([]);
    } finally {
      reconnect.resolve(sessionsResult([], 5));
      h.sessions.dispose();
    }
  });

  it.each(["credential", "gateway", "profile", "selection", "dispose"] as const)(
    "retires retained metadata for %s before listeners can read it",
    async (boundary) => {
      const h = harness();
      const reconnect = createDeferred<SessionsListResult>();
      try {
        await h.sessions.refresh({ agentId: "main" });
        h.hold(reconnect.promise);
        h.publish({ phase: "reconnecting" });
        const observed: Array<SessionsListResult | null> = [];
        h.sessions.subscribe(() => observed.push(h.sessions.presentation.result));
        if (boundary === "credential") {
          h.gateway.connectionRevision += 1;
          h.publish({});
        } else if (boundary === "gateway") {
          h.gateway.connection.gatewayUrl = "ws://other.test";
          h.publish({});
        } else if (boundary === "profile") {
          h.publish({ phase: "connected", selfUser: { id: "two" } });
        } else if (boundary === "selection") {
          h.select("writer");
        } else {
          h.sessions.dispose();
        }
        expect(h.sessions.presentation).toEqual({ result: null, agentId: null });
        expect(observed.every((result) => result === null)).toBe(true);
      } finally {
        reconnect.resolve(sessionsResult([], 2));
        h.sessions.dispose();
      }
    },
  );
});
