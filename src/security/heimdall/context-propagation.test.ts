import { describe, it, expect } from "vitest";
import type { HeimdallConfig } from "./types.js";
import { resolveSenderTier } from "./sender-tier.js";
import { SenderTier } from "./types.js";

/**
 * SecurityContext propagation tests.
 *
 * In the actual pipeline, senderTier is resolved in createOpenClawCodingTools()
 * from senderIsOwner + config (which are propagated through followupRun.run).
 * These tests verify that the resolution is deterministic and consistent.
 */
describe("SecurityContext propagation", () => {
  const config: HeimdallConfig = {
    enabled: true,
    senderTiers: {
      owners: [111, "thebtf"],
      members: [222],
    },
  };

  it("same senderId resolves to same tier across calls", () => {
    const tier1 = resolveSenderTier(111, undefined, config);
    const tier2 = resolveSenderTier(111, undefined, config);
    expect(tier1).toBe(SenderTier.OWNER);
    expect(tier1).toBe(tier2);
  });

  it("senderTier preserved through nested resolution (same config)", () => {
    // Simulates followup run: same config → same tier
    const parentTier = resolveSenderTier(222, undefined, config);
    const childTier = resolveSenderTier(222, undefined, config);
    expect(parentTier).toBe(SenderTier.MEMBER);
    expect(parentTier).toBe(childTier);
  });

  it("unknown sender resolves to GUEST consistently", () => {
    const tier = resolveSenderTier(999, undefined, config);
    expect(tier).toBe(SenderTier.GUEST);
  });

  it("missing senderTiers → always GUEST", () => {
    const emptyConfig: HeimdallConfig = { enabled: true };
    const tier = resolveSenderTier(111, undefined, emptyConfig);
    expect(tier).toBe(SenderTier.GUEST);
  });

  it("senderIsOwner override: cron with no senderId in config still gets OWNER via override", () => {
    // This tests the override logic in pi-tools.ts:
    // When senderIsOwner=true but senderId="cron" (not in owners list),
    // resolveSenderTier returns GUEST, but pi-tools overrides to OWNER.
    const tier = resolveSenderTier("cron", undefined, config);
    expect(tier).toBe(SenderTier.GUEST); // without override
    // The actual OWNER override is applied in createOpenClawCodingTools
  });

  // ---------------------------------------------------------------------------
  // Task 2.2: internal flag → isTrustedInternal → SYSTEM tier
  // ---------------------------------------------------------------------------

  it("isTrustedInternal=true → SYSTEM tier (internal runtime calls)", () => {
    // When isTrustedInternal flag is set, tier is SYSTEM regardless of senderId
    const tier = resolveSenderTier("cron", undefined, config, undefined, true);
    expect(tier).toBe(SenderTier.SYSTEM);
  });

  it("isTrustedInternal=true overrides owner status (SYSTEM has priority)", () => {
    // Even if senderId is in owners list, isTrustedInternal takes precedence
    const tier = resolveSenderTier(111, "thebtf", config, undefined, true);
    expect(tier).toBe(SenderTier.SYSTEM);
  });

  it("isTrustedInternal=false → normal tier resolution (no SYSTEM)", () => {
    // Explicit false should not trigger SYSTEM tier
    const tier = resolveSenderTier(111, "thebtf", config, undefined, false);
    expect(tier).toBe(SenderTier.OWNER);
  });

  it("isTrustedInternal=undefined → normal tier resolution (backward compatible)", () => {
    // Undefined (default) should not trigger SYSTEM tier
    const tier = resolveSenderTier("cron", undefined, config, undefined, undefined);
    expect(tier).toBe(SenderTier.GUEST);
  });
});
