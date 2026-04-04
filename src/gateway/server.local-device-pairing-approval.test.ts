import { describe, expect, test } from "vitest";
import {
  approveDevicePairing,
  getPairedDevice,
  listDevicePairing,
} from "../infra/device-pairing.js";
import { loadDeviceIdentity, openTrackedWs } from "./device-authz.test-helpers.js";
import { connectReq, installGatewayTestHooks, startServerWithClient } from "./test-helpers.js";

installGatewayTestHooks({ scope: "suite" });

describe("gateway local device pairing approval", () => {
  test("requires approval before pairing a fresh shared-auth device with no requested operator scopes", async () => {
    const started = await startServerWithClient("secret");
    const loaded = loadDeviceIdentity("local-not-paired-empty-scope-regression");
    let requesterWs: Awaited<ReturnType<typeof openTrackedWs>> | undefined;

    try {
      requesterWs = await openTrackedWs(started.port);
      const connect = await connectReq(requesterWs, {
        token: "secret",
        deviceIdentityPath: loaded.identityPath,
        scopes: [],
      });

      expect(connect.ok).toBe(false);
      expect(connect.error?.message).toBe("pairing required");

      const pending = await listDevicePairing();
      expect(pending.pending).toHaveLength(1);
      expect(
        (connect.error?.details as { requestId?: unknown; code?: string } | undefined)?.requestId,
      ).toBe(pending.pending[0]?.requestId);
      expect(pending.pending[0]?.deviceId).toBe(loaded.identity.deviceId);
      expect(pending.pending[0]?.scopes ?? []).toEqual([]);

      const paired = await getPairedDevice(loaded.identity.deviceId);
      expect(paired).toBeNull();
    } finally {
      requesterWs?.close();
      started.ws.close();
      await started.server.close();
      started.envSnapshot.restore();
    }
  });

  test("requires approval before granting newly requested operator scopes to an unpaired shared-auth device", async () => {
    const started = await startServerWithClient("secret");
    const loaded = loadDeviceIdentity("local-not-paired-admin-scope-regression");
    let requesterWs: Awaited<ReturnType<typeof openTrackedWs>> | undefined;

    try {
      requesterWs = await openTrackedWs(started.port);
      const connect = await connectReq(requesterWs, {
        token: "secret",
        deviceIdentityPath: loaded.identityPath,
        scopes: ["operator.admin"],
      });

      expect(connect.ok).toBe(false);
      expect(connect.error?.message).toBe("pairing required");

      const pending = await listDevicePairing();
      expect(pending.pending).toHaveLength(1);
      expect(
        (connect.error?.details as { requestId?: unknown; code?: string } | undefined)?.requestId,
      ).toBe(pending.pending[0]?.requestId);
      expect(pending.pending[0]?.deviceId).toBe(loaded.identity.deviceId);
      expect(pending.pending[0]?.scopes).toEqual(["operator.admin"]);

      const paired = await getPairedDevice(loaded.identity.deviceId);
      expect(paired).toBeNull();
    } finally {
      requesterWs?.close();
      started.ws.close();
      await started.server.close();
      started.envSnapshot.restore();
    }
  });

  test("allows the requested operator scopes after an explicit approval", async () => {
    const started = await startServerWithClient("secret");
    const loaded = loadDeviceIdentity("explicit-local-admin-approval-regression");
    let requesterWs: Awaited<ReturnType<typeof openTrackedWs>> | undefined;
    let approvedDeviceWs: Awaited<ReturnType<typeof openTrackedWs>> | undefined;

    try {
      requesterWs = await openTrackedWs(started.port);
      const connect = await connectReq(requesterWs, {
        token: "secret",
        deviceIdentityPath: loaded.identityPath,
        scopes: ["operator.admin"],
      });
      expect(connect.ok).toBe(false);
      expect(connect.error?.message).toBe("pairing required");

      const pending = await listDevicePairing();
      const requestId = pending.pending[0]?.requestId;
      expect(requestId).toBeTruthy();

      const approved = await approveDevicePairing(String(requestId), {
        callerScopes: ["operator.admin"],
      });
      expect(approved?.status).toBe("approved");

      const paired = await getPairedDevice(loaded.identity.deviceId);
      expect(paired?.approvedScopes).toEqual(["operator.admin"]);
      expect(paired?.tokens?.operator?.scopes).toEqual([
        "operator.admin",
        "operator.read",
        "operator.write",
      ]);
      expect(paired?.tokens?.operator?.token).toBeTruthy();

      approvedDeviceWs = await openTrackedWs(started.port);
      const reconnect = await connectReq(approvedDeviceWs, {
        skipDefaultAuth: true,
        deviceToken: paired?.tokens?.operator?.token,
        deviceIdentityPath: loaded.identityPath,
        scopes: ["operator.admin"],
      });
      expect(reconnect.ok).toBe(true);
    } finally {
      approvedDeviceWs?.close();
      requesterWs?.close();
      started.ws.close();
      await started.server.close();
      started.envSnapshot.restore();
    }
  });
});
