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

const { handlerFactory } = vi.hoisted(() => ({
  handlerFactory: vi.fn(),
}));

vi.mock("./approval-handler-runtime.js", async () => {
  const actual = await vi.importActual<typeof import("./approval-handler-runtime.js")>(
    "./approval-handler-runtime.js",
  );
  return {
    ...actual,
    createChannelApprovalHandlerFromCapability: handlerFactory,
  };
});

describe("startChannelApprovalHandlerBootstrap", () => {
  let clock: ReturnType<typeof createGatewaySchedulerClock>;
  let scheduler: ReturnType<typeof createTestGatewayScheduler>;
  let channelRuntime: ReturnType<typeof createRuntimeChannel>;

  beforeEach(() => {
    handlerFactory.mockReset();
    clock = createGatewaySchedulerClock();
    scheduler = createTestGatewayScheduler(clock.clock);
    channelRuntime = createRuntimeChannel();
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
  });

  const approvalPlugin = (
    id: string,
    label: string,
    approvalCapability: Parameters<
      typeof startChannelApprovalHandlerBootstrap
    >[0]["plugin"]["approvalCapability"],
  ) => ({
    id,
    meta: { id, label, selectionLabel: label, docsPath: `/channels/${id}`, blurb: label },
    approvalCapability,
  });

  const makeHandler = () => ({
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
  });

  const loggedFailure = (level: "error" | "warn" = "error") => {
    const logger = createLogger();
    const failed = createDeferred();
    logger[level].mockImplementation(() => failed.resolve());
    return { logger, failed };
  };

  const startTestBootstrap = (logger?: unknown) =>
    startChannelApprovalHandlerBootstrap({
      scheduler,
      plugin: approvalPlugin("slack", "Slack", {
        nativeRuntime: createApprovalNativeRuntimeAdapterStubs(),
      }),
      cfg: {} as never,
      accountId: "default",
      channelRuntime,
      logger: logger as never,
    });

  const registerApprovalContext = (app: unknown = { ok: true }) =>
    channelRuntime.runtimeContexts.register({
      channelId: "slack",
      accountId: "default",
      capability: "approval.native",
      context: { app },
    });

  const startFailingHandler = async (handler: ReturnType<typeof makeHandler>) => {
    const { logger, failed } = loggedFailure();
    handlerFactory.mockResolvedValue(handler);
    const cleanup = await startTestBootstrap(logger);
    const lease = registerApprovalContext();
    await failed.promise;
    return { logger, cleanup, lease };
  };

  it("starts immediately when the runtime context was already registered", async () => {
    const { start, stop } = makeHandler();
    handlerFactory.mockResolvedValue({ start, stop });

    const lease = registerApprovalContext();

    const cleanup = await startTestBootstrap();
    await flushTransitions();

    expect(handlerFactory).toHaveBeenCalledTimes(1);
    expect(start).toHaveBeenCalledTimes(1);

    await cleanup();
    expect(stop).toHaveBeenCalledTimes(1);
    lease.dispose();
  });

  it("bootstraps async-only native delivery to both the origin and approver DM", async () => {
    const actual = await vi.importActual<typeof import("./approval-handler-runtime.js")>(
      "./approval-handler-runtime.js",
    );
    handlerFactory.mockImplementation(actual.createChannelApprovalHandlerFromCapability);
    const subscribed = createDeferred<GatewayApprovalEventSubscriber>();
    const delivered = createDeferred();
    const deliveries: Array<{ to: string; approvalId: string }> = [];
    const unsubscribe = vi.fn();
    const routeCoordinator = createApprovalNativeRouteCoordinator();
    const gatewayRuntime: GatewayNativeApprovalRuntime = {
      getRuntimeConfig: () => ({}),
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
      plugin: approvalPlugin("matrix", "Matrix", {
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
      }),
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
      expect(handlerFactory).toHaveBeenCalledOnce();
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
    handlerFactory.mockReturnValue(new Promise(() => {}));
    registerApprovalContext();

    const cleanup = await startTestBootstrap();
    await cleanup();
  });

  it("does not start a handler after the runtime context is unregistered mid-boot", async () => {
    const { promise: runtimePromise, resolve: resolveRuntime } =
      createDeferred<ReturnType<typeof makeHandler>>();
    handlerFactory.mockReturnValue(runtimePromise);

    const cleanup = await startTestBootstrap();

    const lease = registerApprovalContext();
    await flushTransitions();

    const { start, stop } = makeHandler();

    lease.dispose();
    resolveRuntime?.({ start, stop });
    await flushTransitions();

    expect(start).not.toHaveBeenCalled();
    expect(stop).toHaveBeenCalledTimes(1);

    await cleanup();
  });

  it.each([false, true])("replaces a context with stale retry=%s", async (retryPending) => {
    const first = makeHandler();
    if (retryPending) {
      first.start.mockReset().mockRejectedValueOnce(new Error("boom"));
    }
    const second = makeHandler();
    handlerFactory.mockResolvedValueOnce(first).mockResolvedValueOnce(second);
    if (retryPending) {
      handlerFactory.mockResolvedValueOnce(second);
    }
    const failure = retryPending ? loggedFailure() : undefined;
    const cleanup = await startTestBootstrap(failure?.logger);
    const firstLease = registerApprovalContext({ ok: "first" });
    if (failure) {
      await failure.failed.promise;
      expect(first.start).toHaveBeenCalledTimes(1);
    } else {
      await flushTransitions();
    }
    const secondLease = registerApprovalContext({ ok: "second" });
    await flushTransitions();
    if (retryPending) {
      expect(second.start).toHaveBeenCalledTimes(1);
      await clock.advanceBy(1_000);
      expect(second.stop).not.toHaveBeenCalled();
    } else {
      expect(handlerFactory).toHaveBeenCalledTimes(2);
      expect(first.start).toHaveBeenCalledTimes(1);
    }
    expect(first.stop).toHaveBeenCalledTimes(1);
    expect(second.start).toHaveBeenCalledTimes(1);
    if (!retryPending) {
      secondLease.dispose();
      await flushTransitions();
      expect(second.stop).toHaveBeenCalledTimes(1);
      firstLease.dispose();
    }
    await cleanup();
  });

  it("reports failed cleanup without hiding the original startup error", async () => {
    const logger = createLogger();
    const failed = createDeferred();
    logger.error.mockImplementation((message: string) => {
      if (message === "failed to start native approval handler: Error: startup failed") {
        failed.resolve();
      }
    });
    handlerFactory.mockResolvedValue({
      start: vi.fn().mockRejectedValue(new Error("startup failed")),
      stop: vi.fn().mockRejectedValue(new Error("cleanup failed")),
    });

    const cleanup = await startTestBootstrap(logger);
    const lease = registerApprovalContext();
    try {
      await failed.promise;
      expect(logger.error).toHaveBeenCalledWith(
        "failed to clean up native approval handler: Error: cleanup failed",
      );
      expect(logger.error).toHaveBeenCalledWith(
        "failed to start native approval handler: Error: startup failed",
      );
    } finally {
      await cleanup();
      lease.dispose();
    }
  });

  it.each(["retryable", "terminal"] as const)("handles %s startup failures", async (kind) => {
    const terminal = kind === "terminal";
    const error = terminal
      ? new ExecApprovalChannelRuntimeTerminalStartError({
          code: 1008,
          reason: "pairing required",
          detailCode: "PAIRING_REQUIRED",
        })
      : new Error("gateway event loop readiness timeout");
    const start = terminal
      ? vi.fn().mockRejectedValue(error)
      : vi.fn().mockRejectedValueOnce(error).mockResolvedValueOnce(undefined);
    const handler = { start, stop: makeHandler().stop };
    const { logger, failed } = loggedFailure(terminal ? "error" : "warn");
    if (terminal) {
      handlerFactory.mockResolvedValue(handler);
    } else {
      handlerFactory.mockResolvedValueOnce(handler).mockResolvedValueOnce(handler);
    }
    const cleanup = await startTestBootstrap(logger);
    registerApprovalContext();
    await failed.promise;
    if (!terminal) {
      expect(start).toHaveBeenCalledTimes(1);
      expect(logger.error).not.toHaveBeenCalled();
      expect(logger.warn).toHaveBeenCalledOnce();
      expect(logger.warn).toHaveBeenCalledWith(
        "native approval handler deferred until gateway readiness recovers: gateway readiness unavailable before approval handler start",
      );
    }
    await clock.advanceBy(terminal ? 3_000 : 1_000);
    expect(handlerFactory).toHaveBeenCalledTimes(terminal ? 1 : 2);
    expect(start).toHaveBeenCalledTimes(terminal ? 1 : 2);
    if (terminal) {
      expect(handler.stop).toHaveBeenCalledTimes(1);
      expect(logger.error).toHaveBeenCalledWith(
        `native approval handler disabled: ${String(error)}`,
      );
    }
    await cleanup();
  });

  it.each(["unregister", "cleanup"] as const)("cancels a pending retry on %s", async (action) => {
    const start = vi.fn().mockRejectedValue(new Error("boom"));
    const { stop } = makeHandler();
    const { cleanup, lease } = await startFailingHandler({ start, stop });

    if (action === "unregister") {
      lease.dispose();
    } else {
      await cleanup();
    }
    await clock.advanceBy(1_000);

    expect(handlerFactory).toHaveBeenCalledTimes(1);
    expect(scheduler.nextWakeAtMs).toBeNull();
    await cleanup();
    lease.dispose();
  });

  it("joins an in-flight retry on scheduler shutdown without starting its retired handler", async () => {
    const { logger, failed } = loggedFailure();
    const retryStarted = createDeferred();
    const runtime = createDeferred<ReturnType<typeof makeHandler>>();
    handlerFactory.mockRejectedValueOnce(new Error("boom")).mockImplementationOnce(() => {
      retryStarted.resolve();
      return runtime.promise;
    });

    const cleanup = await startTestBootstrap(logger);
    const lease = registerApprovalContext();
    await failed.promise;
    const retry = clock.advanceBy(1_000);
    await retryStarted.promise;

    let stopped = false;
    const stopping = scheduler.stop().then(() => {
      stopped = true;
    });
    await cleanup();
    expect(stopped).toBe(false);

    const { start, stop } = makeHandler();
    runtime.resolve({ start, stop });
    await Promise.all([retry, stopping]);

    expect(stopped).toBe(true);
    expect(start).not.toHaveBeenCalled();
    expect(stop).toHaveBeenCalledTimes(1);
    expect(scheduler.nextWakeAtMs).toBeNull();
    lease.dispose();
  });
});
