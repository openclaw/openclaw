import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRuntimeChannel } from "../plugins/runtime/runtime-channel.js";
import { startChannelApprovalHandlerBootstrap } from "./approval-handler-bootstrap.js";
import {
  _resetDefaultApprovalHandlerStartCoordinatorForTests,
  createApprovalHandlerStartCoordinator,
  type ApprovalHandlerStartCoordinator,
} from "./approval-handler-start-coordinator.js";
import { createApprovalNativeRuntimeAdapterStubs } from "./approval-handler.test-helpers.js";

const { createChannelApprovalHandlerFromCapability } = vi.hoisted(() => ({
  createChannelApprovalHandlerFromCapability: vi.fn(),
}));

vi.mock("./approval-handler-runtime.js", async () => {
  const actual = await vi.importActual<typeof import("./approval-handler-runtime.js")>(
    "./approval-handler-runtime.js",
  );
  return {
    ...actual,
    createChannelApprovalHandlerFromCapability,
  };
});

// Existing tests rely on synchronous handler start; use an instantly-scheduling
// coordinator unless the test specifically exercises jitter/concurrency.
const createImmediateStartCoordinator = (): ApprovalHandlerStartCoordinator =>
  createApprovalHandlerStartCoordinator({
    jitterMs: 0,
    maxConcurrentStarts: 1_000,
  });

describe("startChannelApprovalHandlerBootstrap", () => {
  beforeEach(() => {
    createChannelApprovalHandlerFromCapability.mockReset();
    vi.useRealTimers();
    _resetDefaultApprovalHandlerStartCoordinatorForTests();
  });

  afterEach(() => {
    _resetDefaultApprovalHandlerStartCoordinatorForTests();
  });

  const flushTransitions = async () => {
    // The bootstrap path chains several awaits (context dispatch, start
    // coordinator jitter + slot acquisition, stopHandler, handler factory,
    // handler.start). Flush generously so tests observe terminal state.
    for (let i = 0; i < 8; i++) {
      await Promise.resolve();
    }
  };

  const createApprovalPlugin = () =>
    ({
      id: "slack",
      meta: { label: "Slack" },
      approvalCapability: {
        nativeRuntime: createApprovalNativeRuntimeAdapterStubs(),
      },
    }) as never;

  const startTestBootstrap = (params: {
    channelRuntime: ReturnType<typeof createRuntimeChannel>;
    logger?: unknown;
    startCoordinator?: ApprovalHandlerStartCoordinator;
    accountId?: string;
  }) =>
    startChannelApprovalHandlerBootstrap({
      plugin: createApprovalPlugin(),
      cfg: {} as never,
      accountId: params.accountId ?? "default",
      channelRuntime: params.channelRuntime,
      logger: params.logger as never,
      startCoordinator: params.startCoordinator ?? createImmediateStartCoordinator(),
    });

  const registerApprovalContext = (
    channelRuntime: ReturnType<typeof createRuntimeChannel>,
    app: unknown = { ok: true },
    accountId: string = "default",
  ) =>
    channelRuntime.runtimeContexts.register({
      channelId: "slack",
      accountId,
      capability: "approval.native",
      context: { app },
    });

  it("starts and stops the shared approval handler from runtime context registration", async () => {
    const channelRuntime = createRuntimeChannel();
    const start = vi.fn().mockResolvedValue(undefined);
    const stop = vi.fn().mockResolvedValue(undefined);
    createChannelApprovalHandlerFromCapability.mockResolvedValue({
      start,
      stop,
    });

    const cleanup = await startTestBootstrap({ channelRuntime });

    const lease = registerApprovalContext(channelRuntime);
    await flushTransitions();

    expect(createChannelApprovalHandlerFromCapability).toHaveBeenCalled();
    expect(start).toHaveBeenCalledTimes(1);

    lease.dispose();
    await flushTransitions();

    expect(stop).toHaveBeenCalledTimes(1);

    await cleanup();
  });

  it("starts immediately when the runtime context was already registered", async () => {
    const channelRuntime = createRuntimeChannel();
    const start = vi.fn().mockResolvedValue(undefined);
    const stop = vi.fn().mockResolvedValue(undefined);
    createChannelApprovalHandlerFromCapability.mockResolvedValue({
      start,
      stop,
    });

    const lease = registerApprovalContext(channelRuntime);

    const cleanup = await startTestBootstrap({ channelRuntime });

    expect(createChannelApprovalHandlerFromCapability).toHaveBeenCalledTimes(1);
    expect(start).toHaveBeenCalledTimes(1);

    await cleanup();
    expect(stop).toHaveBeenCalledTimes(1);
    lease.dispose();
  });

  it("does not start a handler after the runtime context is unregistered mid-boot", async () => {
    const channelRuntime = createRuntimeChannel();
    let resolveRuntime:
      | ((value: { start: ReturnType<typeof vi.fn>; stop: ReturnType<typeof vi.fn> }) => void)
      | undefined;
    const runtimePromise = new Promise<{
      start: ReturnType<typeof vi.fn>;
      stop: ReturnType<typeof vi.fn>;
    }>((resolve) => {
      resolveRuntime = resolve;
    });
    createChannelApprovalHandlerFromCapability.mockReturnValue(runtimePromise);

    const cleanup = await startTestBootstrap({ channelRuntime });

    const lease = registerApprovalContext(channelRuntime);
    await flushTransitions();

    const start = vi.fn().mockResolvedValue(undefined);
    const stop = vi.fn().mockResolvedValue(undefined);

    lease.dispose();
    resolveRuntime?.({ start, stop });
    await flushTransitions();

    expect(start).not.toHaveBeenCalled();
    expect(stop).toHaveBeenCalledTimes(1);

    await cleanup();
  });

  it("restarts the shared approval handler when the runtime context is replaced", async () => {
    const channelRuntime = createRuntimeChannel();
    const startFirst = vi.fn().mockResolvedValue(undefined);
    const stopFirst = vi.fn().mockResolvedValue(undefined);
    const startSecond = vi.fn().mockResolvedValue(undefined);
    const stopSecond = vi.fn().mockResolvedValue(undefined);
    createChannelApprovalHandlerFromCapability
      .mockResolvedValueOnce({
        start: startFirst,
        stop: stopFirst,
      })
      .mockResolvedValueOnce({
        start: startSecond,
        stop: stopSecond,
      });

    const cleanup = await startTestBootstrap({ channelRuntime });

    const firstLease = registerApprovalContext(channelRuntime, { ok: "first" });
    await flushTransitions();

    const secondLease = registerApprovalContext(channelRuntime, { ok: "second" });
    await flushTransitions();

    expect(createChannelApprovalHandlerFromCapability).toHaveBeenCalledTimes(2);
    expect(startFirst).toHaveBeenCalledTimes(1);
    expect(stopFirst).toHaveBeenCalledTimes(1);
    expect(startSecond).toHaveBeenCalledTimes(1);

    secondLease.dispose();
    await flushTransitions();

    expect(stopSecond).toHaveBeenCalledTimes(1);

    firstLease.dispose();
    await cleanup();
  });

  it("retries registered-context startup failures until the handler starts", async () => {
    vi.useFakeTimers();
    const channelRuntime = createRuntimeChannel();
    const start = vi.fn().mockRejectedValueOnce(new Error("boom")).mockResolvedValueOnce(undefined);
    const stop = vi.fn().mockResolvedValue(undefined);
    const logger = {
      error: vi.fn(),
      warn: vi.fn(),
      info: vi.fn(),
      debug: vi.fn(),
      child: vi.fn(),
      isEnabled: vi.fn().mockReturnValue(true),
      isVerboseEnabled: vi.fn().mockReturnValue(false),
      verbose: vi.fn(),
    };
    createChannelApprovalHandlerFromCapability
      .mockResolvedValueOnce({ start, stop })
      .mockResolvedValueOnce({ start, stop });

    const cleanup = await startTestBootstrap({ channelRuntime, logger });

    registerApprovalContext(channelRuntime);
    await flushTransitions();

    expect(start).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1_000);
    await flushTransitions();

    expect(createChannelApprovalHandlerFromCapability).toHaveBeenCalledTimes(2);
    expect(start).toHaveBeenCalledTimes(2);
    expect(stop).toHaveBeenCalledTimes(1);
    expect(logger.error).toHaveBeenCalledWith(
      "failed to start native approval handler: Error: boom",
    );

    await cleanup();
  });

  it("does not let a stale retry stop a newer active handler", async () => {
    vi.useFakeTimers();
    const channelRuntime = createRuntimeChannel();
    const firstStart = vi.fn().mockRejectedValueOnce(new Error("boom"));
    const firstStop = vi.fn().mockResolvedValue(undefined);
    const secondStart = vi.fn().mockResolvedValue(undefined);
    const secondStop = vi.fn().mockResolvedValue(undefined);
    createChannelApprovalHandlerFromCapability
      .mockResolvedValueOnce({ start: firstStart, stop: firstStop })
      .mockResolvedValueOnce({ start: secondStart, stop: secondStop })
      .mockResolvedValueOnce({ start: secondStart, stop: secondStop });

    const cleanup = await startTestBootstrap({ channelRuntime });

    registerApprovalContext(channelRuntime, { ok: "first" });
    await flushTransitions();
    expect(firstStart).toHaveBeenCalledTimes(1);

    registerApprovalContext(channelRuntime, { ok: "second" });
    await flushTransitions();
    expect(secondStart).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1_000);
    await flushTransitions();

    expect(firstStop).toHaveBeenCalledTimes(1);
    expect(secondStart).toHaveBeenCalledTimes(1);
    expect(secondStop).not.toHaveBeenCalled();

    await cleanup();
  });

  it("delays the first handler start by the configured jitter interval", async () => {
    vi.useFakeTimers();
    const channelRuntime = createRuntimeChannel();
    const start = vi.fn().mockResolvedValue(undefined);
    const stop = vi.fn().mockResolvedValue(undefined);
    createChannelApprovalHandlerFromCapability.mockResolvedValue({ start, stop });

    const startCoordinator = createApprovalHandlerStartCoordinator({
      jitterMs: 500,
      maxConcurrentStarts: 1_000,
      random: () => 0.5,
    });

    const cleanup = await startTestBootstrap({ channelRuntime, startCoordinator });

    registerApprovalContext(channelRuntime);
    await flushTransitions();

    expect(createChannelApprovalHandlerFromCapability).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(249);
    await flushTransitions();
    expect(createChannelApprovalHandlerFromCapability).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    await flushTransitions();
    expect(createChannelApprovalHandlerFromCapability).toHaveBeenCalledTimes(1);
    expect(start).toHaveBeenCalledTimes(1);

    await cleanup();
  });

  it("does not start a handler if the context is unregistered during the jitter wait", async () => {
    vi.useFakeTimers();
    const channelRuntime = createRuntimeChannel();
    const start = vi.fn().mockResolvedValue(undefined);
    const stop = vi.fn().mockResolvedValue(undefined);
    createChannelApprovalHandlerFromCapability.mockResolvedValue({ start, stop });

    const startCoordinator = createApprovalHandlerStartCoordinator({
      jitterMs: 1_000,
      maxConcurrentStarts: 1_000,
      random: () => 0.9,
    });

    const cleanup = await startTestBootstrap({ channelRuntime, startCoordinator });

    const lease = registerApprovalContext(channelRuntime);
    await flushTransitions();
    expect(createChannelApprovalHandlerFromCapability).not.toHaveBeenCalled();

    lease.dispose();
    await flushTransitions();

    await vi.advanceTimersByTimeAsync(2_000);
    await flushTransitions();

    expect(createChannelApprovalHandlerFromCapability).not.toHaveBeenCalled();
    expect(start).not.toHaveBeenCalled();
    expect(stop).not.toHaveBeenCalled();

    await cleanup();
  });

  it("caps concurrent handler starts to the coordinator limit and serves queued bootstraps as slots free", async () => {
    const channelRuntime = createRuntimeChannel();
    const firstResolver: { resolve?: () => void } = {};
    const secondResolver: { resolve?: () => void } = {};

    const firstStart = vi.fn().mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          firstResolver.resolve = resolve;
        }),
    );
    const firstStop = vi.fn().mockResolvedValue(undefined);
    const secondStart = vi.fn().mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          secondResolver.resolve = resolve;
        }),
    );
    const secondStop = vi.fn().mockResolvedValue(undefined);
    const thirdStart = vi.fn().mockResolvedValue(undefined);
    const thirdStop = vi.fn().mockResolvedValue(undefined);

    createChannelApprovalHandlerFromCapability
      .mockResolvedValueOnce({ start: firstStart, stop: firstStop })
      .mockResolvedValueOnce({ start: secondStart, stop: secondStop })
      .mockResolvedValueOnce({ start: thirdStart, stop: thirdStop });

    const startCoordinator = createApprovalHandlerStartCoordinator({
      jitterMs: 0,
      maxConcurrentStarts: 1,
    });

    const firstCleanup = await startTestBootstrap({
      channelRuntime,
      startCoordinator,
      accountId: "alpha",
    });
    const secondCleanup = await startTestBootstrap({
      channelRuntime,
      startCoordinator,
      accountId: "beta",
    });
    const thirdCleanup = await startTestBootstrap({
      channelRuntime,
      startCoordinator,
      accountId: "gamma",
    });

    registerApprovalContext(channelRuntime, { ok: "alpha" }, "alpha");
    registerApprovalContext(channelRuntime, { ok: "beta" }, "beta");
    registerApprovalContext(channelRuntime, { ok: "gamma" }, "gamma");

    await flushTransitions();
    await flushTransitions();

    expect(createChannelApprovalHandlerFromCapability).toHaveBeenCalledTimes(1);
    expect(firstStart).toHaveBeenCalledTimes(1);
    expect(secondStart).not.toHaveBeenCalled();
    expect(thirdStart).not.toHaveBeenCalled();

    firstResolver.resolve?.();
    await flushTransitions();
    await flushTransitions();

    expect(createChannelApprovalHandlerFromCapability).toHaveBeenCalledTimes(2);
    expect(secondStart).toHaveBeenCalledTimes(1);
    expect(thirdStart).not.toHaveBeenCalled();

    secondResolver.resolve?.();
    await flushTransitions();
    await flushTransitions();

    expect(createChannelApprovalHandlerFromCapability).toHaveBeenCalledTimes(3);
    expect(thirdStart).toHaveBeenCalledTimes(1);

    await firstCleanup();
    await secondCleanup();
    await thirdCleanup();
  });

  it("releases a concurrency slot after a handler start failure", async () => {
    const channelRuntime = createRuntimeChannel();
    const firstStart = vi.fn().mockRejectedValue(new Error("boom"));
    const firstStop = vi.fn().mockResolvedValue(undefined);
    const secondStart = vi.fn().mockResolvedValue(undefined);
    const secondStop = vi.fn().mockResolvedValue(undefined);

    createChannelApprovalHandlerFromCapability
      .mockResolvedValueOnce({ start: firstStart, stop: firstStop })
      .mockResolvedValueOnce({ start: secondStart, stop: secondStop });

    const startCoordinator = createApprovalHandlerStartCoordinator({
      jitterMs: 0,
      maxConcurrentStarts: 1,
    });

    const firstCleanup = await startTestBootstrap({
      channelRuntime,
      startCoordinator,
      accountId: "alpha",
      logger: {
        error: vi.fn(),
        warn: vi.fn(),
        info: vi.fn(),
        debug: vi.fn(),
        child: vi.fn(),
        isEnabled: vi.fn().mockReturnValue(true),
        isVerboseEnabled: vi.fn().mockReturnValue(false),
        verbose: vi.fn(),
      },
    });
    const secondCleanup = await startTestBootstrap({
      channelRuntime,
      startCoordinator,
      accountId: "beta",
    });

    registerApprovalContext(channelRuntime, { ok: "alpha" }, "alpha");
    registerApprovalContext(channelRuntime, { ok: "beta" }, "beta");

    await flushTransitions();
    await flushTransitions();
    await flushTransitions();

    expect(firstStart).toHaveBeenCalledTimes(1);
    expect(secondStart).toHaveBeenCalledTimes(1);

    await firstCleanup();
    await secondCleanup();
  });

  it("stops the previous handler before the replacement start waits on jitter or a queued slot", async () => {
    vi.useFakeTimers();
    const channelRuntime = createRuntimeChannel();
    const startFirst = vi.fn().mockResolvedValue(undefined);
    const stopFirst = vi.fn().mockResolvedValue(undefined);
    const startSecond = vi.fn().mockResolvedValue(undefined);
    const stopSecond = vi.fn().mockResolvedValue(undefined);
    createChannelApprovalHandlerFromCapability
      .mockResolvedValueOnce({ start: startFirst, stop: stopFirst })
      .mockResolvedValueOnce({ start: startSecond, stop: stopSecond });

    const startCoordinator = createApprovalHandlerStartCoordinator({
      jitterMs: 5_000,
      maxConcurrentStarts: 1_000,
      random: () => 0.5,
    });

    const cleanup = await startTestBootstrap({ channelRuntime, startCoordinator });

    registerApprovalContext(channelRuntime, { ok: "first" });
    await vi.advanceTimersByTimeAsync(5_000);
    await flushTransitions();
    expect(startFirst).toHaveBeenCalledTimes(1);
    expect(stopFirst).not.toHaveBeenCalled();

    // Replacement: the new `registered` event fires while jitter is long.
    registerApprovalContext(channelRuntime, { ok: "second" });
    await flushTransitions();

    // The previous handler must be stopped ASAP -- NOT after jitter elapses.
    // Without this guarantee the stale handler would keep processing with
    // outdated context for up to jitterMs + queue delay.
    expect(stopFirst).toHaveBeenCalledTimes(1);
    expect(startSecond).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(5_000);
    await flushTransitions();
    expect(startSecond).toHaveBeenCalledTimes(1);

    await cleanup();
  });
});
