import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ErrorCodes } from "../protocol/index.js";
import { nodeHandlers } from "./nodes.js";

const mocks = vi.hoisted(() => ({
  loadConfig: vi.fn(() => ({})),
  resolveNodeCommandAllowlist: vi.fn(() => []),
  isNodeCommandAllowed: vi.fn(() => ({ ok: true })),
  sanitizeNodeInvokeParamsForForwarding: vi.fn(({ rawParams }: { rawParams: unknown }) => ({
    ok: true,
    params: rawParams,
  })),
  loadApnsRegistration: vi.fn(),
  resolveApnsAuthConfigFromEnv: vi.fn(),
  sendApnsBackgroundWake: vi.fn(),
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
  loadApnsRegistration: mocks.loadApnsRegistration,
  resolveApnsAuthConfigFromEnv: mocks.resolveApnsAuthConfigFromEnv,
  sendApnsBackgroundWake: mocks.sendApnsBackgroundWake,
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
};

const WAKE_WAIT_TIMEOUT_MS = 3_001;

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
  await nodeHandlers["node.invoke"]({
    params: makeNodeInvokeParams(params.requestParams),
    respond: respond as never,
    context: {
      nodeRegistry: params.nodeRegistry,
      execApprovalManager: undefined,
    } as never,
    client: null,
    req: { type: "req", id: "req-node-invoke", method: "node.invoke" },
    isWebchatConnect: () => false,
  });
  return respond;
}

function mockSuccessfulWakeConfig(nodeId: string) {
  mocks.loadApnsRegistration.mockResolvedValue({
    nodeId,
    token: "abcd1234abcd1234abcd1234abcd1234",
    topic: "ai.openclaw.ios",
    environment: "sandbox",
    updatedAtMs: 1,
  });
  mocks.resolveApnsAuthConfigFromEnv.mockResolvedValue({
    ok: true,
    value: {
      teamId: "TEAM123",
      keyId: "KEY123",
      privateKey: "-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----",
    },
  });
  mocks.sendApnsBackgroundWake.mockResolvedValue({
    ok: true,
    status: 200,
    tokenSuffix: "1234abcd",
    topic: "ai.openclaw.ios",
    environment: "sandbox",
  });
}

describe("node.invoke APNs wake path", () => {
  beforeEach(() => {
    mocks.loadConfig.mockReset();
    mocks.loadConfig.mockReturnValue({});
    mocks.resolveNodeCommandAllowlist.mockReset();
    mocks.resolveNodeCommandAllowlist.mockReturnValue([]);
    mocks.isNodeCommandAllowed.mockReset();
    mocks.isNodeCommandAllowed.mockReturnValue({ ok: true });
    mocks.sanitizeNodeInvokeParamsForForwarding.mockReset();
    mocks.sanitizeNodeInvokeParamsForForwarding.mockImplementation(
      ({ rawParams }: { rawParams: unknown }) => ({ ok: true, params: rawParams }),
    );
    mocks.loadApnsRegistration.mockReset();
    mocks.resolveApnsAuthConfigFromEnv.mockReset();
    mocks.sendApnsBackgroundWake.mockReset();
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

  it("wakes and retries invoke after the node reconnects", async () => {
    vi.useFakeTimers();
    mockSuccessfulWakeConfig("ios-node-reconnect");

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

  it("throttles repeated wake attempts for the same disconnected node", async () => {
    vi.useFakeTimers();
    mockSuccessfulWakeConfig("ios-node-throttle");

    const nodeRegistry = {
      get: vi.fn(() => undefined),
      invoke: vi.fn().mockResolvedValue({ ok: true }),
    };

    const first = invokeNode({
      nodeRegistry,
      requestParams: { nodeId: "ios-node-throttle", idempotencyKey: "idem-throttle-1" },
    });
    await vi.advanceTimersByTimeAsync(WAKE_WAIT_TIMEOUT_MS);
    await first;

    const second = invokeNode({
      nodeRegistry,
      requestParams: { nodeId: "ios-node-throttle", idempotencyKey: "idem-throttle-2" },
    });
    await vi.advanceTimersByTimeAsync(WAKE_WAIT_TIMEOUT_MS);
    await second;

    expect(mocks.sendApnsBackgroundWake).toHaveBeenCalledTimes(1);
    expect(nodeRegistry.invoke).not.toHaveBeenCalled();
  });
});
