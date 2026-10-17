// Covers gateway-backed approval channel runtime behavior.
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import type { GatewayClient } from "../gateway/client.js";
import { withGatewayNativeApprovalRuntime } from "./approval-gateway-runtime-context.js";
import type { GatewayNativeApprovalRuntime } from "./approval-gateway-runtime.types.js";
import type { ApprovalRequestInput } from "./approval-types.js";
import type { ExecApprovalChannelRuntimeAdapterAsync } from "./exec-approval-channel-runtime.types.js";
import type { ExecApprovalRequest, ExecApprovalResolved } from "./exec-approvals.js";
import type { PluginApprovalRequest, PluginApprovalResolved } from "./plugin-approvals.js";
import type {
  SystemAgentApprovalRequest,
  SystemAgentApprovalResolved,
} from "./system-agent-approvals.js";

const mockGatewayClientStarts = vi.hoisted(() => vi.fn());
const mockGatewayClientStops = vi.hoisted(() => vi.fn());
const mockGatewayClientRequests = vi.hoisted(() =>
  vi.fn<(method: string, params?: Record<string, unknown>) => Promise<unknown>>(async () => ({
    ok: true,
  })),
);
const mockCreateOperatorApprovalsGatewayClient = vi.hoisted(() => vi.fn());
const mockStartGatewayClientWhenEventLoopReady = vi.hoisted(() => vi.fn());
const loggerMocks = vi.hoisted(() => ({ debug: vi.fn(), error: vi.fn() }));

vi.mock("../gateway/operator-approvals-client.js", () => ({
  createOperatorApprovalsGatewayClient: mockCreateOperatorApprovalsGatewayClient,
}));

vi.mock("../../packages/gateway-client/src/readiness.js", () => ({
  startGatewayClientWhenEventLoopReady: mockStartGatewayClientWhenEventLoopReady,
}));

vi.mock("../logging/subsystem.js", () => ({ createSubsystemLogger: () => loggerMocks }));

let createExecApprovalChannelRuntime: typeof import("./exec-approval-channel-runtime.js").createExecApprovalChannelRuntime;
let ExecApprovalChannelRuntimeTerminalStartError: typeof import("./exec-approval-channel-runtime.js").ExecApprovalChannelRuntimeTerminalStartError;

type GatewayEventClientParams = { onEvent?: (evt: { event: string; payload: unknown }) => void };

function lastGatewayEventClientParams(): GatewayEventClientParams | undefined {
  const call = mockCreateOperatorApprovalsGatewayClient.mock.calls[0];
  expect(call, "operator approvals client call").toBeDefined();
  return call?.[0] as GatewayEventClientParams | undefined;
}

function emitPluginApprovalRequested(clientParams = lastGatewayEventClientParams()) {
  clientParams?.onEvent?.({
    event: "plugin.approval.requested",
    payload: createPluginReplayRequest("plugin:abc"),
  });
}

function createExecReplayRequest(id = "abc", command = "echo abc"): ExecApprovalRequest {
  return { id, request: { command }, createdAtMs: 1000, expiresAtMs: 2000 };
}

function createPluginReplayRequest(id = "plugin:abc"): PluginApprovalRequest {
  return {
    id,
    request: { title: "Plugin approval", description: "Let plugin proceed" },
    createdAtMs: 1000,
    expiresAtMs: 2000,
  };
}

function mockReplayLists(params: {
  exec?: ExecApprovalRequest[];
  plugin?: PluginApprovalRequest[];
}) {
  const lists = new Map<string, ApprovalRequestInput[]>([
    ["exec.approval.list", params.exec ?? []],
    ["plugin.approval.list", params.plugin ?? []],
  ]);
  mockGatewayClientRequests.mockImplementation(async (method) => lists.get(method) ?? { ok: true });
}

function expectStartGatewayClientCall() {
  expect(mockStartGatewayClientWhenEventLoopReady).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({ start: expect.any(Function) }),
    { clientOptions: { preauthHandshakeTimeoutMs: undefined } },
  );
}

function expectFinalized(mock: ReturnType<typeof vi.fn>, id: string, decision?: string) {
  expect(mock).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({
      request: expect.objectContaining({ id }),
      entries: [{ id }],
      ...(decision ? { resolved: expect.objectContaining({ id, decision }) } : {}),
    }),
  );
}

function clientWithStart(start: () => void) {
  return { start, stop: mockGatewayClientStops, request: mockGatewayClientRequests };
}

beforeEach(() => {
  mockGatewayClientStarts.mockReset();
  mockGatewayClientStops.mockReset();
  mockGatewayClientRequests.mockReset();
  mockGatewayClientRequests.mockImplementation(async (method: string) =>
    method.endsWith(".approval.list") ? [] : { ok: true },
  );
  mockStartGatewayClientWhenEventLoopReady.mockReset().mockImplementation(async (client) => {
    client.start();
    return { ready: true, elapsedMs: 0, maxDriftMs: 0, checks: 2, aborted: false };
  });
  loggerMocks.debug.mockReset();
  loggerMocks.error.mockReset();
  mockCreateOperatorApprovalsGatewayClient.mockReset().mockImplementation(async (params) =>
    clientWithStart(() => {
      mockGatewayClientStarts();
      queueMicrotask(() => params.onHelloOk?.({ type: "hello-ok" } as never));
    }),
  );
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

beforeAll(async () => {
  ({ createExecApprovalChannelRuntime, ExecApprovalChannelRuntimeTerminalStartError } =
    await import("./exec-approval-channel-runtime.js"));
});

function createRuntime<
  TRequest extends ApprovalRequestInput = ExecApprovalRequest,
  TResolved extends ExecApprovalResolved | PluginApprovalResolved | SystemAgentApprovalResolved =
    ExecApprovalResolved,
>(
  overrides: Partial<
    ExecApprovalChannelRuntimeAdapterAsync<{ id: string }, TRequest, TResolved>
  > = {},
) {
  return createExecApprovalChannelRuntime<{ id: string }, TRequest, TResolved>({
    label: "test/exec-approvals",
    clientDisplayName: "Test Exec Approvals",
    cfg: {},
    isConfigured: () => true,
    shouldHandle: () => true,
    deliverRequested: async () => [],
    finalizeResolved: async () => undefined,
    ...overrides,
  });
}

describe("createExecApprovalChannelRuntime", () => {
  it.each(["decline", "resolve", "stop", "duplicate"] as const)(
    "joins async eligibility before delivery when a request receives %s",
    async (outcome) => {
      const eligibility = createDeferred<boolean>();
      const deliverRequested = vi.fn(async () => []);
      const runtime = createRuntime({ shouldHandle: () => eligibility.promise, deliverRequested });
      const request = createExecReplayRequest("async-eligibility");
      const requested = runtime.handleRequested(request);
      if (outcome === "resolve") {
        await runtime.handleResolved({ id: request.id, decision: "deny", ts: 1 });
      } else if (outcome === "stop") {
        await runtime.stop();
      } else if (outcome === "duplicate") {
        await runtime.handleRequested(request);
      }
      eligibility.resolve(outcome !== "decline");
      await requested;
      expect(deliverRequested).toHaveBeenCalledTimes(outcome === "duplicate" ? 1 : 0);
      await runtime.stop();
    },
  );

  it("does not connect when the adapter is not configured", async () => {
    const runtime = createRuntime({ isConfigured: () => false });

    await runtime.start();

    expect(mockCreateOperatorApprovalsGatewayClient).not.toHaveBeenCalled();
  });

  it("tracks pending requests and only expires the matching approval id", async () => {
    vi.useFakeTimers();
    const finalizedExpired = vi.fn(async () => undefined);
    const finalizedResolved = vi.fn(async () => undefined);
    const runtime = createRuntime({
      nowMs: () => 1000,
      deliverRequested: async (request) => [{ id: request.id }],
      finalizeResolved: finalizedResolved,
      finalizeExpired: finalizedExpired,
    });

    await runtime.handleRequested(createExecReplayRequest("abc"));
    await runtime.handleRequested(createExecReplayRequest("xyz", "echo xyz"));

    await runtime.handleExpired("abc");

    expectFinalized(finalizedExpired, "abc");
    expect(finalizedResolved).not.toHaveBeenCalled();

    await runtime.handleResolved({ id: "xyz", decision: "allow-once", ts: 1500 });

    expectFinalized(finalizedResolved, "xyz", "allow-once");
  });

  it("finalizes approvals that resolve while delivery is still in flight", async () => {
    const pendingDelivery = createDeferred<Array<{ id: string }>>();
    const finalizeResolved = vi.fn(async () => undefined);
    const runtime = createRuntime<PluginApprovalRequest, PluginApprovalResolved>({
      eventKinds: ["plugin"],
      deliverRequested: async () => pendingDelivery.promise,
      finalizeResolved,
    });

    const requestPromise = runtime.handleRequested(createPluginReplayRequest());
    await runtime.handleResolved({ id: "plugin:abc", decision: "allow-once", ts: 1500 });

    pendingDelivery.resolve([{ id: "plugin:abc" }]);
    await requestPromise;

    expectFinalized(finalizeResolved, "plugin:abc", "allow-once");
  });

  it("routes a system-agent expiry event through expiry finalization", async () => {
    const finalizedExpired = vi.fn(async () => undefined);
    const finalizedResolved = vi.fn(async () => undefined);
    const runtime = createRuntime<SystemAgentApprovalRequest, SystemAgentApprovalResolved>({
      eventKinds: ["system-agent"],
      deliverRequested: async () => [{ id: "system-agent:expired" }],
      finalizeResolved: finalizedResolved,
      finalizeExpired: finalizedExpired,
    });

    await runtime.handleRequested({
      ...createExecReplayRequest("system-agent:expired"),
      request: {
        title: "OpenClaw change",
        description: "restart the Gateway",
        command: "restart the Gateway",
        proposalHash: "a".repeat(64),
        allowedDecisions: ["allow-once", "deny"],
        sessionId: "session-1",
      },
    });
    await runtime.handleResolved({
      id: "system-agent:expired",
      decision: "deny",
      resolvedBy: "timeout",
      ts: 2000,
      terminalStatus: "expired",
    });

    expect(finalizedExpired).toHaveBeenCalledOnce();
    expect(finalizedResolved).not.toHaveBeenCalled();
  });

  it("routes gateway requests through the shared client", async () => {
    const runtime = createRuntime();

    await runtime.start();
    await runtime.request("exec.approval.resolve", { id: "abc", decision: "deny" });
    await runtime.request("exec.approval.list", {});

    expect(mockGatewayClientStarts).toHaveBeenCalledTimes(1);
    expectStartGatewayClientCall();
    expect(mockGatewayClientRequests).toHaveBeenCalledWith("exec.approval.resolve", {
      id: "abc",
      decision: "deny",
    });
    expect(mockGatewayClientRequests).toHaveBeenCalledWith("exec.approval.list", {});
  });

  it("subscribes before replay and dedupes live events that overlap the pending list", async () => {
    const replay = createDeferred<ExecApprovalRequest[]>();
    let subscriber:
      | {
          onRequested: (request: ExecApprovalRequest) => void;
          onResolved: (resolved: never) => void;
          shouldHandle: (request: ExecApprovalRequest) => boolean | Promise<boolean>;
        }
      | undefined;
    const unsubscribe = vi.fn();
    const request = vi.fn(async (method: string) => {
      expect(subscriber, "internal subscriber before replay").toBeDefined();
      return method === "exec.approval.list" ? await replay.promise : { ok: true };
    });
    const shouldHandle = vi.fn(() => true);
    const deliverRequested = vi.fn(async (approval: ExecApprovalRequest) => [{ id: approval.id }]);
    const gatewayRuntime: GatewayNativeApprovalRuntime = {
      request: request as GatewayNativeApprovalRuntime["request"],
      requestRoute: vi.fn(),
      routeCoordinator: {} as never,
      subscribe: (nextSubscriber) => {
        subscriber = nextSubscriber as typeof subscriber;
        return unsubscribe;
      },
    };
    const runtime = withGatewayNativeApprovalRuntime(gatewayRuntime, () =>
      createRuntime({ shouldHandle, deliverRequested }),
    );

    await runtime.start();
    const approval = createExecReplayRequest("overlap");
    const liveSubscriber = subscriber;
    if (liveSubscriber && (await liveSubscriber.shouldHandle(approval))) {
      liveSubscriber.onRequested(approval);
    }
    replay.resolve([approval]);
    await vi.waitFor(() => expect(deliverRequested).toHaveBeenCalledTimes(1));
    expect(shouldHandle).toHaveBeenCalledTimes(1);

    await runtime.request("exec.approval.list", {});
    expect(request).toHaveBeenLastCalledWith(
      "exec.approval.list",
      {},
      { clientDisplayName: "Test Exec Approvals" },
    );

    expect(mockCreateOperatorApprovalsGatewayClient).not.toHaveBeenCalled();
    await runtime.stop();
    await runtime.stop();
    expect(unsubscribe).toHaveBeenCalledOnce();
  });

  it("rejects write RPCs before they reach the approvals-only gateway client", async () => {
    const runtime = createRuntime();

    await runtime.start();
    mockGatewayClientRequests.mockClear();

    await expect(
      runtime.request("send", { channel: "slack", to: "channel:C123", message: "hello" }),
    ).rejects.toThrow(
      "test/exec-approvals: operator approvals runtime cannot dispatch send; use a write-capable gateway client",
    );
    expect(mockGatewayClientRequests).not.toHaveBeenCalled();
  });

  it("fails startup when gateway client readiness times out before start", async () => {
    mockStartGatewayClientWhenEventLoopReady.mockResolvedValueOnce({
      ready: false,
      elapsedMs: 30_000,
      maxDriftMs: 1_000,
      checks: 1,
      aborted: false,
    });
    const runtime = createRuntime();

    await expect(runtime.start()).rejects.toThrow(
      "gateway readiness unavailable before exec approval runtime start",
    );

    expect(mockGatewayClientStarts).not.toHaveBeenCalled();
    expect(mockGatewayClientStops).toHaveBeenCalledTimes(1);
    expectStartGatewayClientCall();
  });

  it("waits through retryable connect auth errors until hello succeeds", async () => {
    const authError = Object.assign(new Error("gateway token mismatch"), {
      details: { code: "AUTH_TOKEN_MISMATCH", canRetryWithDeviceToken: true },
    });
    mockCreateOperatorApprovalsGatewayClient.mockImplementationOnce(async (params) =>
      clientWithStart(() => {
        mockGatewayClientStarts();
        params.onConnectError?.(authError);
        queueMicrotask(() => params.onHelloOk?.({ type: "hello-ok" } as never));
      }),
    );
    const runtime = createRuntime();

    await expect(runtime.start()).resolves.toBeUndefined();

    expect(mockGatewayClientStarts).toHaveBeenCalledTimes(1);
    expect(loggerMocks.error).toHaveBeenCalledWith("connect error: gateway token mismatch");
  });

  it("surfaces reconnect pauses as terminal startup errors", async () => {
    const authError = Object.assign(new Error("pairing required"), {
      details: { code: "PAIRING_REQUIRED" },
    });
    mockCreateOperatorApprovalsGatewayClient.mockImplementationOnce(async (params) =>
      clientWithStart(() => {
        mockGatewayClientStarts();
        params.onConnectError?.(authError);
        params.onReconnectPaused?.({
          code: 1008,
          reason: "pairing required",
          detailCode: "PAIRING_REQUIRED",
        });
        params.onClose?.(1008, "pairing required");
      }),
    );
    const runtime = createRuntime();

    const startup = runtime.start();
    await expect(startup).rejects.toBeInstanceOf(ExecApprovalChannelRuntimeTerminalStartError);
    await expect(startup).rejects.toMatchObject({ detailCode: "PAIRING_REQUIRED" });

    expect(mockGatewayClientStarts).toHaveBeenCalledTimes(1);
    expect(mockGatewayClientStops).toHaveBeenCalledTimes(1);
  });

  it("does not leave a gateway client running when stop wins the startup race", async () => {
    const pendingClient = createDeferred<GatewayClient>();
    const clientCreationStarted = createDeferred();
    mockCreateOperatorApprovalsGatewayClient.mockImplementationOnce(() => {
      clientCreationStarted.resolve();
      return pendingClient.promise;
    });
    const runtime = createRuntime();

    const startPromise = runtime.start();
    await clientCreationStarted.promise;
    const stopPromise = runtime.stop();
    pendingClient.resolve(clientWithStart(mockGatewayClientStarts) as unknown as GatewayClient);
    await startPromise;
    await stopPromise;

    expect(mockGatewayClientStarts).not.toHaveBeenCalled();
    expect(mockGatewayClientStops).toHaveBeenCalledTimes(1);
    await expect(runtime.request("exec.approval.resolve", { id: "abc" })).rejects.toThrow(
      "gateway client not connected",
    );
  });

  it("subscribes to plugin approval events when requested", async () => {
    const deliverRequested = vi.fn(async (request) => [{ id: request.id }]);
    const finalizeResolved = vi.fn(async () => undefined);
    const runtime = createRuntime<PluginApprovalRequest, PluginApprovalResolved>({
      eventKinds: ["plugin"],
      deliverRequested,
      finalizeResolved,
    });

    await runtime.start();
    const clientParams = lastGatewayEventClientParams();
    expect(clientParams?.onEvent).toBeTypeOf("function");

    emitPluginApprovalRequested(clientParams);
    await vi.waitFor(() =>
      expect(deliverRequested).toHaveBeenCalledWith(expect.objectContaining({ id: "plugin:abc" })),
    );

    clientParams?.onEvent?.({
      event: "plugin.approval.resolved",
      payload: { id: "plugin:abc", decision: "allow-once", ts: 1500 },
    });
    await vi.waitFor(() => expectFinalized(finalizeResolved, "plugin:abc", "allow-once"));
  });

  it.each(["complete", "in-flight"] as const)(
    "deduplicates live events with %s replay delivery",
    async (phase) => {
      mockReplayLists({ plugin: [createPluginReplayRequest()] });
      const delivery = phase === "in-flight" ? createDeferred<Array<{ id: string }>>() : undefined;
      const deliverRequested = vi.fn(
        async (request: PluginApprovalRequest) => delivery?.promise ?? [{ id: request.id }],
      );
      const runtime = createRuntime<PluginApprovalRequest, PluginApprovalResolved>({
        ...(delivery ? { nowMs: () => 1000 } : {}),
        eventKinds: ["plugin"],
        deliverRequested,
      });
      await runtime.start();
      await vi.waitFor(() => expect(deliverRequested).toHaveBeenCalledTimes(1));
      emitPluginApprovalRequested();
      await Promise.resolve();
      expect(deliverRequested).toHaveBeenCalledTimes(1);
      if (delivery) {
        delivery.resolve([{ id: "plugin:abc" }]);
        await runtime.stop();
      }
    },
  );

  it("does not replay approvals after stop wins once hello is already complete", async () => {
    const replayDeferred = createDeferred<ExecApprovalRequest[]>();
    mockGatewayClientRequests.mockImplementation(async (method: string) => {
      if (method === "exec.approval.list") {
        return replayDeferred.promise;
      }
      return { ok: true };
    });
    const deliverRequested = vi.fn(async (request) => [{ id: request.id }]);
    const runtime = createRuntime({ deliverRequested });

    const startPromise = runtime.start();
    await vi.waitFor(() =>
      expect(mockGatewayClientRequests).toHaveBeenCalledWith("exec.approval.list", {}),
    );

    const stopPromise = runtime.stop();
    replayDeferred.resolve([createExecReplayRequest()]);

    await startPromise;
    await stopPromise;

    expect(deliverRequested).not.toHaveBeenCalled();
    expect(mockGatewayClientStops).toHaveBeenCalled();
    expect(loggerMocks.error).not.toHaveBeenCalled();
  });

  it("waits for in-flight replay delivery before running stopped cleanup", async () => {
    mockReplayLists({ exec: [createExecReplayRequest()] });
    const pendingDelivery = createDeferred<Array<{ id: string }>>();
    const deliverRequested = vi.fn(async () => pendingDelivery.promise);
    const onStopped = vi.fn(async () => undefined);
    const runtime = createRuntime({ nowMs: () => 1000, deliverRequested, onStopped });

    await runtime.start();
    await vi.waitFor(() => expect(deliverRequested).toHaveBeenCalledTimes(1));

    let stopResolved = false;
    const stopPromise = runtime.stop().then(() => {
      stopResolved = true;
    });
    await Promise.resolve();
    expect(stopResolved).toBe(false);
    expect(onStopped).not.toHaveBeenCalled();

    pendingDelivery.resolve([{ id: "abc" }]);
    await stopPromise;

    expect(stopResolved).toBe(true);
    expect(onStopped).toHaveBeenCalledTimes(1);
    expect(loggerMocks.error).not.toHaveBeenCalled();
  });

  it.each([
    { source: "live", message: "error handling approval request: deliver failed" },
    { source: "replay", message: "error replaying pending approvals: deliver failed" },
  ])("logs $source delivery failures without failing startup", async ({ source, message }) => {
    if (source === "replay") {
      mockReplayLists({ exec: [createExecReplayRequest()] });
    }
    const runtime = createRuntime<ExecApprovalRequest | PluginApprovalRequest>({
      eventKinds: source === "live" ? ["plugin"] : ["exec"],
      deliverRequested: async () => {
        throw new Error("deliver failed");
      },
    });
    await expect(runtime.start()).resolves.toBeUndefined();
    if (source === "live") {
      emitPluginApprovalRequested();
    }
    await vi.waitFor(() => expect(loggerMocks.error).toHaveBeenCalledWith(message));
  });
});
