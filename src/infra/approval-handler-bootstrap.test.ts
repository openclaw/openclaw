// Covers channel approval handler bootstrap lifecycle.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { createRuntimeChannel } from "../plugins/runtime/runtime-channel.js";
import {
  createGatewaySchedulerClock,
  createTestGatewayScheduler,
} from "../test-utils/gateway-scheduler-clock.js";
import type {
  GatewayApprovalEventSubscriber,
  GatewayNativeApprovalRuntime,
} from "./approval-gateway-runtime.types.js";
import { createLazyChannelApprovalNativeRuntimeAdapterAsync } from "./approval-handler-adapter-runtime.js";
import { startChannelApprovalHandlerBootstrap } from "./approval-handler-bootstrap.js";
import { createApprovalNativeRuntimeAdapterStubs } from "./approval-handler.test-helpers.js";
import { createApprovalNativeRouteCoordinator } from "./approval-native-route-coordinator.js";
import { ExecApprovalChannelRuntimeTerminalStartError } from "./exec-approval-channel-runtime.js";

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

describe("startChannelApprovalHandlerBootstrap", () => {
  let clock: ReturnType<typeof createGatewaySchedulerClock>;
  let scheduler: ReturnType<typeof createTestGatewayScheduler>;

  beforeEach(() => {
    createChannelApprovalHandlerFromCapability.mockReset();
    clock = createGatewaySchedulerClock();
    scheduler = createTestGatewayScheduler(clock.clock);
  });

  afterEach(async () => {
    await scheduler.stop();
  });

  const flushTransitions = async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  };

  const createLogger = () => ({
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
    child: vi.fn(),
    isEnabled: vi.fn().mockReturnValue(true),
    isVerboseEnabled: vi.fn().mockReturnValue(false),
    verbose: vi.fn(),
  });

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
  }) =>
    startChannelApprovalHandlerBootstrap({
      scheduler,
      plugin: createApprovalPlugin(),
      cfg: {} as never,
      accountId: "default",
      channelRuntime: params.channelRuntime,
      logger: params.logger as never,
    });

  const registerApprovalContext = (
    channelRuntime: ReturnType<typeof createRuntimeChannel>,
    app: unknown = { ok: true },
  ) =>
    channelRuntime.runtimeContexts.register({
      channelId: "slack",
      accountId: "default",
      capability: "approval.native",
      context: { app },
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
    await flushTransitions();

    expect(createChannelApprovalHandlerFromCapability).toHaveBeenCalledTimes(1);
    expect(start).toHaveBeenCalledTimes(1);

    await cleanup();
    expect(stop).toHaveBeenCalledTimes(1);
    lease.dispose();
  });

  it("bootstraps async-only native delivery to both the origin and approver DM", async () => {
    const actual = await vi.importActual<typeof import("./approval-handler-runtime.js")>(
      "./approval-handler-runtime.js",
    );
    createChannelApprovalHandlerFromCapability.mockImplementation(
      actual.createChannelApprovalHandlerFromCapability,
    );
    const channelRuntime = createRuntimeChannel();
    const subscribed = createDeferred<GatewayApprovalEventSubscriber>();
    const delivered = createDeferred();
    const deliveries: Array<{ to: string; approvalId: string }> = [];
    const unsubscribe = vi.fn();
    const routeCoordinator = createApprovalNativeRouteCoordinator();
    const gatewayRuntime: GatewayNativeApprovalRuntime = {
      request: vi.fn().mockResolvedValue([]),
      requestRoute: vi.fn().mockResolvedValue({}),
      routeCoordinator,
      subscribe: (subscriber) => {
        subscribed.resolve(subscriber);
        return unsubscribe;
      },
    };
    const runtime = actual.createChannelApprovalNativeRuntimeAdapter<
      { approvalId: string },
      { to: string },
      { messageId: string }
    >({
      availability: { isConfigured: () => true, shouldHandle: () => true },
      presentation: {
        buildPendingPayload: ({ view }) => ({ approvalId: view.approvalId }),
        buildResolvedResult: () => ({ kind: "leave" }),
        buildExpiredResult: () => ({ kind: "leave" }),
      },
      transport: {
        prepareTarget: ({ plannedTarget }) => ({
          dedupeKey: plannedTarget.target.to,
          target: { to: plannedTarget.target.to },
        }),
        deliverPending: async ({ preparedTarget, pendingPayload }) => {
          deliveries.push({ to: preparedTarget.to, approvalId: pendingPayload.approvalId });
          return { messageId: String(deliveries.length) };
        },
      },
      observe: {
        onDelivered: () => {
          if (deliveries.length === 2) {
            delivered.resolve();
          }
        },
      },
    });
    const cleanup = await startChannelApprovalHandlerBootstrap({
      scheduler,
      plugin: {
        id: "matrix",
        meta: {
          id: "matrix",
          label: "Matrix",
          selectionLabel: "Matrix",
          docsPath: "/channels/matrix",
          blurb: "Matrix",
        },
        approvalCapability: {
          nativeAsync: {
            describeDeliveryCapabilities: async () => ({
              enabled: true,
              preferredSurface: "both",
              supportsOriginSurface: true,
              supportsApproverDmSurface: true,
            }),
            resolveOriginTarget: () => ({ to: "room:!origin:example.org" }),
            resolveApproverDmTargets: () => [{ to: "user:@approver:example.org" }],
          },
          nativeRuntimeAsync: createLazyChannelApprovalNativeRuntimeAdapterAsync({
            capabilityBoundary: true,
            isConfigured: async () => true,
            shouldHandle: async () => true,
            load: async () => runtime,
          }),
        },
      },
      cfg: {},
      accountId: "default",
      channelRuntime,
      gatewayRuntime,
    });
    const lease = channelRuntime.runtimeContexts.register({
      channelId: "matrix",
      accountId: "default",
      capability: "approval.native",
      context: {},
    });
    try {
      await flushTransitions();
      expect(createChannelApprovalHandlerFromCapability).toHaveBeenCalledOnce();
      const subscriber = await subscribed.promise;
      const request = {
        approvalKind: "exec" as const,
        id: "approval-both",
        createdAtMs: Date.now(),
        expiresAtMs: Date.now() + 60_000,
        request: { command: "echo safe", turnSourceChannel: "matrix" },
      };
      expect(await subscriber.shouldHandle(request)).toBe(true);
      subscriber.onRequested(request);
      await delivered.promise;
      expect(deliveries).toEqual([
        { to: "room:!origin:example.org", approvalId: "approval-both" },
        { to: "user:@approver:example.org", approvalId: "approval-both" },
      ]);
    } finally {
      await cleanup();
      lease.dispose();
      routeCoordinator.close();
    }
    expect(unsubscribe).toHaveBeenCalledOnce();
  });

  it("does not block bootstrap return on an existing runtime context", async () => {
    const channelRuntime = createRuntimeChannel();
    createChannelApprovalHandlerFromCapability.mockReturnValue(new Promise(() => {}));
    registerApprovalContext(channelRuntime);

    const cleanup = await startTestBootstrap({ channelRuntime });
    await cleanup();
  });

  it("does not start a handler after the runtime context is unregistered mid-boot", async () => {
    const channelRuntime = createRuntimeChannel();
    const { promise: runtimePromise, resolve: resolveRuntime } = createDeferred<{
      start: ReturnType<typeof vi.fn>;
      stop: ReturnType<typeof vi.fn>;
    }>();
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

  it("defers retryable gateway readiness startup failures without terminal error logs", async () => {
    const channelRuntime = createRuntimeChannel();
    const readinessError = new Error("gateway event loop readiness timeout");
    const start = vi.fn().mockRejectedValueOnce(readinessError).mockResolvedValueOnce(undefined);
    const stop = vi.fn().mockResolvedValue(undefined);
    const logger = createLogger();
    const deferred = createDeferred();
    logger.warn.mockImplementation(() => deferred.resolve());
    createChannelApprovalHandlerFromCapability
      .mockResolvedValueOnce({ start, stop })
      .mockResolvedValueOnce({ start, stop });

    const cleanup = await startTestBootstrap({ channelRuntime, logger });

    registerApprovalContext(channelRuntime);
    await deferred.promise;

    expect(start).toHaveBeenCalledTimes(1);
    expect(logger.error).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledOnce();
    expect(logger.warn).toHaveBeenCalledWith(
      "native approval handler deferred until gateway readiness recovers: gateway readiness unavailable before approval handler start",
    );

    await clock.advanceBy(1_000);

    expect(createChannelApprovalHandlerFromCapability).toHaveBeenCalledTimes(2);
    expect(start).toHaveBeenCalledTimes(2);

    await cleanup();
  });

  it("does not retry terminal native approval startup failures", async () => {
    const channelRuntime = createRuntimeChannel();
    const terminalError = new ExecApprovalChannelRuntimeTerminalStartError({
      code: 1008,
      reason: "pairing required",
      detailCode: "PAIRING_REQUIRED",
    });
    const start = vi.fn().mockRejectedValue(terminalError);
    const stop = vi.fn().mockResolvedValue(undefined);
    const logger = createLogger();
    const failed = createDeferred();
    logger.error.mockImplementation(() => failed.resolve());
    createChannelApprovalHandlerFromCapability.mockResolvedValue({ start, stop });

    const cleanup = await startTestBootstrap({ channelRuntime, logger });

    registerApprovalContext(channelRuntime);
    await failed.promise;
    await clock.advanceBy(3_000);

    expect(createChannelApprovalHandlerFromCapability).toHaveBeenCalledTimes(1);
    expect(start).toHaveBeenCalledTimes(1);
    expect(stop).toHaveBeenCalledTimes(1);
    expect(logger.error).toHaveBeenCalledWith(
      `native approval handler disabled: ${String(terminalError)}`,
    );

    await cleanup();
  });

  it.each(["unregister", "cleanup"] as const)("cancels a pending retry on %s", async (action) => {
    const channelRuntime = createRuntimeChannel();
    const start = vi.fn().mockRejectedValue(new Error("boom"));
    const stop = vi.fn().mockResolvedValue(undefined);
    const logger = createLogger();
    const failed = createDeferred();
    logger.error.mockImplementation(() => failed.resolve());
    createChannelApprovalHandlerFromCapability.mockResolvedValue({ start, stop });

    const cleanup = await startTestBootstrap({ channelRuntime, logger });
    const lease = registerApprovalContext(channelRuntime);
    await failed.promise;

    if (action === "unregister") {
      lease.dispose();
    } else {
      await cleanup();
    }
    await clock.advanceBy(1_000);

    expect(createChannelApprovalHandlerFromCapability).toHaveBeenCalledTimes(1);
    expect(scheduler.nextWakeAtMs).toBeNull();
    await cleanup();
    lease.dispose();
  });

  it("joins an in-flight retry on scheduler shutdown without starting its retired handler", async () => {
    const channelRuntime = createRuntimeChannel();
    const logger = createLogger();
    const failed = createDeferred();
    logger.error.mockImplementation(() => failed.resolve());
    const retryStarted = createDeferred();
    const runtime = createDeferred<{
      start: ReturnType<typeof vi.fn>;
      stop: ReturnType<typeof vi.fn>;
    }>();
    createChannelApprovalHandlerFromCapability
      .mockRejectedValueOnce(new Error("boom"))
      .mockImplementationOnce(() => {
        retryStarted.resolve();
        return runtime.promise;
      });

    const cleanup = await startTestBootstrap({ channelRuntime, logger });
    const lease = registerApprovalContext(channelRuntime);
    await failed.promise;
    const retry = clock.advanceBy(1_000);
    await retryStarted.promise;

    let stopped = false;
    const stopping = scheduler.stop().then(() => {
      stopped = true;
    });
    await cleanup();
    expect(stopped).toBe(false);

    const start = vi.fn().mockResolvedValue(undefined);
    const stop = vi.fn().mockResolvedValue(undefined);
    runtime.resolve({ start, stop });
    await Promise.all([retry, stopping]);

    expect(stopped).toBe(true);
    expect(start).not.toHaveBeenCalled();
    expect(stop).toHaveBeenCalledTimes(1);
    expect(scheduler.nextWakeAtMs).toBeNull();
    lease.dispose();
  });

  it("does not let a stale retry stop a newer active handler", async () => {
    const channelRuntime = createRuntimeChannel();
    const firstStart = vi.fn().mockRejectedValueOnce(new Error("boom"));
    const firstStop = vi.fn().mockResolvedValue(undefined);
    const secondStart = vi.fn().mockResolvedValue(undefined);
    const secondStop = vi.fn().mockResolvedValue(undefined);
    const logger = createLogger();
    const failed = createDeferred();
    logger.error.mockImplementation(() => failed.resolve());
    createChannelApprovalHandlerFromCapability
      .mockResolvedValueOnce({ start: firstStart, stop: firstStop })
      .mockResolvedValueOnce({ start: secondStart, stop: secondStop })
      .mockResolvedValueOnce({ start: secondStart, stop: secondStop });

    const cleanup = await startTestBootstrap({ channelRuntime, logger });

    registerApprovalContext(channelRuntime, { ok: "first" });
    await failed.promise;
    expect(firstStart).toHaveBeenCalledTimes(1);

    registerApprovalContext(channelRuntime, { ok: "second" });
    await flushTransitions();
    expect(secondStart).toHaveBeenCalledTimes(1);

    await clock.advanceBy(1_000);

    expect(firstStop).toHaveBeenCalledTimes(1);
    expect(secondStart).toHaveBeenCalledTimes(1);
    expect(secondStop).not.toHaveBeenCalled();

    await cleanup();
  });
});
