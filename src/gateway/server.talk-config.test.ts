import { describe, expect, it } from "vitest";
import {
  connectOk,
  installGatewayTestHooks,
  readConnectChallengeNonce,
  rpcReq,
} from "./test-helpers.js";
import { withServer } from "./test-with-server.js";

installGatewayTestHooks({ scope: "suite" });

type GatewaySocket = Parameters<Parameters<typeof withServer>[0]>[0];

async function createFreshOperatorDevice(scopes: string[], nonce: string) {
  const { randomUUID } = await import("node:crypto");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { buildDeviceAuthPayload } = await import("./device-auth.js");
  const { loadOrCreateDeviceIdentity, publicKeyRawBase64UrlFromPem, signDevicePayload } =
    await import("../infra/device-identity.js");

  const identity = loadOrCreateDeviceIdentity(
    join(tmpdir(), `openclaw-talk-config-${randomUUID()}.json`),
  );
  const signedAtMs = Date.now();
  const payload = buildDeviceAuthPayload({
    deviceId: identity.deviceId,
    clientId: "test",
    clientMode: "test",
    role: "operator",
    scopes,
    signedAtMs,
    token: "secret",
    nonce,
  });

  return {
    id: identity.deviceId,
    publicKey: publicKeyRawBase64UrlFromPem(identity.publicKeyPem),
    signature: signDevicePayload(identity.privateKeyPem, payload),
    signedAt: signedAtMs,
    nonce,
  };
}

async function connectOperator(ws: GatewaySocket, scopes: string[]) {
  const nonce = await readConnectChallengeNonce(ws);
  expect(nonce).toBeTruthy();
  await connectOk(ws, {
    token: "secret",
    scopes,
    device: await createFreshOperatorDevice(scopes, String(nonce)),
  });
}

async function writeTalkConfig(config: { apiKey?: string; voiceId?: string }) {
  const { writeConfigFile } = await import("../config/config.js");
  await writeConfigFile({ talk: config });
}

describe("gateway talk.config", () => {
  it("returns redacted talk config for read scope", async () => {
    const { writeConfigFile } = await import("../config/config.js");
    await writeConfigFile({
      talk: {
        voiceId: "voice-123",
        apiKey: "secret-key-abc",
      },
      session: {
        mainKey: "main-test",
      },
      ui: {
        seamColor: "#112233",
      },
    });

    await withServer(async (ws) => {
      await connectOperator(ws, ["operator.read"]);
      const res = await rpcReq<{ config?: { talk?: { apiKey?: string; voiceId?: string } } }>(
        ws,
        "talk.config",
        {},
      );
      expect(res.ok).toBe(true);
      expect(res.payload?.config?.talk?.voiceId).toBe("voice-123");
      expect(res.payload?.config?.talk?.apiKey).toBe("__OPENCLAW_REDACTED__");
    });
  });

  it("requires operator.talk.secrets for includeSecrets", async () => {
    await writeTalkConfig({ apiKey: "secret-key-abc" });

    await withServer(async (ws) => {
      await connectOperator(ws, ["operator.read"]);
      const res = await rpcReq(ws, "talk.config", { includeSecrets: true });
      expect(res.ok).toBe(false);
      expect(res.error?.message).toContain("missing scope: operator.talk.secrets");
    });
  });

  it("returns secrets for operator.talk.secrets scope", async () => {
    await writeTalkConfig({ apiKey: "secret-key-abc" });

    await withServer(async (ws) => {
      await connectOperator(ws, ["operator.read", "operator.write", "operator.talk.secrets"]);
      const res = await rpcReq<{ config?: { talk?: { apiKey?: string } } }>(ws, "talk.config", {
        includeSecrets: true,
      });
      expect(res.ok).toBe(true);
      expect(res.payload?.config?.talk?.apiKey).toBe("secret-key-abc");
    });
  });
});
