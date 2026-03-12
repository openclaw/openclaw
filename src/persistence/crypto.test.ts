import crypto from "node:crypto";
import { describe, expect, it } from "vitest";
import { decryptJsonValue, encryptJsonValue } from "./crypto.js";

function encryptLegacyPayload(value: unknown, secret: string) {
  const iv = crypto.randomBytes(12);
  const key = crypto.createHash("sha256").update(secret, "utf8").digest();
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const plaintext = Buffer.from(JSON.stringify(value), "utf8");
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return {
    version: 1,
    algorithm: "aes-256-gcm" as const,
    iv: iv.toString("base64"),
    authTag: authTag.toString("base64"),
    ciphertext: ciphertext.toString("base64"),
  };
}

describe("persistence crypto", () => {
  it("round-trips encrypted JSON payloads", () => {
    const payload = {
      apiKey: "sk-test-123",
      refresh: "refresh-token",
    };
    const encrypted = encryptJsonValue(payload, "unit-test-secret");

    expect(encrypted.ciphertext).not.toContain("sk-test-123");
    expect(encrypted.ciphertext).not.toContain("refresh-token");
    expect(decryptJsonValue<typeof payload>(encrypted, "unit-test-secret")).toEqual(payload);
  });

  it("rejects decryption with the wrong key", () => {
    const encrypted = encryptJsonValue({ token: "secret-token" }, "correct-secret");
    expect(() => decryptJsonValue(encrypted, "wrong-secret")).toThrow();
  });

  it("decrypts legacy version 1 payloads", () => {
    const payload = encryptLegacyPayload({ token: "legacy-secret" }, "legacy-secret");
    expect(decryptJsonValue<{ token: string }>(payload, "legacy-secret")).toEqual({
      token: "legacy-secret",
    });
  });
});
