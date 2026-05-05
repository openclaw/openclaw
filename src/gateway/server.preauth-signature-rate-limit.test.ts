import { randomBytes, randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { WebSocket } from "ws";
import {
  loadOrCreateDeviceIdentity,
  publicKeyRawBase64UrlFromPem,
  signDevicePayload,
} from "../infra/device-identity.js";
import { GATEWAY_CLIENT_MODES, GATEWAY_CLIENT_NAMES } from "../utils/message-channel.js";
import { buildDeviceAuthPayloadV3 } from "./device-auth.js";
import {
  connectReq,
  installGatewayTestHooks,
  readConnectChallengeNonce,
  testState,
  trackConnectChallengeNonce,
  withGatewayServer,
} from "./test-helpers.js";

installGatewayTestHooks({ scope: "suite" });

const TEST_OPERATOR_CLIENT = {
  id: GATEWAY_CLIENT_NAMES.TEST,
  version: "1.0.0",
  platform: "test",
  mode: GATEWAY_CLIENT_MODES.TEST,
};

type PublicKeyEncoding = "raw-base64url" | "pem";

const originForPort = (port: number) => `http://127.0.0.1:${port}`;

async function openBrowserWs(port: number) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`, {
    headers: { origin: originForPort(port) },
  });
  trackConnectChallengeNonce(ws);
  await new Promise<void>((resolve) => ws.once("open", resolve));
  return ws;
}

async function buildForgedDeviceBlock(params: {
  nonce: string;
  identityPath: string;
  publicKeyEncoding?: PublicKeyEncoding;
}) {
  // Real Ed25519 keypair (so deriveDeviceIdFromPublicKey + the device-id
  // match check pass), random 64-byte signature (so the verify itself
  // fails). This is exactly the attacker shape that exercises the
  // pre-auth crypto path with no schema or shape pre-check shortcut.
  const identity = loadOrCreateDeviceIdentity(params.identityPath);
  const sig = randomBytes(64).toString("base64url");
  const publicKey =
    params.publicKeyEncoding === "pem"
      ? identity.publicKeyPem
      : publicKeyRawBase64UrlFromPem(identity.publicKeyPem);
  return {
    id: identity.deviceId,
    publicKey,
    signature: sig,
    signedAt: Date.now(),
    nonce: params.nonce,
  };
}

async function buildValidlySignedDeviceBlock(params: {
  nonce: string;
  identityPath: string;
  role: string;
  scopes: string[];
  client: typeof TEST_OPERATOR_CLIENT;
}) {
  // Attacker with their own keypair forging a *valid* self-signature.
  // Crypto verify succeeds, but resolveConnectAuthDecision rejects because
  // the device is not server-approved and no token/password matches.
  const identity = loadOrCreateDeviceIdentity(params.identityPath);
  const signedAtMs = Date.now();
  const payload = buildDeviceAuthPayloadV3({
    deviceId: identity.deviceId,
    clientId: params.client.id,
    clientMode: params.client.mode,
    role: params.role,
    scopes: params.scopes,
    signedAtMs,
    token: null,
    nonce: params.nonce,
    platform: params.client.platform,
    deviceFamily: undefined,
  });
  return {
    id: identity.deviceId,
    publicKey: publicKeyRawBase64UrlFromPem(identity.publicKeyPem),
    signature: signDevicePayload(identity.privateKeyPem, payload),
    signedAt: signedAtMs,
    nonce: params.nonce,
  };
}

async function attemptForgedConnect(
  port: number,
  identityPath: string,
  encoding: PublicKeyEncoding = "raw-base64url",
) {
  const ws = await openBrowserWs(port);
  try {
    const nonce = await readConnectChallengeNonce(ws);
    expect(typeof nonce).toBe("string");
    const device = await buildForgedDeviceBlock({
      nonce: nonce ?? "",
      identityPath,
      publicKeyEncoding: encoding,
    });
    const res = await connectReq(ws, {
      skipDefaultAuth: true,
      client: TEST_OPERATOR_CLIENT,
      role: "operator",
      scopes: ["operator.read"],
      device,
    });
    return res;
  } finally {
    ws.close();
    await new Promise<void>((resolve) => {
      if (ws.readyState === WebSocket.CLOSED) {
        resolve();
        return;
      }
      ws.once("close", () => resolve());
    });
  }
}

async function attemptValidSignatureUnauthorizedConnect(port: number, identityPath: string) {
  const ws = await openBrowserWs(port);
  try {
    const nonce = await readConnectChallengeNonce(ws);
    expect(typeof nonce).toBe("string");
    const device = await buildValidlySignedDeviceBlock({
      nonce: nonce ?? "",
      identityPath,
      role: "operator",
      scopes: ["operator.read"],
      client: TEST_OPERATOR_CLIENT,
    });
    const res = await connectReq(ws, {
      skipDefaultAuth: true,
      client: TEST_OPERATOR_CLIENT,
      role: "operator",
      scopes: ["operator.read"],
      device,
    });
    return res;
  } finally {
    ws.close();
    await new Promise<void>((resolve) => {
      if (ws.readyState === WebSocket.CLOSED) {
        resolve();
        return;
      }
      ws.once("close", () => resolve());
    });
  }
}

describe("pre-auth device-signature rate limit", () => {
  test("locks out forged signature attempts after maxAttempts (browser-origin loopback)", async () => {
    // exemptLoopback:true matches production: legit local CLI clients are
    // never throttled. Browser-origin clients (Origin header set) are
    // routed through the non-loopback-exempt limiter, which is also where
    // the device-signature gate fires.
    testState.gatewayAuth = {
      mode: "token",
      token: "secret",
      rateLimit: {
        maxAttempts: 3,
        windowMs: 60_000,
        lockoutMs: 60_000,
        exemptLoopback: true,
      },
    };
    await withGatewayServer(async ({ port }) => {
      const identityPath = path.join(os.tmpdir(), `openclaw-preauth-rate-${randomUUID()}.json`);
      const reasons: Array<string | undefined> = [];

      // Up to maxAttempts forged signatures should each fail with a real
      // signature-mismatch reason — the verify ran. After that, the limiter
      // takes over and short-circuits subsequent attempts.
      for (let i = 0; i < 3; i++) {
        const res = await attemptForgedConnect(port, identityPath);
        expect(res.ok).toBe(false);
        const detail = res.error?.details as { reason?: string } | undefined;
        reasons.push(detail?.reason);
      }
      expect(reasons.every((r) => r === "device-signature")).toBe(true);

      // The next attempt is the one that proves the fix: the gateway
      // rejects without paying for createPublicKey + verify.
      const lockedOut = await attemptForgedConnect(port, identityPath);
      expect(lockedOut.ok).toBe(false);
      const detail = lockedOut.error?.details as
        | { reason?: string; retryAfterMs?: number }
        | undefined;
      expect(detail?.reason).toBe("device-signature-rate-limited");
      expect(typeof detail?.retryAfterMs).toBe("number");
      expect(lockedOut.error?.message).toContain("rate-limited");
    });
  });

  test("forged-signature failures consume the same bucket as other browser-origin failures", async () => {
    testState.gatewayAuth = {
      mode: "token",
      token: "secret",
      rateLimit: {
        maxAttempts: 1,
        windowMs: 60_000,
        lockoutMs: 60_000,
        exemptLoopback: true,
      },
    };
    await withGatewayServer(async ({ port }) => {
      const identityPath = path.join(
        os.tmpdir(),
        `openclaw-preauth-rate-shared-${randomUUID()}.json`,
      );
      const first = await attemptForgedConnect(port, identityPath);
      expect(first.ok).toBe(false);
      const firstDetail = first.error?.details as { reason?: string } | undefined;
      expect(firstDetail?.reason).toBe("device-signature");

      const second = await attemptForgedConnect(port, identityPath);
      expect(second.ok).toBe(false);
      const secondDetail = second.error?.details as { reason?: string } | undefined;
      expect(secondDetail?.reason).toBe("device-signature-rate-limited");
    });
  });

  test("locks out PEM-encoded forged signatures before crypto.createPublicKey runs", async () => {
    // Regression for the case where attackers send a SPKI-encoded PEM
    // public key. deriveDeviceIdFromPublicKey would otherwise call
    // crypto.createPublicKey before the limiter — locked-out attackers
    // would still pay the key-parse cost. The gate must precede that.
    testState.gatewayAuth = {
      mode: "token",
      token: "secret",
      rateLimit: {
        maxAttempts: 1,
        windowMs: 60_000,
        lockoutMs: 60_000,
        exemptLoopback: true,
      },
    };
    await withGatewayServer(async ({ port }) => {
      const identityPath = path.join(os.tmpdir(), `openclaw-preauth-rate-pem-${randomUUID()}.json`);
      const first = await attemptForgedConnect(port, identityPath, "pem");
      expect(first.ok).toBe(false);
      const firstDetail = first.error?.details as { reason?: string } | undefined;
      expect(firstDetail?.reason).toBe("device-signature");

      const second = await attemptForgedConnect(port, identityPath, "pem");
      expect(second.ok).toBe(false);
      const secondDetail = second.error?.details as { reason?: string } | undefined;
      expect(secondDetail?.reason).toBe("device-signature-rate-limited");
    });
  });

  test("valid self-signature does not reset the bucket when auth fails", async () => {
    // An attacker controlling their own keypair can produce signatures
    // that pass verifyDeviceSignature. Resetting the bucket on valid
    // crypto alone would let them flood the verify path indefinitely.
    // The reset must wait until resolveConnectAuthDecision confirms the
    // full handshake is authorized.
    testState.gatewayAuth = {
      mode: "token",
      token: "secret",
      rateLimit: {
        maxAttempts: 2,
        windowMs: 60_000,
        lockoutMs: 60_000,
        exemptLoopback: true,
      },
    };
    await withGatewayServer(async ({ port }) => {
      const identityPath = path.join(
        os.tmpdir(),
        `openclaw-preauth-rate-valid-sig-${randomUUID()}.json`,
      );

      // First attempt: valid signature, missing token → unauthorized.
      // Crypto verify succeeded, so without the deferred reset the bucket
      // would clear and the attacker could repeat indefinitely.
      const first = await attemptValidSignatureUnauthorizedConnect(port, identityPath);
      expect(first.ok).toBe(false);

      // Second attempt: same shape, also unauthorized — but the bucket
      // should now be at its limit, so the third attempt locks out.
      const second = await attemptValidSignatureUnauthorizedConnect(port, identityPath);
      expect(second.ok).toBe(false);

      const third = await attemptValidSignatureUnauthorizedConnect(port, identityPath);
      expect(third.ok).toBe(false);
      const thirdDetail = third.error?.details as { reason?: string } | undefined;
      // The device-signature bucket has now been consumed twice with no
      // reset (auth never succeeded), so the third attempt is gated before
      // any crypto runs — the bucket stayed locked despite valid sigs.
      expect(thirdDetail?.reason).toBe("device-signature-rate-limited");
    });
  });
});
