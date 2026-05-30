import { describe, expect, it, vi } from "vitest";
import { ErrorCodes } from "../../../packages/gateway-protocol/src/index.js";
import { handleNodeInvokeResult } from "./nodes.handlers.invoke-result.js";
import type { GatewayRequestContext } from "./shared-types.js";

function makeContext(overrides?: { handleInvokeResultResult?: boolean }) {
  return {
    nodeRegistry: {
      handleInvokeResult: vi.fn(() => overrides?.handleInvokeResultResult ?? true),
    },
    logGateway: {
      debug: vi.fn(),
      warn: vi.fn(),
      info: vi.fn(),
      error: vi.fn(),
    },
  } as unknown as GatewayRequestContext;
}

function makeClient(instanceId: string, deviceId = "device-1") {
  return {
    connect: {
      client: {
        id: "node-client",
        mode: "node",
        instanceId,
      },
      device: {
        id: deviceId,
      },
    },
  } as never;
}

function makeErrorCode(payload: unknown): number | undefined {
  const obj = payload as { message?: string; code?: number } | undefined;
  return obj?.code;
}

describe("node.invoke.result", () => {
  it("accepts a matching trimmed instanceId as node identity", async () => {
    const respond = vi.fn();
    const context = makeContext();
    await handleNodeInvokeResult({
      params: {
        id: "1",
        nodeId: "custom-node-id",
        ok: true,
      },
      respond,
      context,
      client: makeClient(" custom-node-id "),
      req: { type: "req", id: "r1", method: "node.invoke.result" },
      isWebchatConnect: () => false,
    });

    expect(respond).toHaveBeenCalledWith(true, { ok: true }, undefined);
    expect(context.nodeRegistry.handleInvokeResult).toHaveBeenCalledWith({
      id: "1",
      nodeId: "custom-node-id",
      connId: undefined,
      ok: true,
      payload: undefined,
      payloadJSON: null,
      error: null,
    });
  });

  it("rejects invoke results for mismatched node identities", async () => {
    const respond = vi.fn();
    const context = makeContext();
    await handleNodeInvokeResult({
      params: {
        id: "1",
        nodeId: "custom-node-id",
        ok: true,
      },
      respond,
      context,
      client: makeClient("other-node-id"),
      req: { type: "req", id: "r2", method: "node.invoke.result" },
      isWebchatConnect: () => false,
    });

    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        code: ErrorCodes.INVALID_REQUEST,
        message: "nodeId mismatch",
      }),
    );
    expect(context.nodeRegistry.handleInvokeResult).not.toHaveBeenCalled();
    const call = respond.mock.calls[0] as [boolean, unknown?, { code?: number; message?: string }?];
    expect(makeErrorCode(call[2])).toBe(ErrorCodes.INVALID_REQUEST);
  });
});
