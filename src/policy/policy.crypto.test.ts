import crypto from "node:crypto";
import { describe, expect, it } from "vitest";
import { signEd25519Payload, verifyEd25519Signature } from "./policy.crypto.js";

function generateRawBase64Keypair(): { publicKey: string; privateKey: string } {
  const pair = crypto.generateKeyPairSync("ed25519");
  const publicDer = pair.publicKey.export({ type: "spki", format: "der" }) as Buffer;
  const privateDer = pair.privateKey.export({ type: "pkcs8", format: "der" }) as Buffer;
  return {
    publicKey: publicDer.subarray(publicDer.length - 32).toString("base64"),
    privateKey: privateDer.subarray(privateDer.length - 32).toString("base64"),
  };
}

describe("policy crypto", () => {
  it("signs and verifies with base64 ed25519 keys", () => {
    const keys = generateRawBase64Keypair();
    const payload = JSON.stringify({ version: 1 });
    const signature = signEd25519Payload({ payload, privateKey: keys.privateKey });
    const valid = verifyEd25519Signature({
      payload,
      signatureBase64: signature,
      publicKey: keys.publicKey,
    });
    expect(valid).toBe(true);
  });

  it("fails verification for tampered payload", () => {
    const keys = generateRawBase64Keypair();
    const payload = JSON.stringify({ version: 1 });
    const signature = signEd25519Payload({ payload, privateKey: keys.privateKey });
    const valid = verifyEd25519Signature({
      payload: JSON.stringify({ version: 2 }),
      signatureBase64: signature,
      publicKey: keys.publicKey,
    });
    expect(valid).toBe(false);
  });
});
