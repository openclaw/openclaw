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
import {
  GatewayRequestError,
  type GatewayBrowserClient,
  type GatewayEventFrame,
} from "../../api/gateway.ts";
import type { SessionsListResult } from "../../api/types.ts";
import { createApplicationGateway } from "../../test-helpers/application-context-fixtures.ts";
import { createTestGatewayClient } from "../../test-helpers/gateway-client.ts";
import { gatewayHelloForMethods } from "../../test-helpers/gateway-methods.ts";
import { waitForFast } from "../../test-helpers/wait-for.ts";
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
  return vi.fn(async (method: string, params?: Record<string, unknown>) => {
    if (method === "sessions.subscribe") {
      return subscribe();
    }
    if (method === "sessions.list") {
      return list(params);
    }
    throw new Error(`Unexpected request: ${method}`);
  });
}
const retryError = (message: string) =>
  new GatewayRequestError({
    code: "UNAVAILABLE",
    message,
    retryable: true,
    retryAfterMs: 100,
  });
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

const targetedSessionReconciliationCases = [
  {
    description: "targeted session changes",
    reconcile: (sessions: SessionCapability, emitEvent: (event: GatewayEventFrame) => void) => {
      emitEvent({
        type: "event",
        event: "sessions.changed",
        payload: {
          sessionKey: "agent:main:main",
          key: "agent:main:main",
          kind: "direct",
          updatedAt: 2,
          hasActiveRun: false,
          status: "done",
        },
      });
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
        : { names: [], sectionOrder: [] };
    });
    const source = createApplicationGateway();
    const hello = gatewayHelloForMethods(
      ["sessions.list", "sessions.subscribe", "sessions.groups.list"],
      ["operator.read"],
    );
    hello.auth!.recoveryScope = "test-recovery-scope";
    source.publish({
      ...source.gateway.snapshot,
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
    source.publish({
      ...source.gateway.snapshot,
      phase: "reconnecting",
      hello: null,
      selfUser: undefined,
    });
    expect(sessions.listSnapshot(query).result?.sessions).toEqual(retained.sessions);
    source.publish({
      ...source.gateway.snapshot,
      phase: "connected",
      hello,
      selfUser: undefined,
    });
    expect(sessions.listSnapshot(query).result?.sessions).toEqual(retained.sessions);
    source.publish({ ...source.gateway.snapshot, selfUser: { id: "alice", name: "Alice" } });
    expect(sessions.listSnapshot(query).result?.sessions).toEqual(retained.sessions);
    const old = observed.refresh().catch((error: unknown) => error);
    source.publish({
      ...source.gateway.snapshot,
      ...(change === "account"
        ? { selfUser: { id: "bob", name: "Bob" } }
        : {
            selfUser: undefined,
            hello: { ...hello, auth: { ...hello.auth!, recoveryScope: "bob-scope" } },
          }),
    });
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
  const owned = (key: string, updatedAt: number, id: string) => ({
    key: `agent:main:${key}`,
    kind: "direct" as const,
    updatedAt,
    createdActor: { type: "human" as const, id },
  });
  const roster = sessionsResult(
    [
      owned("mine-new", 3, "operator"),
      owned("mine-old", 1, "operator"),
      owned("theirs", 2, "collaborator"),
    ],
    1,
  );
  const bootstrap = createDeferred<SessionsListResult>();
  const queuedResult = sessionsResult(
    [{ key: "agent:other:queued", kind: "direct", updatedAt: 4 }],
    1,
  );
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
    expect(request).toHaveBeenCalledWith(
      "sessions.list",
      expect.objectContaining({
        agentId: "main",
        limit: SIDEBAR_SESSION_ROSTER_LIMIT,
      }),
    ),
  );
  expect(
    request.mock.calls.find(([method]) => method === "sessions.list")?.[1]?.ownerFirst,
  ).toBeUndefined();
  expect(request).toHaveBeenCalledWith(
    "sessions.subscribe",
    {},
    { timeoutMs: DEFAULT_GATEWAY_REQUEST_TIMEOUT_MS },
  );
  expect(listCallsOf(request)).toHaveLength(1);
  expect(sessions.state.result).toBeNull();
  const queuedRefresh = sessions.refresh({ agentId: "other", search: "queued", force: true });
  h.update({ selfUser: { id: "operator", name: "Operator" } });

  bootstrap.resolve(roster);
  await waitForFast(() => expect(listCallsOf(request)).toHaveLength(2));
  expect(sessions.state.result).toBeNull();
  expect(request.mock.calls.at(-1)?.[1]).toEqual(
    expect.objectContaining({ agentId: "other", search: "queued" }),
  );
  queuedList.resolve(queuedResult);
  await queuedRefresh;
  expect(sessions.state.agentId).toBe("other");
  expect(sessions.state.result).toStrictEqual(queuedResult);
});

it("uses the selected agent before a session key is available", async () => {
  const result = sessionsResult(
    [{ key: "agent:roboclaw:dashboard:one", kind: "direct", updatedAt: 1 }],
    1,
  );
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

  await waitForFast(() =>
    expect(request).toHaveBeenCalledWith(
      "sessions.list",
      expect.objectContaining({ agentId: "roboclaw", includeDerivedTitles: true }),
    ),
  );
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

it("recovers primary and managed lists after retrying the current session observer", async () => {
  vi.useFakeTimers();
  const result = sessionsResult([], 1);
  const recoveredResult = sessionsResult(
    [{ key: "agent:main:recovered", kind: "direct", updatedAt: 2 }],
    1,
  );
  let listCalls = 0;
  const h = observer(retryOnce("session observer temporarily unavailable"), (params) => {
    if (params?.agentId === "writer") {
      const done = h.subscriptionCalls > 1;
      return {
        ...result,
        count: 1,
        sessions: [
          {
            key: "agent:writer:linked",
            kind: "direct",
            updatedAt: done ? 2 : 1,
            hasActiveRun: !done,
            status: done ? "done" : "running",
          },
        ],
      } satisfies SessionsListResult;
    }
    listCalls += 1;
    return listCalls === 1 ? result : recoveredResult;
  });

  const { sessions, connect } = h;
  const writerQuery = { agentId: "writer", archivedFilter: "all" as const, limit: 2 };
  const stopWriter = sessions.subscribeList(writerQuery, () => undefined);

  connect();
  await vi.advanceTimersByTimeAsync(0);

  expect(sessions.state.result).toStrictEqual(result);
  expect(sessions.state.error).toBe("session observer temporarily unavailable");
  expect(h.subscriptionCalls).toBe(1);
  expect(sessions.listSnapshot(writerQuery).result?.sessions[0]).toMatchObject({
    key: "agent:writer:linked",
    hasActiveRun: true,
    status: "running",
  });

  await vi.advanceTimersByTimeAsync(99);
  expect(h.subscriptionCalls).toBe(1);
  await vi.advanceTimersByTimeAsync(1);

  expect(h.subscriptionCalls).toBe(2);
  expect(sessions.state.error).toBeNull();
  expect(sessions.state.result).toStrictEqual(recoveredResult);
  expect(listCalls).toBe(2);
  await vi.advanceTimersByTimeAsync(5_000);
  expect(sessions.listSnapshot(writerQuery).result?.sessions[0]).toMatchObject({
    key: "agent:writer:linked",
    hasActiveRun: false,
    status: "done",
  });
  expect(vi.getTimerCount()).toBe(0);
  stopWriter();
});

it("recovers the roster after a subscription deadline without admitting late replies", async () => {
  vi.useFakeTimers();
  const initialResult = sessionsResult([], 1);
  const recoveredResult = sessionsResult(
    [{ key: "agent:main:recovered", kind: "direct", updatedAt: 2 }],
    1,
  );
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
    if (next.result?.sessions.some((row) => row.key === "agent:main:recovered")) {
      recoveredStates.push(next.result);
    }
  });
  const respond = (id: string, payload: unknown) => {
    handlers?.message(JSON.stringify({ type: "res", id, ok: true, payload }));
  };

  try {
    connect();
    await vi.advanceTimersByTimeAsync(0);
    expect(sent).toEqual([
      { id: "1:request", method: "sessions.subscribe" },
      { id: "2:request", method: "sessions.list" },
    ]);
    respond("2:request", initialResult);
    await vi.advanceTimersByTimeAsync(0);
    expect(sessions.state.result).toEqual(initialResult);

    await vi.advanceTimersByTimeAsync(DEFAULT_GATEWAY_REQUEST_TIMEOUT_MS);
    expect(sessions.state.error).not.toBeNull();
    await vi.advanceTimersByTimeAsync(500);
    expect(sent).toContainEqual({ id: "3:request", method: "sessions.subscribe" });

    respond("1:request", { status: "accepted" });
    respond("1:request", { subscribed: true });
    await vi.advanceTimersByTimeAsync(0);
    expect(sessions.state.error).not.toBeNull();
    expect(sent.filter(({ method }) => method === "sessions.list")).toHaveLength(1);

    respond("3:request", { subscribed: true });
    await vi.advanceTimersByTimeAsync(0);
    expect(sent).toContainEqual({ id: "4:request", method: "sessions.list" });
    respond("4:request", recoveredResult);
    await vi.advanceTimersByTimeAsync(0);

    respond("1:request", { status: "accepted" });
    respond("1:request", { subscribed: true });
    await vi.advanceTimersByTimeAsync(0);

    expect(sessions.state.error).toBeNull();
    expect(sessions.state.result).toEqual(recoveredResult);
    expect(recoveredStates).toEqual([recoveredResult]);
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

it("rejects an unacknowledged session observer and retries until acknowledged", async () => {
  vi.useFakeTimers();
  const h = observer((attempt) => (attempt === 1 ? {} : { subscribed: true }));
  const { sessions, connect, request } = h;

  connect();
  await vi.advanceTimersByTimeAsync(0);

  expect(h.subscriptionCalls).toBe(1);
  expect(sessions.state.result).not.toBeNull();
  expect(sessions.state.error).toContain("did not activate the session event subscription");

  await vi.advanceTimersByTimeAsync(500);

  expect(h.subscriptionCalls).toBe(2);
  expect(sessions.state.error).toBeNull();
  expect(listCallsOf(request)).toHaveLength(2);
  expect(vi.getTimerCount()).toBe(0);
});

it("retires observer retries on disconnect before the same client reconnects", async () => {
  vi.useFakeTimers();
  const h = observer(retryOnce("session observer temporarily unavailable"));
  const { sessions, connect, disconnect, request } = h;

  connect();
  await vi.advanceTimersByTimeAsync(0);
  expect(h.subscriptionCalls).toBe(1);
  expect(vi.getTimerCount()).toBe(1);

  disconnect();
  expect(sessions.state.error).toBeNull();
  expect(vi.getTimerCount()).toBe(0);
  await vi.advanceTimersByTimeAsync(1_000);
  expect(h.subscriptionCalls).toBe(1);

  connect();
  await vi.advanceTimersByTimeAsync(0);

  expect(h.subscriptionCalls).toBe(2);
  expect(sessions.state.error).toBeNull();
  expect(listCallsOf(request)).toHaveLength(2);
  expect(vi.getTimerCount()).toBe(0);
});

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

it("keeps newer session-list failures visible across repeated observer retry failures", async () => {
  vi.useFakeTimers();
  const h = observer(
    (attempt) => {
      throw retryError(`observer unavailable ${attempt}`);
    },
    (_params, attempt) => {
      if (attempt > 1) {
        throw new Error("newer session list failure");
      }
      return sessionsResult([], 1);
    },
  );

  const { sessions, connect } = h;

  connect();
  await vi.advanceTimersByTimeAsync(0);
  await sessions.refresh({ force: true });
  expect(sessions.state.error).toBe("newer session list failure");

  await vi.advanceTimersByTimeAsync(100);

  expect(h.subscriptionCalls).toBe(2);
  expect(sessions.state.error).toBe("newer session list failure");
});

it("does not clear an unrelated list error with the same observer error message", async () => {
  vi.useFakeTimers();
  const pendingCatchUpList = createDeferred<SessionsListResult>();
  const sharedError = retryError("same failure message");
  const h = observer(
    (attempt) => {
      if (attempt === 1) {
        throw sharedError;
      }
      return { subscribed: true };
    },
    (_params, attempt) => {
      if (attempt === 2) {
        throw sharedError;
      }
      return attempt === 3 ? pendingCatchUpList.promise : sessionsResult([], 1);
    },
  );
  const { sessions, connect } = h;
  cleanup.push(() => pendingCatchUpList.resolve(sessionsResult([], 1)));
  connect();
  await vi.advanceTimersByTimeAsync(0);
  await sessions.refresh({ force: true });
  expect(sessions.state.error).toBe("same failure message");

  await vi.advanceTimersByTimeAsync(100);

  expect(h.subscriptionCalls).toBe(2);
  expect(listCallsOf(h.request)).toHaveLength(3);
  expect(sessions.state.error).toBe("same failure message");
  pendingCatchUpList.resolve(sessionsResult([], 1));
  await vi.advanceTimersByTimeAsync(0);
  expect(sessions.state.error).toBeNull();
});

it("ignores an outdated observer refusal after the same client reconnects", async () => {
  vi.useFakeTimers();
  const retiredSubscription = createDeferred<{ subscribed: boolean }>();
  const h = observer((attempt) =>
    attempt === 1 ? retiredSubscription.promise : { subscribed: true },
  );
  const { sessions, connect, disconnect, request } = h;
  cleanup.push(() => retiredSubscription.resolve({ subscribed: false }));
  connect();
  await vi.advanceTimersByTimeAsync(0);
  expect(h.subscriptionCalls).toBe(1);

  disconnect();
  connect();
  await vi.advanceTimersByTimeAsync(0);
  expect(h.subscriptionCalls).toBe(2);
  expect(sessions.state.result).not.toBeNull();

  retiredSubscription.resolve({ subscribed: false });
  await vi.advanceTimersByTimeAsync(0);

  expect(sessions.state.error).toBeNull();
  expect(h.subscriptionCalls).toBe(2);
  expect(listCallsOf(request)).toHaveLength(2);
  expect(vi.getTimerCount()).toBe(0);
});
