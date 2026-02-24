import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import type {
  GatewayRequestHandlers,
  GatewayRequestHandlerOptions,
  ErrorShape,
} from "../../gateway/server-methods/types.js";
import type { DeviceIdentity } from "../../infra/device-identity.js";
import { createMeshForwardHandlers } from "./forward.js";

// Mock the dynamic imports used in the handler.
vi.mock("../../config/config.js", () => ({
  loadConfig: vi.fn(() => ({ channels: {} })),
}));

vi.mock("../../infra/outbound/targets.js", () => ({
  resolveOutboundTarget: vi.fn(() => ({ ok: true, to: "resolved-target" })),
}));

vi.mock("../../infra/outbound/deliver.js", () => ({
  deliverOutboundPayloads: vi.fn(async () => [{ messageId: "msg-123" }]),
}));

const localIdentity: DeviceIdentity = {
  deviceId: "local-gateway-id",
  publicKeyPem: "mock-pub",
  privateKeyPem: "mock-priv",
};

function callHandler(
  handlers: GatewayRequestHandlers,
  method: string,
  params: Record<string, unknown> = {},
) {
  return new Promise<{ ok: boolean; payload?: unknown; error?: ErrorShape }>((resolve) => {
    const respond = (ok: boolean, payload?: unknown, error?: ErrorShape) =>
      resolve({ ok, payload, error });
    void handlers[method]({
      req: { method },
      params,
      client: null,
      isWebchatConnect: () => false,
      respond,
      context: {} as unknown as GatewayRequestHandlerOptions["context"],
    } as unknown as GatewayRequestHandlerOptions);
  });
}

describe("mesh.message.forward handler", () => {
  let handlers: GatewayRequestHandlers;

  beforeEach(() => {
    vi.clearAllMocks();
    handlers = createMeshForwardHandlers({ identity: localIdentity });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("valid forward delivers message and returns messageId", async () => {
    const { ok, payload } = await callHandler(handlers, "mesh.message.forward", {
      channel: "telegram",
      to: "user-123",
      message: "Hello from peer",
      originGatewayId: "remote-gateway-id",
      idempotencyKey: "idem-1",
    });
    expect(ok).toBe(true);
    const result = payload as { messageId: string; channel: string };
    expect(result.messageId).toBe("msg-123");
    expect(result.channel).toBe("telegram");
  });

  it("missing params returns INVALID_PARAMS error", async () => {
    const { ok, error } = await callHandler(handlers, "mesh.message.forward", {
      channel: "telegram",
      // missing: to, originGatewayId
    });
    expect(ok).toBe(false);
    expect(error?.code).toBe("INVALID_PARAMS");
  });

  it("loop detected (originGatewayId matches local) returns LOOP_DETECTED error", async () => {
    const { ok, error } = await callHandler(handlers, "mesh.message.forward", {
      channel: "telegram",
      to: "user-123",
      message: "looped message",
      originGatewayId: "local-gateway-id", // same as local identity
      idempotencyKey: "idem-2",
    });
    expect(ok).toBe(false);
    expect(error?.code).toBe("LOOP_DETECTED");
  });

  it("delivery failure returns DELIVERY_FAILED error", async () => {
    const { deliverOutboundPayloads } = await import("../../infra/outbound/deliver.js");
    vi.mocked(deliverOutboundPayloads).mockRejectedValueOnce(new Error("delivery boom"));

    const { ok, error } = await callHandler(handlers, "mesh.message.forward", {
      channel: "telegram",
      to: "user-123",
      message: "will fail",
      originGatewayId: "remote-gateway-id",
      idempotencyKey: "idem-3",
    });
    expect(ok).toBe(false);
    expect(error?.code).toBe("DELIVERY_FAILED");
  });

  it("target resolution failure returns TARGET_RESOLUTION_FAILED", async () => {
    const { resolveOutboundTarget } = await import("../../infra/outbound/targets.js");
    vi.mocked(resolveOutboundTarget).mockReturnValueOnce({
      ok: false,
      error: "no target",
    } as unknown as ReturnType<typeof resolveOutboundTarget>);

    const { ok, error } = await callHandler(handlers, "mesh.message.forward", {
      channel: "telegram",
      to: "user-123",
      message: "will fail resolve",
      originGatewayId: "remote-gateway-id",
      idempotencyKey: "idem-4",
    });
    expect(ok).toBe(false);
    expect(error?.code).toBe("TARGET_RESOLUTION_FAILED");
  });
});
