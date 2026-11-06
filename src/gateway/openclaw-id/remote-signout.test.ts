import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { approveDevicePairing } from "../../infra/device-pairing-approval.js";
import { requestPairing } from "../../infra/device-pairing-fixtures.test-support.js";
import { verifyDeviceToken } from "../../infra/device-pairing-tokens.js";
import { getPairedDevice } from "../../infra/device-pairing.js";
import { createSuiteTempRootTracker } from "../../test-helpers/temp-dir.js";
import { closeStateDatabaseForTest } from "../../test-utils/database-cleanup.js";
import { linkedClaw } from "./openclaw-id.test-support.js";
import { createOpenClawIdService } from "./service.js";

const roots = createSuiteTempRootTracker({ prefix: "openclaw-remote-signout-" });
let baseDir: string;
beforeAll(async () => {
  baseDir = await roots.setup();
  vi.stubEnv("OPENCLAW_STATE_DIR", baseDir);
});
afterAll(async () => {
  await closeStateDatabaseForTest();
  vi.unstubAllEnvs();
  await roots.cleanup();
});

it("remote sign-out rejects the issued token on replay while keeping this device approved", async () => {
  const claw = await linkedClaw();
  const closeConnections = vi.fn();
  const service = createOpenClawIdService({
    getConfig: () => ({ enabled: true }),
    getStateDir: () => baseDir,
    getGatewayServer: () => undefined,
    log: { info: vi.fn(), warn: vi.fn() },
    createAuthority: async () => claw.authority,
  });
  service.bindEffects(async () => ({
    captureConnections: () => ["browser-rpc"],
    closeConnections,
    revokeDeviceTokens: async (tokens) => [...tokens],
  }));
  const identity = { deviceId: "browser", role: "operator", scopes: ["operator.read"] };
  const pending = await requestPairing({ ...identity, publicKey: "browser-public-key" }, baseDir);
  await approveDevicePairing(
    pending.request.requestId,
    { callerScopes: ["operator.admin"] },
    baseDir,
  );
  const issued = (await getPairedDevice(identity.deviceId, baseDir))!.tokens!.operator!;
  await claw.authority.bindToken(identity.deviceId, identity.role, claw.w1);
  const verify = () => verifyDeviceToken({ ...identity, token: issued.token, baseDir });
  expect(await verify()).toMatchObject({ ok: true });
  const otherPeer = `iroh:${"ab".repeat(32)}`;
  const other = { ...identity, deviceId: "other-browser" };
  const otherPending = await requestPairing({ ...other, publicKey: "other-public-key" }, baseDir);
  await approveDevicePairing(
    otherPending.request.requestId,
    { callerScopes: ["operator.admin"] },
    baseDir,
  );
  const otherToken = (await getPairedDevice(other.deviceId, baseDir))!.tokens!.operator!.token;
  await claw.authority.bindToken(other.deviceId, other.role, otherPeer);

  // The same production service route the private, QUIC-authenticated ingress invokes.
  const server = http.createServer((req, res) => {
    void service.serveTunnelApi(req, res, String(req.headers["x-test-peer"] ?? claw.w1));
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/_openclaw-id/v1/signout`;
  try {
    expect((await fetch(url)).status).toBe(405);
    // A body cannot select another browser: the authenticated peer owns the target.
    const response = await fetch(url, {
      method: "POST",
      body: JSON.stringify({ peerKey: otherPeer }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ signedOut: true });
    expect(await verify()).toMatchObject({ ok: false });
    expect(closeConnections).toHaveBeenCalledWith(["browser-rpc"]);
    expect(claw.authority.tokenBinding(identity.deviceId, identity.role)).toBeUndefined();
    expect(await verifyDeviceToken({ ...other, token: otherToken, baseDir })).toMatchObject({
      ok: true,
    });
    expect(claw.authority.tokenBinding(other.deviceId, other.role)).toBe(otherPeer);
    expect(
      (await fetch(url, { method: "POST", headers: { "x-test-peer": otherPeer } })).status,
    ).toBe(403);
    expect(await verifyDeviceToken({ ...other, token: otherToken, baseDir })).toMatchObject({
      ok: true,
    });
    // Sign-out is not owner-device removal: re-entry needs no certificate or pairing approval.
    expect(await claw.authority.resolvePeer(claw.w1)).toMatchObject({ kind: "owner" });
    expect((await getPairedDevice(identity.deviceId, baseDir))?.publicKey).toBe(
      "browser-public-key",
    );
    expect((await getPairedDevice(identity.deviceId, baseDir))?.roles).toContain("operator");
    // Current remote Control UI re-entry authenticates from the retained W principal, not
    // this revoked token. The loader independently requires fresh issuer authentication.
    expect((await claw.authority.admittedPeerKeys()).admitted).toContain(claw.w1);
    expect(await verify()).toMatchObject({ ok: false });
  } finally {
    await service.stop();
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  }
});
