import { describe, expect, it } from "vitest";
import { decryptJsonValue, encryptJsonValue } from "./crypto.js";

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
});
