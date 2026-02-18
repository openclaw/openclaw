import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { clearKeyringCaches, KEYRING_SCHEMA } from "./agentshield-keyring.js";
import { clearRevocationsCache } from "./agentshield-revocations.js";
import { clearTrustEnforcementConfigCache } from "./agentshield-trust-config.js";
import {
  enforceTrust,
  isTrustEnforcementEnabled,
  getRevocationsStatus,
  getKeyringStatus,
  runTrustChecks,
} from "./agentshield-trust-enforcement.js";

describe("AgentShield Trust Enforcement", () => {
  let tempDir: string;
  let revocationsPath: string;

  const envBackup: Record<string, string | undefined> = {};
  const envKeys = [
    "AGENTSHIELD_TRUST_ROOT",
    "AGENTSHIELD_REVOCATIONS_FILE",
    "AGENTSHIELD_REQUIRE_KEYRING",
    "AGENTSHIELD_REQUIRE_NOT_REVOKED",
  ];

  beforeEach(() => {
    for (const key of envKeys) {
      envBackup[key] = process.env[key];
      delete process.env[key];
    }
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentshield-enforcement-test-"));
    revocationsPath = path.join(tempDir, "revocations.json");
    clearRevocationsCache();
    clearKeyringCaches();
    clearTrustEnforcementConfigCache();
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
    for (const key of envKeys) {
      if (envBackup[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = envBackup[key];
      }
    }
    clearRevocationsCache();
    clearKeyringCaches();
    clearTrustEnforcementConfigCache();
  });

  function writeRevocations(revocations: object) {
    fs.writeFileSync(revocationsPath, JSON.stringify(revocations, null, 2));
  }

  function writeKeyring(publisherId: string, keyring: object) {
    const pubDir = path.join(tempDir, "publishers", publisherId);
    fs.mkdirSync(pubDir, { recursive: true });
    fs.writeFileSync(path.join(pubDir, "keyring.json"), JSON.stringify(keyring, null, 2));
  }

  describe("disabled enforcement", () => {
    it("allows everything when trust root is not set", () => {
      const result = enforceTrust({ publisherId: "test" });
      expect(result.action).toBe("allow");
      expect(result.details.enabled).toBe(false);
    });

    it("reports not enabled", () => {
      expect(isTrustEnforcementEnabled()).toBe(false);
    });
  });

  describe("revocation checks", () => {
    beforeEach(() => {
      process.env.AGENTSHIELD_TRUST_ROOT = tempDir;
      process.env.AGENTSHIELD_REVOCATIONS_FILE = revocationsPath;
      clearTrustEnforcementConfigCache();
    });

    it("allows when publisher is not revoked", () => {
      process.env.AGENTSHIELD_REQUIRE_NOT_REVOKED = "1";
      clearTrustEnforcementConfigCache();

      writeRevocations({
        type: "agentshield.revocations",
        schema: "agentshield.revocation_list.v1",
        issued_at: "2025-01-01T00:00:00Z",
        publisher_id: "test-publisher",
        revocations: [
          {
            kind: "pubkey",
            id: "other-publisher",
            reason: "compromised",
            revoked_at: "2025-01-01T00:00:00Z",
          },
        ],
        signing: { type: "agentshield.revocations", alg: "ed25519", pubkey: "", sig: "" },
      });

      const result = enforceTrust({ publisherId: "good-publisher" });
      expect(result.action).toBe("allow");
    });

    it("blocks revoked publisher when REQUIRE_NOT_REVOKED=1", () => {
      process.env.AGENTSHIELD_REQUIRE_NOT_REVOKED = "1";
      clearTrustEnforcementConfigCache();

      writeRevocations({
        type: "agentshield.revocations",
        schema: "agentshield.revocation_list.v1",
        issued_at: "2025-01-01T00:00:00Z",
        publisher_id: "test-publisher",
        revocations: [
          {
            kind: "pubkey",
            id: "bad-publisher",
            reason: "compromised key",
            revoked_at: "2025-01-01T00:00:00Z",
          },
        ],
        signing: { type: "agentshield.revocations", alg: "ed25519", pubkey: "", sig: "" },
      });

      const result = enforceTrust({ publisherId: "bad-publisher" });
      expect(result.action).toBe("block");
      expect(result.reason).toContain("revoked");
      expect(result.details.publisherRevoked).toBe(true);
    });

    it("warns for revoked publisher when REQUIRE_NOT_REVOKED=0", () => {
      // REQUIRE_NOT_REVOKED defaults to 0
      writeRevocations({
        type: "agentshield.revocations",
        schema: "agentshield.revocation_list.v1",
        issued_at: "2025-01-01T00:00:00Z",
        publisher_id: "test-publisher",
        revocations: [
          {
            kind: "pubkey",
            id: "bad-publisher",
            reason: "compromised",
            revoked_at: "2025-01-01T00:00:00Z",
          },
        ],
        signing: { type: "agentshield.revocations", alg: "ed25519", pubkey: "", sig: "" },
      });

      const result = enforceTrust({ publisherId: "bad-publisher" });
      expect(result.action).toBe("warn");
      expect(result.details.publisherRevoked).toBe(true);
    });

    it("blocks revoked trust card", () => {
      process.env.AGENTSHIELD_REQUIRE_NOT_REVOKED = "1";
      clearTrustEnforcementConfigCache();

      writeRevocations({
        type: "agentshield.revocations",
        schema: "agentshield.revocation_list.v1",
        issued_at: "2025-01-01T00:00:00Z",
        publisher_id: "test-publisher",
        revocations: [
          {
            kind: "trust_card",
            id: "card-123",
            reason: "withdrawn",
            revoked_at: "2025-01-01T00:00:00Z",
          },
        ],
        signing: { type: "agentshield.revocations", alg: "ed25519", pubkey: "", sig: "" },
      });

      const result = enforceTrust({ trustCardId: "card-123" });
      expect(result.action).toBe("block");
      expect(result.reason).toContain("trust card is revoked");
    });

    it("blocks revoked skill attestation", () => {
      process.env.AGENTSHIELD_REQUIRE_NOT_REVOKED = "1";
      clearTrustEnforcementConfigCache();

      writeRevocations({
        type: "agentshield.revocations",
        schema: "agentshield.revocation_list.v1",
        issued_at: "2025-01-01T00:00:00Z",
        publisher_id: "test-publisher",
        revocations: [
          {
            kind: "skill_attestation",
            id: "sha256-abc",
            reason: "tampered",
            revoked_at: "2025-01-01T00:00:00Z",
          },
        ],
        signing: { type: "agentshield.revocations", alg: "ed25519", pubkey: "", sig: "" },
      });

      const result = enforceTrust({ contentSha256: "sha256-abc" });
      expect(result.action).toBe("block");
      expect(result.reason).toContain("artifact is revoked");
    });
  });

  describe("keyring checks", () => {
    beforeEach(() => {
      process.env.AGENTSHIELD_TRUST_ROOT = tempDir;
      process.env.AGENTSHIELD_REQUIRE_KEYRING = "1";
      clearTrustEnforcementConfigCache();
    });

    it("blocks when signer pubkey is not in keyring", () => {
      writeKeyring("test-pub", {
        schema: KEYRING_SCHEMA,
        publisher_id: "test-pub",
        keys: [
          {
            key_id: "k1",
            alg: "ed25519",
            pubkey: "known-key",
            status: "active",
            created_at: "2025-01-01T00:00:00Z",
          },
        ],
      });

      const result = enforceTrust({
        publisherId: "test-pub",
        signerPubkey: "unknown-key",
      });
      expect(result.action).toBe("block");
      expect(result.reason).toContain("not found in keyring");
    });

    it("allows active key in keyring", () => {
      writeKeyring("test-pub", {
        schema: KEYRING_SCHEMA,
        publisher_id: "test-pub",
        keys: [
          {
            key_id: "k1",
            alg: "ed25519",
            pubkey: "active-key",
            status: "active",
            created_at: "2025-01-01T00:00:00Z",
          },
        ],
      });

      const result = enforceTrust({
        publisherId: "test-pub",
        signerPubkey: "active-key",
      });
      expect(result.action).toBe("allow");
      expect(result.details.keyringChecked).toBe(true);
      expect(result.details.keyId).toBe("k1");
    });

    it("allows retired key in keyring", () => {
      writeKeyring("test-pub", {
        schema: KEYRING_SCHEMA,
        publisher_id: "test-pub",
        keys: [
          {
            key_id: "k1",
            alg: "ed25519",
            pubkey: "retired-key",
            status: "retired",
            created_at: "2025-01-01T00:00:00Z",
          },
          {
            key_id: "k2",
            alg: "ed25519",
            pubkey: "active-key",
            status: "active",
            created_at: "2025-01-01T00:00:00Z",
          },
        ],
      });

      const result = enforceTrust({
        publisherId: "test-pub",
        signerPubkey: "retired-key",
      });
      expect(result.action).toBe("allow");
    });

    it("blocks revoked key in keyring", () => {
      writeKeyring("test-pub", {
        schema: KEYRING_SCHEMA,
        publisher_id: "test-pub",
        keys: [
          {
            key_id: "k1",
            alg: "ed25519",
            pubkey: "revoked-key",
            status: "revoked",
            created_at: "2025-01-01T00:00:00Z",
          },
          {
            key_id: "k2",
            alg: "ed25519",
            pubkey: "active-key",
            status: "active",
            created_at: "2025-01-01T00:00:00Z",
          },
        ],
      });

      const result = enforceTrust({
        publisherId: "test-pub",
        signerPubkey: "revoked-key",
      });
      expect(result.action).toBe("block");
      expect(result.reason).toContain("revoked");
    });
  });

  describe("combined checks", () => {
    beforeEach(() => {
      process.env.AGENTSHIELD_TRUST_ROOT = tempDir;
      process.env.AGENTSHIELD_REVOCATIONS_FILE = revocationsPath;
      process.env.AGENTSHIELD_REQUIRE_NOT_REVOKED = "1";
      process.env.AGENTSHIELD_REQUIRE_KEYRING = "1";
      clearTrustEnforcementConfigCache();
    });

    it("blocks on both revocation and keyring failure", () => {
      writeRevocations({
        type: "agentshield.revocations",
        schema: "agentshield.revocation_list.v1",
        issued_at: "2025-01-01T00:00:00Z",
        publisher_id: "test-publisher",
        revocations: [
          {
            kind: "pubkey",
            id: "bad-pub",
            reason: "compromised",
            revoked_at: "2025-01-01T00:00:00Z",
          },
        ],
        signing: { type: "agentshield.revocations", alg: "ed25519", pubkey: "", sig: "" },
      });

      writeKeyring("bad-pub", {
        schema: KEYRING_SCHEMA,
        publisher_id: "bad-pub",
        keys: [
          {
            key_id: "k1",
            alg: "ed25519",
            pubkey: "known-key",
            status: "active",
            created_at: "2025-01-01T00:00:00Z",
          },
        ],
      });

      const result = enforceTrust({
        publisherId: "bad-pub",
        signerPubkey: "unknown-key",
      });
      expect(result.action).toBe("block");
      expect(result.reason).toContain("revoked");
      expect(result.reason).toContain("keyring");
    });
  });

  describe("status helpers", () => {
    it("reports revocations not available when not configured", () => {
      const status = getRevocationsStatus();
      expect(status.available).toBe(false);
    });

    it("reports revocations available when file exists", () => {
      process.env.AGENTSHIELD_TRUST_ROOT = tempDir;
      process.env.AGENTSHIELD_REVOCATIONS_FILE = revocationsPath;
      clearTrustEnforcementConfigCache();

      writeRevocations({
        type: "agentshield.revocations",
        schema: "agentshield.revocation_list.v1",
        issued_at: "2025-01-01T00:00:00Z",
        publisher_id: "test",
        revocations: [],
        signing: { type: "agentshield.revocations", alg: "ed25519", pubkey: "", sig: "" },
      });

      const status = getRevocationsStatus();
      expect(status.available).toBe(true);
    });

    it("reports keyring status", () => {
      process.env.AGENTSHIELD_TRUST_ROOT = tempDir;
      clearTrustEnforcementConfigCache();

      writeKeyring("test-pub", {
        schema: KEYRING_SCHEMA,
        publisher_id: "test-pub",
        keys: [
          {
            key_id: "k1",
            alg: "ed25519",
            pubkey: "abc",
            status: "active",
            created_at: "2025-01-01T00:00:00Z",
          },
        ],
      });

      const status = getKeyringStatus("test-pub");
      expect(status.available).toBe(true);
      expect(status.activeKeyCount).toBe(1);
    });

    it("runTrustChecks returns combined result", () => {
      process.env.AGENTSHIELD_TRUST_ROOT = tempDir;
      process.env.AGENTSHIELD_REVOCATIONS_FILE = revocationsPath;
      clearTrustEnforcementConfigCache();

      writeRevocations({
        type: "agentshield.revocations",
        schema: "agentshield.revocation_list.v1",
        issued_at: "2025-01-01T00:00:00Z",
        publisher_id: "test",
        revocations: [],
        signing: { type: "agentshield.revocations", alg: "ed25519", pubkey: "", sig: "" },
      });

      writeKeyring("test-pub", {
        schema: KEYRING_SCHEMA,
        publisher_id: "test-pub",
        keys: [
          {
            key_id: "k1",
            alg: "ed25519",
            pubkey: "abc",
            status: "active",
            created_at: "2025-01-01T00:00:00Z",
          },
        ],
      });

      const checks = runTrustChecks({ publisherId: "test-pub" });
      expect(checks.result.action).toBe("allow");
      expect(checks.revocationsStatus.available).toBe(true);
      expect(checks.keyringStatus?.available).toBe(true);
    });
  });
});
