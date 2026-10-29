import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { registerSessionResourceCleanup } from "../../packages/ai/src/session-resources.js";
import { createDeferredCore } from "../shared/deferred.js";
import {
  createGatewaySchedulerClock,
  createTestGatewayScheduler,
} from "../test-utils/gateway-scheduler-clock.js";
import {
  closeCliResources,
  getPendingCliDisposers,
  runCliDisposer,
  waitForPendingCliDisposers,
} from "./runtime-cleanup.js";

const memoryClosed = vi.hoisted(() => vi.fn(async () => {}));
const databasesClosed = vi.hoisted(() => vi.fn(async () => {}));
const skillsClosed = vi.hoisted(() => vi.fn(async () => {}));
vi.mock("../state/openclaw-agent-db-resources.js", () => ({
  hasOpenClawAgentDatabaseAsyncResources: () => true,
}));
vi.mock("../state/openclaw-agent-db-lifecycle.js", () => ({
  closeOpenClawAgentDatabasesAsync: databasesClosed,
}));
vi.mock("../agents/harness/registry.js", () => ({
  listRegisteredAgentHarnesses: () => [],
  disposeRegisteredAgentHarnesses: async () => {},
}));
vi.mock("../plugins/registry-lifecycle.js", () => ({ markPluginRegistryRetired() {} }));
vi.mock("../agents/provider-runtime-lifecycle.js", () => ({
  stopActiveManagedProviderLocalServices: async () => {},
  hasProviderTransportDispatcherPool: () => false,
}));
vi.mock("../gateway/mcp-http.loopback-runtime.js", () => ({
  getActiveMcpLoopbackRuntime: () => undefined,
}));
vi.mock("../plugins/memory-state.js", () => ({ hasMemoryRuntime: () => true }));
vi.mock("../plugins/memory-runtime.js", () => ({
  closeActiveMemorySearchManagersCore: memoryClosed,
}));

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

it.each([false, true])(
  "reports a failed disposer without preventing later cleanup (after deadline: %s)",
  async (afterDeadline) => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const pending = createDeferredCore();
    const next = vi.fn(async () => {});
    const cleanup = runCliDisposer("failed-resource", async () => {
      await pending.promise;
      throw new Error("resource close failed");
    });
    if (afterDeadline) {
      await vi.advanceTimersByTimeAsync(5_000);
      await expect(cleanup).resolves.toBeUndefined();
    }
    pending.resolve();
    await cleanup;
    await waitForPendingCliDisposers();
    await runCliDisposer("next-resource", next);
    expect(console.error).toHaveBeenCalledWith(
      "CLI cleanup failed: failed-resource: resource close failed",
    );
    expect(next).toHaveBeenCalledOnce();
  },
);

function expectResourcesClosed(count: number) {
  for (const close of [skillsClosed, memoryClosed, databasesClosed]) {
    expect(close).toHaveBeenCalledTimes(count);
  }
}

it("joins stalled scheduled work before closing resources", async () => {
  const clock = createGatewaySchedulerClock();
  const scheduler = createTestGatewayScheduler(clock.clock);
  const entered = createDeferredCore();
  const release = createDeferredCore();
  const dispose = async () => {
    entered.resolve();
    await release.promise;
    expectResourcesClosed(0);
  };
  const stderr = vi.spyOn(console, "error").mockImplementation(() => {});
  scheduler.schedule({ id: "cli-work", atMs: 0, everyMs: 1_000, run: dispose });
  const running = clock.advanceBy(0);
  await entered.promise;
  const closing = closeCliResources({
    scheduler,
    harnesses: new Map(),
    registries: new Set(),
    closeSkillsWatchers: skillsClosed,
  });
  try {
    expect(scheduler).toMatchObject({ signal: { aborted: true }, nextWakeAtMs: null });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining("scheduled-work"));
    expectResourcesClosed(0);
    release.resolve();
    await Promise.all([running, closing]);
    expectResourcesClosed(1);
  } finally {
    release.resolve();
    await Promise.all([running, closing, scheduler.stop()]);
    await vi.advanceTimersByTimeAsync(0);
  }
  expect(getPendingCliDisposers()).toEqual([]);
});

it("retires provider session resources after a one-shot command", async () => {
  const expired = vi.fn();
  const retainedSocketTimer = setTimeout(expired, 60_000);
  const unregister = registerSessionResourceCleanup(() => clearTimeout(retainedSocketTimer));
  try {
    await closeCliResources();
    expect(skillsClosed).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(expired).not.toHaveBeenCalled();
  } finally {
    unregister();
    clearTimeout(retainedSocketTimer);
  }
});
