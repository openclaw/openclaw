import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ErrorCodes } from "../protocol/index.js";
import { maybeWakeNodeWithApns, nodeHandlers } from "./nodes.js";

const mocks = vi.hoisted(() => ({
  loadConfig: vi.fn(() => ({})),
  resolveNodeCommandAllowlist: vi.fn(() => []),
  isNodeCommandAllowed: vi.fn(() => ({ ok: true })),
  sanitizeNodeInvokeParamsForForwarding: vi.fn(({ rawParams }: { rawParams: unknown }) => ({
    ok: true,
    params: rawParams,
  })),
  clearApnsRegistrationIfCurrent: vi.fn(),
  loadApnsRegistration: vi.fn(),
  resolveApnsAuthConfigFromEnv: vi.fn(),
  resolveApnsRelayConfigFromEnv: vi.fn(),
  sendApnsBackgroundWake: vi.fn(),
  sendApnsAlert: vi.fn(),
  shouldClearStoredApnsRegistration: vi.fn(() => false),
}));

vi.mock("../../config/config.js", () => ({
  loadConfig: mocks.loadConfig,
}));

vi.mock("../node-command-policy.js", () => ({
  resolveNodeCommandAllowlist: mocks.resolveNodeCommandAllowlist,
  isNodeCommandAllowed: mocks.isNodeCommandAllowed,
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

type RespondCall = [
  boolean,
  unknown?,
  {
    code?: number;
    message?: string;
    details?: unknown;
  }?,
];

type TestNodeSession = {
  nodeId: string;
  commands: string[];
  platform?: string;
};

const WAKE_WAIT_TIMEOUT_MS = 3_001;
const DEFAULT_RELAY_CONFIG = {
  baseUrl: "https://relay.example.com",
  timeoutMs: 1000,
} as const;
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

function mockDirectWakeConfig(nodeId: string, overrides: WakeResultOverrides = {}) {
  mocks.loadApnsRegistration.mockResolvedValue(directRegistration(nodeId));
  mocks.resolveApnsAuthConfigFromEnv.mockResolvedValue({
    ok: true,
    value: {
      teamId: "TEAM123",
      keyId: "KEY123",
      privateKey: "-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----", // pragma: allowlist secret
    },
  });
  mocks.sendApnsBackgroundWake.mockResolvedValue({
    ok: true,
    status: 200,
    tokenSuffix: "1234abcd",
    topic: "ai.openclaw.ios",
    environment: "sandbox",
    transport: "direct",
    ...overrides,
  });
}

function mockRelayWakeConfig(nodeId: string, overrides: WakeResultOverrides = {}) {
  mocks.loadConfig.mockReturnValue({
    gateway: {
      push: {
        apns: {
          relay: DEFAULT_RELAY_CONFIG,
        },
      },
    },
  });
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

function makeNodeInvokeParams(overrides?: Partial<Record<string, unknown>>) {
  return {
    nodeId: "ios-node-1",
    command: "camera.capture",
    params: { quality: "high" },
    timeoutMs: 5000,
    idempotencyKey: "idem-node-invoke",
    ...overrides,
  };
}

async function invokeNode(params: {
  nodeRegistry: {
    get: (nodeId: string) => TestNodeSession | undefined;
    invoke: (payload: {
      nodeId: string;
      command: string;
      params?: unknown;
      timeoutMs?: number;
      idempotencyKey?: string;
    }) => Promise<{
      ok: boolean;
      payload?: unknown;
      payloadJSON?: string | null;
      error?: { code?: string; message?: string } | null;
    }>;
  };
  requestParams?: Partial<Record<string, unknown>>;
}) {
  const respond = vi.fn();
  const logGateway = {
    info: vi.fn(),
    warn: vi.fn(),
  };
  await nodeHandlers["node.invoke"]({
    params: makeNodeInvokeParams(params.requestParams),
    respond: respond as never,
    context: {
      nodeRegistry: params.nodeRegistry,
      execApprovalManager: undefined,
      logGateway,
    } as never,
    client: null,
    req: { type: "req", id: "req-node-invoke", method: "node.invoke" },
    isWebchatConnect: () => false,
  });
  return respond;
}

async function pullPending(nodeId: string) {
  const respond = vi.fn();
  await nodeHandlers["node.pending.pull"]({
    params: {},
    respond: respond as never,
    context: {} as never,
    client: {
      connect: {
        role: "node",
        client: {
          id: nodeId,
          mode: "node",
          name: "ios-test",
          platform: "iOS 26.4.0",
          version: "test",
        },
      },
    } as never,
    req: { type: "req", id: "req-node-pending", method: "node.pending.pull" },
    isWebchatConnect: () => false,
  });
  return respond;
}

async function ackPending(nodeId: string, ids: string[]) {
  const respond = vi.fn();
  await nodeHandlers["node.pending.ack"]({
    params: { ids },
    respond: respond as never,
    context: {} as never,
    client: {
      connect: {
        role: "node",
        client: {
          id: nodeId,
          mode: "node",
          name: "ios-test",
          platform: "iOS 26.4.0",
          version: "test",
        },
      },
    } as never,
    req: { type: "req", id: "req-node-pending-ack", method: "node.pending.ack" },
    isWebchatConnect: () => false,
  });
  return respond;
}

describe("node.invoke APNs wake path", () => {
  beforeEach(() => {
    mocks.loadConfig.mockClear();
    mocks.loadConfig.mockReturnValue({});
    mocks.resolveNodeCommandAllowlist.mockClear();
    mocks.resolveNodeCommandAllowlist.mockReturnValue([]);
    mocks.isNodeCommandAllowed.mockClear();
    mocks.isNodeCommandAllowed.mockReturnValue({ ok: true });
    mocks.sanitizeNodeInvokeParamsForForwarding.mockClear();
    mocks.sanitizeNodeInvokeParamsForForwarding.mockImplementation(
      ({ rawParams }: { rawParams: unknown }) => ({ ok: true, params: rawParams }),
    );
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

  it("keeps the existing not-connected response when wake path is unavailable", async () => {
    mocks.loadApnsRegistration.mockResolvedValue(null);

    const nodeRegistry = {
      get: vi.fn(() => undefined),
      invoke: vi.fn().mockResolvedValue({ ok: true }),
    };

    const respond = await invokeNode({ nodeRegistry });
    const call = respond.mock.calls[0] as RespondCall | undefined;
    expect(call?.[0]).toBe(false);
    expect(call?.[2]?.code).toBe(ErrorCodes.UNAVAILABLE);
    expect(call?.[2]?.message).toBe("node not connected");
    expect(mocks.sendApnsBackgroundWake).not.toHaveBeenCalled();
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

    expect(first).toMatchObject({
      available: false,
      throttled: false,
      path: "no-auth",
      apnsReason: "relay config missing",
    });
    expect(second).toMatchObject({
      available: false,
      throttled: false,
      path: "no-auth",
      apnsReason: "relay config missing",
    });
    expect(mocks.resolveApnsRelayConfigFromEnv).toHaveBeenCalledTimes(2);
    expect(mocks.sendApnsBackgroundWake).not.toHaveBeenCalled();
  });

  it("wakes and retries invoke after the node reconnects", async () => {
    vi.useFakeTimers();
    mockDirectWakeConfig("ios-node-reconnect");

    let connected = false;
    const session: TestNodeSession = { nodeId: "ios-node-reconnect", commands: ["camera.capture"] };
    const nodeRegistry = {
      get: vi.fn((nodeId: string) => {
        if (nodeId !== "ios-node-reconnect") {
          return undefined;
        }
        return connected ? session : undefined;
      }),
      invoke: vi.fn().mockResolvedValue({
        ok: true,
        payload: { ok: true },
        payloadJSON: '{"ok":true}',
      }),
    };

    const invokePromise = invokeNode({
      nodeRegistry,
      requestParams: { nodeId: "ios-node-reconnect", idempotencyKey: "idem-reconnect" },
    });
    setTimeout(() => {
      connected = true;
    }, 300);

    await vi.advanceTimersByTimeAsync(WAKE_WAIT_TIMEOUT_MS);
    const respond = await invokePromise;

    expect(mocks.sendApnsBackgroundWake).toHaveBeenCalledTimes(1);
    expect(nodeRegistry.invoke).toHaveBeenCalledTimes(1);
    expect(nodeRegistry.invoke).toHaveBeenCalledWith(
      expect.objectContaining({
        nodeId: "ios-node-reconnect",
        command: "camera.capture",
      }),
    );
    const call = respond.mock.calls[0] as RespondCall | undefined;
    expect(call?.[0]).toBe(true);
    expect(call?.[1]).toMatchObject({ ok: true, nodeId: "ios-node-reconnect" });
  });

  it("clears stale registrations after an invalid device token wake failure", async () => {
    const registration = directRegistration("ios-node-stale");
    mocks.loadApnsRegistration.mockResolvedValue(registration);
    mockDirectWakeConfig("ios-node-stale", {
      ok: false,
      status: 400,
      reason: "BadDeviceToken",
    });
    mocks.shouldClearStoredApnsRegistration.mockReturnValue(true);

    const nodeRegistry = {
      get: vi.fn(() => undefined),
      invoke: vi.fn().mockResolvedValue({ ok: true }),
    };

    const respond = await invokeNode({
      nodeRegistry,
      requestParams: { nodeId: "ios-node-stale", idempotencyKey: "idem-stale" },
    });

    const call = respond.mock.calls[0] as RespondCall | undefined;
    expect(call?.[0]).toBe(false);
    expect(call?.[2]?.message).toBe("node not connected");
    expect(mocks.clearApnsRegistrationIfCurrent).toHaveBeenCalledWith({
      nodeId: "ios-node-stale",
      registration,
    });
  });

  it("does not clear relay registrations from wake failures", async () => {
    const registration = relayRegistration("ios-node-relay");
    mockRelayWakeConfig("ios-node-relay", {
      ok: false,
      status: 410,
      reason: "Unregistered",
    });
    mocks.shouldClearStoredApnsRegistration.mockReturnValue(false);

    const nodeRegistry = {
      get: vi.fn(() => undefined),
      invoke: vi.fn().mockResolvedValue({ ok: true }),
    };

    const respond = await invokeNode({
      nodeRegistry,
      requestParams: { nodeId: "ios-node-relay", idempotencyKey: "idem-relay" },
    });

    const call = respond.mock.calls[0] as RespondCall | undefined;
    expect(call?.[0]).toBe(false);
    expect(call?.[2]?.message).toBe("node not connected");
    expect(mocks.resolveApnsRelayConfigFromEnv).toHaveBeenCalledWith(process.env, {
      push: {
        apns: {
          relay: DEFAULT_RELAY_CONFIG,
        },
      },
    });
    expect(mocks.shouldClearStoredApnsRegistration).toHaveBeenCalledWith({
      registration,
      result: {
        ok: false,
        status: 410,
        reason: "Unregistered",
        tokenSuffix: "abcd1234",
        topic: "ai.openclaw.ios",
        environment: "production",
        transport: "relay",
      },
    });
    expect(mocks.clearApnsRegistrationIfCurrent).not.toHaveBeenCalled();
  });

  it("forces one retry wake when the first wake still fails to reconnect", async () => {
    vi.useFakeTimers();
    mockDirectWakeConfig("ios-node-throttle");

    const nodeRegistry = {
      get: vi.fn(() => undefined),
      invoke: vi.fn().mockResolvedValue({ ok: true }),
    };

    const invokePromise = invokeNode({
      nodeRegistry,
      requestParams: { nodeId: "ios-node-throttle", idempotencyKey: "idem-throttle-1" },
    });
    await vi.advanceTimersByTimeAsync(20_000);
    await invokePromise;

    expect(mocks.sendApnsBackgroundWake).toHaveBeenCalledTimes(2);
    expect(nodeRegistry.invoke).not.toHaveBeenCalled();
  });

  it("queues iOS foreground-only command failures and keeps them until acked", async () => {
    mocks.loadApnsRegistration.mockResolvedValue(null);

    const nodeRegistry = {
      get: vi.fn(() => ({
        nodeId: "ios-node-queued",
        commands: ["canvas.navigate"],
        platform: "iOS 26.4.0",
      })),
      invoke: vi.fn().mockResolvedValue({
        ok: false,
        error: {
          code: "NODE_BACKGROUND_UNAVAILABLE",
          message: "NODE_BACKGROUND_UNAVAILABLE: canvas/camera/screen commands require foreground",
        },
      }),
    };

    const respond = await invokeNode({
      nodeRegistry,
      requestParams: {
        nodeId: "ios-node-queued",
        command: "canvas.navigate",
        params: { url: "http://example.com/" },
        idempotencyKey: "idem-queued",
      },
    });
    const call = respond.mock.calls[0] as RespondCall | undefined;
    expect(call?.[0]).toBe(false);
    expect(call?.[2]?.code).toBe(ErrorCodes.UNAVAILABLE);
    expect(call?.[2]?.message).toBe("node command queued until iOS returns to foreground");
    expect(mocks.sendApnsBackgroundWake).not.toHaveBeenCalled();

    const pullRespond = await pullPending("ios-node-queued");
    const pullCall = pullRespond.mock.calls[0] as RespondCall | undefined;
    expect(pullCall?.[0]).toBe(true);
    expect(pullCall?.[1]).toMatchObject({
      nodeId: "ios-node-queued",
      actions: [
        expect.objectContaining({
          command: "canvas.navigate",
          paramsJSON: JSON.stringify({ url: "http://example.com/" }),
        }),
      ],
    });

    const repeatedPullRespond = await pullPending("ios-node-queued");
    const repeatedPullCall = repeatedPullRespond.mock.calls[0] as RespondCall | undefined;
    expect(repeatedPullCall?.[0]).toBe(true);
    expect(repeatedPullCall?.[1]).toMatchObject({
      nodeId: "ios-node-queued",
      actions: [
        expect.objectContaining({
          command: "canvas.navigate",
          paramsJSON: JSON.stringify({ url: "http://example.com/" }),
        }),
      ],
    });

    const queuedActionId = (pullCall?.[1] as { actions?: Array<{ id?: string }> } | undefined)
      ?.actions?.[0]?.id;
    expect(queuedActionId).toBeTruthy();

    const ackRespond = await ackPending("ios-node-queued", [queuedActionId!]);
    const ackCall = ackRespond.mock.calls[0] as RespondCall | undefined;
    expect(ackCall?.[0]).toBe(true);
    expect(ackCall?.[1]).toMatchObject({
      nodeId: "ios-node-queued",
      ackedIds: [queuedActionId],
      remainingCount: 0,
    });

    const emptyPullRespond = await pullPending("ios-node-queued");
    const emptyPullCall = emptyPullRespond.mock.calls[0] as RespondCall | undefined;
    expect(emptyPullCall?.[0]).toBe(true);
    expect(emptyPullCall?.[1]).toMatchObject({
      nodeId: "ios-node-queued",
      actions: [],
    });
  });

  it("dedupes queued foreground actions by idempotency key", async () => {
    mocks.loadApnsRegistration.mockResolvedValue(null);

    const nodeRegistry = {
      get: vi.fn(() => ({
        nodeId: "ios-node-dedupe",
        commands: ["canvas.navigate"],
        platform: "iPadOS 26.4.0",
      })),
      invoke: vi.fn().mockResolvedValue({
        ok: false,
        error: {
          code: "NODE_BACKGROUND_UNAVAILABLE",
          message: "NODE_BACKGROUND_UNAVAILABLE: canvas/camera/screen commands require foreground",
        },
      }),
    };

    await invokeNode({
      nodeRegistry,
      requestParams: {
        nodeId: "ios-node-dedupe",
        command: "canvas.navigate",
        params: { url: "http://example.com/first" },
        idempotencyKey: "idem-dedupe",
      },
    });
    await invokeNode({
      nodeRegistry,
      requestParams: {
        nodeId: "ios-node-dedupe",
        command: "canvas.navigate",
        params: { url: "http://example.com/first" },
        idempotencyKey: "idem-dedupe",
      },
    });

    const pullRespond = await pullPending("ios-node-dedupe");
    const pullCall = pullRespond.mock.calls[0] as RespondCall | undefined;
    expect(pullCall?.[0]).toBe(true);
    expect(pullCall?.[1]).toMatchObject({
      nodeId: "ios-node-dedupe",
      actions: [
        expect.objectContaining({
          command: "canvas.navigate",
          paramsJSON: JSON.stringify({ url: "http://example.com/first" }),
        }),
      ],
    });
    const actions = (pullCall?.[1] as { actions?: unknown[] } | undefined)?.actions ?? [];
    expect(actions).toHaveLength(1);
  });
});
