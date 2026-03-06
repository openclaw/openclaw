import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { canonicalizePolicyJson } from "./policy.canonical.js";
import { signEd25519Payload } from "./policy.crypto.js";
import { clearPolicyManagerCacheForTests, getPolicyManagerState } from "./policy.manager.js";

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
  const signature = signEd25519Payload({
    payload: canonicalizePolicyJson(params.payload),
    privateKey: params.privateKey,
  });
  await fs.writeFile(params.policyPath, raw, "utf8");
  await fs.writeFile(params.sigPath, `${signature}\n`, "utf8");
}

describe("policy manager", () => {
  beforeEach(() => {
    clearPolicyManagerCacheForTests();
  });

  it("loads a valid signed policy", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-policy-"));
    const policyPath = path.join(dir, "POLICY.json");
    const sigPath = path.join(dir, "POLICY.sig");
    const statePath = path.join(dir, "POLICY.state.json");
    const keys = generateRawBase64Keypair();
    await writeSignedPolicy({
      policyPath,
      sigPath,
      payload: { version: 1, policySerial: 5 },
      privateKey: keys.privateKey,
    });

    const config: OpenClawConfig = {
      policy: {
        enabled: true,
        failClosed: true,
        policyPath,
        sigPath,
        statePath,
        publicKey: keys.publicKey,
      },
    };
    const state = await getPolicyManagerState({ config, forceReload: true });
    expect(state.enabled).toBe(true);
    expect(state.valid).toBe(true);
    expect(state.lockdown).toBe(false);
    expect(state.policy?.version).toBe(1);
    expect(state.lastAcceptedSerial).toBe(5);
  });

  it("enters lockdown when failClosed is enabled and signature is missing", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-policy-lockdown-"));
    const policyPath = path.join(dir, "POLICY.json");
    await fs.writeFile(policyPath, JSON.stringify({ version: 1 }), "utf8");

    const config: OpenClawConfig = {
      policy: {
        enabled: true,
        failClosed: true,
        policyPath,
        sigPath: path.join(dir, "MISSING.sig"),
        publicKey: "invalid",
      },
    };
    const state = await getPolicyManagerState({ config, forceReload: true });
    expect(state.enabled).toBe(true);
    expect(state.valid).toBe(false);
    expect(state.lockdown).toBe(true);
  });

  it("verifies keyId policies against a trusted key set", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-policy-keyset-"));
    const policyPath = path.join(dir, "POLICY.json");
    const sigPath = path.join(dir, "POLICY.sig");
    const statePath = path.join(dir, "POLICY.state.json");
    const keyA = generateRawBase64Keypair();
    const keyB = generateRawBase64Keypair();
    await writeSignedPolicy({
      policyPath,
      sigPath,
      payload: { version: 1, keyId: "next", policySerial: 7 },
      privateKey: keyB.privateKey,
    });

    const config: OpenClawConfig = {
      policy: {
        enabled: true,
        failClosed: true,
        policyPath,
        sigPath,
        statePath,
        publicKeys: {
          active: keyA.publicKey,
          next: keyB.publicKey,
        },
      },
    };

    const state = await getPolicyManagerState({ config, forceReload: true });
    expect(state.valid).toBe(true);
    expect(state.lockdown).toBe(false);
    expect(state.verifiedKeyId).toBe("next");
    expect(state.lastAcceptedSerial).toBe(7);
    const persistedRaw = await fs.readFile(statePath, "utf8");
    const persisted = JSON.parse(persistedRaw) as Record<string, unknown>;
    expect(persisted.keyId).toBe("next");
  });

  it("rejects rollback to a lower policySerial", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-policy-rollback-"));
    const policyPath = path.join(dir, "POLICY.json");
    const sigPath = path.join(dir, "POLICY.sig");
    const statePath = path.join(dir, "POLICY.state.json");
    const keys = generateRawBase64Keypair();

    const config: OpenClawConfig = {
      policy: {
        enabled: true,
        failClosed: true,
        policyPath,
        sigPath,
        statePath,
        publicKey: keys.publicKey,
      },
    };

    await writeSignedPolicy({
      policyPath,
      sigPath,
      payload: { version: 1, policySerial: 9 },
      privateKey: keys.privateKey,
    });
    const first = await getPolicyManagerState({ config, forceReload: true });
    expect(first.valid).toBe(true);
    expect(first.lastAcceptedSerial).toBe(9);

    await writeSignedPolicy({
      policyPath,
      sigPath,
      payload: { version: 1, policySerial: 8 },
      privateKey: keys.privateKey,
    });
    const second = await getPolicyManagerState({ config, forceReload: true });
    expect(second.valid).toBe(false);
    expect(second.lockdown).toBe(true);
    expect(second.reason).toContain("policy rollback detected");
  });

  it("rejects an expired policy", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-policy-expired-"));
    const policyPath = path.join(dir, "POLICY.json");
    const sigPath = path.join(dir, "POLICY.sig");
    const keys = generateRawBase64Keypair();
    await writeSignedPolicy({
      policyPath,
      sigPath,
      payload: { version: 1, policySerial: 1, expiresAt: "2000-01-01T00:00:00Z" },
      privateKey: keys.privateKey,
    });

    const config: OpenClawConfig = {
      policy: {
        enabled: true,
        failClosed: true,
        policyPath,
        sigPath,
        publicKey: keys.publicKey,
      },
    };

    const state = await getPolicyManagerState({ config, forceReload: true });
    expect(state.valid).toBe(false);
    expect(state.lockdown).toBe(true);
    expect(state.reason).toContain("policy expired at");
  });

  it("rejects issuedAt rollback when policySerial is absent", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-policy-issuedat-"));
    const policyPath = path.join(dir, "POLICY.json");
    const sigPath = path.join(dir, "POLICY.sig");
    const statePath = path.join(dir, "POLICY.state.json");
    const keys = generateRawBase64Keypair();

    const config: OpenClawConfig = {
      policy: {
        enabled: true,
        failClosed: true,
        policyPath,
        sigPath,
        statePath,
        publicKey: keys.publicKey,
      },
    };

    await writeSignedPolicy({
      policyPath,
      sigPath,
      payload: { version: 1, issuedAt: "2026-03-05T10:00:00.000Z" },
      privateKey: keys.privateKey,
    });
    const first = await getPolicyManagerState({ config, forceReload: true });
    expect(first.valid).toBe(true);

    await writeSignedPolicy({
      policyPath,
      sigPath,
      payload: { version: 1, issuedAt: "2026-03-05T09:00:00.000Z" },
      privateKey: keys.privateKey,
    });
    const second = await getPolicyManagerState({ config, forceReload: true });
    expect(second.valid).toBe(false);
    expect(second.lockdown).toBe(true);
    expect(second.reason).toContain("policy rollback detected: issuedAt");
  });
});
