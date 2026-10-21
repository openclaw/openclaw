import { generateKeyPairSync } from "node:crypto";
import { vi } from "vitest";
import * as identityRuntime from "./device-identity-async.js";
import { deriveDeviceIdFromPublicKey, publicKeyRawBase64UrlFromPem } from "./device-identity.js";

const relayGatewayIdentity = (() => {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const publicKeyPem = publicKey.export({ format: "pem", type: "spki" });
  const publicKeyRaw = publicKeyRawBase64UrlFromPem(publicKeyPem);
  const deviceId = deriveDeviceIdFromPublicKey(publicKeyRaw);
  if (!deviceId) {
    throw new Error("failed to derive test gateway device id");
  }
  return {
    deviceId,
    publicKeyPem,
    publicKey: publicKeyRaw,
    privateKeyPem: privateKey.export({ format: "pem", type: "pkcs8" }),
  };
})();

export function mockApnsRelayIdentity() {
  vi.spyOn(identityRuntime, "loadOrCreateProcessDeviceIdentityAsync").mockResolvedValue(
    relayGatewayIdentity,
  );
  return relayGatewayIdentity;
}

export function mockApnsRelayFetch(result: object) {
  mockApnsRelayIdentity();
  const send = vi.fn<typeof fetch>(async () => Response.json(result));
  vi.stubGlobal("fetch", send);
  return send;
}
