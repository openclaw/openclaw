import { describe, expect, it } from "vitest";
import { withTempHome } from "../../../test/helpers/temp-home.js";
import type {
  GatewayRequestHandlers,
  GatewayRequestHandlerOptions,
  ErrorShape,
} from "../../gateway/server-methods/types.js";
import { listTrustedPeers } from "../peer-trust.js";
import { createMeshTrustHandlers } from "./trust.js";

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

describe("mesh trust handlers", () => {
  it("mesh.trust.add with valid deviceId adds to store", async () => {
    await withTempHome(async () => {
      const handlers = createMeshTrustHandlers();
      const { ok, payload } = await callHandler(handlers, "mesh.trust.add", {
        deviceId: "peer-1",
        displayName: "Mac",
      });
      expect(ok).toBe(true);
      const p = payload as { added: boolean; deviceId: string };
      expect(p.added).toBe(true);
      expect(p.deviceId).toBe("peer-1");

      const peers = await listTrustedPeers();
      expect(peers).toHaveLength(1);
      expect(peers[0].deviceId).toBe("peer-1");
    });
  });

  it("mesh.trust.add with missing deviceId returns INVALID_PARAMS", async () => {
    await withTempHome(async () => {
      const handlers = createMeshTrustHandlers();
      const { ok, error } = await callHandler(handlers, "mesh.trust.add", {});
      expect(ok).toBe(false);
      expect(error?.code).toBe("INVALID_PARAMS");
    });
  });

  it("mesh.trust.add with empty string deviceId returns INVALID_PARAMS", async () => {
    await withTempHome(async () => {
      const handlers = createMeshTrustHandlers();
      const { ok, error } = await callHandler(handlers, "mesh.trust.add", { deviceId: "  " });
      expect(ok).toBe(false);
      expect(error?.code).toBe("INVALID_PARAMS");
    });
  });

  it("mesh.trust.remove removes from store", async () => {
    await withTempHome(async () => {
      const handlers = createMeshTrustHandlers();
      await callHandler(handlers, "mesh.trust.add", { deviceId: "peer-1" });
      const { ok, payload } = await callHandler(handlers, "mesh.trust.remove", {
        deviceId: "peer-1",
      });
      expect(ok).toBe(true);
      expect((payload as { removed: boolean }).removed).toBe(true);

      const peers = await listTrustedPeers();
      expect(peers).toHaveLength(0);
    });
  });

  it("mesh.trust.list returns all trusted peers", async () => {
    await withTempHome(async () => {
      const handlers = createMeshTrustHandlers();
      await callHandler(handlers, "mesh.trust.add", { deviceId: "peer-1" });
      await callHandler(handlers, "mesh.trust.add", { deviceId: "peer-2" });
      const { ok, payload } = await callHandler(handlers, "mesh.trust.list");
      expect(ok).toBe(true);
      const result = payload as { peers: Array<{ deviceId: string }> };
      expect(result.peers).toHaveLength(2);
      expect(result.peers.map((p) => p.deviceId)).toEqual(["peer-1", "peer-2"]);
    });
  });
});
