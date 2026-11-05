import { Value } from "typebox/value";
import { expect, onTestFinished, vi } from "vitest";
import { SessionsListParamsSchema } from "../../../../packages/gateway-protocol/src/schema/sessions-list.js";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { GatewaySessionRow, SessionsListResult } from "../../api/types.ts";
import { createConnectionBootstrapCoordinator } from "../../app/connection-bootstrap.ts";
import { createTestGatewayClient } from "../../test-helpers/gateway-client.ts";
import { sessionRequest } from "./hydration-family.test-support.ts";
import { createSessionCapability } from "./index.ts";
import { createGatewayHarness, sessionsResult } from "./session-capability.test-support.ts";
import type { SessionGateway, SessionListScope } from "./session-capability.ts";

type PendingList = ReturnType<typeof createDeferred<SessionsListResult>>;
type Cleanup = () => unknown;

export function rosterPage(rows: GatewaySessionRow[], totalCount: number, limit: number, ts = 1) {
  return {
    ...sessionsResult(rows, ts),
    totalCount,
    hasMore: true,
    nextOffset: limit,
    limitApplied: limit,
  };
}

export function ownRoster(
  gateway: SessionGateway,
  bootstrap?: ReturnType<typeof createConnectionBootstrapCoordinator>,
) {
  const selection = { state: { selectedId: "main" }, subscribe: () => () => undefined };
  const sessions = createSessionCapability(
    gateway,
    selection,
    bootstrap ? { connectionBootstrap: bootstrap } : undefined,
  );
  const stops: Cleanup[] = [];
  const pending: Array<[PendingList, SessionsListResult]> = [];
  const after: Cleanup[] = [];
  onTestFinished(async () => {
    pending.forEach(([deferred, result]) => deferred.resolve(result));
    stops.forEach((stop) => stop());
    sessions.dispose();
    bootstrap?.reset();
    for (const settle of after) {
      await settle();
    }
    vi.useRealTimers();
  });
  return {
    sessions,
    watch(this: void, query: SessionListScope | (() => unknown)) {
      const stop = typeof query === "function" ? query : sessions.subscribeList(query, () => {});
      stops.push(stop);
      return stop;
    },
    resolveOnCleanup: (...entries: typeof pending) => {
      entries.forEach(([deferred, result]) => pending.push([deferred, result]));
    },
    settle: (run: Cleanup) => {
      after.push(run);
    },
    listResult: (query: SessionListScope) => sessions.listSnapshot(query).result,
    listRows: (query: SessionListScope) => sessions.listSnapshot(query).result?.sessions,
    rows: () => sessions.state.result?.sessions,
  };
}

export function rosterFixture(
  request: GatewayBrowserClient["request"],
  options?: { ownerId?: string },
) {
  const harness = createGatewayHarness({ request } as GatewayBrowserClient, undefined, {
    selfUser: options?.ownerId ? { id: options.ownerId } : null,
  });
  return { ...harness, ...ownRoster(harness.gateway) };
}

export function rosterReadFixture(
  read: (params: ReturnType<typeof listParams>) => unknown,
  ownerId?: string,
) {
  const request = vi.fn((method: string, params?: unknown) => read(listParams(method, params)));
  const client = createTestGatewayClient(request);
  return { request, ...rosterFixture(client.request.bind(client), { ownerId }) };
}

export function queuedLists(lists: Record<string, PendingList>) {
  const request = vi.fn((method: string, params?: ReturnType<typeof listParams>) => {
    expect(method).toBe("sessions.list");
    const pending = params?.agentId ? lists[params.agentId] : undefined;
    if (!pending) {
      throw new Error(`Unexpected refresh: ${params?.agentId}`);
    }
    return pending.promise;
  });
  const client = createTestGatewayClient((method, params) =>
    request(method, listParams(method, params)),
  );
  return { request, ...rosterFixture(client.request.bind(client)) };
}

export function listRequest<P = unknown>(
  read: (params?: P) => unknown,
  subscribe: () => unknown = () => ({ subscribed: true }),
) {
  return sessionRequest<P>({ "sessions.subscribe": subscribe, "sessions.list": read });
}

export function coordinated(request: Parameters<typeof createTestGatewayClient>[0]) {
  const client = createTestGatewayClient(request);
  const harness = createGatewayHarness(client);
  const coordinator = createConnectionBootstrapCoordinator();
  coordinator.synchronize({ client, connected: true });
  return {
    ...harness,
    client,
    coordinator,
    ...ownRoster(harness.gateway, coordinator),
    hold: (key: string) => coordinator.setForegroundRoute(key),
    release: (sessionKey: string) =>
      coordinator.setForegroundPane({}, { sessionKey, client, ready: true }),
  };
}

export function listParams(method: string, params: unknown) {
  expect(method).toBe("sessions.list");
  if (!Value.Check(SessionsListParamsSchema, params)) {
    throw new Error("Invalid sessions.list request");
  }
  return params;
}

export const delay = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

export const advance = (ms = 0) => vi.advanceTimersByTimeAsync(ms);

export function ownerCountsFixture(row: GatewaySessionRow, fullRows?: GatewaySessionRow[]) {
  const counts = { open: 8, running: 0 };
  const summaryRequest = vi.fn();
  const request = vi.fn(async (method: string, params?: unknown) => {
    const query = listParams(method, params);
    if (fullRows && !query.includeOwnerSessionCounts) {
      return sessionsResult(fullRows, 1);
    }
    if (query.includeOwnerSessionCounts) {
      summaryRequest(params);
    }
    return {
      ...sessionsResult([row], 1),
      ownerSessionCounts: [{ profileId: "ada", ...counts }],
      totalCount: counts.open,
      hasMore: true,
      nextOffset: 1,
    } satisfies SessionsListResult;
  });
  const harness = createGatewayHarness(createTestGatewayClient(request));
  return { ...harness, ...ownRoster(harness.gateway), counts, summaryRequest };
}
