// Upgrade regression: retired Control UI bypass users can explicitly pair without host-shell recovery.
import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { WebSocket } from "ws";
import {
  loadOrCreateDeviceIdentity,
  publicKeyRawBase64UrlFromPem,
  signDevicePayload,
} from "../infra/device-identity.js";
import { buildDeviceAuthPayload } from "./device-auth.js";
import { CONTROL_UI_CLIENT } from "./server.auth.test-helpers.js";
import {
  connectReq,
  createGatewaySuiteHarness,
  installGatewayTestHooks,
  readConnectChallengeNonce,
  rpcReq,
  testState,
} from "./test-helpers.js";

installGatewayTestHooks({ scope: "suite" });

const BROWSER_ORIGIN = "https://control.example.com";
const SCOPES = ["operator.admin", "operator.pairing"];

async function signedDevice(ws: WebSocket, identityPath: string) {
  const nonce = await readConnectChallengeNonce(ws);
  const identity = loadOrCreateDeviceIdentity({ path: identityPath });
  const signedAt = Date.now();
  const payload = buildDeviceAuthPayload({
    deviceId: identity.deviceId,
    clientId: CONTROL_UI_CLIENT.id,
    clientMode: CONTROL_UI_CLIENT.mode,
    role: "operator",
    scopes: SCOPES,
    signedAtMs: signedAt,
    token: "secret",
    nonce: nonce ?? "",
  });
  return {
    identity,
    device: {
      id: identity.deviceId,
      publicKey: publicKeyRawBase64UrlFromPem(identity.publicKeyPem),
      signature: signDevicePayload(identity.privateKeyPem, payload),
      signedAt,
      nonce: nonce ?? "",
    },
  };
}

describe("Control UI device-auth upgrade migration", () => {
  it("keeps only the signed legacy browser online until it explicitly pairs", async () => {
    const { writeConfigFile } = await import("../config/config.js");
    await writeConfigFile({
      meta: { lastTouchedVersion: "2026.7.1" },
      gateway: {
        trustedProxies: ["127.0.0.1"],
        controlUi: {
          allowedOrigins: [BROWSER_ORIGIN],
          dangerouslyDisableDeviceAuth: true,
        },
      },
    });
    testState.gatewayAuth = { mode: "token", token: "secret" };
    const harness = await createGatewaySuiteHarness();
    const { requestDevicePairing } = await import("../infra/device-pairing.js");
    const otherIdentityPath = path.join(
      os.tmpdir(),
      `openclaw-other-pending-${randomUUID()}.sqlite`,
    );
    const otherIdentity = loadOrCreateDeviceIdentity({ path: otherIdentityPath });
    await requestDevicePairing({
      deviceId: otherIdentity.deviceId,
      publicKey: publicKeyRawBase64UrlFromPem(otherIdentity.publicKeyPem),
      role: "operator",
      scopes: SCOPES,
    });
    const identityPath = path.join(
      os.tmpdir(),
      `openclaw-device-auth-migration-${randomUUID()}.sqlite`,
    );
    const headers = {
      origin: BROWSER_ORIGIN,
      "x-forwarded-for": "203.0.113.50",
    };
    let firstWs: WebSocket | undefined;
    let competingWs: WebSocket | undefined;
    let secondWs: WebSocket | undefined;
    try {
      firstWs = await harness.openWs(headers);
      const first = await signedDevice(firstWs, identityPath);
      const firstConnect = await connectReq(firstWs, {
        token: "secret",
        scopes: SCOPES,
        client: CONTROL_UI_CLIENT,
        device: first.device,
      });
      expect(firstConnect.ok).toBe(true);
      expect(firstConnect.payload).toMatchObject({
        deviceAuthMigration: { pending: true },
        auth: { role: "operator", scopes: ["operator.pairing"] },
      });
      expect(
        (firstConnect.payload as { auth?: { deviceToken?: string } } | undefined)?.auth
          ?.deviceToken,
      ).toBeUndefined();
      const unrelatedAdminCall = await rpcReq(firstWs, "config.get", {});
      expect(unrelatedAdminCall.ok).toBe(false);
      expect(unrelatedAdminCall.error?.message).toContain("missing scope");

      competingWs = await harness.openWs(headers);
      const competing = await signedDevice(competingWs, otherIdentityPath);
      const competingConnect = await connectReq(competingWs, {
        token: "secret",
        scopes: SCOPES,
        client: CONTROL_UI_CLIENT,
        device: competing.device,
      });
      expect(competingConnect.ok).toBe(true);
      expect(competingConnect.payload).toMatchObject({
        auth: { scopes: ["operator.pairing"] },
      });
      const firstClosed = new Promise<number>((resolve) => {
        firstWs!.once("close", resolve);
      });
      const competingClosed = new Promise<number>((resolve) => {
        competingWs!.once("close", resolve);
      });

      const list = await rpcReq<{
        pending: Array<{ requestId: string; deviceId: string }>;
      }>(firstWs, "device.pair.list", {});
      expect(list.ok).toBe(true);
      expect(list.payload?.pending).toHaveLength(1);
      const pending = list.payload?.pending[0];
      expect(pending?.deviceId).toBe(first.identity.deviceId);
      const competingList = await rpcReq<{
        pending: Array<{ requestId: string; deviceId: string }>;
      }>(competingWs, "device.pair.list", {});
      const competingPending = competingList.payload?.pending[0];
      expect(competingPending?.deviceId).toBe(competing.identity.deviceId);

      const [firstApproval, competingApproval] = await Promise.allSettled([
        rpcReq(firstWs, "device.pair.approve", { requestId: pending?.requestId }),
        rpcReq(competingWs, "device.pair.approve", {
          requestId: competingPending?.requestId,
        }),
      ]);
      const firstWon = firstApproval.status === "fulfilled" && firstApproval.value.ok;
      const competingWon = competingApproval.status === "fulfilled" && competingApproval.value.ok;
      expect([firstWon, competingWon].filter(Boolean)).toHaveLength(1);
      if (firstWon) {
        await expect(competingClosed).resolves.toBe(4001);
        competingWs = undefined;
      } else {
        await expect(firstClosed).resolves.toBe(4001);
        firstWs = undefined;
      }

      firstWs?.close();
      firstWs = undefined;
      competingWs?.close();
      competingWs = undefined;
      secondWs = await harness.openWs(headers);
      const second = await signedDevice(secondWs, firstWon ? identityPath : otherIdentityPath);
      const secondConnect = await connectReq(secondWs, {
        token: "secret",
        scopes: SCOPES,
        client: CONTROL_UI_CLIENT,
        device: second.device,
      });
      expect(secondConnect.ok).toBe(true);
      expect(
        (secondConnect.payload as { deviceAuthMigration?: unknown } | undefined)
          ?.deviceAuthMigration,
      ).toBeUndefined();
      expect(
        (secondConnect.payload as { auth?: { deviceToken?: string } } | undefined)?.auth
          ?.deviceToken,
      ).toEqual(expect.any(String));
      expect(
        (secondConnect.payload as { auth?: { scopes?: string[] } } | undefined)?.auth?.scopes,
      ).toEqual(expect.arrayContaining(SCOPES));
    } finally {
      firstWs?.close();
      competingWs?.close();
      secondWs?.close();
      await harness.close();
    }
  });
});
