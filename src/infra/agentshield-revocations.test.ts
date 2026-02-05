import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  loadRevocations,
  isRevoked,
  isPublisherRevoked,
  isTrustCardRevoked,
  isSkillAttestationRevoked,
  clearRevocationsCache,
  listRevocations,
  verifyRevocationList,
  type RevocationListPayload,
} from "./agentshield-revocations.js";
import { clearTrustEnforcementConfigCache } from "./agentshield-trust-config.js";

describe("AgentShield Revocations", () => {
  let tempDir: string;
  let revocationsPath: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentshield-revocations-test-"));
    revocationsPath = path.join(tempDir, "revocations.json");

    // Set up environment for trust config
    process.env.AGENTSHIELD_TRUST_ROOT = tempDir;
    process.env.AGENTSHIELD_REVOCATIONS_FILE = revocationsPath;

    // Clear caches
    clearRevocationsCache();
    clearTrustEnforcementConfigCache();
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
    delete process.env.AGENTSHIELD_TRUST_ROOT;
    delete process.env.AGENTSHIELD_REVOCATIONS_FILE;
    clearRevocationsCache();
    clearTrustEnforcementConfigCache();
  });

  describe("loadRevocations", () => {
    it("returns error when file not found", () => {
      const result = loadRevocations();
      expect(result.data).toBeNull();
      expect(result.verified).toBe(false);
      expect(result.error).toContain("not found");
    });

    it("loads unsigned revocation list", () => {
      const revocations = {
        type: "agentshield.revocations",
        schema: "agentshield.revocation_list.v1",
        issued_at: "2025-01-01T00:00:00Z",
        publisher_id: "test-publisher",
        revocations: [
          {
            kind: "pubkey",
            id: "revoked-key-id",
            reason: "compromised",
            revoked_at: "2025-01-01T00:00:00Z",
          },
        ],
        signing: {
          type: "agentshield.revocations",
          alg: "ed25519",
          pubkey: "",
          sig: "",
        },
      };

      fs.writeFileSync(revocationsPath, JSON.stringify(revocations, null, 2));

      const result = loadRevocations();
      expect(result.data).not.toBeNull();
      expect(result.verified).toBe(true);
    });

    it("caches loaded revocations by mtime", () => {
      const revocations = {
        type: "agentshield.revocations",
        schema: "agentshield.revocation_list.v1",
        issued_at: "2025-01-01T00:00:00Z",
        publisher_id: "test-publisher",
        revocations: [],
        signing: { type: "agentshield.revocations", alg: "ed25519", pubkey: "", sig: "" },
      };

      fs.writeFileSync(revocationsPath, JSON.stringify(revocations));

      // First load
      const result1 = loadRevocations();
      expect(result1.data).not.toBeNull();

      // Second load should use cache
      const result2 = loadRevocations();
      expect(result2.data).not.toBeNull();
    });
  });

  describe("isRevoked", () => {
    it("returns revoked=true for matching entry", () => {
      const revocations = {
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
      };

      fs.writeFileSync(revocationsPath, JSON.stringify(revocations));

      const result = isRevoked("pubkey", "bad-publisher");
      expect(result.revoked).toBe(true);
      expect(result.reason).toBe("compromised key");
    });

    it("returns revoked=false for non-matching entry", () => {
      const revocations = {
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
      };

      fs.writeFileSync(revocationsPath, JSON.stringify(revocations));

      const result = isRevoked("pubkey", "good-publisher");
      expect(result.revoked).toBe(false);
    });

    it("ignores expired revocations", () => {
      const revocations = {
        type: "agentshield.revocations",
        schema: "agentshield.revocation_list.v1",
        issued_at: "2025-01-01T00:00:00Z",
        publisher_id: "test-publisher",
        revocations: [
          {
            kind: "pubkey",
            id: "temp-revoked",
            reason: "temporary",
            revoked_at: "2025-01-01T00:00:00Z",
            expires_at: "2025-01-02T00:00:00Z", // Past date
          },
        ],
        signing: { type: "agentshield.revocations", alg: "ed25519", pubkey: "", sig: "" },
      };

      fs.writeFileSync(revocationsPath, JSON.stringify(revocations));

      const result = isRevoked("pubkey", "temp-revoked");
      expect(result.revoked).toBe(false); // Revocation expired
    });
  });

  describe("helper functions", () => {
    beforeEach(() => {
      const revocations = {
        type: "agentshield.revocations",
        schema: "agentshield.revocation_list.v1",
        issued_at: "2025-01-01T00:00:00Z",
        publisher_id: "test-publisher",
        revocations: [
          { kind: "pubkey", id: "pub-1", reason: "r1", revoked_at: "2025-01-01T00:00:00Z" },
          { kind: "trust_card", id: "tc-1", reason: "r2", revoked_at: "2025-01-01T00:00:00Z" },
          {
            kind: "skill_attestation",
            id: "sha256-1",
            reason: "r3",
            revoked_at: "2025-01-01T00:00:00Z",
          },
        ],
        signing: { type: "agentshield.revocations", alg: "ed25519", pubkey: "", sig: "" },
      };
      fs.writeFileSync(revocationsPath, JSON.stringify(revocations));
    });

    it("isPublisherRevoked checks pubkey kind", () => {
      expect(isPublisherRevoked("pub-1").revoked).toBe(true);
      expect(isPublisherRevoked("pub-2").revoked).toBe(false);
    });

    it("isTrustCardRevoked checks trust_card kind", () => {
      expect(isTrustCardRevoked("tc-1").revoked).toBe(true);
      expect(isTrustCardRevoked("tc-2").revoked).toBe(false);
    });

    it("isSkillAttestationRevoked checks skill_attestation kind", () => {
      expect(isSkillAttestationRevoked("sha256-1").revoked).toBe(true);
      expect(isSkillAttestationRevoked("sha256-2").revoked).toBe(false);
    });

    it("listRevocations returns all entries", () => {
      const entries = listRevocations();
      expect(entries.length).toBe(3);
    });
  });

  describe("verifyRevocationList", () => {
    it("validates unsigned list structure", () => {
      const unsigned = {
        type: "agentshield.revocations",
        schema: "agentshield.revocation_list.v1",
        issued_at: "2025-01-01T00:00:00Z",
        publisher_id: "test",
        revocations: [],
        signing: { type: "agentshield.revocations", alg: "ed25519", pubkey: "", sig: "" },
      };

      const [ok, reason] = verifyRevocationList(unsigned);
      expect(ok).toBe(true);
      expect(reason).toContain("ok");
    });

    it("rejects invalid type", () => {
      const invalid = {
        type: "wrong.type",
        schema: "agentshield.revocation_list.v1",
        issued_at: "2025-01-01T00:00:00Z",
        publisher_id: "test",
        revocations: [],
      };

      const [ok, reason] = verifyRevocationList(invalid as RevocationListPayload);
      expect(ok).toBe(false);
      expect(reason).toContain("unexpected type");
    });
  });
});
