import {
  DEFAULT_GATEWAY_REQUEST_TIMEOUT_MS,
  GatewayProtocolClient,
  type GatewayProtocolSocketHandlers,
} from "@openclaw/gateway-client/browser";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, expect, it, vi } from "vitest";
// @vitest-environment node
import { SIDEBAR_SESSION_ROSTER_LIMIT } from "../../../../src/shared/session-list-limits.ts";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { GatewayBrowserClient, GatewayEventFrame } from "../../api/gateway.ts";
import type { SessionsListResult } from "../../api/types.ts";
import { createApplicationGateway } from "../../test-helpers/application-context-fixtures.ts";
import { createTestGatewayClient } from "../../test-helpers/gateway-client.ts";
import { retryableGatewayError as retryError } from "../../test-helpers/gateway-errors.test-support.ts";
import { gatewayHelloForMethods } from "../../test-helpers/gateway-methods.ts";
import { waitForFast } from "../../test-helpers/wait-for.ts";
import { sessionRequest } from "./hydration-family.test-support.ts";
import type { SessionCapability } from "./index.ts";
import {
  createSubscriptionHydrationHarness,
  createTestSessionCapability,
  runningSessionsResult,
  sessionsResult,
} from "./session-capability.test-support.ts";

const cleanup: Array<() => void> = [];
afterEach(() => {
  for (const dispose of cleanup.splice(0).toReversed()) {
    dispose();
  }
  vi.useRealTimers();
});
function requestFor(subscribe: () => unknown, list: (params?: Record<string, unknown>) => unknown) {
  return sessionRequest({ "sessions.subscribe": subscribe, "sessions.list": list });
}

function hydration(request: GatewayBrowserClient["request"]) {
  const harness = createSubscriptionHydrationHarness(request);
  cleanup.push(harness.sessions.dispose);
  return harness;
}
function observer(
  subscribe: (attempt: number) => unknown,
  list: (params: Record<string, unknown> | undefined, attempt: number) => unknown = () =>
    sessionsResult([], 1),
) {
  let subscriptions = 0;
  let lists = 0;
  const request = requestFor(
    () => subscribe(++subscriptions),
    (params) => list(params, ++lists),
  );
  return {
    ...hydration(request as unknown as GatewayBrowserClient["request"]),
    request,
    get subscriptionCalls() {
      return subscriptions;
    },
  };
}
function retryOnce(message: string) {
  return (attempt: number) => {
    if (attempt === 1) {
      throw retryError(message);
    }
    return { subscribed: true };
  };
}
function connection(
  request: GatewayBrowserClient["request"],
  selectedId = "main",
  initialFields: {
    sessionKey?: string;
    assistantAgentId?: string;
    selfUser?: { id: string; name: string };
  } = {},
) {
  const client = { request } as GatewayBrowserClient;
  let snapshot = {
    client: null as GatewayBrowserClient | null,
    phase: "reconnecting" as "connected" | "reconnecting",
    sessionKey: "agent:main:main",
    assistantAgentId: "main" as string | null,
    hello: null,
    canvasPluginSurfaceUrl: null as string | null,
    selfUser: null as { id: string; name?: string } | null,
    ...initialFields,
  };
  let listener: ((next: typeof snapshot) => void) | undefined;
  const sessions = createTestSessionCapability(
    {
      get snapshot() {
        return snapshot;
      },
      subscribe(next) {
        listener = next;
        return () => undefined;
      },
      subscribeEvents: () => () => undefined,
    },
    selectedId,
  );
  cleanup.push(sessions.dispose);
  return {
    sessions,
    client,
    update(fields: Partial<typeof snapshot>, notify = true) {
      snapshot = { ...snapshot, ...fields };
      if (notify) {
        listener?.(snapshot);
      }
    },
  };
}
const listCallsOf = (request: { mock: { calls: readonly (readonly unknown[])[] } }) =>
  request.mock.calls.filter(([method]) => method === "sessions.list");
const expectList = (request: ReturnType<typeof requestFor>, fields: Record<string, unknown>) =>
  expect(request).toHaveBeenCalledWith("sessions.list", expect.objectContaining(fields));
const row = (key: string, updatedAt = 1) => ({ key, kind: "direct" as const, updatedAt });
const recoveredResult = () => sessionsResult([row("agent:main:recovered", 2)], 1);

const targetedSessionReconciliationCases = [
  {
    description: "targeted session changes",
    reconcile: (sessions: SessionCapability, emitEvent: (event: GatewayEventFrame) => void) => {
      const terminal = {
        ...row("agent:main:main", 2),
        sessionKey: "agent:main:main",
        hasActiveRun: false,
        status: "done",
      };
      emitEvent({ type: "event", event: "sessions.changed", payload: terminal });
      expect(sessions.state.result?.sessions[0]).toMatchObject({
        hasActiveRun: false,
        status: "done",
      });
    },
  },
  {
    description: "targeted run-terminal reconciliation",
    reconcile: (sessions: SessionCapability) => {
      expect(
        sessions.reconcileRunTerminal({
          sessionKeys: ["agent:main:main"],
          runId: "run-1",
          status: "done",
          endedAt: 2,
        }),
      ).toBe(true);
    },
  },
] as const;

it.each(["account", "recovery scope"])(
  "retires observed membership before the same client's %s replacement loads",
  async (change) => {
    const retained = sessionsResult([{ key: "agent:main:private", kind: "direct" }], 1);
    const stale = createDeferred<SessionsListResult>();
    const fresh = createDeferred<SessionsListResult>();
    let reads = 0;
    const request = vi.fn(async (method: string, params?: unknown) => {
      if (method === "sessions.list") {
        if (isRecord(params) && params.archived === "all") {
          reads += 1;
          return reads === 1 ? retained : reads === 2 ? stale.promise : fresh.promise;
        }
        return sessionsResult([], 2);
      }
      return method === "sessions.subscribe"
        ? { subscribed: true }
        : { groups: [], sectionOrder: [] };
    });
    const source = createApplicationGateway();
    const publish = (fields: Partial<typeof source.gateway.snapshot>) =>
      source.publish({ ...source.gateway.snapshot, ...fields });
    const hello = gatewayHelloForMethods(
      ["sessions.list", "sessions.subscribe", "sessions.groups.list"],
      ["operator.read"],
    );
    hello.auth!.recoveryScope = "test-recovery-scope";
    publish({
      phase: "connected",
      client: createTestGatewayClient(request),
      hello,
      selfUser: { id: "alice", name: "Alice" },
    });
    const sessions = createTestSessionCapability(source.gateway);
    const query = { source: "agent-roster" as const, archivedFilter: "all" as const, limit: 50 };
    const observed = sessions.observeList(query, () => {});
    await sessions.refreshList(query);
    expect(sessions.listSnapshot(query).result?.sessions).toEqual(retained.sessions);
    publish({ phase: "reconnecting", hello: null, selfUser: undefined });
    expect(sessions.listSnapshot(query).result?.sessions).toEqual(retained.sessions);
    publish({ phase: "connected", hello, selfUser: undefined });
    expect(sessions.listSnapshot(query).result?.sessions).toEqual(retained.sessions);
    publish({ selfUser: { id: "alice", name: "Alice" } });
    expect(sessions.listSnapshot(query).result?.sessions).toEqual(retained.sessions);
    const old = observed.refresh().catch((error: unknown) => error);
    publish(
      change === "account"
        ? { selfUser: { id: "bob", name: "Bob" } }
        : {
            selfUser: undefined,
            hello: { ...hello, auth: { ...hello.auth!, recoveryScope: "bob-scope" } },
          },
    );
    expect(sessions.listSnapshot(query).result).toBeNull();
    let replayed: SessionsListResult | null = retained;
    const replacement = sessions.observeList(query, (snapshot) => {
      replayed = snapshot.result;
    });
    expect(replayed).toBeNull();
    stale.resolve(retained);
    await old;
    expect(sessions.listSnapshot(query).result).toBeNull();
    fresh.resolve(sessionsResult([], 2));
    await sessions.refreshList(query);
    observed.dispose();
    replacement.dispose();
  },
);

it("lets a queued foreground refresh supersede bootstrap during profile hydration", async () => {
  const roster = sessionsResult(
    [{ ...row("agent:main:mine-new", 3), createdActor: { type: "human", id: "operator" } }],
    1,
  );
  const bootstrap = createDeferred<SessionsListResult>();
  const queuedResult = sessionsResult([row("agent:other:queued", 4)], 1);
  const queuedList = createDeferred<SessionsListResult>();
  const request = requestFor(
    () => ({ subscribed: true }),
    (params) => (params?.search === "queued" ? queuedList.promise : bootstrap.promise),
  );
  const h = connection(request as unknown as GatewayBrowserClient["request"], "main", {
    sessionKey: "agent:main:mine-new",
  });
  const { sessions, client } = h;
  h.update({ client, phase: "connected" });

  await waitForFast(() =>
    expectList(request, { agentId: "main", limit: SIDEBAR_SESSION_ROSTER_LIMIT }),
  );
  expect(
    request.mock.calls.find(([method]) => method === "sessions.list")?.[1]?.ownerFirst,
  ).toBeUndefined();
  expect(listCallsOf(request)).toHaveLength(1);
  expect(sessions.state.result).toBeNull();
  const queuedRefresh = sessions.refresh({ agentId: "other", search: "queued", force: true });
  h.update({ selfUser: { id: "operator", name: "Operator" } });

  bootstrap.resolve(roster);
  await waitForFast(() => expect(listCallsOf(request)).toHaveLength(2));
  expect(sessions.state.result).toBeNull();
  expectList(request, { agentId: "other", search: "queued" });
  queuedList.resolve(queuedResult);
  await queuedRefresh;
  expect(sessions.state).toMatchObject({ agentId: "other", result: queuedResult });
});

it("uses the selected agent before a session key is available", async () => {
  const result = sessionsResult([row("agent:roboclaw:dashboard:one")], 1);
  const request = requestFor(
    () => ({ subscribed: true }),
    () => result,
  );
  const h = connection(request as unknown as GatewayBrowserClient["request"], "roboclaw", {
    sessionKey: "",
    assistantAgentId: "roboclaw",
  });
  const { sessions, client } = h;
  h.update({ client, phase: "connected" });

  await waitForFast(() => expectList(request, { agentId: "roboclaw", includeDerivedTitles: true }));
  await waitForFast(() => expect(sessions.state.agentId).toBe("roboclaw"));
  expect(sessions.state.result).toStrictEqual(result);
});

it.each(["main", "work"])(
  "rehydrates the current %s roster when identity arrives on the same connection",
  async (agentId) => {
    const pendingList = createDeferred<SessionsListResult>();
    let listCalls = 0;
    const result = sessionsResult([], 1);
    const request = requestFor(
      () => ({ subscribed: true }),
      () => (++listCalls === 1 ? pendingList.promise : result),
    );

    const h = connection(request as unknown as GatewayBrowserClient["request"]);
    const { sessions, client } = h;
    h.update({ client, phase: "connected" });
    await waitForFast(() => expect(listCallsOf(request)).toHaveLength(1));

    h.update({ canvasPluginSurfaceUrl: "https://gateway.example.test/canvas" });
    await Promise.resolve();
    expect(listCallsOf(request)).toHaveLength(1);

    if (agentId === "work") {
      pendingList.resolve(result);
      await waitForFast(() => expect(sessions.state.result).toStrictEqual(result));
      h.update({ sessionKey: "global" }, false);
      await sessions.refresh({ agentId, search: "selected", force: true });
      expect(sessions.state.agentId).toBe(agentId);
    }
    vi.useFakeTimers();
    h.update({ selfUser: { id: "operator", name: "Operator" } });
    pendingList.resolve(result);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(listCallsOf(request)).toHaveLength(agentId === "work" ? 3 : 2);
    vi.useRealTimers();

    expect(listCallsOf(request).map(([, params]) => params)).toEqual([
      expect.not.objectContaining({ ownerFirst: expect.anything() }),
      ...(agentId === "work" ? [expect.objectContaining({ agentId, search: "selected" })] : []),
      expect.objectContaining({
        agentId,
        limit: SIDEBAR_SESSION_ROSTER_LIMIT,
        ...(agentId === "work" ? { search: "selected" } : { ownerFirst: true }),
      }),
    ]);
    await waitForFast(() => expect(sessions.state.agentId).toBe(agentId));
    expect(sessions.state.result?.sessions).toEqual([]);

    h.update({ phase: "reconnecting" });
    h.update({ phase: "connected", sessionKey: "agent:main:main" });
    await waitForFast(() => expect(sessions.state.agentId).toBe("main"));
  },
);

it.each([
  { refusal: "rejected", delay: 100, error: "session observer temporarily unavailable" },
  {
    refusal: "unacknowledged",
    delay: 500,
    error: expect.stringContaining("did not activate the session event subscription"),
  },
])(
  "recovers primary and managed lists after an observer is $refusal",
  async ({ refusal, delay, error }) => {
    vi.useFakeTimers();
    const result = sessionsResult([], 1);
    const recovered = recoveredResult();
    let listCalls = 0;
    const subscribe =
      refusal === "rejected"
        ? retryOnce("session observer temporarily unavailable")
        : (attempt: number) => (attempt === 1 ? {} : { subscribed: true });
    const h = observer(subscribe, (params) => {
      if (params?.agentId === "writer") {
        const done = h.subscriptionCalls > 1;
        return sessionsResult(
          [
            {
              ...row("agent:writer:linked", done ? 2 : 1),
              hasActiveRun: !done,
              status: done ? "done" : "running",
            },
          ],
          1,
        );
      }
      listCalls += 1;
      return listCalls === 1 ? result : recovered;
    });

    const { sessions, connect } = h;
    const writerQuery = { agentId: "writer", archivedFilter: "all" as const, limit: 2 };
    const stopWriter = sessions.subscribeList(writerQuery, () => undefined);

    connect();
    await vi.advanceTimersByTimeAsync(0);

    expect(sessions.state.result).toStrictEqual(result);
    expect(sessions.state.error).toEqual(error);
    expect(h.subscriptionCalls).toBe(1);
    expect(sessions.listSnapshot(writerQuery).result?.sessions[0]).toMatchObject({
      key: "agent:writer:linked",
      hasActiveRun: true,
      status: "running",
    });

    await vi.advanceTimersByTimeAsync(delay - 1);
    expect(h.subscriptionCalls).toBe(1);
    await vi.advanceTimersByTimeAsync(1);

    expect(h.subscriptionCalls).toBe(2);
    expect(sessions.state.error).toBeNull();
    expect(sessions.state.result).toStrictEqual(recovered);
    expect(listCalls).toBe(2);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(sessions.listSnapshot(writerQuery).result?.sessions[0]).toMatchObject({
      key: "agent:writer:linked",
      hasActiveRun: false,
      status: "done",
    });
    expect(vi.getTimerCount()).toBe(0);
    stopWriter();
  },
);

it("recovers the roster after a subscription deadline without admitting late replies", async () => {
  vi.useFakeTimers();
  const initialResult = sessionsResult([], 1);
  const recovered = recoveredResult();
  const sent: Array<{ id: string; method: string }> = [];
  let handlers: GatewayProtocolSocketHandlers | undefined;
  const protocol = new GatewayProtocolClient<Record<string, never>>({
    createSocket: (nextHandlers) => {
      handlers = nextHandlers;
      return {
        isOpen: () => true,
        send: (data) => {
          const frame = JSON.parse(data) as { id: string; method: string };
          sent.push({ id: frame.id, method: frame.method });
        },
        close: () => undefined,
      };
    },
    createRequestId: () => "request",
    buildConnectPlan: () => ({}),
    buildConnectParams: (plan) => plan,
    resolveClose: () => ({ retry: false, notify: false }),
    handshake: { mode: "require-challenge", timeoutMs: 100 },
    reconnect: { initialMs: 10, multiplier: 2, maxMs: 100 },
  });
  protocol.start();
  const request = protocol.request.bind(protocol) as GatewayBrowserClient["request"];
  const { sessions, connect } = hydration(request);
  const recoveredStates: SessionsListResult[] = [];
  const unsubscribe = sessions.subscribe((next) => {
    if (next.result?.sessions.some((entry) => entry.key === "agent:main:recovered")) {
      recoveredStates.push(next.result);
    }
  });
  const respond = (id: string, payload: unknown) => {
    handlers?.message(JSON.stringify({ type: "res", id, ok: true, payload }));
  };

  try {
    handlers?.open();
    handlers?.message(
      JSON.stringify({ type: "event", event: "connect.challenge", payload: { nonce: "fixture" } }),
    );
    expect(sent.shift()).toEqual({ id: "1:request", method: "connect" });
    respond("1:request", { type: "hello-ok" });
    await vi.advanceTimersByTimeAsync(0);
    connect();
    await vi.advanceTimersByTimeAsync(0);
    expect(sent).toEqual([
      { id: "2:request", method: "sessions.subscribe" },
      { id: "3:request", method: "sessions.list" },
    ]);
    respond("3:request", initialResult);
    await vi.advanceTimersByTimeAsync(0);
    expect(sessions.state.result).toEqual(initialResult);

    await vi.advanceTimersByTimeAsync(DEFAULT_GATEWAY_REQUEST_TIMEOUT_MS);
    expect(sessions.state.error).not.toBeNull();
    await vi.advanceTimersByTimeAsync(500);
    expect(sent).toContainEqual({ id: "4:request", method: "sessions.subscribe" });

    respond("2:request", { status: "accepted" });
    respond("2:request", { subscribed: true });
    await vi.advanceTimersByTimeAsync(0);
    expect(sessions.state.error).not.toBeNull();
    expect(sent.filter(({ method }) => method === "sessions.list")).toHaveLength(1);

    respond("4:request", { subscribed: true });
    await vi.advanceTimersByTimeAsync(0);
    expect(sent).toContainEqual({ id: "5:request", method: "sessions.list" });
    respond("5:request", recovered);
    await vi.advanceTimersByTimeAsync(0);

    respond("2:request", { status: "accepted" });
    respond("2:request", { subscribed: true });
    await vi.advanceTimersByTimeAsync(0);

    expect(sessions.state.error).toBeNull();
    expect(sessions.state.result).toEqual(recovered);
    expect(recoveredStates).toEqual([recovered]);
    expect(sent.filter(({ method }) => method === "sessions.subscribe")).toHaveLength(2);
    expect(sent.filter(({ method }) => method === "sessions.list")).toHaveLength(2);
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    unsubscribe();
    sessions.dispose();
    protocol.stop();
    vi.useRealTimers();
  }
});

it.each(["retry", "pending"])(
  "retires an observer %s across a same-client reconnect",
  async (state) => {
    vi.useFakeTimers();
    const retired = createDeferred<{ subscribed: boolean }>();
    const h = observer(
      state === "retry"
        ? retryOnce("session observer temporarily unavailable")
        : (attempt) => (attempt === 1 ? retired.promise : { subscribed: true }),
    );
    cleanup.push(() => retired.resolve({ subscribed: false }));
    const { sessions, connect, disconnect, request } = h;

    connect();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.subscriptionCalls).toBe(1);
    if (state === "retry") {
      expect(vi.getTimerCount()).toBe(1);
    }

    disconnect();
    expect(sessions.state.error).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
    if (state === "retry") {
      await vi.advanceTimersByTimeAsync(1_000);
      expect(h.subscriptionCalls).toBe(1);
    }

    connect();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.subscriptionCalls).toBe(2);
    expect(sessions.state.result).not.toBeNull();
    retired.resolve({ subscribed: false });
    await vi.advanceTimersByTimeAsync(0);
    expect(h.subscriptionCalls).toBe(2);
    expect(sessions.state.error).toBeNull();
    expect(listCallsOf(request)).toHaveLength(2);
    expect(vi.getTimerCount()).toBe(0);
  },
);

it("does not recreate a retry timer when an observer-error listener disposes its owner", async () => {
  vi.useFakeTimers();
  const h = observer(() => {
    throw retryError("observer unavailable during teardown");
  });
  const { sessions, connect } = h;
  sessions.subscribe((next) => {
    if (next.error) {
      sessions.dispose();
    }
  });

  connect();
  await vi.advanceTimersByTimeAsync(0);

  expect(h.subscriptionCalls).toBe(1);
  expect(vi.getTimerCount()).toBe(0);
  await vi.advanceTimersByTimeAsync(500);
  expect(h.subscriptionCalls).toBe(1);
});

it.each([
  { ...targetedSessionReconciliationCases[0], operationFails: false },
  { ...targetedSessionReconciliationCases[1], operationFails: false },
  { ...targetedSessionReconciliationCases[0], operationFails: true },
  { ...targetedSessionReconciliationCases[1], operationFails: true },
])(
  "preserves failure across $description (newer operation: $operationFails)",
  async ({ reconcile, operationFails }) => {
    vi.useFakeTimers();
    const result = runningSessionsResult();
    const h = observer(retryOnce("broad session observer unavailable"), (_params, attempt) => {
      if (operationFails && attempt === 2) {
        throw new Error("newer session list failure");
      }
      return result;
    });

    const { sessions, connect, emitEvent } = h;

    connect();
    await vi.advanceTimersByTimeAsync(0);
    if (operationFails) {
      await sessions.refresh({ force: true });
    }
    const error = operationFails
      ? "newer session list failure"
      : "broad session observer unavailable";
    expect(sessions.state.error).toBe(error);

    reconcile(sessions, emitEvent);
    expect(sessions.state.error).toBe(error);

    await vi.advanceTimersByTimeAsync(100);
    expect(h.subscriptionCalls).toBe(2);
    expect(sessions.state.error).toBeNull();
  },
);

it.each(["repeated observer failure", "matching error message"])(
  "preserves list error ownership across %s",
  async (scenario) => {
    vi.useFakeTimers();
    const recovers = scenario === "matching error message";
    const pending = createDeferred<SessionsListResult>();
    const listError = recovers
      ? retryError("newer session list failure")
      : new Error("newer session list failure");
    const h = observer(
      (attempt) => {
        if (recovers && attempt > 1) {
          return { subscribed: true };
        }
        throw recovers ? listError : retryError(`observer unavailable ${attempt}`);
      },
      (_params, attempt) => {
        if (recovers && attempt === 3) {
          return pending.promise;
        }
        if (attempt > 1) {
          throw listError;
        }
        return sessionsResult([], 1);
      },
    );

    cleanup.push(() => pending.resolve(sessionsResult([], 1)));
    const { sessions, connect } = h;
    connect();
    await vi.advanceTimersByTimeAsync(0);
    await sessions.refresh({ force: true });
    expect(sessions.state.error).toBe("newer session list failure");

    await vi.advanceTimersByTimeAsync(100);

    expect(h.subscriptionCalls).toBe(2);
    expect(sessions.state.error).toBe("newer session list failure");
    if (recovers) {
      expect(listCallsOf(h.request)).toHaveLength(3);
      pending.resolve(sessionsResult([], 1));
      await vi.advanceTimersByTimeAsync(0);
      expect(sessions.state.error).toBeNull();
    }
  },
);
