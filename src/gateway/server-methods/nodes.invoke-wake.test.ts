import { expectDefined } from "@openclaw/normalization-core";
import { MAX_TIMER_TIMEOUT_MS } from "@openclaw/normalization-core/number-coercion";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import { ErrorCodes } from "../../../packages/gateway-protocol/src/index.js";
import { createDeferred } from "../../../test/helpers/promise.js";
import { createOperationalRunInstanceRef } from "../../agents/admitted-run-context.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import * as nodeInvokePluginPolicy from "../node-invoke-plugin-policy.js";
import { NodeRegistry, type NodeInvokeResult } from "../node-registry.js";
import {
  captureNodeWakeLifecycle,
  clearNodeWakeState,
  invalidateNodeWakeState,
} from "../node-wake-state.js";
import {
  getNodeWakeStateSnapshot,
  resetNodeWakeStateForTest,
} from "../node-wake-state.test-support.js";
import { expectRecordFields, requireGatewayRecord } from "../test-helpers.assertions.js";
import {
  bindNodeRegistry,
  createNodeInvokeTestHarness,
  invokeNodeRequest,
  createOperatorClient,
  firstRespondCall,
  mockArg,
  registerNodeInvokeUploadTests,
  type RespondCall,
  type TestNodeSession,
} from "./nodes.invoke.test-support.js";
import {
  maybeSendNodeWakeNudge,
  maybeWakeNodeWithApns,
  nodeHandlers,
  waitForNodeReconnect,
} from "./nodes.js";
import type { GatewayRequestHandlerOptions } from "./types.js";

type ForwardedParams = {
  ok: boolean;
  params: unknown;
  approvalAuthority?: { recordId: string; decision: "allow-once" | "allow-always" };
};

const mocks = vi.hoisted(() => ({
  captureNodePairingGeneration: vi.fn(),
  getRuntimeConfig: vi.fn(() => ({})),
  isNodePairingGenerationCurrent: vi.fn(),
  resolveNodeCommandAllowlist: vi.fn<
    typeof import("../node-command-policy.js").resolveNodeCommandAllowlist
  >(() => new Set()),
  isNodeCommandAllowed: vi.fn<typeof import("../node-command-policy.js").isNodeCommandAllowed>(
    () => ({ ok: true }),
  ),
  isForegroundRestrictedPluginNodeCommand: vi.fn((command: string) =>
    command.startsWith("canvas."),
  ),
  sanitizeNodeInvokeParamsForForwarding: vi.fn<
    ({ rawParams }: { rawParams: unknown }) => ForwardedParams
  >(({ rawParams }) => ({ ok: true, params: rawParams })),
  clearApnsRegistrationIfCurrent: vi.fn(),
  loadApnsRegistration: vi.fn(),
  resolveApnsAuthConfigFromEnv: vi.fn(),
  resolveApnsRelayConfigFromEnv: vi.fn(),
  sendApnsBackgroundWake: vi.fn(),
  sendApnsAlert: vi.fn(),
  shouldClearStoredApnsRegistration: vi.fn(() => false),
}));

vi.mock("../../config/io.js", () => ({
  getRuntimeConfig: mocks.getRuntimeConfig,
}));

vi.mock("../../infra/device-pairing-node-state.js", () => ({
  captureNodePairingGeneration: mocks.captureNodePairingGeneration,
  isNodePairingGenerationCurrent: mocks.isNodePairingGenerationCurrent,
}));

vi.mock("../node-command-policy.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../node-command-policy.js")>()),
  DEFAULT_DANGEROUS_NODE_COMMANDS: ["sms.send", "sms.search"],
  resolveNodeCommandAllowlist: mocks.resolveNodeCommandAllowlist,
  isNodeCommandAllowed: mocks.isNodeCommandAllowed,
  isForegroundRestrictedPluginNodeCommand: mocks.isForegroundRestrictedPluginNodeCommand,
}));

vi.mock("../node-invoke-sanitize.js", () => ({
  sanitizeNodeInvokeParamsForForwarding: mocks.sanitizeNodeInvokeParamsForForwarding,
}));

vi.mock("../../infra/push-apns.js", () => ({
  clearApnsRegistrationIfCurrent: mocks.clearApnsRegistrationIfCurrent,
  loadApnsRegistration: mocks.loadApnsRegistration,
  resolveApnsAuthConfigFromEnv: mocks.resolveApnsAuthConfigFromEnv,
  resolveApnsRelayConfigFromEnv: mocks.resolveApnsRelayConfigFromEnv,
  sendApnsBackgroundWake: mocks.sendApnsBackgroundWake,
  sendApnsAlert: mocks.sendApnsAlert,
  shouldClearStoredApnsRegistration: mocks.shouldClearStoredApnsRegistration,
}));

function requireString(value: unknown, label: string): string {
  expect(typeof value, `${label} must be a string`).toBe("string");
  return value as string;
}

function expectInvokeTimeout(respond: Parameters<typeof firstRespondCall>[0]) {
  expectInvokeError(respond, {
    message: "TIMEOUT: node invoke timed out",
    details: { nodeError: { code: "TIMEOUT" } },
  });
}

function expectInvokeError(
  respond: Parameters<typeof firstRespondCall>[0],
  error: Record<string, unknown>,
) {
  expect(firstRespondCall(respond)).toMatchObject([false, undefined, error]);
}

function expectNodeError(respond: Parameters<typeof firstRespondCall>[0], code: string) {
  expectInvokeError(respond, { details: { nodeError: { code } } });
}

function expectPairingChanged(respond: Parameters<typeof firstRespondCall>[0]) {
  expectInvokeError(respond, {
    message: "node pairing changed while invocation was active",
    details: { code: "PAIRING_CHANGED" },
  });
}

function requireRespondPayload(call: RespondCall | undefined, label: string) {
  expect(call?.[0], `${label} success`).toBe(true);
  return requireGatewayRecord(call?.[1], `${label} payload`);
}

function expectQueuedAction(
  payload: Record<string, unknown>,
  expected: Record<string, unknown>,
): Record<string, unknown> {
  expect(Array.isArray(payload.actions), "payload.actions must be an array").toBe(true);
  const actions = payload.actions as unknown[];
  expect(actions).toHaveLength(1);
  return expectRecordFields(actions[0], "queued action", expected);
}

function expectWakeSendError(wake: unknown, reason: string, status: number) {
  expectRecordFields(wake, "wake result", {
    available: true,
    throttled: false,
    path: "send-error",
    apnsReason: reason,
    apnsStatus: status,
  });
}

function expectNoAuthWake(wake: unknown, label: string, reason: string) {
  expectRecordFields(wake, label, {
    available: false,
    throttled: false,
    path: "no-auth",
    apnsReason: reason,
  });
}

async function expectWakeState(
  nodeId: string,
  expected: Record<string, unknown>,
  label = "wake result",
) {
  expectRecordFields(await maybeWakeNodeWithApns(nodeId), label, expected);
}

async function expectNudgeState(nodeId: string, expected: Record<string, unknown>) {
  expectRecordFields(await maybeSendNodeWakeNudge(nodeId), "nudge result", expected);
}

async function expectWakeAndNudgeSent(nodeId: string) {
  await expectWakeState(nodeId, { path: "sent", throttled: false });
  await expectNudgeState(nodeId, { sent: true, throttled: false });
}

function useClock(now = 0) {
  vi.useFakeTimers();
  vi.setSystemTime(now);
}

const WAKE_WAIT_TIMEOUT_MS = 3_001;
const DEFAULT_RELAY_CONFIG = {
  baseUrl: "https://relay.example.com",
  timeoutMs: 1000,
} as const;
const RELAY_GATEWAY_CONFIG = { push: { apns: { relay: DEFAULT_RELAY_CONFIG } } };
type WakeResultOverrides = Partial<{
  ok: boolean;
  status: number;
  reason: string;
  tokenSuffix: string;
  topic: string;
  environment: "sandbox" | "production";
  transport: "direct" | "relay";
}>;

function directRegistration(nodeId: string) {
  return {
    nodeId,
    transport: "direct" as const,
    token: "abcd1234abcd1234abcd1234abcd1234",
    topic: "ai.openclaw.ios",
    environment: "sandbox" as const,
    updatedAtMs: 1,
  };
}

function relayRegistration(nodeId: string) {
  return {
    nodeId,
    transport: "relay" as const,
    relayHandle: "relay-handle-123",
    sendGrant: "send-grant-123",
    installationId: "install-123",
    topic: "ai.openclaw.ios",
    environment: "production" as const,
    distribution: "official" as const,
    updatedAtMs: 1,
    tokenDebugSuffix: "abcd1234",
  };
}

const DIRECT_APNS_AUTH = {
  ok: true,
  value: {
    teamId: "TEAM123",
    keyId: "KEY123",
    privateKey: "-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----", // pragma: allowlist secret
  },
} as const;
const DIRECT_APNS_RESULT = {
  ok: true,
  status: 200,
  tokenSuffix: "1234abcd",
  topic: "ai.openclaw.ios",
  environment: "sandbox",
  transport: "direct",
} as const;

function directWake(nodeId: string, overrides: WakeResultOverrides = {}) {
  mocks.loadApnsRegistration.mockResolvedValue(directRegistration(nodeId));
  mocks.resolveApnsAuthConfigFromEnv.mockResolvedValue(DIRECT_APNS_AUTH);
  mocks.sendApnsBackgroundWake.mockResolvedValue({
    ...DIRECT_APNS_RESULT,
    ...overrides,
  });
}

function relayWake(nodeId: string, overrides: WakeResultOverrides = {}) {
  mocks.getRuntimeConfig.mockReturnValue({ gateway: RELAY_GATEWAY_CONFIG });
  mocks.loadApnsRegistration.mockResolvedValue(relayRegistration(nodeId));
  mocks.resolveApnsRelayConfigFromEnv.mockReturnValue({
    ok: true,
    value: DEFAULT_RELAY_CONFIG,
  });
  mocks.sendApnsBackgroundWake.mockResolvedValue({
    ok: true,
    status: 200,
    tokenSuffix: "abcd1234",
    topic: "ai.openclaw.ios",
    environment: "production",
    transport: "relay",
    ...overrides,
  });
}

const invokeNode = createNodeInvokeTestHarness({
  getRuntimeConfig: () => mocks.getRuntimeConfig(),
  nodeHandlers,
});

type InvokeOptions = Parameters<typeof invokeNode>[0];
function invokeAt(
  nodeRegistry: InvokeOptions["nodeRegistry"],
  nodeId: string,
  requestParams: Record<string, unknown> = {},
) {
  return invokeNode({ nodeRegistry, requestParams: { nodeId, ...requestParams } });
}

function makeNodeSession(
  nodeId: string,
  overrides: Partial<TestNodeSession> = {},
): TestNodeSession {
  return { nodeId, commands: ["camera.capture"], platform: "iOS 26.4.0", ...overrides };
}

function createNodeClient(nodeId: string, commands?: string[]) {
  return {
    connId: `conn:${nodeId}`,
    connect: {
      ...(commands ? { commands } : {}),
      role: "node" as const,
      client: {
        id: nodeId,
        mode: "node" as const,
        name: "ios-test",
        platform: "iOS 26.4.0",
        version: "test",
      },
    },
  };
}

function createRegisteredNodeClient(
  nodeId: string,
  commands: string[],
  send: (raw: string) => void,
) {
  return {
    ...createNodeClient(nodeId, commands),
    usesSharedGatewayAuth: false,
    socket: { readyState: WebSocket.OPEN, bufferedAmount: 0, close: vi.fn(), send },
  };
}

function backgroundNode(params: { nodeId: string; commands?: string[]; platform?: string }) {
  return {
    get: vi.fn(() =>
      makeNodeSession(params.nodeId, {
        commands: params.commands ?? ["canvas.navigate"],
        platform: params.platform ?? "iOS 26.4.0",
      }),
    ),
    invoke: vi.fn().mockResolvedValue({
      ok: false,
      error: {
        code: "NODE_BACKGROUND_UNAVAILABLE",
        message: "NODE_BACKGROUND_UNAVAILABLE: canvas/camera/screen commands require foreground",
      },
    }),
  };
}

function offlineNode() {
  return mockNode(() => undefined);
}

async function rpc(
  method: string,
  params: Record<string, unknown>,
  client: GatewayRequestHandlerOptions["client"],
  context: GatewayRequestHandlerOptions["context"],
) {
  return invokeNodeRequest(
    expectDefined(nodeHandlers[method], method),
    context,
    client,
    method,
    params,
    "request",
  );
}

function mockNode(get: () => TestNodeSession | undefined, result: NodeInvokeResult = { ok: true }) {
  return {
    get: vi.fn(get),
    invoke: vi.fn<InvokeOptions["nodeRegistry"]["invoke"]>().mockResolvedValue(result),
  };
}

async function pendingRequest(
  method: "node.pending.pull" | "node.pending.ack",
  nodeId: string,
  params: Record<string, unknown>,
  commands?: string[],
  sessionConnId: string | null = `conn:${nodeId}`,
) {
  return rpc(
    method,
    params,
    createNodeClient(nodeId, commands) as never,
    {
      getRuntimeConfig: () => mocks.getRuntimeConfig(),
      nodeRegistry: {
        getForPairingGeneration: vi.fn(() =>
          sessionConnId === null ? undefined : { connId: sessionConnId },
        ),
      },
    } as never,
  );
}

function pullPending(nodeId: string, commands?: string[], sessionConnId?: string | null) {
  return pendingRequest("node.pending.pull", nodeId, {}, commands, sessionConnId);
}

function ackPending(
  nodeId: string,
  ids: string[],
  commands?: string[],
  sessionConnId?: string | null,
) {
  return pendingRequest("node.pending.ack", nodeId, { ids }, commands, sessionConnId);
}

async function invokeForeground(
  nodeId: string,
  options: Partial<Parameters<typeof invokeNode>[0]> = {},
) {
  const { requestParams, ...rest } = options;
  return invokeNode({
    nodeRegistry: backgroundNode({ nodeId }),
    ...rest,
    requestParams: {
      nodeId,
      command: "canvas.navigate",
      idempotencyKey: `pending:${nodeId}`,
      ...requestParams,
    },
  });
}

async function pendingPayload(nodeId: string, commands = ["canvas.navigate"]) {
  return requireRespondPayload(
    firstRespondCall(await pullPending(nodeId, commands)),
    "pending pull",
  );
}

describe("plugin surface refresh", () => {
  const origin = "http://127.0.0.1:18789";
  const currentUrl = `${origin}/__openclaw__/cap/current-token`;
  const observedUrl = "https://gateway.example/__openclaw__/cap/old-token";

  function surfaceClient() {
    return {
      connect: { client: { id: "node-1", mode: "node" } },
      pluginSurfaceUrls: { canvas: currentUrl },
      pluginNodeCapabilitySurfaces: { canvas: { surface: "canvas", ttlMs: 100 } },
    };
  }

  function currentClient(expiresAtMs = 1_100) {
    return {
      ...surfaceClient(),
      pluginNodeCapabilities: { canvas: { capability: "current-token", expiresAtMs } },
    };
  }

  async function refresh(client: unknown, method: string, params: Record<string, unknown>) {
    const respond = await rpc(method, params, client as never, {} as never);
    expect(respond).toHaveBeenCalledOnce();
    const call = firstRespondCall(respond);
    expect(call[0]).toBe(true);
    expect(call[2]).toBeUndefined();
    return requireGatewayRecord(call[1], "refresh payload");
  }

  beforeEach(() => {
    useClock(1_000);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("rotates the calling operator's own capability", async () => {
    const client = {
      ...surfaceClient(),
      connect: {
        role: "operator",
        scopes: ["operator.read"],
        client: { id: "operator-1", mode: "ui" },
      },
    };
    const payload = await refresh(client, "plugin.surface.refresh", { surface: "canvas" });
    expect(payload).toMatchObject({ surface: "canvas", expiresAtMs: 1_100 });
    const urls = requireGatewayRecord(payload.pluginSurfaceUrls, "surface urls");
    const canvasUrl = requireString(urls.canvas, "canvas url");
    const url = new URL(canvasUrl);
    expect(url.origin).toBe(origin);
    expect(url.pathname).toMatch(/^\/__openclaw__\/cap\/.+/);
    expect(canvasUrl).not.toBe(currentUrl);
    expect(client.pluginSurfaceUrls.canvas).toBe(canvasUrl);
  });

  it.each([
    { expiresAtMs: 1_100, rotates: false },
    { expiresAtMs: 999, rotates: true },
  ])(
    "refreshes a conflicting capability expiring at $expiresAtMs",
    async ({ expiresAtMs, rotates }) => {
      const client = currentClient(expiresAtMs);
      const payload = await refresh(client, "node.pluginSurface.refresh", {
        surface: "canvas",
        observedUrl,
      });
      if (rotates) {
        expect(payload.expiresAtMs).toBe(1_100);
        const urls = requireGatewayRecord(payload.pluginSurfaceUrls, "surface urls");
        const canvasUrl = requireString(urls.canvas, "canvas url");
        expect(canvasUrl).not.toBe(currentUrl);
        expect(client.pluginSurfaceUrls.canvas).toBe(canvasUrl);
        expect(client.pluginNodeCapabilities.canvas.capability).not.toBe("current-token");
        expect(client.pluginNodeCapabilities.canvas.expiresAtMs).toBe(1_100);
      } else {
        expect(payload).toEqual({ surface: "canvas", pluginSurfaceUrls: { canvas: currentUrl } });
        expect(client.pluginSurfaceUrls.canvas).toBe(currentUrl);
        expect(client.pluginNodeCapabilities.canvas).toEqual({
          capability: "current-token",
          expiresAtMs: 1_100,
        });
      }
    },
  );
});

describe("node.invoke APNs wake path", () => {
  beforeEach(() => {
    resetNodeWakeStateForTest();
    mocks.captureNodePairingGeneration.mockReset().mockImplementation(async (nodeId: string) => ({
      nodeId,
      key: `generation:${nodeId}:1`,
    }));
    mocks.getRuntimeConfig.mockClear().mockReturnValue({});
    mocks.resolveNodeCommandAllowlist.mockClear().mockReturnValue(new Set());
    mocks.isNodeCommandAllowed.mockClear().mockReturnValue({ ok: true });
    mocks.isForegroundRestrictedPluginNodeCommand
      .mockClear()
      .mockImplementation((command: string) => command.startsWith("canvas."));
    mocks.isNodePairingGenerationCurrent.mockReset().mockResolvedValue(true);
    mocks.sanitizeNodeInvokeParamsForForwarding
      .mockClear()
      .mockImplementation(({ rawParams }: { rawParams: unknown }) => ({
        ok: true,
        params: rawParams,
      }));
    mocks.loadApnsRegistration.mockClear();
    mocks.clearApnsRegistrationIfCurrent.mockClear();
    mocks.resolveApnsAuthConfigFromEnv.mockClear();
    mocks.resolveApnsRelayConfigFromEnv.mockClear();
    mocks.sendApnsBackgroundWake.mockClear();
    mocks.sendApnsAlert.mockClear();
    mocks.shouldClearStoredApnsRegistration.mockReturnValue(false);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe("node readiness recovery", () => {
    const nodeId = "ios-node-readiness";
    const command = "system.which";
    const initialGeneration = `generation:${nodeId}:1`;
    let registry: NodeRegistry;
    let controller: AbortController;
    let pairing: { identity: string; generation: string };
    let pairingDelayMs: number;
    let connId: string;
    let requests: Array<{ id: string; connId: string; timeoutMs: number }>;
    let pending: Array<Promise<unknown>>;

    function register(connection: string) {
      connId = connection;
      registry.register(
        {
          ...createRegisteredNodeClient(nodeId, [command], (raw: string) => {
            const frame = JSON.parse(raw) as {
              event: string;
              payload: { id: string; timeoutMs: number };
            };
            if (frame.event === "node.invoke.request") {
              requests.push({ ...frame.payload, connId: connection });
            }
          }),
          connId,
        } as never,
        { pairingIdentity: pairing.identity, pairingGeneration: pairing.generation },
      );
    }

    function start(requestParams: Partial<Record<string, unknown>> = {}, client?: unknown) {
      const invocation = invokeNode({
        nodeRegistry: bindNodeRegistry(registry),
        requestParams: { nodeId, command, params: { bins: ["git"] }, ...requestParams },
        signal: controller.signal,
        client,
      });
      pending.push(invocation);
      return invocation;
    }

    function reply(index: number, result: NodeInvokeResult) {
      const request = expectDefined(requests[index], "expected node transport request");
      expect(
        registry.handleInvokeResult({
          id: request.id,
          nodeId,
          connId: request.connId,
          ...result,
        }),
      ).toBe(true);
    }

    function rejectNotReady(index = 0) {
      reply(index, {
        ok: false,
        error: { code: "NODE_NOT_READY", message: "Node lifecycle transition in progress" },
      });
    }

    beforeEach(() => {
      useClock();
      controller = new AbortController();
      pairing = { identity: "readiness-identity", generation: initialGeneration };
      pairingDelayMs = 0;
      requests = [];
      pending = [];
      mocks.getRuntimeConfig.mockReturnValue({
        gateway: { nodes: { commands: { allow: [command] } } },
      });
      mockCommandPolicy();
      registry = new NodeRegistry({
        getConfig: mocks.getRuntimeConfig,
        resolveCurrentPairingState: async () => {
          if (pairingDelayMs > 0) {
            await new Promise((resolve) => {
              setTimeout(resolve, pairingDelayMs);
            });
          }
          return pairing;
        },
      });
      register("readiness-connection");
    });

    afterEach(async () => {
      controller.abort();
      for (const session of registry.listConnected()) {
        registry.unregister(session.connId);
      }
      await vi.runAllTimersAsync();
      await Promise.allSettled(pending);
    });

    it("retains the public deadline when less than one millisecond remains before registry admission", async () => {
      let now = 1_000;
      const clock = vi.spyOn(performance, "now").mockImplementation(() => now);
      mocks.captureNodePairingGeneration.mockImplementationOnce(async () => {
        now = 1_099.5;
        return { nodeId, key: initialGeneration };
      });
      const originalInvoke = registry.invoke.bind(registry);
      const admission = vi.spyOn(registry, "invoke").mockImplementation((params) => {
        now = 1_099.75;
        return originalInvoke(params);
      });
      const invocation = start({ timeoutMs: 100 });
      try {
        await vi.advanceTimersByTimeAsync(0);
        expect(requests).toHaveLength(1);
        expect(requests[0]?.timeoutMs).toBe(1);

        // The response arrives at the original deadline before a timer callback runs.
        now = 1_100;
        const request = expectDefined(requests[0], "expected node transport request");
        expect(
          registry.handleInvokeResult({
            id: request.id,
            nodeId,
            connId: request.connId,
            ok: true,
          }),
        ).toBe(false);
        expectNodeError(await invocation, "TIMEOUT");
        expect(requests).toHaveLength(1);
      } finally {
        controller.abort();
        registry.unregister(connId);
        await vi.advanceTimersByTimeAsync(0);
        await invocation;
        admission.mockRestore();
        clock.mockRestore();
      }
    });

    it.each(["command denial", "cancellation", "connection replacement", "pairing replacement"])(
      "does not redispatch after %s during readiness backoff",
      async (change) => {
        const invocation = start();
        await vi.advanceTimersByTimeAsync(0);
        rejectNotReady();
        await vi.advanceTimersByTimeAsync(50);
        switch (change) {
          case "command denial":
            mocks.getRuntimeConfig.mockReturnValue({
              gateway: { nodes: { commands: { deny: [command] } } },
            });
            break;
          case "cancellation":
            controller.abort();
            break;
          case "connection replacement":
            register("replacement-connection");
            break;
          case "pairing replacement":
            pairing = { ...pairing, generation: "replacement-generation" };
            break;
        }
        await vi.advanceTimersByTimeAsync(2_000);

        expect(requests).toHaveLength(1);
        expect(firstRespondCall(await invocation)[0]).toBe(false);
      },
    );

    it("preserves the default dispatch deadline across readiness retries", async () => {
      pairingDelayMs = 250;
      const invocation = start({ timeoutMs: undefined });
      await vi.advanceTimersByTimeAsync(250);
      pairingDelayMs = 0;
      const budget = 30_000;
      expect(requests[0]?.timeoutMs).toBe(budget);
      await vi.advanceTimersByTimeAsync(budget - 150);
      rejectNotReady();
      await vi.advanceTimersByTimeAsync(100);
      expect(requests).toHaveLength(2);
      expect(requests[1]?.timeoutMs).toBe(50);
      await vi.advanceTimersByTimeAsync(50);

      expectNodeError(await invocation, "TIMEOUT");
      expect(requests).toHaveLength(2);
    });

    it("expires during readiness backoff without dispatching another attempt", async () => {
      const invocation = start({ timeoutMs: 50 });
      await vi.advanceTimersByTimeAsync(0);
      rejectNotReady();
      await vi.advanceTimersByTimeAsync(50);

      expect(requests).toHaveLength(1);
      expectNodeError(await invocation, "TIMEOUT");
    });

    it("keeps the invoke deadline stable across a backward wall-clock change", async () => {
      const invocation = start({ timeoutMs: 500 });
      await vi.advanceTimersByTimeAsync(0);
      vi.setSystemTime(-10_000);
      await vi.advanceTimersByTimeAsync(499);
      expect(requests).toHaveLength(1);
      vi.setSystemTime(-9_999);
      await vi.advanceTimersByTimeAsync(1);
      expectNodeError(await invocation, "TIMEOUT");
      expect(requests).toHaveLength(1);
    });

    it("returns the final readiness rejection after exhausting bounded retries", async () => {
      const invocation = start({ timeoutMs: 0 });
      await vi.advanceTimersByTimeAsync(0);
      for (const [index, delay] of [100, 250, 500, 1_000].entries()) {
        rejectNotReady(index);
        await vi.advanceTimersByTimeAsync(delay);
        expect(requests).toHaveLength(index + 2);
      }
      rejectNotReady(4);
      expectNodeError(await invocation, "NODE_NOT_READY");
      expect(requests).toHaveLength(5);
    });

    it.each([
      { seq: 0, streaming: true },
      { seq: 1, streaming: true },
      { seq: 0, streaming: false },
    ])(
      "does not retry node-not-ready after progress $seq (streaming=$streaming)",
      async ({ seq, streaming }) => {
        const onProgress = vi.fn();
        const invocation = start(
          {},
          streaming
            ? {
                ...createOperatorClient({ pluginRuntimeOwnerId: "readiness-fixture" }),
                internal: {
                  syntheticClient: true,
                  pluginRuntimeOwnerId: "readiness-fixture",
                  nodeInvokeStream: {
                    onProgress,
                    onDispatchReady: vi.fn(),
                    isRuntimeCurrent: () => true,
                  },
                },
              }
            : undefined,
        );
        await vi.advanceTimersByTimeAsync(0);
        const request = expectDefined(requests[0], "expected streamed node request");
        expect(
          registry.handleInvokeProgress({
            invokeId: request.id,
            nodeId,
            connId,
            seq,
            chunk: seq === 0 ? "" : "execution started",
          }),
        ).toBe(streaming);
        rejectNotReady();
        await vi.advanceTimersByTimeAsync(2_000);

        expect(requests).toHaveLength(1);
        expectNodeError(await invocation, "UNAVAILABLE");
        expect(onProgress).toHaveBeenCalledTimes(streaming && seq === 0 ? 1 : 0);
      },
    );

    it.each(["nodeId", "connId"] as const)(
      "ignores foreign progress with mismatched %s during recovery",
      async (field) => {
        const invocation = start();
        await vi.advanceTimersByTimeAsync(0);
        const request = expectDefined(requests[0], "expected node request");
        expect(
          registry.handleInvokeProgress({
            invokeId: request.id,
            nodeId,
            connId,
            seq: 0,
            chunk: "foreign progress",
            [field]: "different-owner",
          }),
        ).toBe(false);
        rejectNotReady();
        await vi.advanceTimersByTimeAsync(100);
        expect(requests).toHaveLength(2);
        reply(1, { ok: true, payloadJSON: "{}" });
        expect(firstRespondCall(await invocation)[0]).toBe(true);
      },
    );
  });

  it.each([
    { scope: "operator.write", owner: "third-party", allowed: false },
    { scope: "operator.admin", owner: "google-meet", allowed: true },
  ])(
    "enforces browser.proxy admin scope for $owner ($scope)",
    async ({ scope, owner, allowed }) => {
      const command = "browser.proxy";
      const nodeRegistry = mockNode(() => ({ nodeId: "browser-node", commands: [command] }), {
        ok: true,
        payloadJSON: '{"ok":true}',
      });

      const respond = await invokeNode({
        nodeRegistry,
        client: createOperatorClient({
          scopes: [scope],
          pluginRuntimeOwnerId: owner,
        }),
        requestParams: {
          nodeId: "browser-node",
          command,
          params: { method: "GET", path: "/profiles" },
        },
      });

      const call = firstRespondCall(respond);
      expect(call[0]).toBe(allowed);
      if (allowed) {
        expect(nodeRegistry.invoke).toHaveBeenCalledTimes(1);
        expectRecordFields(mockArg(nodeRegistry.invoke, 0, 0), "node invoke payload", {
          nodeId: "browser-node",
          command,
          params: { method: "GET", path: "/profiles" },
        });
      } else {
        expect(call[2]).toMatchObject({
          code: "FORBIDDEN",
          message: "missing scope: operator.admin",
          details: {
            code: "MISSING_SCOPE",
            missingScope: "operator.admin",
            requiredScopes: ["operator.admin"],
          },
        });
        expect(nodeRegistry.invoke).not.toHaveBeenCalled();
      }
    },
  );

  registerNodeInvokeUploadTests({ mocks, invokeNode });

  it.each([
    {
      name: "explains the explicit opt-in required for dangerous commands",
      command: "sms.search",
      reason: "command not allowlisted",
      node: { nodeId: "android-sms-node", commands: ["sms.search"], platform: "android" },
      message:
        'node command not allowed: "sms.search" requires explicit gateway.nodes.commands.allow opt-in',
    },
    {
      name: "explains when a declared node command surface awaits approval",
      command: "system.notify",
      reason: "node did not declare commands",
      node: {
        nodeId: "linux-node",
        commands: [],
        declaredCommands: ["system.notify", "camera.list", "location.get"],
        platform: "linux",
      },
      message:
        "node command not allowed: the node's declared command surface is pending approval; run `openclaw nodes pending`, then `openclaw nodes approve <requestId>`",
    },
    {
      name: "does not claim approval can add an undeclared command",
      command: "system.notify",
      reason: "node did not declare commands",
      node: {
        nodeId: "linux-node",
        commands: [],
        declaredCommands: ["camera.list"],
        platform: "linux",
      },
      message: "node command not allowed: the node did not declare any supported commands",
    },
  ])("$name", async ({ command, reason, node, message }) => {
    mocks.isNodeCommandAllowed.mockReturnValue({ ok: false, reason });
    const nodeRegistry = { get: vi.fn(() => node), invoke: vi.fn() };

    const respond = await invokeNode({
      nodeRegistry,
      requestParams: { nodeId: node.nodeId, command },
    });

    const call = firstRespondCall(respond);
    expect(call[0]).toBe(false);
    expect(call[2]?.message).toBe(message);
    expect(nodeRegistry.invoke).not.toHaveBeenCalled();
  });

  it("does not throttle repeated relay wake attempts when relay config is missing", async () => {
    mocks.loadApnsRegistration.mockResolvedValue(relayRegistration("ios-node-relay-no-auth"));
    mocks.resolveApnsRelayConfigFromEnv.mockReturnValue({
      ok: false,
      error: "relay config missing",
    });

    const first = await maybeWakeNodeWithApns("ios-node-relay-no-auth");
    const second = await maybeWakeNodeWithApns("ios-node-relay-no-auth");

    expectNoAuthWake(first, "first wake result", "relay config missing");
    expectNoAuthWake(second, "second wake result", "relay config missing");
    expect(mocks.resolveApnsRelayConfigFromEnv).toHaveBeenCalledTimes(2);
    expect(mocks.sendApnsBackgroundWake).not.toHaveBeenCalled();
  });

  it("does not share an in-flight wake with a replacement pairing generation", async () => {
    const nodeId = "ios-node-replacement-in-flight";
    const generationOne = { nodeId, key: "generation-1" };
    const generationTwo = { nodeId, key: "generation-2" };
    const registration = createDeferred<null>();
    mocks.loadApnsRegistration
      .mockReturnValueOnce(registration.promise)
      .mockResolvedValueOnce(null);

    const firstWake = maybeWakeNodeWithApns(nodeId, { generation: generationOne });
    await vi.waitFor(() => expect(mocks.loadApnsRegistration).toHaveBeenCalledTimes(1));

    await expect(
      maybeWakeNodeWithApns(nodeId, { generation: generationTwo }),
    ).resolves.toMatchObject({ path: "no-registration", available: false });
    expect(mocks.loadApnsRegistration).toHaveBeenCalledTimes(2);

    registration.resolve(null);
    await expect(firstWake).resolves.toMatchObject({ path: "no-registration", available: false });
    invalidateNodeWakeState(nodeId);
  });

  it("does not share wake or nudge throttles with a replacement pairing generation", async () => {
    const nodeId = "ios-node-replacement-throttles";
    const generations = ["generation-1", "generation-2"].map((key) => ({ nodeId, key }));
    directWake(nodeId);
    mocks.sendApnsAlert.mockResolvedValue(DIRECT_APNS_RESULT);

    for (const generation of generations) {
      await expect(maybeWakeNodeWithApns(nodeId, { generation })).resolves.toMatchObject({
        path: "sent",
        throttled: false,
      });
    }
    for (const generation of generations) {
      await expect(maybeSendNodeWakeNudge(nodeId, { generation })).resolves.toMatchObject({
        reason: "sent",
        throttled: false,
      });
    }

    expect(mocks.sendApnsBackgroundWake).toHaveBeenCalledTimes(2);
    expect(mocks.sendApnsAlert).toHaveBeenCalledTimes(2);
    for (const { key } of generations) {
      const snapshot = getNodeWakeStateSnapshot(nodeId, key);
      expect(snapshot?.lastWakeAtMs).toBeGreaterThan(0);
      expect(snapshot?.lastNudgeAtMs).toBeGreaterThan(0);
    }
    invalidateNodeWakeState(nodeId);
  });

  it("clears wake and nudge throttle state when a node disconnects", async () => {
    directWake("ios-node-clear-wake");
    mocks.sendApnsAlert.mockResolvedValue(DIRECT_APNS_RESULT);

    await expectWakeAndNudgeSent("ios-node-clear-wake");
    await expectWakeState("ios-node-clear-wake", {
      path: "throttled",
      throttled: true,
    });
    await expectNudgeState("ios-node-clear-wake", {
      sent: false,
      throttled: true,
    });

    clearNodeWakeState("ios-node-clear-wake");

    await expectWakeAndNudgeSent("ios-node-clear-wake");
    expect(mocks.sendApnsBackgroundWake).toHaveBeenCalledTimes(2);
    expect(mocks.sendApnsAlert).toHaveBeenCalledTimes(2);
  });

  it("times out when initial node pairing capture remains in flight", async () => {
    useClock();
    mocks.captureNodePairingGeneration.mockImplementation(() => new Promise<never>(() => {}));
    const nodeRegistry = offlineNode();

    const pending = invokeAt(nodeRegistry, "stalled-pairing", { timeoutMs: 100 });

    await vi.advanceTimersByTimeAsync(100);

    expectInvokeTimeout(await pending);
    expect(nodeRegistry.invoke).not.toHaveBeenCalled();
    expect(mocks.sendApnsBackgroundWake).not.toHaveBeenCalled();
  });

  it("preserves dispatched plugin work when its pairing recheck times out", async () => {
    useClock();
    const nodeId = "ios-node-dispatched-plugin-pairing-timeout";
    mocks.isNodePairingGenerationCurrent.mockImplementation(() => new Promise<never>(() => {}));
    const session = makeNodeSession(nodeId, { connId: "dispatched-plugin-conn" });
    const nodeRegistry = mockNode(() => session, {
      ok: true,
      payload: { ok: true },
      payloadJSON: null,
    });
    const applyPolicy = vi
      .spyOn(nodeInvokePluginPolicy, "applyPluginNodeInvokePolicy")
      .mockImplementation(async (params) => {
        params.onNodeCommandDispatched?.();
        await params.context.nodeRegistry.invoke({
          nodeId: params.nodeSession.nodeId,
          expectedConnId: params.nodeSession.connId,
          command: params.command,
          params: params.params,
          timeoutMs: params.timeoutMs,
          idempotencyKey: params.idempotencyKey,
        });
        return { ok: true, payload: { ok: true }, payloadJSON: null };
      });

    try {
      const pending = invokeAt(nodeRegistry, nodeId, {
        timeoutMs: 100,
      });

      await vi.advanceTimersByTimeAsync(100);

      expectInvokeError(await pending, {
        message: "TIMEOUT: node invoke timed out",
        details: {
          nodeError: { code: "TIMEOUT" },
          nodeCommandDispatched: true,
        },
      });
      expect(nodeRegistry.invoke).toHaveBeenCalledOnce();
    } finally {
      applyPolicy.mockRestore();
    }
  });

  it.each([100, MAX_TIMER_TIMEOUT_MS + 100])(
    "bounds a pending APNs wake to the %i ms invoke budget",
    async (timeoutMs) => {
      useClock();
      const nodeId = "pending-apns";
      directWake(nodeId);
      const wake = createDeferred<typeof DIRECT_APNS_RESULT>();
      mocks.sendApnsBackgroundWake.mockReturnValue(wake.promise);
      const nodeRegistry = offlineNode();
      let settled = false;
      const pending = invokeAt(nodeRegistry, nodeId, { timeoutMs });
      void pending.then(() => {
        settled = true;
      });
      try {
        if (timeoutMs > MAX_TIMER_TIMEOUT_MS) {
          await vi.advanceTimersByTimeAsync(MAX_TIMER_TIMEOUT_MS);
          expect(settled).toBe(false);
        }
        await vi.advanceTimersByTimeAsync(100);
        expectInvokeTimeout(await pending);
        expect(nodeRegistry.invoke).not.toHaveBeenCalled();
        expect(mocks.sendApnsBackgroundWake).toHaveBeenCalledOnce();
      } finally {
        wake.resolve(DIRECT_APNS_RESULT);
        await vi.advanceTimersByTimeAsync(0);
      }
    },
  );

  it("rejects wake results that resolve after the absolute invoke deadline", async () => {
    useClock();
    let now = 0;
    const clock = vi.spyOn(performance, "now").mockImplementation(() => now);
    const nodeId = "ios-node-late-apns-wake-result";
    directWake(nodeId);
    mocks.sendApnsBackgroundWake.mockImplementation(async () => {
      now = 101;
      vi.setSystemTime(101);
      return DIRECT_APNS_RESULT;
    });
    const nodeRegistry = offlineNode();

    try {
      const respond = await invokeAt(nodeRegistry, nodeId, {
        timeoutMs: 100,
      });

      expectInvokeTimeout(respond);
      expect(nodeRegistry.invoke).not.toHaveBeenCalled();
    } finally {
      clock.mockRestore();
    }
  });

  function mockCommandPolicy() {
    mocks.resolveNodeCommandAllowlist.mockImplementation((cfg) => {
      const allowlist = new Set(cfg.gateway?.nodes?.commands?.allow ?? []);
      for (const command of cfg.gateway?.nodes?.commands?.deny ?? []) {
        allowlist.delete(command);
      }
      return allowlist;
    });
    mocks.isNodeCommandAllowed.mockImplementation(({ command, allowlist }) =>
      allowlist.has(command) ? { ok: true } : { ok: false, reason: "command not allowlisted" },
    );
  }

  it.each([true, false])(
    "retains admission and current command policy when initiallyAllowed=%s",
    async (initiallyAllowed) => {
      vi.useFakeTimers();
      const nodeId = "policy-reload";
      directWake(nodeId);
      const policy = (allow: boolean): OpenClawConfig => ({
        gateway: { nodes: { commands: { [allow ? "allow" : "deny"]: ["computer.act"] } } },
      });
      const admissionConfig = policy(initiallyAllowed);
      let runtimeConfig = admissionConfig;
      mocks.getRuntimeConfig.mockImplementation(() => runtimeConfig);
      mockCommandPolicy();
      let connected = false;
      const session: TestNodeSession = {
        nodeId,
        commands: ["computer.act"],
        platform: "macOS 26.0.0",
      };
      const nodeRegistry = mockNode(() => (connected ? session : undefined));
      const pending = invokeAt(nodeRegistry, nodeId, { command: "computer.act" });
      setTimeout(() => {
        runtimeConfig = policy(!initiallyAllowed);
        connected = true;
      }, 300);
      await vi.advanceTimersByTimeAsync(WAKE_WAIT_TIMEOUT_MS);
      const call = firstRespondCall(await pending);
      expect(call[0]).toBe(false);
      expect(call[2]).toMatchObject({
        message:
          'node command not allowed: "computer.act" is blocked by gateway.nodes.commands.deny',
        details: { reason: "command not allowlisted", command: "computer.act" },
      });
      expect(mockArg(mocks.resolveNodeCommandAllowlist, 0, 0)).toBe(admissionConfig);
      if (initiallyAllowed) {
        expect(mockArg(mocks.resolveNodeCommandAllowlist, 1, 0)).toBe(runtimeConfig);
      }
      expect(nodeRegistry.invoke).not.toHaveBeenCalled();
    },
  );

  it("does not dispatch system.which when policy changes during final pairing validation", async () => {
    let runtimeConfig: OpenClawConfig = {
      gateway: { nodes: { commands: { allow: ["system.which"] } } },
    };
    mocks.getRuntimeConfig.mockImplementation(() => runtimeConfig);
    mockCommandPolicy();

    const nodeId = "mac-node-final-policy-reload";
    const connId = `conn:${nodeId}`;
    const dispatch = vi.fn();
    const pairingEntered = createDeferred();
    const pairingReleased = createDeferred();
    const registry = new NodeRegistry({
      getConfig: () => runtimeConfig,
      resolveCurrentPairingState: async () => {
        pairingEntered.resolve();
        await pairingReleased.promise;
        return { identity: "identity", generation: `generation:${nodeId}:1` };
      },
    });
    registry.register(createRegisteredNodeClient(nodeId, ["system.which"], dispatch) as never, {
      pairingIdentity: "identity",
      pairingGeneration: `generation:${nodeId}:1`,
    });
    try {
      const invocation = invokeNode({
        nodeRegistry: bindNodeRegistry(registry),
        requestParams: {
          nodeId,
          command: "system.which",
          params: { bins: ["git"] },
        },
      });
      await pairingEntered.promise;
      runtimeConfig = { gateway: { nodes: { commands: { deny: ["system.which"] } } } };
      pairingReleased.resolve();

      expectInvokeError(await invocation, {
        details: {
          nodeError: { code: "POLICY_CHANGED" },
          nodeCommandDispatched: false,
        },
      });
      expect(dispatch).not.toHaveBeenCalled();
    } finally {
      pairingReleased.resolve();
      registry.unregister(connId);
    }
  });

  it("keeps the reconnect wait interval across a backward wall-clock change", async () => {
    useClock(10_000_000);
    const nodeRegistry = {
      get: vi.fn(() => undefined),
      getForPairingGeneration: vi.fn(() => undefined),
    };
    let settled = false;
    const reconnect = waitForNodeReconnect({
      nodeId: "clock-node",
      context: { nodeRegistry },
      timeoutMs: 300,
    }).then((result) => {
      settled = true;
      return result;
    });
    vi.setSystemTime(6_400_000);
    await vi.advanceTimersByTimeAsync(299);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(settled).toBe(true);
    await expect(reconnect).resolves.toBe(false);
  });

  it("broadcasts canonical Talk capture events for successful PTT node commands", async () => {
    const broadcast = vi.fn();
    const nodeSession = {
      nodeId: "android-talk-node",
      pairingGeneration: "generation:android-talk-node:1",
      commands: ["talk.ptt.start"],
      capabilities: ["talk"],
      platform: "android",
    };
    const nodeRegistry = {
      ...mockNode(() => nodeSession, { ok: true, payloadJSON: '{"captureId":"capture-1"}' }),
      getForPairingGeneration: vi.fn(() => nodeSession),
    };

    const command = { nodeId: "android-talk-node", command: "talk.ptt.start" };
    const respond = await rpc("node.invoke", { ...command, idempotencyKey: "talk-ptt" }, null, {
      nodeRegistry,
      execApprovalManager: undefined,
      logGateway: { info: vi.fn(), warn: vi.fn() },
      getRuntimeConfig: () => mocks.getRuntimeConfig(),
      broadcast,
    } as never);

    expect(firstRespondCall(respond)[0]).toBe(true);
    expect(broadcast.mock.calls[0]).toMatchObject([
      "talk.event",
      {
        ...command,
        talkEvent: {
          type: "capture.started",
          sessionId: "node:android-talk-node:talk:capture-1",
          captureId: "capture-1",
          mode: "stt-tts",
          transport: "managed-room",
          brain: "agent-consult",
          final: false,
          seq: expect.any(Number),
          payload: command,
        },
      },
      { dropIfSlow: true },
    ]);
  });

  it.each([
    { transport: "direct", status: 400, reason: "BadDeviceToken", clear: true },
    { transport: "relay", status: 410, reason: "Unregistered", clear: false },
  ])("clears failed $transport wake registration only when eligible", async (failure) => {
    const { transport, status, reason, clear } = failure;
    const nodeId = `ios-node-${transport}`;
    const registration =
      transport === "direct" ? directRegistration(nodeId) : relayRegistration(nodeId);
    (transport === "direct" ? directWake : relayWake)(nodeId, { ok: false, status, reason });
    mocks.shouldClearStoredApnsRegistration.mockReturnValue(clear);
    expectWakeSendError(await maybeWakeNodeWithApns(nodeId, { force: true }), reason, status);
    if (clear) {
      expect(mocks.clearApnsRegistrationIfCurrent).toHaveBeenCalledWith({ nodeId, registration });
    } else {
      expect(mocks.resolveApnsRelayConfigFromEnv).toHaveBeenCalledWith(
        process.env,
        RELAY_GATEWAY_CONFIG,
        { registrationRelayOrigin: undefined },
      );
      expect(mocks.shouldClearStoredApnsRegistration).toHaveBeenCalledWith({
        registration,
        result: {
          ok: false,
          status,
          reason,
          tokenSuffix: "abcd1234",
          topic: "ai.openclaw.ios",
          environment: "production",
          transport: "relay",
        },
      });
      expect(mocks.clearApnsRegistrationIfCurrent).not.toHaveBeenCalled();
    }
  });

  it.each(["removed", "lookup failure"])(
    "fails closed before policy when pairing is %s",
    async (state) => {
      const nodeId = "node-pairing-admission";
      if (state === "removed") {
        mocks.captureNodePairingGeneration.mockResolvedValueOnce(null);
        mocks.getRuntimeConfig.mockReturnValue({
          gateway: { nodes: { commands: { deny: ["system.which"] } } },
        });
      } else {
        mocks.captureNodePairingGeneration.mockRejectedValueOnce(
          new Error("pairing transport unavailable"),
        );
      }
      const nodeRegistry = offlineNode();

      const respond = await invokeAt(nodeRegistry, nodeId, { command: "system.which" });

      expect(mocks.getRuntimeConfig).not.toHaveBeenCalled();
      expect(mocks.resolveNodeCommandAllowlist).not.toHaveBeenCalled();
      expect(mocks.isNodeCommandAllowed).not.toHaveBeenCalled();
      expect(mocks.loadApnsRegistration).not.toHaveBeenCalled();
      expect(mocks.sendApnsBackgroundWake).not.toHaveBeenCalled();
      expect(nodeRegistry.invoke).not.toHaveBeenCalled();
      expectInvokeError(
        respond,
        state === "removed"
          ? {
              message: "node pairing changed while invocation was active",
              details: { code: "PAIRING_CHANGED" },
            }
          : { code: ErrorCodes.UNAVAILABLE, message: "Error: pairing transport unavailable" },
      );
    },
  );

  it("forces one retry wake when the first wake still fails to reconnect", async () => {
    vi.useFakeTimers();
    directWake("ios-node-throttle");

    const nodeRegistry = offlineNode();

    const invokePromise = invokeAt(nodeRegistry, "ios-node-throttle", {
      timeoutMs: 0,
    });
    await vi.advanceTimersByTimeAsync(20_000);
    await invokePromise;

    expect(mocks.sendApnsBackgroundWake).toHaveBeenCalledTimes(2);
    expect(nodeRegistry.invoke).not.toHaveBeenCalled();
  });

  it.each(["removed", "replaced"])(
    "does not dispatch after pairing is %s during an in-flight wake",
    async (change) => {
      vi.useFakeTimers();
      const nodeId = "revoked-during-wake";
      directWake(nodeId);
      mocks.sendApnsAlert.mockResolvedValue(DIRECT_APNS_RESULT);
      let pairingCurrent = true;
      mocks.isNodePairingGenerationCurrent.mockImplementation(async () => pairingCurrent);
      const session = makeNodeSession(nodeId, { connId: "replacement-conn" });
      let connected = false;
      const nodeRegistry = mockNode(() => (connected ? session : undefined), {
        ok: true,
        payload: { replacement: true },
      });
      const pending = invokeAt(nodeRegistry, nodeId);
      await vi.advanceTimersByTimeAsync(0);
      expect(mocks.sendApnsBackgroundWake).toHaveBeenCalledTimes(1);
      if (change === "removed") {
        invalidateNodeWakeState(nodeId);
      } else {
        pairingCurrent = false;
        connected = true;
      }
      await vi.advanceTimersByTimeAsync(20_000);
      expectPairingChanged(await pending);
      expect(nodeRegistry.invoke).not.toHaveBeenCalled();
      if (change === "removed") {
        expect(mocks.sendApnsBackgroundWake).toHaveBeenCalledTimes(1);
        expect(mocks.sendApnsAlert).not.toHaveBeenCalled();
        expect(getNodeWakeStateSnapshot(nodeId)).toBeUndefined();
      }
    },
  );

  it.each(["wake", "nudge"])("revalidates pairing after direct %s auth resolves", async (kind) => {
    const nodeId = `revoked-${kind}-auth`;
    const generation = { nodeId, key: "generation-1" };
    const lifecycle = captureNodeWakeLifecycle(nodeId, generation.key);
    let pairingCurrent = true;
    const auth = createDeferred<typeof DIRECT_APNS_AUTH>();
    const entered = createDeferred();
    mocks.isNodePairingGenerationCurrent.mockImplementation(async () => pairingCurrent);
    mocks.loadApnsRegistration.mockResolvedValue(directRegistration(nodeId));
    mocks.resolveApnsAuthConfigFromEnv.mockImplementation(() => {
      entered.resolve();
      return auth.promise;
    });
    const pending =
      kind === "wake"
        ? maybeWakeNodeWithApns(nodeId, { lifecycle, generation })
        : maybeSendNodeWakeNudge(nodeId, { lifecycle, generation });
    await entered.promise;
    pairingCurrent = false;
    auth.resolve(DIRECT_APNS_AUTH);
    await expect(pending).resolves.toMatchObject(
      kind === "wake"
        ? { path: "invalidated", available: false }
        : { reason: "invalidated", sent: false },
    );
    expect(mocks.sendApnsBackgroundWake).not.toHaveBeenCalled();
    expect(mocks.sendApnsAlert).not.toHaveBeenCalled();
    invalidateNodeWakeState(nodeId);
  });

  it("passes lifecycle and persistent currentness into direct APNs transport", async () => {
    const nodeId = "ios-node-transport-generation-guard";
    const generation = { nodeId, key: "generation-1" };
    const lifecycle = captureNodeWakeLifecycle(nodeId, generation.key);
    let pairingCurrent = true;
    mocks.isNodePairingGenerationCurrent.mockImplementation(async () => pairingCurrent);
    mocks.loadApnsRegistration.mockResolvedValue(directRegistration(nodeId));
    mocks.resolveApnsAuthConfigFromEnv.mockResolvedValue(DIRECT_APNS_AUTH);

    await maybeWakeNodeWithApns(nodeId, { lifecycle, generation });

    const transport = requireGatewayRecord(
      mockArg(mocks.sendApnsBackgroundWake, 0, 0),
      "guarded APNs transport",
    );
    expect(transport.signal).toBe(lifecycle);
    expect(transport.isCurrent).toBeTypeOf("function");
    pairingCurrent = false;
    await expect((transport.isCurrent as () => Promise<boolean>)()).resolves.toBe(false);
    invalidateNodeWakeState(nodeId);
  });

  it("does not raw-dispatch when runtime authority closes during an awaited policy check", async () => {
    const nodeId = "ios-node-authority-close";
    const nodeRegistry = mockNode(() => makeNodeSession(nodeId, { connId: "authority-conn" }), {
      ok: true,
      payload: { delivered: true },
    });
    let authorityActive = true;
    const releaseHandoff = vi.fn();
    const retainForHandoff = vi.fn(() => releaseHandoff);
    vi.spyOn(nodeInvokePluginPolicy, "applyPluginNodeInvokePolicy").mockImplementationOnce(
      async () => {
        await Promise.resolve();
        authorityActive = false;
        return null;
      },
    );
    mocks.sanitizeNodeInvokeParamsForForwarding.mockReturnValueOnce({
      ok: true,
      params: { command: ["echo", "approved"] },
      approvalAuthority: { recordId: "approval-backend-bridge", decision: "allow-always" },
    });

    const respond = await invokeNode({
      nodeRegistry,
      client: createOperatorClient(),
      requestParams: { nodeId },
      execApprovalManager: {
        projectDecisionIfActive: (_id, decision) => (authorityActive ? decision : null),
        retainForHandoff,
      },
    });

    expect(retainForHandoff).toHaveBeenCalledWith("approval-backend-bridge");
    expect(releaseHandoff).toHaveBeenCalledOnce();
    expect(nodeRegistry.invoke).not.toHaveBeenCalled();
    expectInvokeError(respond, {
      message: "approved runtime authority closed before node dispatch",
      details: { code: "APPROVAL_AUTHORITY_CLOSED" },
    });
  });

  it.each(["invalidated", "prior generation"])(
    "does not dispatch through a %s node session",
    async (state) => {
      const nodeId = "ios-node-stale-session";
      mocks.loadApnsRegistration.mockResolvedValue(null);
      const oldSession = makeNodeSession(nodeId, {
        connId: "old-conn",
        pairingGeneration: `generation:${nodeId}:0`,
        client: { invalidated: state === "invalidated" },
      });
      const getForPairingGeneration = vi.fn((_requestedNodeId: string, generation: string) =>
        generation === oldSession.pairingGeneration ? oldSession : undefined,
      );
      const nodeRegistry = {
        get: vi.fn(() => oldSession),
        ...(state === "prior generation" ? { getForPairingGeneration } : {}),
        invoke: vi.fn().mockResolvedValue({ ok: true, payload: { delivered: true } }),
      };

      const respond = await invokeAt(nodeRegistry, nodeId);

      if (state === "prior generation") {
        expect(getForPairingGeneration).toHaveBeenCalledWith(nodeId, `generation:${nodeId}:1`);
      }
      expect(nodeRegistry.invoke).not.toHaveBeenCalled();
      expectInvokeError(respond, { details: { code: "NOT_CONNECTED" } });
    },
  );

  it("cancels dispatched node work when its pairing generation is revoked", async () => {
    const nodeId = "ios-node-revoked-during-dispatch";
    let pairingCurrent = true;
    mocks.isNodePairingGenerationCurrent.mockImplementation(async () => pairingCurrent);
    const session = makeNodeSession(nodeId, { connId: "revoked-conn" });
    const nodeRegistry = mockNode(() => session);
    nodeRegistry.invoke.mockImplementation(
      ({ signal }) =>
        new Promise((resolve) => {
          signal?.addEventListener(
            "abort",
            () => resolve({ ok: false, error: { code: "ABORTED", message: "cancelled" } }),
            { once: true },
          );
        }),
    );

    const pending = invokeAt(nodeRegistry, nodeId);
    await vi.waitFor(() => expect(nodeRegistry.invoke).toHaveBeenCalledTimes(1));
    const signal = requireGatewayRecord(mockArg(nodeRegistry.invoke, 0, 0), "invoke").signal;
    if (!(signal instanceof AbortSignal)) {
      throw new Error("expected dispatched node work to receive an abort signal");
    }
    expect(signal.aborted).toBe(false);

    pairingCurrent = false;
    invalidateNodeWakeState(nodeId);

    expect(signal.aborted).toBe(true);
    expectInvokeError(await pending, { details: { code: "PAIRING_CHANGED" } });
  });

  it("does not queue foreground work when pairing changes during node dispatch", async () => {
    const nodeId = "ios-node-replaced-during-dispatch";
    let pairingCurrent = true;
    mocks.isNodePairingGenerationCurrent.mockImplementation(async () => pairingCurrent);
    const nodeRegistry = backgroundNode({ nodeId });
    nodeRegistry.invoke.mockImplementation(async () => {
      pairingCurrent = false;
      return {
        ok: false,
        error: {
          code: "NODE_BACKGROUND_UNAVAILABLE",
          message: "NODE_BACKGROUND_UNAVAILABLE: canvas commands require foreground",
        },
      };
    });

    const respond = await invokeNode({
      nodeRegistry,
      requestParams: {
        nodeId,
        command: "canvas.navigate",
      },
    });

    expect(nodeRegistry.invoke).toHaveBeenCalledTimes(1);
    expect(mocks.loadApnsRegistration).not.toHaveBeenCalled();
    expectPairingChanged(respond);
  });

  it("keeps a foreground-recovery wake alive across an ordinary disconnect cleanup", async () => {
    const nodeId = "ios-node-disconnect-during-foreground-wake";
    const registration = createDeferred<ReturnType<typeof directRegistration>>();
    mocks.loadApnsRegistration.mockReturnValue(registration.promise);
    mocks.resolveApnsAuthConfigFromEnv.mockResolvedValue(DIRECT_APNS_AUTH);
    mocks.sendApnsBackgroundWake.mockResolvedValue(DIRECT_APNS_RESULT);
    const nodeRegistry = backgroundNode({ nodeId });

    const invokePromise = invokeAt(nodeRegistry, nodeId, {
      command: "canvas.navigate",
      params: { url: "http://example.com/" },
    });
    await vi.waitFor(() => expect(mocks.loadApnsRegistration).toHaveBeenCalledTimes(1));

    clearNodeWakeState(nodeId);
    registration.resolve(directRegistration(nodeId));
    const respond = await invokePromise;

    expect(mocks.sendApnsBackgroundWake).toHaveBeenCalledTimes(1);
    const call = firstRespondCall(respond);
    const details = requireGatewayRecord(call[2]?.details, "queued foreground details");
    expectRecordFields(details.wake, "queued foreground wake", {
      path: "sent",
      available: true,
      throttled: false,
    });
  });

  it.each([
    { priorIdempotencyKey: "idem-foreground-deadline", heldActionCount: 1 },
    { priorIdempotencyKey: "idem-prior-foreground-action", heldActionCount: 2 },
  ])(
    "expires a held foreground wake and preserves the prior action with key $priorIdempotencyKey",
    async ({ priorIdempotencyKey, heldActionCount }) => {
      vi.useFakeTimers();
      const nodeId = `ios-node-foreground-deadline-${priorIdempotencyKey}`;
      const nodeRegistry = backgroundNode({
        nodeId,
        commands: ["canvas.navigate"],
        platform: heldActionCount === 1 ? "iPadOS 26.4.0" : "iOS 26.4.0",
      });
      const requestParams = {
        nodeId,
        command: "canvas.navigate",
        params: { url: "https://example.com/foreground" },
        idempotencyKey: "idem-foreground-deadline",
        timeoutMs: 100,
      };
      mocks.loadApnsRegistration.mockResolvedValue(null);
      await invokeNode({
        nodeRegistry,
        requestParams: { ...requestParams, idempotencyKey: priorIdempotencyKey },
      });
      const original = await pendingPayload(nodeId);
      const originalActionId = requireString(
        expectQueuedAction(original, { command: "canvas.navigate" }).id,
        "original pending action id",
      );
      directWake(nodeId);
      const wake = createDeferred<typeof DIRECT_APNS_RESULT>();
      mocks.sendApnsBackgroundWake.mockReturnValue(wake.promise);
      const invocation = invokeNode({ nodeRegistry, requestParams });
      let respond: Awaited<typeof invocation> | undefined;
      void invocation.then((value) => {
        respond = value;
      });
      try {
        await vi.advanceTimersByTimeAsync(0);
        expect(mocks.sendApnsBackgroundWake).toHaveBeenCalledOnce();
        const queued = await pendingPayload(nodeId);
        expect(queued.actions).toHaveLength(heldActionCount);
        expect(queued.actions).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ id: originalActionId, command: "canvas.navigate" }),
          ]),
        );

        await vi.advanceTimersByTimeAsync(100);
        expect(
          respond,
          "foreground wake must not hold the invocation past its deadline",
        ).toBeDefined();
        const completed = expectDefined(respond, "completed invocation response");
        expectInvokeTimeout(completed);
        expect(completed).toHaveBeenCalledOnce();
        const afterTimeout = await pendingPayload(nodeId);
        expectQueuedAction(afterTimeout, { id: originalActionId, command: "canvas.navigate" });

        wake.resolve(DIRECT_APNS_RESULT);
        await vi.advanceTimersByTimeAsync(0);
        await invocation;
        expect(completed).toHaveBeenCalledOnce();
        const afterWake = await pendingPayload(nodeId);
        expect(afterWake.actions).toEqual(afterTimeout.actions);
      } finally {
        wake.resolve(DIRECT_APNS_RESULT);
        await vi.advanceTimersByTimeAsync(0);
        await invocation;
      }
    },
  );

  it("queues iOS foreground-only command failures and keeps them until acked", async () => {
    mocks.loadApnsRegistration.mockResolvedValue(null);
    const nodeId = "ios-node-queued";
    const respond = await invokeForeground(nodeId, {
      requestParams: { params: { url: "http://example.com/" } },
    });
    expectInvokeError(respond, {
      code: ErrorCodes.UNAVAILABLE,
      message: "node command queued until iOS returns to foreground",
    });
    expect(mocks.sendApnsBackgroundWake).not.toHaveBeenCalled();
    const payload = await pendingPayload(nodeId);
    expect(payload.nodeId).toBe(nodeId);
    const action = expectQueuedAction(payload, {
      command: "canvas.navigate",
      paramsJSON: JSON.stringify({ url: "http://example.com/" }),
    });
    expect(await pendingPayload(nodeId)).toEqual(payload);
    const queuedActionId = requireString(action.id, "queued action id");
    expect(queuedActionId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(
      requireRespondPayload(
        firstRespondCall(await ackPending(nodeId, [queuedActionId], ["canvas.navigate"])),
        "ack",
      ),
    ).toMatchObject({ nodeId, ackedIds: [queuedActionId], remainingCount: 0 });
    expect(await pendingPayload(nodeId)).toMatchObject({ nodeId, actions: [] });
  });

  it.each(["agent runtime", "forwarded approval"])(
    "does not persist %s authority into a later foreground pull",
    async (authority) => {
      mocks.loadApnsRegistration.mockResolvedValue(null);
      const nodeId = `ios-node-${authority}`;
      const operationalRunInstance = createOperationalRunInstanceRef("run-1");
      const client = createOperatorClient();
      if (authority === "forwarded approval") {
        mocks.sanitizeNodeInvokeParamsForForwarding.mockReturnValueOnce({
          ok: true,
          params: { url: "https://example.com" },
          approvalAuthority: { recordId: "approval-1", decision: "allow-once" },
        });
      }
      const respond = await invokeForeground(
        nodeId,
        authority === "agent runtime"
          ? {
              client: {
                ...client,
                internal: {
                  agentRuntimeIdentity: {
                    kind: "agentRuntime",
                    agentId: "main",
                    sessionKey: "agent:main:main",
                    operationalRunInstance,
                    delegatedAuthority: {
                      kind: "local",
                      operationalRunInstance,
                      lifecycleGeneration: "generation-1",
                      claimId: "claim-1",
                    },
                  },
                },
              },
              validateAgentRuntimeApprovalAuthority: () => true,
            }
          : {
              client,
              execApprovalManager: { projectDecisionIfActive: (_id, decision) => decision },
            },
      );
      expectInvokeError(respond, {
        details: { nodeError: { code: "NODE_BACKGROUND_UNAVAILABLE" } },
      });
      expect((await pendingPayload(nodeId)).actions).toEqual([]);
    },
  );

  it("drops queued actions that are no longer allowed at pull time", async () => {
    mocks.loadApnsRegistration.mockResolvedValue(null);
    const nodeId = "ios-node-policy";
    const commands = ["camera.snap", "canvas.navigate"];
    const allowlistedCommands = new Set(commands);
    mocks.resolveNodeCommandAllowlist.mockImplementation(() => new Set(allowlistedCommands));
    mocks.isNodeCommandAllowed.mockImplementation(({ command, declaredCommands, allowlist }) => {
      if (!allowlist.has(command)) {
        return { ok: false, reason: "command not allowlisted" };
      }
      if (!declaredCommands?.includes(command)) {
        return { ok: false, reason: "command not declared by node" };
      }
      return { ok: true };
    });
    await invokeForeground(nodeId, {
      nodeRegistry: backgroundNode({ nodeId, commands }),
      requestParams: { command: "camera.snap", params: { facing: "front" } },
    });
    const payload = await pendingPayload(nodeId, commands);
    expect(payload.nodeId).toBe(nodeId);
    expectQueuedAction(payload, {
      command: "camera.snap",
      paramsJSON: JSON.stringify({ facing: "front" }),
    });
    allowlistedCommands.delete("camera.snap");
    expect(await pendingPayload(nodeId, commands)).toMatchObject({ nodeId, actions: [] });
  });

  it("does not let a prior-generation session pull or ack current-generation actions", async () => {
    const nodeId = "ios-node-prior-generation-pending";
    mocks.loadApnsRegistration.mockResolvedValue(null);
    await invokeForeground(nodeId);
    expectInvokeError(await pullPending(nodeId, ["canvas.navigate"], null), {
      details: { code: "PAIRING_CHANGED" },
    });
    const payload = await pendingPayload(nodeId);
    const id = requireString(
      expectQueuedAction(payload, { command: "canvas.navigate" }).id,
      "action id",
    );
    expect(
      firstRespondCall(await ackPending(nodeId, [id], ["canvas.navigate"], null)),
    ).toMatchObject([false, undefined, { details: { code: "PAIRING_CHANGED" } }]);
    expect((await pendingPayload(nodeId)).actions).toHaveLength(1);
  });

  it("isolates foreground actions from replacement and stale-generation pulls", async () => {
    const nodeId = "ios-node-stale-pull";
    mocks.loadApnsRegistration.mockResolvedValue(null);
    await invokeForeground(nodeId);
    mocks.captureNodePairingGeneration.mockResolvedValue({ nodeId, key: `generation:${nodeId}:2` });
    expect(await pendingPayload(nodeId)).toMatchObject({ nodeId, actions: [] });
    await invokeForeground(nodeId, { requestParams: { idempotencyKey: "replacement" } });
    mocks.captureNodePairingGeneration.mockResolvedValue({ nodeId, key: `generation:${nodeId}:1` });
    expect((await pendingPayload(nodeId)).actions).toHaveLength(1);
    mocks.captureNodePairingGeneration.mockResolvedValue({ nodeId, key: `generation:${nodeId}:2` });
    expect((await pendingPayload(nodeId)).actions).toHaveLength(1);
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
