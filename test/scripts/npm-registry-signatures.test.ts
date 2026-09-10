import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { describe, expect, it } from "vitest";
import { verifyNpmRegistrySignatures } from "../../scripts/lib/npm-registry-signatures.mjs";

function signedPackage() {
  const keys = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const packageName = "@openclaw/fixture";
  const version = "2026.9.3";
  const integrity = `sha512-${createHash("sha512").update("qualified fixture").digest("base64")}`;
  const payload = `${packageName}@${version}:${integrity}`;
  return {
    packageName,
    version,
    integrity,
    signatures: [
      {
        keyid: "fixture-key",
        sig: sign("sha256", Buffer.from(payload), keys.privateKey).toString("base64"),
      },
    ],
    keys: [
      {
        keyid: "fixture-key",
        key: keys.publicKey.export({ format: "der", type: "spki" }).toString("base64"),
      },
    ],
  };
}

describe("npm registry signatures", () => {
  it("verifies the registry signature over the exact name, version and integrity", () => {
    expect(() => verifyNpmRegistrySignatures(signedPackage())).not.toThrow();
  });
  it.each(["packageName", "version", "integrity"] as const)(
    "rejects a valid signature for a different %s",
    (field) => {
      const fixture = signedPackage();
      fixture[field] += "changed";
      expect(() => verifyNpmRegistrySignatures(fixture)).toThrow("signatures did not verify");
    },
  );
  it("rejects missing signatures, unknown keys and signatures from another key", () => {
    const fixture = signedPackage();
    expect(() => verifyNpmRegistrySignatures({ ...fixture, signatures: [] })).toThrow(
      "no signatures",
    );
    expect(() => verifyNpmRegistrySignatures({ ...fixture, keys: [] })).toThrow(
      "signatures did not verify",
    );
    expect(() => verifyNpmRegistrySignatures({ ...fixture, keys: signedPackage().keys })).toThrow(
      "signatures did not verify",
    );
  });
});
