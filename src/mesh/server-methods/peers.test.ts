import { describe, expect, it, vi, beforeEach } from "vitest";
import type {
  GatewayRequestHandlers,
  GatewayRequestHandlerOptions,
  ErrorShape,
} from "../../gateway/server-methods/types.js";
import { MeshCapabilityRegistry } from "../capabilities.js";
import { PeerRegistry } from "../peer-registry.js";
import type { PeerSession } from "../types.js";
import { createMeshPeersHandlers } from "./peers.js";

function createMockSocket() {
  return { send: vi.fn(), close: vi.fn(), readyState: 1 } as unknown as PeerSession["socket"];
}

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

describe("mesh.peers handler", () => {
  let peerRegistry: PeerRegistry;
  let capabilityRegistry: MeshCapabilityRegistry;
  let handlers: GatewayRequestHandlers;

  beforeEach(() => {
    peerRegistry = new PeerRegistry();
    capabilityRegistry = new MeshCapabilityRegistry();
    handlers = createMeshPeersHandlers({
      peerRegistry,
      capabilityRegistry,
      localDeviceId: "local-device",
    });
  });

  it("mesh.peers returns connected peer list", async () => {
    peerRegistry.register({
      deviceId: "peer-a",
      connId: "c1",
      displayName: "Mac",
      socket: createMockSocket(),
      outbound: true,
      capabilities: ["channel:telegram"],
      connectedAtMs: 1000,
    });

    const { ok, payload } = await callHandler(handlers, "mesh.peers");
    expect(ok).toBe(true);
    const p = payload as {
      peers: Array<{
        deviceId: string;
        displayName: string;
        outbound: boolean;
        capabilities: string[];
      }>;
    };
    expect(p.peers).toHaveLength(1);
    expect(p.peers[0].deviceId).toBe("peer-a");
    expect(p.peers[0].displayName).toBe("Mac");
    expect(p.peers[0].outbound).toBe(true);
    expect(p.peers[0].capabilities).toEqual(["channel:telegram"]);
  });

  it("mesh.status returns localDeviceId and peerCount", async () => {
    peerRegistry.register({
      deviceId: "peer-a",
      connId: "c1",
      socket: createMockSocket(),
      outbound: false,
      capabilities: [],
      connectedAtMs: 1000,
    });

    const { ok, payload } = await callHandler(handlers, "mesh.status");
    expect(ok).toBe(true);
    const s = payload as { localDeviceId: string; connectedPeers: number; peers: unknown[] };
    expect(s.localDeviceId).toBe("local-device");
    expect(s.connectedPeers).toBe(1);
    expect(s.peers).toHaveLength(1);
  });

  it("no peers returns empty list", async () => {
    const { ok, payload } = await callHandler(handlers, "mesh.peers");
    expect(ok).toBe(true);
    expect((payload as { peers: unknown[] }).peers).toEqual([]);
  });
});
