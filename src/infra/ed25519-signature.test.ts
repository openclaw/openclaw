import crypto from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  decodeCanonicalBase64OrBase64Url,
  deriveCanonicalEd25519PrivateKeyRaw,
  deriveCanonicalEd25519PublicKeyRaw,
  deriveEd25519PrivateKeyRaw,
  deriveEd25519PublicKeyRaw,
  ed25519PrivateKeyPemFromRaw,
  ed25519PublicKeyPemFromRaw,
  normalizeEd25519PublicKeyBase64Url,
  signEd25519Payload,
  verifyEd25519Signature,
  verifyEd25519SignatureBytes,
} from "./ed25519-signature.js";

describe("strict base64 decoding", () => {
  it("accepts canonical unpadded base64url", () => {
    expect(normalizeEd25519PublicKeyBase64Url("-_8B")).toBe("-_8B");
  });

  it("accepts canonical standard base64 through the strict mixed decoder", () => {
    const raw = Buffer.from([0xfb, 0xff, 0x01]);
    expect(decodeCanonicalBase64OrBase64Url("+/8B")).toEqual(raw);
  });

  it.each(["", "A", "AB==", "AA=", "AA===", "AA==junk", "-_8B="])(
    "rejects noncanonical input %j",
    (input) => {
      expect(() => decodeCanonicalBase64OrBase64Url(input)).toThrow();
    },
  );

  it("throws on input exceeding the maximum allowed length", () => {
    expect(() => decodeCanonicalBase64OrBase64Url("A".repeat(5000))).toThrow(
      /maximum allowed length/,
    );
  });
});

describe("strict Ed25519 keys", () => {
  it("round-trips exact 32-byte raw keys", () => {
    const raw = Buffer.alloc(32, 7);
    const publicKeyPem = ed25519PublicKeyPemFromRaw(raw);
    const privateKeyPem = ed25519PrivateKeyPemFromRaw(raw);

    expect(deriveEd25519PublicKeyRaw(publicKeyPem)).toEqual(raw);
    expect(deriveEd25519PrivateKeyRaw(privateKeyPem)).toEqual(raw);
  });

  it.each([31, 33])("rejects %i-byte raw keys", (length) => {
    const raw = Buffer.alloc(length);
    expect(() => ed25519PublicKeyPemFromRaw(raw)).toThrow(/exactly 32 bytes/);
    expect(() => ed25519PrivateKeyPemFromRaw(raw)).toThrow(/exactly 32 bytes/);
  });

  it("rejects non-Ed25519 key types", () => {
    const { publicKey, privateKey } = crypto.generateKeyPairSync("rsa", {
      modulusLength: 2048,
    });
    const publicKeyPem = publicKey.export({ type: "spki", format: "pem" });
    const privateKeyPem = privateKey.export({ type: "pkcs8", format: "pem" });

    expect(() => deriveEd25519PublicKeyRaw(publicKeyPem)).toThrow(/Ed25519/);
    expect(() => deriveEd25519PrivateKeyRaw(privateKeyPem)).toThrow(/Ed25519/);
    expect(normalizeEd25519PublicKeyBase64Url(publicKeyPem)).toBeNull();
  });

  it("rejects alternate PEM formatting even when crypto can parse it", () => {
    const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
    const publicKeyPem = publicKey.export({ type: "spki", format: "pem" });
    const privateKeyPem = privateKey.export({ type: "pkcs8", format: "pem" });
    const variants = [
      publicKeyPem.trimEnd(),
      publicKeyPem.replaceAll("\n", "\r\n"),
      publicKeyPem.replace(/\n([A-Za-z0-9+/=]{30})/, "\n$1\n"),
    ];

    for (const pem of variants) {
      expect(() => crypto.createPublicKey(pem)).not.toThrow();
      expect(() => deriveCanonicalEd25519PublicKeyRaw(pem)).toThrow(/canonical PEM/);
      expect(deriveEd25519PublicKeyRaw(pem)).toHaveLength(32);
      expect(normalizeEd25519PublicKeyBase64Url(pem)).not.toBeNull();
    }
    expect(() => deriveCanonicalEd25519PrivateKeyRaw(privateKeyPem.trimEnd())).toThrow(
      /canonical PEM/,
    );
    expect(deriveEd25519PrivateKeyRaw(privateKeyPem.trimEnd())).toHaveLength(32);
  });
});

describe("pre-auth crypto input bounds", () => {
  afterEach(() => vi.restoreAllMocks());

  function signedPayload() {
    const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
    const pem = publicKey.export({ type: "spki", format: "pem" });
    const privatePem = privateKey.export({ type: "pkcs8", format: "pem" });
    return {
      pem,
      privatePem,
      raw: deriveEd25519PublicKeyRaw(pem),
      signature: signEd25519Payload(privatePem, "payload"),
    };
  }

  it.each([
    "canonical",
    "trimmed",
    "crlf",
    "leading",
    "trailing",
    "body-spaces",
    "body-tabs",
    "carriage-returns",
    "private",
  ] as const)("verifies and normalizes %s PEM through bounded real crypto", (variant) => {
    const { pem, privatePem, raw, signature } = signedPayload();
    const variants = {
      canonical: pem,
      trimmed: pem.trimEnd(),
      crlf: pem.replaceAll("\n", "\r\n"),
      leading: " \t\r\n".repeat(4096) + pem,
      trailing: pem + " \t\r\n".repeat(4096),
      "body-spaces": pem.replace(/\n([A-Za-z0-9+/=]{20})/, "\n$1" + " ".repeat(16384)),
      "body-tabs": pem.replace(/\n([A-Za-z0-9+/=]{20})/, "\n$1" + "\t".repeat(16384)),
      "carriage-returns": pem.replaceAll("\n", "\r".repeat(4096) + "\n"),
      private: privatePem,
    };
    const publicKey = variants[variant];
    // Establish the dependency contract independently before observing our boundary.
    expect(
      crypto.verify(
        null,
        Buffer.from("payload"),
        crypto.createPublicKey(publicKey),
        Buffer.from(signature, "base64url"),
      ),
    ).toBe(true);
    const create = vi.spyOn(crypto, "createPublicKey");
    const verify = vi.spyOn(crypto, "verify");
    expect(
      verifyEd25519SignatureBytes({
        publicKey,
        payload: Buffer.from("payload"),
        signatureBase64Url: signature,
      }),
    ).toBe(true);
    expect(normalizeEd25519PublicKeyBase64Url(publicKey)).toBe(raw.toString("base64url"));
    expect(create).toHaveBeenCalledTimes(2);
    expect(verify).toHaveBeenCalledTimes(1);
    for (const [input] of create.mock.calls) {
      expect(typeof input).toBe("string");
      expect((input as string).length).toBeLessThanOrEqual(4096);
    }
  });

  it.each([
    "pem",
    "signature",
    "raw",
    "empty-key",
    "short-key",
    "nonstring-key",
    "empty-signature",
    "invalid-signature",
    "nonstring-signature",
  ])("rejects %s input before creating a key or verifying", (variant) => {
    const { pem, signature } = signedPayload();
    let publicKey = pem;
    let signatureBase64Url = signature;
    switch (variant) {
      case "pem":
        publicKey = `-----BEGIN PUBLIC KEY-----\n${"A".repeat(512 * 1024)}\n-----END PUBLIC KEY-----\n`;
        break;
      case "signature":
        signatureBase64Url = "A".repeat(512 * 1024);
        break;
      case "raw":
        publicKey = "A".repeat(4097);
        break;
      case "empty-key":
        publicKey = "";
        break;
      case "short-key":
        publicKey = "-_8B";
        break;
      case "nonstring-key":
        publicKey = null as unknown as string;
        break;
      case "empty-signature":
        signatureBase64Url = "";
        break;
      case "invalid-signature":
        signatureBase64Url = "%%%";
        break;
      case "nonstring-signature":
        signatureBase64Url = null as unknown as string;
        break;
    }
    const create = vi.spyOn(crypto, "createPublicKey");
    const verify = vi.spyOn(crypto, "verify");
    expect(verifyEd25519Signature({ publicKey, payload: "payload", signatureBase64Url })).toBe(
      false,
    );
    if (variant === "pem") {
      expect(normalizeEd25519PublicKeyBase64Url(publicKey)).toBeNull();
    }
    expect(create).not.toHaveBeenCalled();
    expect(verify).not.toHaveBeenCalled();
  });

  it("preserves permissive raw key normalization and wire signature encodings", () => {
    const { raw, signature } = signedPayload();
    const bytes = Buffer.from(signature, "base64url");
    const signatures = [
      signature,
      bytes.toString("base64"),
      signature + "==",
      ` \n${signature}\t`,
      signature.slice(0, 20) + "%" + signature.slice(20),
    ];
    for (const publicKey of [
      raw.toString("base64url"),
      raw.toString("base64"),
      Buffer.concat([raw, Buffer.alloc(3)]).toString("base64url"),
    ]) {
      for (const signatureBase64Url of signatures) {
        expect(verifyEd25519Signature({ publicKey, payload: "payload", signatureBase64Url })).toBe(
          true,
        );
        expect(verifyEd25519Signature({ publicKey, payload: "tampered", signatureBase64Url })).toBe(
          false,
        );
      }
    }
    expect(normalizeEd25519PublicKeyBase64Url("-_8B")).toBe("-_8B");
    expect(normalizeEd25519PublicKeyBase64Url("A".repeat(4096))).toBe("A".repeat(4096));
    expect(normalizeEd25519PublicKeyBase64Url("A".repeat(4097))).toBeNull();
  });

  it("does not change the existing PEM key-type contract", () => {
    const pair = crypto.generateKeyPairSync("ed448");
    const pem = pair.publicKey.export({ type: "spki", format: "pem" });
    const signature = crypto
      .sign(null, Buffer.from("payload"), pair.privateKey)
      .toString("base64url");
    expect(
      verifyEd25519Signature({ publicKey: pem, payload: "payload", signatureBase64Url: signature }),
    ).toBe(true);
    // The normalization/parser API remains Ed25519-only, as before.
    expect(normalizeEd25519PublicKeyBase64Url(pem)).toBeNull();
  });
});
