import { beforeEach, expect, it, vi } from "vitest";
import type { GatewayCloseParams } from "./server-close.test-support.js";

const { mocks } = await vi.hoisted(() => import("./server-close.mocks.test-support.js"));

let enqueueSwarmRun: typeof import("../agents/subagents/swarm/swarm-scheduler.lifecycle.test-support.js").enqueueSwarmRun;
let PluginRuntimeCloseRetainedError: typeof import("../plugins/runtime-close-error.js").PluginRuntimeCloseRetainedError;
type GatewayCloseHandler = ReturnType<
  ReturnType<typeof import("./server-close.test-support.js").createGatewayCloseTestHandlerFactory>
>;
let createGatewayCloseHandler: (overrides?: Partial<GatewayCloseParams>) => GatewayCloseHandler;

beforeEach(async () => {
  vi.resetModules();
  vi.clearAllMocks();
  ({ enqueueSwarmRun } =
    await import("../agents/subagents/swarm/swarm-scheduler.lifecycle.test-support.js"));
  ({ PluginRuntimeCloseRetainedError } = await import("../plugins/runtime-close-error.js"));
  const { createGatewayCloseTestDepsFactory, createGatewayCloseTestHandlerFactory } =
    await import("./server-close.test-support.js");
  const closeGateway = createGatewayCloseTestHandlerFactory(await import("./server-close.js"));
  const createDeps = createGatewayCloseTestDepsFactory(mocks);
  createGatewayCloseHandler = (overrides = {}) => closeGateway(createDeps(overrides));
});

it.each([
  { ownership: "owned", retained: false },
  { ownership: "unowned", retained: false },
  { ownership: "owned", retained: true },
  { ownership: "unowned", retained: true },
] as const)(
  "reports $ownership queued cleanup failure and honors retained resources ($retained)",
  async ({ ownership, retained }) => {
    const resolveGatewayContext = () => undefined;
    const cleanupError = new Error("queued engine disposal failed");
    const failure = retained ? new PluginRuntimeCloseRetainedError(cleanupError) : cleanupError;
    const onRemoved = vi.fn(() => Promise.reject(failure));
    enqueueSwarmRun({
      groupId: `failed-queued-cleanup-${ownership}`,
      runId: `failed-queued-${ownership}`,
      maxConcurrent: 1,
      activeRunIds: [`failed-queued-blocker-${ownership}`],
      lifecycleOwner: ownership === "owned" ? resolveGatewayContext : undefined,
      start: async () => {},
      onStartFailure: () => true,
      onRemoved,
    });
    const retireRegistry = vi.fn(async () => ({ cleanupCount: 0, failures: [] }));
    const closeSdkResources = vi.fn(async () => {});
    const clearSecretsRuntimeSnapshot = vi.fn();
    const close = createGatewayCloseHandler({
      resolveGatewayContext,
      closeSdkResources,
      clearSecretsRuntimeSnapshot,
      closePluginRegistry: async (onRetirement) => {
        await onRetirement?.(retireRegistry);
        return { memoryErrors: [], pluginFailures: [] };
      },
    });
    await expect(close()).rejects.toMatchObject({ errors: [failure] });
    expect(onRemoved).toHaveBeenCalledExactlyOnceWith("shutdown");
    expect(closeSdkResources).toHaveBeenCalledTimes(ownership === "owned" && retained ? 0 : 1);
    expect(retireRegistry).toHaveBeenCalledTimes(retained ? 0 : 1);
    expect(clearSecretsRuntimeSnapshot).toHaveBeenCalledTimes(retained ? 0 : 1);
  },
);
