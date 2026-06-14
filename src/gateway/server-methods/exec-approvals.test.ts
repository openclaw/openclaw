import { describe, expect, it, vi } from "vitest";
import { ErrorCodes } from "../../../packages/gateway-protocol/src/index.js";
import type { ExecApprovalsFile } from "../../infra/exec-approvals.js";
import { execApprovalsHandlers } from "./exec-approvals.js";
import type { GatewayRequestContext, RespondFn } from "./types.js";

const FILE: ExecApprovalsFile = {
  version: 1,
  defaults: {
    security: "allowlist",
    ask: "on-miss",
  },
  agents: {},
};

function createContext(invoke: ReturnType<typeof vi.fn>): GatewayRequestContext {
  return {
    nodeRegistry: {
      invoke,
    },
  } as unknown as GatewayRequestContext;
}

async function callNodeSet(params: Record<string, unknown>, invoke: ReturnType<typeof vi.fn>) {
  const respond = vi.fn() as unknown as RespondFn;
  const handler = execApprovalsHandlers["exec.approvals.node.set"];
  if (!handler) {
    throw new Error("exec.approvals.node.set handler missing");
  }
  await handler({
    req: { type: "req", id: "req-1", method: "exec.approvals.node.set", params },
    params,
    client: null,
    isWebchatConnect: () => false,
    respond,
    context: createContext(invoke),
  });
  return respond as unknown as ReturnType<typeof vi.fn>;
}

describe("exec approval node methods", () => {
  it("rejects stale node approval writes before forwarding the set command", async () => {
    const invoke = vi.fn(async () => ({
      ok: true,
      payload: {
        path: "node://node-1/exec-approvals",
        exists: true,
        hash: "fresh-hash",
        file: FILE,
      },
    }));

    const respond = await callNodeSet(
      {
        nodeId: "node-1",
        file: FILE,
        baseHash: "stale-hash",
      },
      invoke,
    );

    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke).toHaveBeenCalledWith({
      nodeId: "node-1",
      command: "system.execApprovals.get",
      params: {},
    });
    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        code: ErrorCodes.INVALID_REQUEST,
        message: expect.stringContaining("exec.approvals.node.get"),
      }),
    );
  });

  it("rejects stale native node approval writes that return baseHash without file metadata", async () => {
    const invoke = vi.fn(async () => ({
      ok: true,
      payload: {
        enabled: true,
        defaultAction: "deny",
        hash: "fresh-native-hash",
        baseHash: "fresh-native-hash",
        rules: [],
      },
    }));

    const respond = await callNodeSet(
      {
        nodeId: "node-1",
        file: FILE,
        baseHash: "stale-native-hash",
      },
      invoke,
    );

    expect(invoke).toHaveBeenCalledTimes(1);
    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        code: ErrorCodes.INVALID_REQUEST,
        message: expect.stringContaining("exec.approvals.node.get"),
      }),
    );
  });

  it("requires a base hash when the node approval file already exists", async () => {
    const invoke = vi.fn(async () => ({
      ok: true,
      payload: {
        path: "node://node-1/exec-approvals",
        exists: true,
        hash: "fresh-hash",
        file: FILE,
      },
    }));

    const respond = await callNodeSet(
      {
        nodeId: "node-1",
        file: FILE,
      },
      invoke,
    );

    expect(invoke).toHaveBeenCalledTimes(1);
    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        code: ErrorCodes.INVALID_REQUEST,
        message: expect.stringContaining("base hash required"),
      }),
    );
  });

  it("forwards matching node approval writes after a fresh snapshot read", async () => {
    const nextPayload = {
      path: "node://node-1/exec-approvals",
      exists: true,
      hash: "next-hash",
      file: FILE,
    };
    const invoke = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        payload: {
          path: "node://node-1/exec-approvals",
          exists: true,
          hash: "fresh-hash",
          file: FILE,
        },
      })
      .mockResolvedValueOnce({
        ok: true,
        payloadJSON: JSON.stringify(nextPayload),
      });

    const respond = await callNodeSet(
      {
        nodeId: "node-1",
        file: FILE,
        baseHash: "fresh-hash",
      },
      invoke,
    );

    expect(invoke).toHaveBeenCalledTimes(2);
    expect(invoke).toHaveBeenNthCalledWith(2, {
      nodeId: "node-1",
      command: "system.execApprovals.set",
      params: {
        file: FILE,
        baseHash: "fresh-hash",
      },
    });
    expect(respond).toHaveBeenCalledWith(true, nextPayload, undefined);
  });
});
