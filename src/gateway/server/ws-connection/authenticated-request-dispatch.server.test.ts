import { EventEmitter, once } from "node:events";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import {
  GATEWAY_CLIENT_IDS,
  GATEWAY_CLIENT_MODES,
} from "../../../../packages/gateway-protocol/src/client-info.js";
import { createOperationalRunInstanceRef } from "../../../agents/admitted-run-context.js";
import {
  createDiagnosticTraceContext,
  getActiveDiagnosticTraceContext,
  runWithDiagnosticTraceContext,
  type DiagnosticTraceContext,
} from "../../../infra/diagnostic-trace-context.js";
import { createEmptyPluginRegistry } from "../../../plugins/registry-empty.js";
import {
  getActiveGatewayRootWorkCount,
  tryBeginGatewayRootWorkAdmission,
} from "../../../process/gateway-work-admission.js";
import { createDeferredCore, type Deferred } from "../../../shared/deferred.js";
import { acquireTestPortBlock } from "../../../test-utils/port-claims.js";
import type { AgentRuntimeIdentity } from "../../agent-runtime-identity-token.js";
import { createPluginGatewayMethodDescriptor } from "../../methods/descriptor.js";
import {
  connectOk,
  installGatewayTestHooks,
  onceMessage,
  startTestGatewayServer,
  trackConnectChallengeNonce,
} from "../../test-helpers.js";
import {
  resetTestPluginRegistry,
  setTestPluginRegistry,
} from "../../test-helpers.plugin-registry.js";
import type { GatewayWsClient } from "../ws-types.js";
import { createRequestGate } from "./authenticated-request-dispatch.fixtures.test-support.js";
import {
  createDispatchTestHarness,
  createOperatorWsClient,
  requestFrame,
} from "./authenticated-request-dispatch.test-support.js";
import type { GatewayWsMessageHandlerParams } from "./message-handler-types.js";

const TRACEPARENTS = {
  first: "00-11111111111111111111111111111111-1111111111111111-01",
  second: "00-22222222222222222222222222222222-2222222222222222-00",
} as const;
const CLIENTS = {
  ui: { id: GATEWAY_CLIENT_IDS.CONTROL_UI, mode: GATEWAY_CLIENT_MODES.UI },
  cli: { id: GATEWAY_CLIENT_IDS.CLI, mode: GATEWAY_CLIENT_MODES.CLI },
};
type TraceObservation = {
  before: DiagnosticTraceContext | undefined;
  after?: DiagnosticTraceContext;
};
type Handler = NonNullable<GatewayWsMessageHandlerParams["extraHandlers"][string]>;
const traceRequest = (id: string, traceparent?: string, method = "test.trace") => ({
  ...requestFrame(id, method),
  ...(traceparent ? { traceparent } : {}),
});

installGatewayTestHooks({ scope: "suite" });

function createClient(): GatewayWsClient {
  return createOperatorWsClient({ connId: "conn-trace-test" });
}

function createTestAgentRuntimeIdentity(runId: string): AgentRuntimeIdentity {
  const operationalRunInstance = createOperationalRunInstanceRef(runId);
  return {
    kind: "agentRuntime",
    agentId: "main",
    sessionKey: "agent:main:test",
    operationalRunInstance,
    delegatedAuthority: {
      kind: "local",
      operationalRunInstance,
      lifecycleGeneration: `generation-${runId}`,
      claimId: `claim-${runId}`,
    },
  };
}

function createDispatcher(handler: Handler, context: Record<string, unknown> = {}) {
  return createDispatchTestHarness({
    connId: "conn-trace-test",
    extraHandlers: { "test.trace": handler },
    buildRequestContext: () => ({ getRuntimeConfig: () => ({}), ...context }),
  });
}

function createAuthorityScenario(change: string, handler: Handler, queued = false) {
  let generation = "current";
  let runtimeActive = true;
  const client = createClient();
  if (change === "shared-auth") {
    client.usesSharedGatewayAuth = true;
    client.sharedGatewaySessionGeneration = generation;
  } else if (change === "runtime") {
    client.internal = { agentRuntimeIdentity: createTestAgentRuntimeIdentity("pending-start") };
  }
  return {
    client,
    harness: createDispatchTestHarness({
      extraHandlers: { "test.trace": handler },
      getRequiredSharedGatewaySessionGeneration: () => generation,
      buildRequestContext: queued
        ? () => ({
            getRuntimeConfig: () => ({}),
            validateAgentRuntimeApprovalAuthority: () => runtimeActive,
          })
        : undefined,
    }),
    revoke(this: void) {
      if (change === "shared-auth") {
        generation = "rotated";
      } else if (change === "runtime") {
        runtimeActive = false;
      } else {
        Object.assign(client, { invalidated: true, invalidatedReason: "device-token-revoked" });
      }
    },
  };
}

function expectAuthorityClosed(
  harness: ReturnType<typeof createDispatchTestHarness>,
  id: string,
  reason: string,
) {
  expect(harness.close).toHaveBeenCalledWith(4001, reason);
  expect(harness.send).not.toHaveBeenCalledWith(expect.objectContaining({ id, ok: true }));
}

async function dispatchInFreshMessageScope(
  dispatcher: ReturnType<typeof createDispatcher>["dispatcher"],
  client: GatewayWsClient,
  id: string,
  traceparent?: string,
): Promise<void> {
  await runWithDiagnosticTraceContext(createDiagnosticTraceContext(), () =>
    dispatcher.dispatch(traceRequest(id, traceparent), client),
  );
}

async function warmDispatcher(
  harness: ReturnType<typeof createDispatchTestHarness>,
  client: GatewayWsClient,
): Promise<void> {
  await harness.dispatcher.dispatch(traceRequest("warmup"), client);
  await harness.awaitResponseFrame("warmup");
}

async function openAuthenticatedTraceSocket(port: number, token: string, traceparent: string) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  trackConnectChallengeNonce(ws);
  await once(ws, "open");
  try {
    await connectOk(ws, { token, traceparent });
    return ws;
  } catch (error) {
    ws.terminate();
    throw error;
  }
}

async function sendTraceRequest(
  ws: WebSocket,
  id: string,
  traceparent?: string,
  method = "test.trace",
): Promise<{ ok: boolean; error?: unknown }> {
  const response = onceMessage<{ type: "res"; id: string; ok: boolean; error?: unknown }>(
    ws,
    (value) => value.type === "res" && value.id === id,
  );
  ws.send(JSON.stringify(traceRequest(id, traceparent, method)));
  return await response;
}

async function startTraceServer(method: string, handler: Handler) {
  const registry = createEmptyPluginRegistry();
  registry.gatewayHandlers[method] = handler;
  registry.gatewayMethodDescriptors.push(
    createPluginGatewayMethodDescriptor({
      pluginId: "request-dispatch-proof",
      name: method,
      handler,
    }),
  );
  setTestPluginRegistry(registry);
  const token = "gateway-request-trace-test-token";
  const portClaim = await acquireTestPortBlock({ offsets: [0, 1, 2, 3, 4] });
  const server = await startTestGatewayServer(portClaim, {
    auth: { mode: "token", token },
    bind: "loopback",
    controlUiEnabled: false,
  });
  return {
    server,
    connect: (connectTraceparent: string) =>
      openAuthenticatedTraceSocket(portClaim.port, token, connectTraceparent),
  };
}

describe("authenticated WebSocket request trace dispatch", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it.each(["before dispatch", "before response"] as const)(
    "rejects delegated authority revoked %s",
    async (stage) => {
      let authorityActive = stage === "before response";
      const gate = createRequestGate();
      const handler = vi.fn(async ({ respond }) => {
        await gate.wait();
        respond(true, { exposed: true }, undefined);
      });
      const validateAgentRuntimeApprovalAuthority = vi.fn(() => authorityActive);
      const harness = createDispatcher(handler, { validateAgentRuntimeApprovalAuthority });
      const client = createClient();
      const agentRuntimeIdentity = createTestAgentRuntimeIdentity(stage);
      client.internal = { agentRuntimeIdentity };
      const dispatch = dispatchInFreshMessageScope(harness.dispatcher, client, stage);
      try {
        if (stage === "before response") {
          await gate.entered;
          expect(handler).toHaveBeenCalledOnce();
          authorityActive = false;
        }
      } finally {
        gate.release();
        await dispatch;
      }

      const failure = {
        id: stage,
        ok: false,
        error: expect.objectContaining({
          message: "agent runtime authority is no longer active",
        }),
      };
      expect(await harness.awaitResponseFrame(stage)).toMatchObject(failure);
      expect(harness.send).toHaveBeenCalledWith(expect.objectContaining(failure));
      expectAuthorityClosed(harness, stage, "agent runtime authority closed");
      if (stage === "before dispatch") {
        expect(validateAgentRuntimeApprovalAuthority).toHaveBeenCalledWith(agentRuntimeIdentity);
        expect(handler).not.toHaveBeenCalled();
        expect(harness.setCloseCause).toHaveBeenCalledWith("agent-runtime-authority-closed", {
          method: "test.trace",
        });
      }
    },
  );

  it.each([
    { change: "shared-auth", closeReason: "gateway auth changed" },
    { change: "invalidated", closeReason: "client invalidated: device-token-revoked" },
    { change: "runtime", closeReason: "agent runtime authority closed" },
  ] as const)("revalidates $change authority after waiting to start", async (testCase) => {
    let pendingStarted = false;
    const { client, harness, revoke } = createAuthorityScenario(
      testCase.change,
      ({ req, respond }) => {
        pendingStarted ||= req.id === "pending";
        respond(true, { completed: req.id });
      },
      true,
    );
    await warmDispatcher(harness, client);
    const dispatch = harness.dispatcher.dispatch(traceRequest("pending"), client);
    expect(pendingStarted).toBe(false);
    revoke();
    await dispatch;
    expect(pendingStarted).toBe(false);
    expectAuthorityClosed(harness, "pending", testCase.closeReason);
  });

  it.each([
    { change: "shared-auth", closeReason: "gateway auth changed" },
    { change: "invalidated", closeReason: "client invalidated: device-token-revoked" },
  ] as const)("exposes live $change authority to an active handler", async (testCase) => {
    let observedAuthority: boolean | undefined;
    const gate = createRequestGate();
    const handler: Handler = async ({ hasCurrentClientAuthority }) => {
      await gate.wait();
      observedAuthority = hasCurrentClientAuthority?.();
    };
    const { client, harness, revoke } = createAuthorityScenario(testCase.change, handler);
    const dispatch = harness.dispatcher.dispatch(traceRequest("active"), client);
    await gate.during(dispatch, revoke);
    expect(observedAuthority).toBe(false);
    expectAuthorityClosed(harness, "active", testCase.closeReason);
  });

  it.each([
    ["ordinary UI node invocation", "node.invoke", CLIENTS.ui, false],
    ["CLI node invocation", "node.invoke", CLIENTS.cli, true],
    ["session companion ask", "sessions.companion.ask", CLIENTS.ui, true],
  ] as const)(
    "preserves pending %s disconnect policy",
    async (_label, method, clientInfo, cancel) => {
      const socket = new EventEmitter();
      let disconnected = false;
      let pendingStarted = false;
      let pendingSignal: AbortSignal | undefined;
      const handler: Handler = ({ req, respond, signal }) => {
        if (req.id === "pending") {
          pendingStarted = true;
          pendingSignal = signal;
        }
        respond(true, { completed: req.id });
      };
      const client = createOperatorWsClient({ socket, clientInfo });
      const harness = createDispatchTestHarness({
        isClosed: () => disconnected,
        extraHandlers: { "test.trace": handler, [method]: handler },
      });
      await warmDispatcher(harness, client);
      const dispatch = harness.dispatcher.dispatch(
        traceRequest("pending", undefined, method),
        client,
      );
      expect(pendingStarted).toBe(false);
      disconnected = true;
      socket.emit("close", 1000, Buffer.alloc(0));

      await dispatch;
      expect(pendingStarted).toBe(!cancel);
      if (!cancel) {
        expect(await harness.awaitResponseFrame("pending")).toMatchObject({ ok: true });
        expect(pendingSignal).toBeUndefined();
      } else {
        expect(harness.send).not.toHaveBeenCalledWith(expect.objectContaining({ id: "pending" }));
      }
      expect(socket.listenerCount("close")).toBe(0);
    },
  );

  it("gives concurrent requests their own root admission", async () => {
    const gate = createRequestGate();
    const bothObserved = createDeferredCore();
    let entered = 0;
    const { dispatcher } = createDispatcher(async () => {
      if (++entered === 2) {
        bothObserved.resolve();
      }
      await gate.wait();
    });
    const client = createClient();

    const parent = tryBeginGatewayRootWorkAdmission();
    if (!parent) {
      throw new Error("expected open parent work admission");
    }
    const dispatches = parent.run(() =>
      Promise.all(["first", "second"].map((id) => dispatcher.dispatch(traceRequest(id), client))),
    );
    try {
      await bothObserved.promise;
      // Pending starts cannot borrow the caller's parent admission.
      expect(getActiveGatewayRootWorkCount()).toBe(3);
    } finally {
      gate.release();
      parent.release();
      await dispatches;
    }
  });

  it("preserves request isolation through a real authenticated WebSocket session", async () => {
    const observed = new Map<string, TraceObservation>();
    const bothConcurrentObserved = createDeferredCore();
    let requestBarrier: Deferred | undefined;
    const { server, connect } = await startTraceServer("test.trace", async ({ req, respond }) => {
      const observation: TraceObservation = { before: getActiveDiagnosticTraceContext() };
      observed.set(req.id, observation);
      if (observed.has("concurrent-first") && observed.has("concurrent-second")) {
        bothConcurrentObserved.resolve();
      }
      await requestBarrier?.promise;
      observation.after = getActiveDiagnosticTraceContext();
      respond(true, { traced: true });
    });
    let ws: WebSocket | undefined;
    try {
      ws = await connect(TRACEPARENTS.first);

      await expect(sendTraceRequest(ws, "untraced-after-connect")).resolves.toMatchObject({
        ok: true,
      });
      await expect(
        sendTraceRequest(
          ws,
          "malformed",
          "00-11111111111111111111111111111111-1111111111111111-zz",
        ),
      ).resolves.toMatchObject({ ok: true });
      const afterConnect = observed.get("untraced-after-connect")?.before;
      const malformed = observed.get("malformed")?.before;
      expect(afterConnect).toBeDefined();
      expect(malformed).toBeDefined();
      expect(afterConnect?.traceId).not.toBe("11111111111111111111111111111111");
      expect(malformed?.traceId).not.toBe("11111111111111111111111111111111");
      expect(malformed?.traceId).not.toBe(afterConnect?.traceId);

      requestBarrier = createDeferredCore();
      const first = sendTraceRequest(ws, "concurrent-first", TRACEPARENTS.first);
      const second = sendTraceRequest(ws, "concurrent-second", TRACEPARENTS.second);
      await bothConcurrentObserved.promise;
      requestBarrier.resolve();
      await expect(Promise.all([first, second])).resolves.toMatchObject([
        { ok: true },
        { ok: true },
      ]);

      const firstObservation = observed.get("concurrent-first");
      const secondObservation = observed.get("concurrent-second");
      expect(firstObservation?.before).toMatchObject({
        traceId: "11111111111111111111111111111111",
        parentSpanId: "1111111111111111",
        traceFlags: "01",
      });
      expect(secondObservation?.before).toMatchObject({
        traceId: "22222222222222222222222222222222",
        parentSpanId: "2222222222222222",
        traceFlags: "00",
      });
      expect(firstObservation?.before?.spanId).not.toBe("1111111111111111");
      expect(firstObservation?.after).toEqual(firstObservation?.before);
      expect(secondObservation?.after).toEqual(secondObservation?.before);
    } finally {
      ws?.terminate();
      await server.close();
      resetTestPluginRegistry();
    }
  });

  it("returns a typed error when a handler response cannot be serialized", async () => {
    let invalidSerializationAttempts = 0;
    const healthySerializationAttempts = new Map<string, number>();
    const { server, connect } = await startTraceServer("test.serialize", ({ req, respond }) => {
      const invalid = req.id === "invalid-payload";
      respond(true, {
        toJSON: () => {
          if (invalid) {
            invalidSerializationAttempts += 1;
            return { value: 1n };
          }
          const attempts = (healthySerializationAttempts.get(req.id) ?? 0) + 1;
          healthySerializationAttempts.set(req.id, attempts);
          if (attempts > 1) {
            throw new Error("healthy response serialized more than once");
          }
          return { value: 1 };
        },
      });
    });
    let ws: WebSocket | undefined;
    try {
      ws = await connect(TRACEPARENTS.first);
      await expect(
        sendTraceRequest(ws, "invalid-payload", undefined, "test.serialize"),
      ).resolves.toMatchObject({
        ok: false,
        error: { code: "UNAVAILABLE", message: "response serialization failed" },
      });
      expect(invalidSerializationAttempts).toBe(1);
      await expect(
        onceMessage(ws, (value) => value.type === "res" && value.id === "invalid-payload", 100),
      ).rejects.toThrow("timeout");

      await expect(
        sendTraceRequest(ws, "healthy-after-error", undefined, "test.serialize"),
      ).resolves.toMatchObject({ ok: true });
      expect(healthySerializationAttempts.get("healthy-after-error")).toBe(1);

      ws.terminate();
      ws = await connect(TRACEPARENTS.second);
      await expect(
        sendTraceRequest(ws, "healthy-after-reconnect", undefined, "test.serialize"),
      ).resolves.toMatchObject({ ok: true });
      expect(healthySerializationAttempts.get("healthy-after-reconnect")).toBe(1);
    } finally {
      ws?.terminate();
      await server.close();
      resetTestPluginRegistry();
    }
  });
});
