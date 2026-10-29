import { describe, expect, it, onTestFinished } from "vitest";
import { registerListener } from "../../../../src/shared/listeners.js";
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
  let holding = false;
  const pending = createDeferred<SessionsListResult>();
  const client = createTestGatewayClient((method) => {
    if (method === "sessions.list") {
      return holding ? pending.promise : result;
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
    subscribe: (listener: () => void) => registerListener(selectionListeners, listener),
  };
  const gateway = {
    connection: { gatewayUrl: "ws://museum.test", token: "synthetic-test-token" },
    connectionRevision: 0,
    get snapshot() {
      return snapshot;
    },
    subscribe: (listener: Parameters<SessionGateway["subscribe"]>[0]) =>
      registerListener(listeners, listener),
    subscribeEvents: () => () => undefined,
  } satisfies SessionGateway;
  const sessions = createSessionCapability(gateway, selection);
  onTestFinished(() => {
    pending.resolve(sessionsResult([], 5));
    sessions.dispose();
  });
  return {
    sessions,
    gateway,
    client,
    setResult(next: SessionsListResult) {
      result = next;
      holding = false;
    },
    hold() {
      holding = true;
      return pending;
    },
    publish(patch: Partial<SessionGateway["snapshot"]>) {
      snapshot = { ...snapshot, ...patch };
      listeners.forEach((listener) => listener(snapshot));
    },
    select(agentId: string) {
      selection.state.selectedId = agentId;
      selectionListeners.forEach((listener) => listener());
    },
  };
}
describe("session roster presentation", () => {
  it("presents accepted history while the first canonical roster is pending", async () => {
    const h = harness();
    h.hold();
    h.publish({ phase: "reconnecting", client: null });
    h.publish({ phase: "connected", client: h.client });
    h.sessions.reconcile(row);
    expect(h.sessions.canonicalListRevision).toBe(0);
    expect(h.sessions.canonicalListReady).toBe(false);
    expect(h.sessions.presentation.result?.sessions[0]?.derivedTitle).toBe(row.derivedTitle);
  });
  it("retains the paired roster through reconnect partial reads, then accepts canonical changes", async () => {
    const h = harness();
    await h.sessions.refresh({ agentId: "main" });
    const presentation = h.sessions.presentation;
    expect(h.sessions.canonicalListReady).toBe(true);
    const reconnect = h.hold();
    h.publish({ phase: "reconnecting" });
    expect(h.sessions.state.result).toBeNull();
    expect(h.sessions.presentation).toBe(presentation);
    h.publish({ phase: "connected" });
    h.sessions.reconcile({ ...row, derivedTitle: "Partial" });
    expect(h.sessions.presentation).toBe(presentation);
    expect(h.sessions.canonicalListReady).toBe(false);
    reconnect.resolve(sessionsResult([{ ...row, derivedTitle: "Renamed" }], 2));
    await expect
      .poll(() => h.sessions.presentation.result?.sessions[0]?.derivedTitle)
      .toBe("Renamed");
    expect(h.sessions.presentation.agentId).toBe("main");
    expect(h.sessions.canonicalListReady).toBe(true);
    h.setResult(sessionsResult([{ ...row, derivedTitle: "" }], 3));
    await h.sessions.refresh({ agentId: "main", force: true });
    expect(h.sessions.presentation.result?.sessions[0]?.derivedTitle).toBe("");
    h.setResult(sessionsResult([], 4));
    await h.sessions.refresh({ agentId: "main", force: true });
    expect(h.sessions.presentation.result?.sessions).toEqual([]);
  });
  it.each([
    "credential",
    "gateway",
    "profile",
    "connected-profile",
    "selection",
    "dispose",
  ] as const)("retires retained metadata for %s before listeners can read it", async (boundary) => {
    const h = harness();
    await h.sessions.refresh({ agentId: "main" });
    h.hold();
    if (boundary !== "connected-profile") {
      h.publish({ phase: "reconnecting" });
    }
    const observed: Array<SessionsListResult | null> = [];
    h.sessions.subscribe(() => observed.push(h.sessions.presentation.result));
    if (boundary === "credential") {
      h.gateway.connectionRevision += 1;
      h.publish({});
    } else if (boundary === "gateway") {
      h.gateway.connection.gatewayUrl = "ws://other.test";
      h.publish({});
    } else if (boundary === "profile" || boundary === "connected-profile") {
      h.publish({ phase: "connected", selfUser: { id: "two" } });
    } else if (boundary === "selection") {
      h.select("writer");
    } else {
      h.sessions.dispose();
    }
    expect(h.sessions.presentation).toEqual({ result: null, agentId: null });
    if (boundary === "connected-profile") {
      expect(h.sessions.captureBootRoster()).toBeNull();
    }
    if (boundary !== "dispose") {
      expect(observed.length).toBeGreaterThan(0);
    }
    expect(observed.every((result) => result === null)).toBe(true);
  });
});
