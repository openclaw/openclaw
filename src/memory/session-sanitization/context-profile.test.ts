import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  BUILT_IN_PROFILE_IDS,
  clearCustomProfileCache,
  resolveContextProfile,
} from "./context-profile.js";

afterEach(() => {
  clearCustomProfileCache();
});

// ---------------------------------------------------------------------------
// Built-in profile selection
// ---------------------------------------------------------------------------

describe("resolveContextProfile — built-in profiles", () => {
  it("returns general profile by default when no config provided", () => {
    const profile = resolveContextProfile(undefined);
    expect(profile.id).toBe("general");
    expect(profile.isCustom).toBe(false);
    expect(profile.baseProfile).toBe("general");
  });

  it("returns general profile when context.profile is omitted", () => {
    const profile = resolveContextProfile({});
    expect(profile.id).toBe("general");
  });

  it("resolves each built-in profile by name", () => {
    for (const id of BUILT_IN_PROFILE_IDS) {
      const profile = resolveContextProfile({ profile: id });
      expect(profile.id).toBe(id);
      expect(profile.isCustom).toBe(false);
      expect(profile.baseProfile).toBe(id);
    }
  });

  it("general profile has broadest restrictions (no suppressRules, strict schema)", () => {
    const p = resolveContextProfile({ profile: "general" });
    expect(p.syntacticEmphasis.suppressRules).toEqual([]);
    expect(p.syntacticEmphasis.addRules).toEqual([]);
    expect(p.schemaStrictness).toBe("strict");
    expect(p.rejectUndeclaredToolSchemas).toBe(false);
    expect(p.auditVerbosityFloor).toBe("minimal");
    expect(p.frequencyWeightOverrides).toEqual({});
    expect(p.promptSuffix).toBe("");
  });

  it("customer-service profile: lenient transcript schema, strict mcp schema, high verbosity floor", () => {
    const p = resolveContextProfile({ profile: "customer-service" });
    expect(p.schemaStrictness).toEqual({ transcript: "lenient", mcp: "strict" });
    expect(p.auditVerbosityFloor).toBe("high");
    expect(p.frequencyWeightOverrides["credential.*"]).toBe(15);
    expect(p.promptSuffix).toBeTruthy();
  });

  it("code-generation profile: suppresses structural.encoding-trick, lenient schema", () => {
    const p = resolveContextProfile({ profile: "code-generation" });
    expect(p.syntacticEmphasis.suppressRules).toContain("structural.encoding-trick");
    expect(p.schemaStrictness).toBe("lenient");
    expect(p.frequencyWeightOverrides["structural.encoding-trick"]).toBe(1);
    expect(p.frequencyWeightOverrides["credential.*"]).toBe(12);
    expect(p.promptSuffix).toBeTruthy();
  });

  it("research profile: suppresses injection.role-switch-only, lenient schema", () => {
    const p = resolveContextProfile({ profile: "research" });
    expect(p.syntacticEmphasis.suppressRules).toContain("injection.role-switch-only");
    expect(p.schemaStrictness).toBe("lenient");
    expect(p.frequencyWeightOverrides["injection.role-switch-only"]).toBe(2);
    expect(p.promptSuffix).toBeTruthy();
  });

  it("admin profile: maximum verbosity, lower frequency thresholds, rejectUndeclaredToolSchemas", () => {
    const p = resolveContextProfile({ profile: "admin" });
    expect(p.auditVerbosityFloor).toBe("maximum");
    expect(p.frequencyThresholdOverrides.tier1).toBe(10);
    expect(p.frequencyThresholdOverrides.tier2).toBe(20);
    expect(p.frequencyThresholdOverrides.tier3).toBe(35);
    expect(p.rejectUndeclaredToolSchemas).toBe(true);
    expect(p.syntacticEmphasis.suppressRules).toEqual([]);
    expect(p.schemaStrictness).toBe("strict");
    expect(p.promptSuffix).toBeTruthy();
  });

  it("throws on unknown profile name with no customProfilePath", () => {
    expect(() => resolveContextProfile({ profile: "unknown-profile" })).toThrow(
      /not a built-in profile.*customProfilePath/,
    );
  });
});

// ---------------------------------------------------------------------------
// Custom profile loading and validation
// ---------------------------------------------------------------------------

function writeTmpProfile(obj: unknown): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-profile-test-"));
  const filePath = path.join(dir, "profile.json");
  fs.writeFileSync(filePath, JSON.stringify(obj), "utf8");
  return filePath;
}

describe("resolveContextProfile — custom profiles", () => {
  it("loads a valid custom profile from file", () => {
    const filePath = writeTmpProfile({
      id: "my-custom",
      description: "Test profile",
      baseProfile: "general",
      overrides: {},
    });
    const profile = resolveContextProfile({ profile: "my-custom", customProfilePath: filePath });
    expect(profile.id).toBe("my-custom");
    expect(profile.isCustom).toBe(true);
    expect(profile.baseProfile).toBe("general");
  });

  it("inherits syntacticEmphasis.suppressRules from base profile", () => {
    const filePath = writeTmpProfile({
      id: "custom-code",
      baseProfile: "code-generation",
      overrides: {},
    });
    const profile = resolveContextProfile({ profile: "custom-code", customProfilePath: filePath });
    // inherits code-generation's suppressRules
    expect(profile.syntacticEmphasis.suppressRules).toContain("structural.encoding-trick");
  });

  it("custom profile with addRules must exist in RULE_TAXONOMY", () => {
    const filePath = writeTmpProfile({
      id: "bad-add",
      baseProfile: "general",
      overrides: { syntacticEmphasis: { addRules: ["nonexistent.rule"] } },
    });
    expect(() =>
      resolveContextProfile({ profile: "bad-add", customProfilePath: filePath }),
    ).toThrow(/RULE_TAXONOMY/);
  });

  it("custom profile with suppressRules must exist in RULE_TAXONOMY", () => {
    const filePath = writeTmpProfile({
      id: "bad-suppress",
      baseProfile: "general",
      overrides: { syntacticEmphasis: { suppressRules: ["fake.rule"] } },
    });
    expect(() =>
      resolveContextProfile({ profile: "bad-suppress", customProfilePath: filePath }),
    ).toThrow(/RULE_TAXONOMY/);
  });

  it("custom profile id colliding with built-in name fails", () => {
    // File declares id "admin" (a built-in name). Load via a non-built-in profile name
    // to force the file to be read and the collision check to fire.
    const filePath = writeTmpProfile({
      id: "admin",
      baseProfile: "general",
      overrides: {},
    });
    expect(() =>
      resolveContextProfile({ profile: "not-a-builtin", customProfilePath: filePath }),
    ).toThrow(/collides with a built-in/);
  });

  it("custom profile with invalid baseProfile fails", () => {
    const filePath = writeTmpProfile({
      id: "my-custom",
      baseProfile: "not-a-real-profile",
      overrides: {},
    });
    expect(() =>
      resolveContextProfile({ profile: "my-custom", customProfilePath: filePath }),
    ).toThrow(/baseProfile/);
  });

  it("subAgentPromptAppend exceeding 4096 bytes fails", () => {
    const filePath = writeTmpProfile({
      id: "big-append",
      baseProfile: "general",
      overrides: { subAgentPromptAppend: "x".repeat(4097) },
    });
    expect(() =>
      resolveContextProfile({ profile: "big-append", customProfilePath: filePath }),
    ).toThrow(/4096 byte/);
  });

  it("subAgentPromptAppend with template variables fails", () => {
    for (const tpl of ["${var}", "{{var}}", "%s"]) {
      clearCustomProfileCache();
      const filePath = writeTmpProfile({
        id: "tpl-append",
        baseProfile: "general",
        overrides: { subAgentPromptAppend: `Hello ${tpl} world` },
      });
      expect(() =>
        resolveContextProfile({ profile: "tpl-append", customProfilePath: filePath }),
      ).toThrow(/template variables/);
    }
  });

  it("custom profile path with path traversal is rejected", () => {
    expect(() =>
      resolveContextProfile({ profile: "x", customProfilePath: "/tmp/../etc/passwd" }),
    ).toThrow(/path traversal/);
  });

  it("custom profile path with http:// scheme is rejected", () => {
    expect(() =>
      resolveContextProfile({ profile: "x", customProfilePath: "http://example.com/profile.json" }),
    ).toThrow(/remote URL/);
  });

  it("frequencyThresholdOverrides invalid ordering is rejected", () => {
    const filePath = writeTmpProfile({
      id: "bad-thresholds",
      baseProfile: "general",
      overrides: { frequencyThresholdOverrides: { tier1: 30, tier2: 10 } },
    });
    expect(() =>
      resolveContextProfile({ profile: "bad-thresholds", customProfilePath: filePath }),
    ).toThrow(/tier1.*tier2/);
  });

  it("schemaStrictness per-source object is accepted", () => {
    const filePath = writeTmpProfile({
      id: "per-source",
      baseProfile: "general",
      overrides: { schemaStrictness: { transcript: "lenient", mcp: "strict" } },
    });
    const profile = resolveContextProfile({ profile: "per-source", customProfilePath: filePath });
    expect(profile.schemaStrictness).toEqual({ transcript: "lenient", mcp: "strict" });
  });

  it("invalid schemaStrictness value is rejected", () => {
    const filePath = writeTmpProfile({
      id: "bad-strictness",
      baseProfile: "general",
      overrides: { schemaStrictness: "very-strict" },
    });
    expect(() =>
      resolveContextProfile({ profile: "bad-strictness", customProfilePath: filePath }),
    ).toThrow(/schemaStrictness/);
  });

  it("frequencyWeightOverrides with negative value is rejected", () => {
    const filePath = writeTmpProfile({
      id: "neg-weight",
      baseProfile: "general",
      overrides: { frequencyWeightOverrides: { "injection.*": -1 } },
    });
    expect(() =>
      resolveContextProfile({ profile: "neg-weight", customProfilePath: filePath }),
    ).toThrow(/non-negative/);
  });

  it("frequencyWeightOverrides key not in RULE_TAXONOMY is rejected", () => {
    const filePath = writeTmpProfile({
      id: "bad-weight-key",
      baseProfile: "general",
      overrides: { frequencyWeightOverrides: { "unknown.category.*": 5 } },
    });
    expect(() =>
      resolveContextProfile({ profile: "bad-weight-key", customProfilePath: filePath }),
    ).toThrow(/RULE_TAXONOMY/);
  });

  it("custom profile is cached on second load", () => {
    const filePath = writeTmpProfile({
      id: "cacheable",
      baseProfile: "general",
      overrides: {},
    });
    const a = resolveContextProfile({ profile: "cacheable", customProfilePath: filePath });
    const b = resolveContextProfile({ profile: "cacheable", customProfilePath: filePath });
    expect(a).toBe(b); // same object reference — cache hit
  });

  it("custom profile file id mismatch vs config profile name throws", () => {
    const filePath = writeTmpProfile({
      id: "actual-id",
      baseProfile: "general",
      overrides: {},
    });
    expect(() =>
      resolveContextProfile({ profile: "different-id", customProfilePath: filePath }),
    ).toThrow(/declares id 'actual-id' but config requests 'different-id'/);
  });
});

// ---------------------------------------------------------------------------
// Prompt assembly
// ---------------------------------------------------------------------------

describe("resolveContextProfile — prompt suffix", () => {
  it("general profile has empty prompt suffix", () => {
    const p = resolveContextProfile({ profile: "general" });
    expect(p.promptSuffix).toBe("");
  });

  it("non-general built-in profiles have non-empty prompt suffix", () => {
    for (const id of BUILT_IN_PROFILE_IDS) {
      if (id === "general") continue;
      const p = resolveContextProfile({ profile: id });
      expect(p.promptSuffix.length).toBeGreaterThan(0);
    }
  });

  it("custom profile subAgentPromptAppend replaces base promptSuffix", () => {
    const filePath = writeTmpProfile({
      id: "custom-prompt",
      baseProfile: "general",
      overrides: { subAgentPromptAppend: "Custom instructions here." },
    });
    const profile = resolveContextProfile({
      profile: "custom-prompt",
      customProfilePath: filePath,
    });
    expect(profile.promptSuffix).toBe("Custom instructions here.");
  });
});
