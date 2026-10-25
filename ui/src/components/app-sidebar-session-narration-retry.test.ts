import { afterEach, beforeEach, expect, it, vi } from "vitest";
// @vitest-environment node
import {
  GatewayProtocolRequestError as RequestError,
  GatewayProtocolRequestTimeoutError as RequestTimeoutError,
} from "../../../packages/gateway-client/src/protocol-request.js";
import { GatewaySessionMessageSubscriptionCoordinator as SubscriptionCoordinator } from "../../../packages/gateway-client/src/session-subscriptions.js";
import { createDeferred } from "../../../test/helpers/promise.js";
import { browserVisibility, runningRow } from "../test-helpers/app-sidebar-session-narration.ts";
import {
  createSidebarNarration,
  type SidebarNarrationSyncInput as SyncInput,
} from "./app-sidebar-session-narration.ts";

function sourceWith<T extends NonNullable<SyncInput["source"]>["subscribeMessages"]>(
  subscribeMessages: T,
) {
  return { subscribeMessages, unsubscribeMessages: vi.fn().mockResolvedValue(undefined) };
}

const subscribeMethod = "sessions.messages.subscribe";
type Handle = { key: string; agentId: null };
function retrySource(error: Error, next?: Promise<Handle>) {
  const subscribe = vi.fn().mockRejectedValueOnce(error);
  return sourceWith(
    next
      ? subscribe.mockReturnValueOnce(next)
      : subscribe.mockResolvedValue({ key: "agent:main:run", agentId: null }),
  );
}
const retryError = (retryAfterMs?: number) => new RequestError({ retryable: true, retryAfterMs });
function start(
  source: SyncInput["source"],
  rows: SyncInput["rows"] = [runningRow("agent:main:run")],
) {
  const input: SyncInput = {
    enabled: true,
    connected: true,
    source,
    rows,
    connectionIdentity: {},
    openSessionKey: "",
    agentId: "main",
  };
  const narration = createSidebarNarration();
  narration.sync(input);
  return { input, narration };
}

function coordinatedSource(
  request: ConstructorParameters<typeof SubscriptionCoordinator>[0]["request"],
) {
  const coordinator = new SubscriptionCoordinator({ request });
  return {
    subscribeMessages: vi.fn(coordinator.acquire.bind(coordinator)),
    unsubscribeMessages: coordinator.release.bind(coordinator),
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(10_000);
  vi.spyOn(Math, "random").mockReturnValue(0.5);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

it("paces failed acquisitions across render syncs and converges without another render", async () => {
  let busy = true;
  const wireKeys = new Set<string>();
  const request = vi.fn().mockImplementation(async (method: string, params: { key: string }) => {
    const subscribing = method === subscribeMethod;
    if (subscribing && busy) {
      throw new RequestError({ code: "UNAVAILABLE", retryable: true });
    }
    wireKeys[subscribing ? "add" : "delete"](params.key);
    return { key: params.key };
  });
  const { input, narration } = start(
    coordinatedSource(request),
    Array.from({ length: 8 }, (_, index) => ({
      key: `agent:main:run-${index}`,
      hasActiveRun: true,
      updatedAt: index,
    })),
  );
  for (let index = 0; index < 100; index++) {
    await vi.advanceTimersByTimeAsync(0);
    input.rows = input.rows.map((row, rowIndex) =>
      rowIndex === 0 ? { ...row, updatedAt: index + 10 } : row,
    );
    narration.sync(input);
  }
  await vi.advanceTimersByTimeAsync(0);
  expect(request).toHaveBeenCalledTimes(6);
  expect(vi.getTimerCount()).toBe(6);

  for (const delay of [250, 500, 1_000, 2_000, 4_000, 8_000, 15_000, 15_000]) {
    const attempts = request.mock.calls.length;
    await vi.advanceTimersByTimeAsync(delay - 1);
    narration.sync(input);
    expect(request).toHaveBeenCalledTimes(attempts);
    await vi.advanceTimersByTimeAsync(1);
    expect(request).toHaveBeenCalledTimes(attempts + 6);
  }
  busy = false;
  await vi.advanceTimersByTimeAsync(15_000);
  expect([...wireKeys].toSorted()).toEqual(
    Array.from({ length: 6 }, (_, index) => `agent:main:run-${index + 2}`),
  );
  expect(vi.getTimerCount()).toBe(0);
  narration.disconnect();
  await vi.advanceTimersByTimeAsync(0);
  expect(wireKeys.size).toBe(0);
});

it("reacquires after a sent request timeout without a compensating RPC", async () => {
  const timeout = new RequestTimeoutError({
    method: subscribeMethod,
    timeoutMs: 30_000,
    requestSent: true,
  });
  const request = vi
    .fn()
    .mockRejectedValueOnce(timeout)
    .mockResolvedValue({ key: "agent:main:run" });
  const source = coordinatedSource(request);
  const { narration } = start(source);
  await expect(source.subscribeMessages.mock.results[0]?.value).rejects.toBeInstanceOf(
    RequestTimeoutError,
  );
  await vi.advanceTimersByTimeAsync(0);
  expect(request.mock.calls.map(([method]) => method)).toEqual([subscribeMethod]);
  await vi.advanceTimersByTimeAsync(250);
  expect(request.mock.calls.map(([method]) => method)).toEqual(Array(2).fill(subscribeMethod));
  expect(vi.getTimerCount()).toBe(0);
  narration.disconnect();
  await vi.advanceTimersByTimeAsync(0);
  expect(request).toHaveBeenCalledTimes(3);
});

it.each<{ draw: number; hint?: number; delay: number; clockShift?: number }>([
  { draw: 0, hint: undefined, delay: 1 },
  { draw: 0.9, hint: undefined, delay: 450 },
  { draw: 0.5, hint: 90_000, delay: 90_250 },
  { draw: 0.5, hint: Number.MAX_VALUE, delay: 2_147_483_647 },
  { draw: 0.5, delay: 250, clockShift: -5_000 },
])(
  "honors full jitter and the server retry floor: %j",
  async ({ draw, hint, delay, clockShift }) => {
    vi.spyOn(Math, "random").mockReturnValue(draw);
    const source = retrySource(retryError(hint));
    const { narration } = start(source);
    await vi.advanceTimersByTimeAsync(0);
    if (clockShift) {
      vi.setSystemTime(Date.now() + clockShift);
    }
    await vi.advanceTimersByTimeAsync(delay - 1);
    expect(source.subscribeMessages).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1);
    expect(source.subscribeMessages).toHaveBeenCalledTimes(2);
    narration.disconnect();
  },
);

it.each([false, undefined])("does not retry a rejection with retryable=%s", async (retryable) => {
  const source = sourceWith(
    vi.fn().mockRejectedValue(new RequestError({ code: "FORBIDDEN", retryable })),
  );
  const visibility = browserVisibility();
  const { narration } = start(source);
  await vi.advanceTimersByTimeAsync(0);
  visibility("visible");
  await vi.advanceTimersByTimeAsync(60_000);
  expect(source.subscribeMessages).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
  visibility("hidden");
  visibility("visible");
  expect(source.subscribeMessages).toHaveBeenCalledTimes(2);
  narration.disconnect();
});

it("coalesces an overdue retry with a sync and shares the in-flight attempt", async () => {
  const ready = createDeferred<Handle>();
  const source = retrySource(retryError(), ready.promise);
  const visibility = browserVisibility();
  const { narration } = start(source);
  await vi.advanceTimersByTimeAsync(0);
  vi.setSystemTime(Date.now() + 250);
  visibility("visible");
  visibility("visible");
  await vi.advanceTimersByTimeAsync(1_000);
  expect(source.subscribeMessages).toHaveBeenCalledTimes(2);
  expect(vi.getTimerCount()).toBe(0);
  ready.resolve({ key: "agent:main:run", agentId: null });
  await ready.promise;
  visibility("visible");
  expect(source.subscribeMessages).toHaveBeenCalledTimes(2);
  narration.disconnect();
});

it.each(["rows", "agent", "source", "connection", "hidden", "disabled", "disconnect"])(
  "cancels retry work when %s changes and ignores late failures",
  async (change) => {
    const visibility = browserVisibility();
    const failure = retryError();
    const late = createDeferred<Handle>();
    const source = retrySource(failure, late.promise);
    source.subscribeMessages.mockImplementation(
      async (key: string, options?: { agentId?: string }) => ({
        key,
        agentId: options?.agentId ?? null,
      }),
    );
    const { input, narration } = start(source, [
      runningRow("global"),
      runningRow("agent:main:late"),
    ]);
    await vi.advanceTimersByTimeAsync(0);
    expect(vi.getTimerCount()).toBe(1);
    const changes: Record<string, () => void> = {
      rows: () => narration.sync({ ...input, rows: [] }),
      agent: () => narration.sync({ ...input, agentId: "research", rows: [runningRow("global")] }),
      source: () => narration.sync({ ...input, source: { ...source } }),
      connection: () => narration.sync({ ...input, connected: false }),
      hidden: () => visibility("hidden"),
      disabled: () => narration.sync({ ...input, enabled: false }),
      disconnect: () => narration.disconnect(),
    };
    changes[change]!();
    late.reject(failure);
    await vi.advanceTimersByTimeAsync(0);
    expect(vi.getTimerCount()).toBe(0);
    const attempts = source.subscribeMessages.mock.calls.length;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(source.subscribeMessages).toHaveBeenCalledTimes(attempts);
    narration.disconnect();
  },
);
