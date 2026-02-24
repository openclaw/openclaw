import { describe, expect, it, vi, afterEach } from "vitest";
import { withTempHome } from "../../test/helpers/temp-home.js";
import { loadOrCreateDeviceIdentity } from "../infra/device-identity.js";
import { buildMeshConnectAuth, verifyMeshConnectAuth, buildMeshAuthPayload } from "./handshake.js";

describe("mesh handshake (Ed25519)", () => {
  afterEach(() => {
    if (vi.isFakeTimers()) {
      vi.useRealTimers();
    }
  });

  it("buildMeshConnectAuth() creates a valid signed payload", async () => {
    await withTempHome(async () => {
      const identity = loadOrCreateDeviceIdentity();
      const auth = buildMeshConnectAuth({ identity });
      expect(auth.deviceId).toBe(identity.deviceId);
      expect(auth.publicKey).toBeTruthy();
      expect(auth.signature).toBeTruthy();
      expect(auth.signedAtMs).toBeGreaterThan(0);
    });
  });

  it("verifyMeshConnectAuth() accepts a valid signature", async () => {
    await withTempHome(async () => {
      const identity = loadOrCreateDeviceIdentity();
      const auth = buildMeshConnectAuth({ identity });
      expect(
        verifyMeshConnectAuth({
          deviceId: auth.deviceId,
          publicKey: auth.publicKey,
          signature: auth.signature,
          signedAtMs: auth.signedAtMs,
        }),
      ).toBe(true);
    });
  });

  it("verifyMeshConnectAuth() rejects an invalid signature", async () => {
    await withTempHome(async () => {
      const identity = loadOrCreateDeviceIdentity();
      const auth = buildMeshConnectAuth({ identity });
      expect(
        verifyMeshConnectAuth({
          deviceId: auth.deviceId,
          publicKey: auth.publicKey,
          signature: "invalid-signature-data",
          signedAtMs: auth.signedAtMs,
        }),
      ).toBe(false);
    });
  });

  it("verifyMeshConnectAuth() rejects expired timestamp (>5 min)", async () => {
    await withTempHome(async () => {
      const identity = loadOrCreateDeviceIdentity();
      const sixMinutesAgo = Date.now() - 6 * 60 * 1000;
      const auth = buildMeshConnectAuth({ identity });
      // Override signedAtMs to be 6 minutes ago — signature was created with Date.now() so
      // rebuild with the old timestamp manually.
      const { signDevicePayload } = await import("../infra/device-identity.js");
      const payload = buildMeshAuthPayload({
        deviceId: identity.deviceId,
        signedAtMs: sixMinutesAgo,
      });
      const signature = signDevicePayload(identity.privateKeyPem, payload);
      expect(
        verifyMeshConnectAuth({
          deviceId: auth.deviceId,
          publicKey: auth.publicKey,
          signature,
          signedAtMs: sixMinutesAgo,
        }),
      ).toBe(false);
    });
  });

  it("verifyMeshConnectAuth() accepts near-edge timestamp (4 min)", async () => {
    await withTempHome(async () => {
      const identity = loadOrCreateDeviceIdentity();
      const fourMinutesAgo = Date.now() - 4 * 60 * 1000;
      const { signDevicePayload } = await import("../infra/device-identity.js");
      const payload = buildMeshAuthPayload({
        deviceId: identity.deviceId,
        signedAtMs: fourMinutesAgo,
      });
      const signature = signDevicePayload(identity.privateKeyPem, payload);
      const { publicKeyRawBase64UrlFromPem } = await import("../infra/device-identity.js");
      expect(
        verifyMeshConnectAuth({
          deviceId: identity.deviceId,
          publicKey: publicKeyRawBase64UrlFromPem(identity.publicKeyPem),
          signature,
          signedAtMs: fourMinutesAgo,
        }),
      ).toBe(true);
    });
  });

  it("round-trip: build then verify succeeds", async () => {
    await withTempHome(async () => {
      const identity = loadOrCreateDeviceIdentity();
      const auth = buildMeshConnectAuth({ identity, displayName: "Mac Gateway" });
      const verified = verifyMeshConnectAuth({
        deviceId: auth.deviceId,
        publicKey: auth.publicKey,
        signature: auth.signature,
        signedAtMs: auth.signedAtMs,
      });
      expect(verified).toBe(true);
    });
  });

  it("nonce is included in signature payload when provided", async () => {
    await withTempHome(async () => {
      const identity = loadOrCreateDeviceIdentity();
      const nonce = "test-nonce-123";
      const auth = buildMeshConnectAuth({ identity, nonce });
      expect(auth.nonce).toBe(nonce);
      // Verify with nonce succeeds
      expect(
        verifyMeshConnectAuth({
          deviceId: auth.deviceId,
          publicKey: auth.publicKey,
          signature: auth.signature,
          signedAtMs: auth.signedAtMs,
          nonce,
        }),
      ).toBe(true);
      // Verify without nonce fails (payload mismatch)
      expect(
        verifyMeshConnectAuth({
          deviceId: auth.deviceId,
          publicKey: auth.publicKey,
          signature: auth.signature,
          signedAtMs: auth.signedAtMs,
        }),
      ).toBe(false);
    });
  });
});
