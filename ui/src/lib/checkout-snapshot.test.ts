import { expect, it, vi } from "vitest";
import type { ApplicationGateway } from "../app/gateway.ts";
import { createApplicationGatewaySnapshot } from "../test-helpers/application-context-fixtures.ts";
import {
  createTestGatewayClient,
  type GatewayRequestHandler,
} from "../test-helpers/gateway-client.ts";
import { requestCheckoutSnapshot } from "./checkout-snapshot.ts";

function createFixture(request: GatewayRequestHandler) {
  let event!: Parameters<ApplicationGateway["subscribeEvents"]>[0];
  let snapshot!: Parameters<ApplicationGateway["subscribe"]>[0];
  const stopEvents = vi.fn();
  const stopConnection = vi.fn();
  const gateway = {
    snapshot: createApplicationGatewaySnapshot({
      phase: "connected",
      client: createTestGatewayClient(request),
    }),
    subscribe(listener: typeof snapshot) {
      snapshot = listener;
      return stopConnection;
    },
    subscribeEvents(listener: typeof event) {
      event = listener;
      return stopEvents;
    },
  };
  return {
    gateway,
    stopEvents,
    stopConnection,
    event: (...args: Parameters<typeof event>) => event(...args),
    disconnect: () => snapshot(createApplicationGatewaySnapshot()),
  };
}

it("retains a cached picker snapshot until its own invalidation, including one arriving during the RPC", async () => {
  const stale = { branches: [{ name: "main" }], refreshing: true };
  const fresh = { branches: [{ name: "main" }, { name: "feature" }] };
  const request = vi.fn(
    async (): Promise<{ branches: { name: string }[]; refreshing?: boolean }> => stale,
  );
  const { gateway, event: listener, stopEvents, stopConnection } = createFixture(request);
  const published = Promise.withResolvers<void>();
  const onSnapshot = vi.fn(() => published.resolve());
  const result = requestCheckoutSnapshot(
    gateway,
    "worktrees.branches",
    { repoRoot: "/repo" },
    { onSnapshot },
  );
  await published.promise;
  expect(onSnapshot).toHaveBeenCalledWith(stale);
  listener({ type: "event", event: "worktrees.branches.changed", payload: { repoRoot: "/other" } });
  expect(request).toHaveBeenCalledTimes(1);
  request
    .mockImplementationOnce(async () => {
      listener({
        type: "event",
        event: "worktrees.branches.changed",
        payload: { repoRoot: "/repo" },
      });
      return stale;
    })
    .mockResolvedValue(fresh);
  listener({ type: "event", event: "worktrees.branches.changed", payload: { repoRoot: "/repo" } });
  expect(await result).toEqual(fresh);
  expect(request).toHaveBeenCalledTimes(3);
  expect(stopEvents).toHaveBeenCalledOnce();
  expect(stopConnection).toHaveBeenCalledOnce();
});

it("retires a pending refresh when its caller leaves", async () => {
  const { gateway, stopEvents, stopConnection } = createFixture(async () => ({ refreshing: true }));
  const controller = new AbortController();
  const published = Promise.withResolvers<void>();
  const result = requestCheckoutSnapshot(
    gateway,
    "projects.checkoutOptions",
    { projectId: "one", agentId: "main" },
    {
      signal: controller.signal,
      onSnapshot: () => published.resolve(),
    },
  );
  await published.promise;
  const rejected = expect(result).rejects.toMatchObject({ name: "AbortError" });
  controller.abort();
  await rejected;
  expect(stopEvents).toHaveBeenCalledOnce();
  expect(stopConnection).toHaveBeenCalledOnce();
});

it("releases the event listener if the peer never publishes completion", async () => {
  vi.useFakeTimers();
  try {
    const { gateway, stopEvents, stopConnection } = createFixture(async () => ({
      refreshing: true,
    }));
    const result = requestCheckoutSnapshot(gateway, "worktrees.branches", { repoRoot: "/repo" });
    const rejected = expect(result).rejects.toThrow("select the project again to retry");
    await vi.advanceTimersByTimeAsync(10_000);
    await rejected;
    expect(stopEvents).toHaveBeenCalledOnce();
    expect(stopConnection).toHaveBeenCalledOnce();
  } finally {
    vi.useRealTimers();
  }
});

it("retires a pending refresh immediately when the connection closes", async () => {
  const { gateway, disconnect, stopEvents, stopConnection } = createFixture(async () => ({
    refreshing: true,
  }));
  const published = Promise.withResolvers<void>();
  const result = requestCheckoutSnapshot(
    gateway,
    "worktrees.branches",
    { repoRoot: "/repo" },
    { onSnapshot: () => published.resolve() },
  );
  await published.promise;
  const rejected = expect(result).rejects.toMatchObject({ name: "AbortError" });
  disconnect();
  await rejected;
  expect(stopEvents).toHaveBeenCalledOnce();
  expect(stopConnection).toHaveBeenCalledOnce();
});
