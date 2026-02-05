import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  getTrustEnforcementConfig,
  clearTrustEnforcementConfigCache,
} from "./agentshield-trust-config.js";

describe("AgentShield Trust Config", () => {
  const envBackup: Record<string, string | undefined> = {};
  const envKeys = [
    "AGENTSHIELD_TRUST_ROOT",
    "AGENTSHIELD_REVOCATIONS_FILE",
    "AGENTSHIELD_REQUIRE_KEYRING",
    "AGENTSHIELD_REQUIRE_NOT_REVOKED",
    "AGENTSHIELD_KEYS_DIR",
  ];

  beforeEach(() => {
    for (const key of envKeys) {
      envBackup[key] = process.env[key];
      delete process.env[key];
    }
    clearTrustEnforcementConfigCache();
  });

  afterEach(() => {
    for (const key of envKeys) {
      if (envBackup[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = envBackup[key];
      }
    }
    clearTrustEnforcementConfigCache();
  });

  it("returns disabled config when no env vars set", () => {
    const config = getTrustEnforcementConfig();
    expect(config.enabled).toBe(false);
    expect(config.trustRoot).toBeNull();
    expect(config.revocationsFile).toBeNull();
    expect(config.requireKeyring).toBe(false);
    expect(config.requireNotRevoked).toBe(false);
    expect(config.keysDir).toBeNull();
  });

  it("enables when TRUST_ROOT is set", () => {
    process.env.AGENTSHIELD_TRUST_ROOT = "/tmp/trust";
    const config = getTrustEnforcementConfig();
    expect(config.enabled).toBe(true);
    expect(config.trustRoot).toBe("/tmp/trust");
  });

  it("defaults revocations file to trust_root/revocations.json", () => {
    process.env.AGENTSHIELD_TRUST_ROOT = "/tmp/trust";
    const config = getTrustEnforcementConfig();
    expect(config.revocationsFile).toBe("/tmp/trust/revocations.json");
  });

  it("allows explicit revocations file override", () => {
    process.env.AGENTSHIELD_TRUST_ROOT = "/tmp/trust";
    process.env.AGENTSHIELD_REVOCATIONS_FILE = "/other/revocations.json";
    const config = getTrustEnforcementConfig();
    expect(config.revocationsFile).toBe("/other/revocations.json");
  });

  it("parses REQUIRE_KEYRING=1", () => {
    process.env.AGENTSHIELD_TRUST_ROOT = "/tmp/trust";
    process.env.AGENTSHIELD_REQUIRE_KEYRING = "1";
    const config = getTrustEnforcementConfig();
    expect(config.requireKeyring).toBe(true);
  });

  it("parses REQUIRE_NOT_REVOKED=1", () => {
    process.env.AGENTSHIELD_TRUST_ROOT = "/tmp/trust";
    process.env.AGENTSHIELD_REQUIRE_NOT_REVOKED = "1";
    const config = getTrustEnforcementConfig();
    expect(config.requireNotRevoked).toBe(true);
  });

  it("reads KEYS_DIR", () => {
    process.env.AGENTSHIELD_KEYS_DIR = "/data/keys";
    const config = getTrustEnforcementConfig();
    expect(config.keysDir).toBe("/data/keys");
  });

  it("caches config across calls", () => {
    process.env.AGENTSHIELD_TRUST_ROOT = "/tmp/trust";
    const config1 = getTrustEnforcementConfig();
    process.env.AGENTSHIELD_TRUST_ROOT = "/changed";
    const config2 = getTrustEnforcementConfig();
    expect(config2.trustRoot).toBe(config1.trustRoot);
  });

  it("clears cache on clearTrustEnforcementConfigCache", () => {
    process.env.AGENTSHIELD_TRUST_ROOT = "/tmp/trust";
    getTrustEnforcementConfig();
    clearTrustEnforcementConfigCache();
    process.env.AGENTSHIELD_TRUST_ROOT = "/changed";
    const config = getTrustEnforcementConfig();
    expect(config.trustRoot).toBe("/changed");
  });
});
