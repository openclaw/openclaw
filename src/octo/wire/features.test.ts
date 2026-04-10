// Octopus Orchestrator — features advertisement tests (M0-07)
//
// Covers FeaturesOctoSchema + buildFeaturesOcto:
//   - Shape validation: canonical HLD example accepted; strict-mode
//     rejection of unknown fields at both levels; required-field
//     rejection parameterized; unknown adapter literal rejected
//   - Parameterized sweep over all four adapter literals
//   - Builder enabled branch: canonical shape, preserved ordering,
//     deduplication, capability merge, constant version, schema round-trip
//   - Builder disabled branch: ignores caller adapters, empty list,
//     default capabilities, schema round-trip
//   - Builder rejection: unknown adapter name via runtime cast throws
//   - Adapter filtering: representative node-availability scenarios
//   - Exported constants round-trip through their schemas

import { Value } from "@sinclair/typebox/value";
import { describe, expect, it } from "vitest";
import {
  FeaturesOctoSchema,
  FeaturesOctoCapabilitiesSchema,
  buildFeaturesOcto,
  FEATURES_OCTO_VERSION,
  DEFAULT_FEATURES_OCTO_CAPABILITIES,
  type FeaturesOcto,
} from "./features.ts";
import { type AdapterType } from "./schema.ts";

const ALL_ADAPTERS: readonly AdapterType[] = [
  "structured_subagent",
  "cli_exec",
  "pty_tmux",
  "structured_acp",
];

function canonicalExample(): FeaturesOcto {
  return {
    version: "1",
    enabled: true,
    adapters: ["structured_subagent", "cli_exec", "pty_tmux", "structured_acp"],
    capabilities: {
      missionBudgets: true,
      worktreeClaims: true,
      forwardProgressWatchdog: true,
    },
  };
}

// ──────────────────────────────────────────────────────────────────────────
// FeaturesOctoSchema — shape validation
// ──────────────────────────────────────────────────────────────────────────

describe("FeaturesOctoSchema — shape validation", () => {
  it("accepts the canonical HLD example", () => {
    expect(Value.Check(FeaturesOctoSchema, canonicalExample())).toBe(true);
  });

  it("rejects missing version", () => {
    const bad = canonicalExample() as Partial<FeaturesOcto>;
    delete bad.version;
    expect(Value.Check(FeaturesOctoSchema, bad)).toBe(false);
  });

  it("rejects empty version (NonEmptyString)", () => {
    const bad = { ...canonicalExample(), version: "" };
    expect(Value.Check(FeaturesOctoSchema, bad)).toBe(false);
  });

  it("rejects missing enabled", () => {
    const bad = canonicalExample() as Partial<FeaturesOcto>;
    delete bad.enabled;
    expect(Value.Check(FeaturesOctoSchema, bad)).toBe(false);
  });

  it("rejects non-boolean enabled", () => {
    const bad = { ...canonicalExample(), enabled: "true" as unknown as boolean };
    expect(Value.Check(FeaturesOctoSchema, bad)).toBe(false);
  });

  it("rejects missing adapters", () => {
    const bad = canonicalExample() as Partial<FeaturesOcto>;
    delete bad.adapters;
    expect(Value.Check(FeaturesOctoSchema, bad)).toBe(false);
  });

  it("rejects missing capabilities", () => {
    const bad = canonicalExample() as Partial<FeaturesOcto>;
    delete bad.capabilities;
    expect(Value.Check(FeaturesOctoSchema, bad)).toBe(false);
  });

  it("rejects extra top-level key (strict mode)", () => {
    const bad = { ...canonicalExample(), extra: "nope" };
    expect(Value.Check(FeaturesOctoSchema, bad)).toBe(false);
  });

  it("rejects extra key in capabilities (strict mode)", () => {
    const bad = {
      ...canonicalExample(),
      capabilities: {
        ...canonicalExample().capabilities,
        extraCap: true,
      },
    };
    expect(Value.Check(FeaturesOctoSchema, bad)).toBe(false);
  });

  it("rejects a capability field set to a non-boolean", () => {
    const bad = {
      ...canonicalExample(),
      capabilities: {
        ...canonicalExample().capabilities,
        missionBudgets: "yes" as unknown as boolean,
      },
    };
    expect(Value.Check(FeaturesOctoSchema, bad)).toBe(false);
  });

  it("rejects an unknown adapter name in the adapters array", () => {
    const bad = {
      ...canonicalExample(),
      adapters: ["structured_subagent", "cursor"] as unknown as AdapterType[],
    };
    expect(Value.Check(FeaturesOctoSchema, bad)).toBe(false);
  });

  it.each(ALL_ADAPTERS)("accepts a descriptor with exactly one adapter: %s", (adapter) => {
    const descriptor: FeaturesOcto = {
      version: "1",
      enabled: true,
      adapters: [adapter],
      capabilities: { ...DEFAULT_FEATURES_OCTO_CAPABILITIES },
    };
    expect(Value.Check(FeaturesOctoSchema, descriptor)).toBe(true);
  });
});

// ──────────────────────────────────────────────────────────────────────────
// buildFeaturesOcto — enabled branch
// ──────────────────────────────────────────────────────────────────────────

describe("buildFeaturesOcto — enabled branch", () => {
  it("with all four adapters returns the canonical shape", () => {
    const built = buildFeaturesOcto({
      enabled: true,
      adapters: ["structured_subagent", "cli_exec", "pty_tmux", "structured_acp"],
    });
    expect(built).toEqual(canonicalExample());
  });

  it("returns adapters in the order given", () => {
    const built = buildFeaturesOcto({
      enabled: true,
      adapters: ["pty_tmux", "structured_acp", "cli_exec", "structured_subagent"],
    });
    expect(built.adapters).toEqual([
      "pty_tmux",
      "structured_acp",
      "cli_exec",
      "structured_subagent",
    ]);
  });

  it("deduplicates adapters preserving first occurrence", () => {
    const built = buildFeaturesOcto({
      enabled: true,
      adapters: ["cli_exec", "cli_exec", "pty_tmux", "cli_exec"],
    });
    expect(built.adapters).toEqual(["cli_exec", "pty_tmux"]);
  });

  it("merges custom capabilities over defaults keeping unmentioned ones true", () => {
    const built = buildFeaturesOcto({
      enabled: true,
      adapters: ["structured_subagent"],
      capabilities: { worktreeClaims: false },
    });
    expect(built.capabilities).toEqual({
      missionBudgets: true,
      worktreeClaims: false,
      forwardProgressWatchdog: true,
    });
  });

  it("version is always the FEATURES_OCTO_VERSION constant", () => {
    const built = buildFeaturesOcto({
      enabled: true,
      adapters: ["structured_subagent"],
    });
    expect(built.version).toBe(FEATURES_OCTO_VERSION);
    expect(built.version).toBe("1");
  });

  it("output validates against FeaturesOctoSchema (round-trip)", () => {
    const built = buildFeaturesOcto({
      enabled: true,
      adapters: ["structured_subagent", "cli_exec"],
      capabilities: { forwardProgressWatchdog: false },
    });
    expect(Value.Check(FeaturesOctoSchema, built)).toBe(true);
  });
});

// ──────────────────────────────────────────────────────────────────────────
// buildFeaturesOcto — disabled branch
// ──────────────────────────────────────────────────────────────────────────

describe("buildFeaturesOcto — disabled branch", () => {
  it("returns the canonical disabled descriptor", () => {
    const built = buildFeaturesOcto({ enabled: false, adapters: [] });
    expect(built).toEqual({
      version: "1",
      enabled: false,
      adapters: [],
      capabilities: {
        missionBudgets: true,
        worktreeClaims: true,
        forwardProgressWatchdog: true,
      },
    });
  });

  it("ignores any adapters passed in (empty list in output)", () => {
    const built = buildFeaturesOcto({
      enabled: false,
      adapters: ["structured_subagent", "cli_exec", "pty_tmux", "structured_acp"],
    });
    expect(built.adapters).toEqual([]);
  });

  it("still includes the default capabilities block", () => {
    const built = buildFeaturesOcto({ enabled: false, adapters: [] });
    expect(built.capabilities).toEqual(DEFAULT_FEATURES_OCTO_CAPABILITIES);
  });

  it("validates against FeaturesOctoSchema", () => {
    const built = buildFeaturesOcto({ enabled: false, adapters: [] });
    expect(Value.Check(FeaturesOctoSchema, built)).toBe(true);
  });
});

// ──────────────────────────────────────────────────────────────────────────
// buildFeaturesOcto — rejection
// ──────────────────────────────────────────────────────────────────────────

describe("buildFeaturesOcto — rejection", () => {
  it("throws on an unknown adapter string (runtime cast)", () => {
    expect(() =>
      buildFeaturesOcto({
        enabled: true,
        adapters: ["bogus" as unknown as AdapterType],
      }),
    ).toThrow(/bogus/);
  });

  it("throws on a mix of valid and invalid adapters", () => {
    expect(() =>
      buildFeaturesOcto({
        enabled: true,
        adapters: ["structured_subagent", "cursor" as unknown as AdapterType],
      }),
    ).toThrow(/cursor/);
  });
});

// ──────────────────────────────────────────────────────────────────────────
// Adapter filtering — representative scenarios
//
// These simulate the config layer filtering the adapter list based on
// per-node availability before calling the builder.
// ──────────────────────────────────────────────────────────────────────────

describe("buildFeaturesOcto — adapter filtering scenarios", () => {
  it("structured_subagent only (native-only node)", () => {
    const built = buildFeaturesOcto({
      enabled: true,
      adapters: ["structured_subagent"],
    });
    expect(built.adapters).toEqual(["structured_subagent"]);
  });

  it("structured_subagent + pty_tmux (no cli_exec, no acp)", () => {
    const built = buildFeaturesOcto({
      enabled: true,
      adapters: ["structured_subagent", "pty_tmux"],
    });
    expect(built.adapters).toEqual(["structured_subagent", "pty_tmux"]);
  });

  it("cli_exec + pty_tmux (external-tools-only node)", () => {
    const built = buildFeaturesOcto({
      enabled: true,
      adapters: ["cli_exec", "pty_tmux"],
    });
    expect(built.adapters).toEqual(["cli_exec", "pty_tmux"]);
  });

  it("all four adapters in given order", () => {
    const built = buildFeaturesOcto({
      enabled: true,
      adapters: ["structured_subagent", "cli_exec", "pty_tmux", "structured_acp"],
    });
    expect(built.adapters).toEqual([
      "structured_subagent",
      "cli_exec",
      "pty_tmux",
      "structured_acp",
    ]);
  });
});

// ──────────────────────────────────────────────────────────────────────────
// Exported constants
// ──────────────────────────────────────────────────────────────────────────

describe("FEATURES_OCTO_VERSION + DEFAULT_FEATURES_OCTO_CAPABILITIES", () => {
  it("FEATURES_OCTO_VERSION is the string '1'", () => {
    expect(FEATURES_OCTO_VERSION).toBe("1");
  });

  it("DEFAULT_FEATURES_OCTO_CAPABILITIES validates against the capabilities schema", () => {
    expect(Value.Check(FeaturesOctoCapabilitiesSchema, DEFAULT_FEATURES_OCTO_CAPABILITIES)).toBe(
      true,
    );
  });

  it("DEFAULT_FEATURES_OCTO_CAPABILITIES has all three flags set to true (M0 baseline)", () => {
    expect(DEFAULT_FEATURES_OCTO_CAPABILITIES).toEqual({
      missionBudgets: true,
      worktreeClaims: true,
      forwardProgressWatchdog: true,
    });
  });
});
