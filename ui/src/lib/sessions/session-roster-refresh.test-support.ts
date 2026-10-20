import { Value } from "typebox/value";
import { expect, onTestFinished, vi } from "vitest";
import { SessionsListParamsSchema } from "../../../../packages/gateway-protocol/src/schema/sessions-list.js";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { GatewaySessionRow, SessionsListResult } from "../../api/types.ts";
import { createConnectionBootstrapCoordinator } from "../../app/connection-bootstrap.ts";
import { createTestGatewayClient } from "../../test-helpers/gateway-client.ts";
import { createSessionCapability } from "./index.ts";
import { createGatewayHarness, sessionsResult } from "./session-capability.test-support.ts";
import type { SessionGateway, SessionListScope } from "./session-capability.ts";

export function ownRoster(
  gateway: SessionGateway,
  bootstrap?: ReturnType<typeof createConnectionBootstrapCoordinator>,
) {
  const sessions = createSessionCapability(
    gateway,
    {
      state: { selectedId: "main" },
      subscribe: () => () => undefined,
    },
    bootstrap ? { connectionBootstrap: bootstrap } : undefined,
  );
  const stops: Array<() => unknown> = [];
  const before: Array<() => unknown> = [];
  const after: Array<() => unknown> = [];
  onTestFinished(async () => {
    before.forEach((resolve) => resolve());
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
    resolveOnCleanup(
      this: void,
      ...pending: Array<[ReturnType<typeof createDeferred<SessionsListResult>>, SessionsListResult]>
    ) {
      pending.forEach(([deferred, result]) => before.push(() => deferred.resolve(result)));
    },
    settle(this: void, run: () => unknown) {
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

export function queuedLists(
  lists: Record<string, ReturnType<typeof createDeferred<SessionsListResult>>>,
) {
  const request = vi.fn(async (method: string, params?: { agentId?: string }) => {
    expect(method).toBe("sessions.list");
    const pending = params?.agentId ? lists[params.agentId] : undefined;
    if (!pending) {
      throw new Error(`Unexpected refresh: ${params?.agentId}`);
    }
    return pending.promise;
  });
  return { ...rosterFixture(request as unknown as GatewayBrowserClient["request"]), request };
}

export function listRequest<P = unknown>(
  read: (params?: P) => unknown,
  subscribe: () => unknown = () => ({ subscribed: true }),
) {
  return vi.fn(async (method: string, params?: P) => {
    if (method === "sessions.subscribe") {
      return subscribe();
    }
    expect(method).toBe("sessions.list");
    return read(params);
  });
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

export function delay(ms: number) {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}

export function advance(ms = 0) {
  return vi.advanceTimersByTimeAsync(ms);
}

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
