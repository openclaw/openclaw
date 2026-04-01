import { describe, expect, test } from "vitest";
import { WebSocket } from "ws";
import * as devicePairingModule from "../infra/device-pairing.js";
import { getPairedDevice } from "../infra/device-pairing.js";
import { loadDeviceIdentity, openTrackedWs } from "./device-authz.test-helpers.js";
import {
  connectOk,
  connectReq,
  installGatewayTestHooks,
  onceMessage,
  startServerWithClient,
} from "./test-helpers.js";

installGatewayTestHooks({ scope: "suite" });

describe("gateway silent local not-paired admin", () => {
  test("requires explicit approval before a fresh shared-auth device can request operator.admin", async () => {
    const started = await startServerWithClient("secret");
    const loaded = loadDeviceIdentity("silent-local-not-paired-admin");

    let watcherWs: WebSocket | undefined;
    let freshWs: WebSocket | undefined;

    try {
      watcherWs = await openTrackedWs(started.port);
      await connectOk(watcherWs, { scopes: ["operator.admin"] });
      const requestedEvent = onceMessage(
        watcherWs,
        (obj) => obj.type === "event" && obj.event === "device.pair.requested",
      );

      freshWs = await openTrackedWs(started.port);
      const firstConnect = await connectReq(freshWs, {
        token: "secret",
        deviceIdentityPath: loaded.identityPath,
        scopes: ["operator.admin"],
      });

      expect(firstConnect.ok).toBe(false);
      expect(firstConnect.error?.message).toBe("pairing required");

      const pending = await devicePairingModule.listDevicePairing();
      expect(pending.pending).toHaveLength(1);
      expect(
        (firstConnect.error?.details as { requestId?: unknown; code?: string } | undefined)
          ?.requestId,
      ).toBe(pending.pending[0]?.requestId);

      const requested = (await requestedEvent) as {
        payload?: { requestId?: string; deviceId?: string; scopes?: string[] };
      };
      expect(requested.payload?.requestId).toBe(pending.pending[0]?.requestId);
      expect(requested.payload?.deviceId).toBe(loaded.identity.deviceId);
      expect(requested.payload?.scopes).toEqual(["operator.admin"]);

      const paired = await getPairedDevice(loaded.identity.deviceId);
      expect(paired).toBeNull();
    } finally {
      watcherWs?.close();
      freshWs?.close();
      started.ws.close();
      await started.server.close();
      started.envSnapshot.restore();
    }
  });
});
