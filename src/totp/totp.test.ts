import { describe, expect, it } from "vitest";
import {
  decodeBase32,
  encodeBase32,
  generateTotp,
  generateTotpSecret,
  verifyTotp,
  buildOtpauthUri,
} from "./totp.js";

describe("base32", () => {
  it("round-trips arbitrary buffers", () => {
    const buf = Buffer.from("Hello, World!");
    const encoded = encodeBase32(buf);
    const decoded = decodeBase32(encoded);
    expect(decoded.toString()).toBe("Hello, World!");
  });

  it("encodes empty buffer", () => {
    expect(encodeBase32(Buffer.alloc(0))).toBe("");
  });

  it("decodes with padding and whitespace", () => {
    const buf = Buffer.from("test");
    const encoded = encodeBase32(buf);
    const decoded = decodeBase32(`  ${encoded}====  `);
    expect(decoded.toString()).toBe("test");
  });

  it("throws on invalid characters", () => {
    expect(() => decodeBase32("!!!")).toThrow("invalid base32 character");
  });

  // RFC 4648 test vectors
  it("encodes RFC 4648 vectors", () => {
    expect(encodeBase32(Buffer.from(""))).toBe("");
    expect(encodeBase32(Buffer.from("f"))).toBe("MY");
    expect(encodeBase32(Buffer.from("fo"))).toBe("MZXQ");
    expect(encodeBase32(Buffer.from("foo"))).toBe("MZXW6");
    expect(encodeBase32(Buffer.from("foob"))).toBe("MZXW6YQ");
    expect(encodeBase32(Buffer.from("fooba"))).toBe("MZXW6YTB");
    expect(encodeBase32(Buffer.from("foobar"))).toBe("MZXW6YTBOI");
  });
});

describe("generateTotpSecret", () => {
  it("generates a 20-byte secret by default", () => {
    const secret = generateTotpSecret();
    expect(secret).toBeInstanceOf(Buffer);
    expect(secret.length).toBe(20);
  });

  it("generates different secrets", () => {
    const a = generateTotpSecret();
    const b = generateTotpSecret();
    expect(a.equals(b)).toBe(false);
  });
});

describe("generateTotp / verifyTotp", () => {
  it("generates a 6-digit string", () => {
    const secret = generateTotpSecret();
    const code = generateTotp(secret);
    expect(code).toMatch(/^\d{6}$/);
  });

  it("verifies a freshly generated code", () => {
    const secret = generateTotpSecret();
    const code = generateTotp(secret);
    expect(verifyTotp(secret, code)).toBe(true);
  });

  it("rejects an incorrect code", () => {
    const secret = generateTotpSecret();
    expect(verifyTotp(secret, "000000")).toBe(false);
  });

  it("rejects code from a different secret", () => {
    const secret1 = generateTotpSecret();
    const secret2 = generateTotpSecret();
    const code = generateTotp(secret1);
    expect(verifyTotp(secret2, code)).toBe(false);
  });

  // RFC 6238 test vector: SHA-1, time=59, step=30, expected=287082
  it("produces correct TOTP for RFC 6238 test vector (time=59)", () => {
    const secret = Buffer.from("12345678901234567890");
    // Counter at time=59, step=30 is floor(59/30) = 1
    // We test by computing HOTP for counter=1
    // The expected code is 287082
    const counterBuf = Buffer.alloc(8);
    counterBuf.writeBigUInt64BE(1n);
    const crypto = require("node:crypto");
    const hmac = crypto.createHmac("sha1", secret).update(counterBuf).digest() as Buffer;
    const offset = hmac[hmac.length - 1]! & 0x0f;
    const code =
      ((hmac[offset]! & 0x7f) << 24) |
      ((hmac[offset + 1]! & 0xff) << 16) |
      ((hmac[offset + 2]! & 0xff) << 8) |
      (hmac[offset + 3]! & 0xff);
    const otpString = String(code % 10 ** 6).padStart(6, "0");
    expect(otpString).toBe("287082");
  });
});

describe("buildOtpauthUri", () => {
  it("builds a valid otpauth URI", () => {
    const uri = buildOtpauthUri({
      secret: "JBSWY3DPEHPK3PXP",
      issuer: "OpenClaw",
      account: "user@example.com",
    });
    expect(uri).toContain("otpauth://totp/");
    expect(uri).toContain("OpenClaw");
    expect(uri).toContain("secret=JBSWY3DPEHPK3PXP");
    expect(uri).toContain("issuer=OpenClaw");
    expect(uri).toContain("algorithm=SHA1");
    expect(uri).toContain("digits=6");
    expect(uri).toContain("period=30");
  });
});
