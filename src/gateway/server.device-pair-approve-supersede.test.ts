import { describe, expect, test } from "vitest";
import { getPairedDevice, requestDevicePairing } from "../infra/device-pairing.js";
import {
  connectOk,
  installGatewayTestHooks,
  rpcReq,
  startServerWithClient,
} from "./test-helpers.js";

installGatewayTestHooks({ scope: "suite" });

describe("gateway device.pair.approve superseded request ids", () => {
  test("rejects approving a superseded request id", async () => {
    const started = await startServerWithClient("secret");

    try {
      const first = await requestDevicePairing({
        deviceId: "supersede-device-1",
        publicKey: "supersede-public-key",
        role: "node",
        scopes: ["node.exec"],
      });
      const second = await requestDevicePairing({
        deviceId: "supersede-device-1",
        publicKey: "supersede-public-key",
        role: "operator",
        scopes: ["operator.admin"],
      });

      expect(second.request.requestId).not.toBe(first.request.requestId);
      await connectOk(started.ws);

      const staleApprove = await rpcReq(started.ws, "device.pair.approve", {
        requestId: first.request.requestId,
      });
      expect(staleApprove.ok).toBe(false);
      expect(staleApprove.error?.message).toBe("unknown requestId");

      const latestApprove = await rpcReq(started.ws, "device.pair.approve", {
        requestId: second.request.requestId,
      });
      expect(latestApprove.ok).toBe(true);

      const paired = await getPairedDevice("supersede-device-1");
      expect(paired?.role).toBe("operator");
      expect(paired?.scopes).toEqual(["operator.admin"]);
    } finally {
      started.ws.close();
      await started.server.close();
      started.envSnapshot.restore();
    }
  });
});
