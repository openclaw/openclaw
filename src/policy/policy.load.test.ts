import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { signEd25519Payload } from "./policy.crypto.js";
import { loadSignedPolicy } from "./policy.load.js";

function generateRawBase64Keypair(): { publicKey: string; privateKey: string } {
  const pair = crypto.generateKeyPairSync("ed25519");
  const publicDer = pair.publicKey.export({ type: "spki", format: "der" }) as Buffer;
  const privateDer = pair.privateKey.export({ type: "pkcs8", format: "der" }) as Buffer;
  return {
    publicKey: publicDer.subarray(publicDer.length - 32).toString("base64"),
    privateKey: privateDer.subarray(privateDer.length - 32).toString("base64"),
  };
}

async function writeSignedPolicy(params: {
  policyPath: string;
  sigPath: string;
  payload: Record<string, unknown>;
  privateKey: string;
}): Promise<void> {
  const raw = JSON.stringify(params.payload);
  const signature = signEd25519Payload({ payload: raw, privateKey: params.privateKey });
  await fs.writeFile(params.policyPath, raw, "utf8");
  await fs.writeFile(params.sigPath, `${signature}\n`, "utf8");
}

describe("policy load", () => {
  it("verifies signatures using keyId + publicKeys", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-policy-load-keyid-"));
    const policyPath = path.join(dir, "POLICY.json");
    const sigPath = path.join(dir, "POLICY.sig");
    const oldKey = generateRawBase64Keypair();
    const nextKey = generateRawBase64Keypair();

    await writeSignedPolicy({
      policyPath,
      sigPath,
      payload: { version: 1, keyId: "next", policySerial: 1 },
      privateKey: nextKey.privateKey,
    });

    const result = await loadSignedPolicy({
      policyPath,
      sigPath,
      publicKeys: {
        active: oldKey.publicKey,
        next: nextKey.publicKey,
      },
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.verifiedKeyId).toBe("next");
      expect(result.policy.keyId).toBe("next");
    }
  });

  it("rejects an untrusted keyId", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-policy-load-untrusted-"));
    const policyPath = path.join(dir, "POLICY.json");
    const sigPath = path.join(dir, "POLICY.sig");
    const signingKey = generateRawBase64Keypair();

    await writeSignedPolicy({
      policyPath,
      sigPath,
      payload: { version: 1, keyId: "rotated-key", policySerial: 1 },
      privateKey: signingKey.privateKey,
    });

    const result = await loadSignedPolicy({
      policyPath,
      sigPath,
      publicKeys: {
        active: signingKey.publicKey,
      },
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("POLICY_KEY_ID_UNTRUSTED");
    }
  });

  it("rejects insecure policy file permissions in strict mode", async () => {
    if (process.platform === "win32") {
      return;
    }
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-policy-load-perms-"));
    const policyPath = path.join(dir, "POLICY.json");
    const sigPath = path.join(dir, "POLICY.sig");
    const key = generateRawBase64Keypair();

    await writeSignedPolicy({
      policyPath,
      sigPath,
      payload: { version: 1, policySerial: 1 },
      privateKey: key.privateKey,
    });
    await fs.chmod(policyPath, 0o666);
    await fs.chmod(sigPath, 0o600);

    const result = await loadSignedPolicy({
      policyPath,
      sigPath,
      publicKey: key.publicKey,
      strictFilePermissions: true,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("POLICY_FILE_INSECURE");
    }
  });
});
