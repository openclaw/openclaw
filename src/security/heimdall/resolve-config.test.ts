import { describe, it, expect } from "vitest";
import type { HeimdallConfig } from "./types.js";
import { resolveHeimdallConfig } from "./resolve-config.js";

describe("resolveHeimdallConfig", () => {
  const globalCfg: HeimdallConfig = {
    enabled: true,
    senderTiers: { owners: [111], members: [222] },
    defaultGuestPolicy: "deny",
    toolACL: [{ pattern: "exec", allowedTiers: ["owner"] }],
    outputFilter: { enabled: true, customPatterns: [{ name: "pat1", regex: "secret1" }] },
    sanitize: { maxLength: 50_000, nfkcNormalize: true },
    rateLimit: { enabled: true, windowMs: 60_000, maxMessages: 30 },
    audit: { enabled: true, logBlockedTools: true, logRedactions: false },
  };

  it("returns global config when no per-channel override", () => {
    const result = resolveHeimdallConfig(globalCfg, undefined);
    expect(result).toEqual(globalCfg);
  });

  it("returns per-channel config when no global", () => {
    const channelCfg: HeimdallConfig = { enabled: true, sanitize: { maxLength: 10_000 } };
    const result = resolveHeimdallConfig(undefined, channelCfg);
    expect(result).toEqual(channelCfg);
  });

  it("returns undefined when both are undefined", () => {
    expect(resolveHeimdallConfig(undefined, undefined)).toBeUndefined();
  });

  it("merges senderTiers.owners as UNION (deduped)", () => {
    const channel: HeimdallConfig = {
      senderTiers: { owners: [111, 333] },
    };
    const result = resolveHeimdallConfig(globalCfg, channel)!;
    // 111 deduped, 333 added from channel
    expect(result.senderTiers?.owners).toEqual([111, 333]);
    // members from global preserved
    expect(result.senderTiers?.members).toEqual([222]);
  });

  it("merges senderTiers.members as UNION (deduped)", () => {
    const channel: HeimdallConfig = {
      senderTiers: { members: [222, 444] },
    };
    const result = resolveHeimdallConfig(globalCfg, channel)!;
    expect(result.senderTiers?.members).toEqual([222, 444]);
    // owners from global preserved
    expect(result.senderTiers?.owners).toEqual([111]);
  });

  it("toolACL: per-channel REPLACES global", () => {
    const channel: HeimdallConfig = {
      toolACL: [{ pattern: "browser_*", allowedTiers: ["member"] }],
    };
    const result = resolveHeimdallConfig(globalCfg, channel)!;
    expect(result.toolACL).toEqual([{ pattern: "browser_*", allowedTiers: ["member"] }]);
  });

  it("outputFilter.customPatterns: UNION (deduped by name)", () => {
    const channel: HeimdallConfig = {
      outputFilter: {
        customPatterns: [
          { name: "pat1", regex: "override" },
          { name: "pat2", regex: "new_secret" },
        ],
      },
    };
    const result = resolveHeimdallConfig(globalCfg, channel)!;
    // pat1 from channel overrides global's pat1; pat2 is new
    expect(result.outputFilter?.customPatterns).toEqual([
      { name: "pat1", regex: "override" },
      { name: "pat2", regex: "new_secret" },
    ]);
  });

  it("outputFilter.enabled: per-channel overrides global", () => {
    const channel: HeimdallConfig = {
      outputFilter: { enabled: false },
    };
    const result = resolveHeimdallConfig(globalCfg, channel)!;
    expect(result.outputFilter?.enabled).toBe(false);
  });

  it("sanitize: shallow-merge (per-channel fields override)", () => {
    const channel: HeimdallConfig = {
      sanitize: { maxLength: 10_000 },
    };
    const result = resolveHeimdallConfig(globalCfg, channel)!;
    expect(result.sanitize?.maxLength).toBe(10_000);
    expect(result.sanitize?.nfkcNormalize).toBe(true); // from global
  });

  it("rateLimit: per-channel overrides global entirely", () => {
    const channel: HeimdallConfig = {
      rateLimit: { enabled: false },
    };
    const result = resolveHeimdallConfig(globalCfg, channel)!;
    expect(result.rateLimit?.enabled).toBe(false);
    // windowMs not set in channel, shallow merge from global
    expect(result.rateLimit?.windowMs).toBe(60_000);
  });

  it("disabled globally → per-channel cannot re-enable", () => {
    const disabled: HeimdallConfig = { enabled: false };
    const channel: HeimdallConfig = { enabled: true };
    const result = resolveHeimdallConfig(disabled, channel)!;
    expect(result.enabled).toBe(false);
  });

  it("enabled globally → per-channel can disable", () => {
    const channel: HeimdallConfig = { enabled: false };
    const result = resolveHeimdallConfig(globalCfg, channel)!;
    expect(result.enabled).toBe(false);
  });

  it("null/undefined channel fields → fallback to global", () => {
    const channel: HeimdallConfig = {
      // only override sanitize, everything else undefined
      sanitize: { controlCharDensityThreshold: 0.05 },
    };
    const result = resolveHeimdallConfig(globalCfg, channel)!;
    expect(result.defaultGuestPolicy).toBe("deny");
    expect(result.toolACL).toEqual(globalCfg.toolACL);
    expect(result.senderTiers?.owners).toEqual([111]);
    expect(result.audit).toEqual(globalCfg.audit);
  });

  it("per-channel owners promoted to global owners (UNION includes channel owners in members list)", () => {
    const channel: HeimdallConfig = {
      senderTiers: { owners: [555] },
    };
    const result = resolveHeimdallConfig(globalCfg, channel)!;
    // 555 is now an owner via channel override
    expect(result.senderTiers?.owners).toContain(555);
    // original global owner still present
    expect(result.senderTiers?.owners).toContain(111);
  });

  it("audit: shallow merge", () => {
    const channel: HeimdallConfig = {
      audit: { logRedactions: true },
    };
    const result = resolveHeimdallConfig(globalCfg, channel)!;
    expect(result.audit?.logRedactions).toBe(true);
    expect(result.audit?.logBlockedTools).toBe(true); // from global
    expect(result.audit?.enabled).toBe(true); // from global
  });
});
