import { describe, expect, it, vi } from "vitest";
import type { NodePairingRequestInput } from "../infra/node-pairing.js";
import { reconcileNodePairingOnConnect } from "./node-connect-reconcile.js";
import type { ConnectParams } from "./protocol/index.js";

function makeNodeConnectParams(overrides?: Partial<ConnectParams>): ConnectParams {
  return {
    minProtocol: 1,
    maxProtocol: 1,
    client: {
      id: "ios-node-1",
      version: "test",
      platform: "ios",
      mode: "node",
    },
    commands: ["canvas.snapshot"],
    ...overrides,
  };
}

describe("reconcileNodePairingOnConnect", () => {
  it("includes declared permissions in pending node pairing requests", async () => {
    const requestPairing = vi.fn(async (input: NodePairingRequestInput) => ({
      status: "pending" as const,
      request: { ...input, requestId: "req-1", ts: 1 },
      created: true,
    }));

    await reconcileNodePairingOnConnect({
      cfg: {} as never,
      connectParams: makeNodeConnectParams({
        permissions: { camera: true, notifications: false },
      }),
      pairedNode: null,
      requestPairing,
    });

    expect(requestPairing).toHaveBeenCalledWith(
      expect.objectContaining({
        nodeId: "ios-node-1",
        commands: ["canvas.snapshot"],
        permissions: { camera: true, notifications: false },
      }),
    );
  });
});
