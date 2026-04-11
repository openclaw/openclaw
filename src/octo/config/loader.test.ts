// Tests for the Octopus `octo:` config block loader (M0-11)
//
// The loader takes a parsed OpenClaw config object, extracts the
// `octo:` subtree (if any), deep-merges it over DEFAULT_OCTO_CONFIG,
// and validates the result against OctoConfigSchema. These tests
// exercise every branch of that behavior:
//
//   - missing / null / undefined block → default config
//   - minimal `{ enabled: true }` → defaults with enabled flipped
//   - deep-merge rules for primitives, nested weights, arrays,
//     classifier hints, and per-node habitats
//   - full-block override round-trip
//   - validation failures (type, range, enum, unknown key)
//   - shape rejections (non-object octo, null root)
//   - logger injection (single info line per successful load, silent
//     on failure)

import { Value } from "@sinclair/typebox/value";
import { describe, expect, it, vi } from "vitest";
import { loadOctoConfig } from "./loader.ts";
import { DEFAULT_OCTO_CONFIG, OctoConfigSchema, type OctoConfig } from "./schema.ts";

// ──────────────────────────────────────────────────────────────────────────
// Missing block
// ──────────────────────────────────────────────────────────────────────────

describe("loadOctoConfig — missing octo: block", () => {
  it("returns the default config when the root is {}", () => {
    const logger = vi.fn();
    const result = loadOctoConfig({}, { logger });
    expect(result).toEqual(DEFAULT_OCTO_CONFIG);
    expect(logger).toHaveBeenCalledTimes(1);
    expect(logger).toHaveBeenCalledWith("octopus orchestrator: enabled=false");
  });

  it("ignores unrelated top-level keys owned by other subsystems", () => {
    const logger = vi.fn();
    const result = loadOctoConfig({ tools: { exec: { mode: "strict" } }, models: {} }, { logger });
    expect(result).toEqual(DEFAULT_OCTO_CONFIG);
    expect(logger).toHaveBeenCalledWith("octopus orchestrator: enabled=false");
  });

  it("treats octo: undefined as missing", () => {
    const result = loadOctoConfig({ octo: undefined }, { logger: vi.fn() });
    expect(result).toEqual(DEFAULT_OCTO_CONFIG);
  });

  it("treats octo: null as missing", () => {
    const result = loadOctoConfig({ octo: null }, { logger: vi.fn() });
    expect(result).toEqual(DEFAULT_OCTO_CONFIG);
  });

  it("returns a clone, not the frozen module-level default object", () => {
    const result = loadOctoConfig({}, { logger: vi.fn() });
    expect(result).not.toBe(DEFAULT_OCTO_CONFIG);
  });
});

// ──────────────────────────────────────────────────────────────────────────
// Minimal { enabled: true }
// ──────────────────────────────────────────────────────────────────────────

describe("loadOctoConfig — minimal enabled block", () => {
  it("flips enabled and preserves every other default", () => {
    const logger = vi.fn();
    const result = loadOctoConfig({ octo: { enabled: true } }, { logger });
    expect(result.enabled).toBe(true);
    expect(result.storage.registryPath).toBe(DEFAULT_OCTO_CONFIG.storage.registryPath);
    expect(result.lease.ttlS).toBe(DEFAULT_OCTO_CONFIG.lease.ttlS);
    expect(result.scheduler.weights.stickiness).toBe(
      DEFAULT_OCTO_CONFIG.scheduler.weights.stickiness,
    );
    expect(result.classifier.defaultMode).toBe(DEFAULT_OCTO_CONFIG.classifier.defaultMode);
    expect(logger).toHaveBeenCalledWith("octopus orchestrator: enabled=false");
  });
});

// ──────────────────────────────────────────────────────────────────────────
// Partial overrides — deep-merge semantics
// ──────────────────────────────────────────────────────────────────────────

describe("loadOctoConfig — partial overrides and deep-merge", () => {
  it("overrides a single lease primitive, preserving siblings", () => {
    const result = loadOctoConfig({ octo: { lease: { ttlS: 60 } } }, { logger: vi.fn() });
    expect(result.lease.ttlS).toBe(60);
    expect(result.lease.renewIntervalS).toBe(DEFAULT_OCTO_CONFIG.lease.renewIntervalS);
    expect(result.lease.graceS).toBe(DEFAULT_OCTO_CONFIG.lease.graceS);
    expect(result.lease.sideEffectingGraceS).toBe(DEFAULT_OCTO_CONFIG.lease.sideEffectingGraceS);
  });

  it("merges scheduler.weights two levels deep without dropping siblings", () => {
    const result = loadOctoConfig(
      { octo: { scheduler: { weights: { stickiness: 5 } } } },
      { logger: vi.fn() },
    );
    expect(result.scheduler.weights.stickiness).toBe(5);
    expect(result.scheduler.weights.locality).toBe(DEFAULT_OCTO_CONFIG.scheduler.weights.locality);
    expect(result.scheduler.weights.preferredMatch).toBe(
      DEFAULT_OCTO_CONFIG.scheduler.weights.preferredMatch,
    );
    expect(result.scheduler.weights.loadBalance).toBe(
      DEFAULT_OCTO_CONFIG.scheduler.weights.loadBalance,
    );
    expect(result.scheduler.defaultSpread).toBe(DEFAULT_OCTO_CONFIG.scheduler.defaultSpread);
  });

  it("overrides events.retentionDays while preserving other event fields", () => {
    const result = loadOctoConfig({ octo: { events: { retentionDays: 30 } } }, { logger: vi.fn() });
    expect(result.events.retentionDays).toBe(30);
    expect(result.events.ingestRateLimit).toBe(DEFAULT_OCTO_CONFIG.events.ingestRateLimit);
    expect(result.events.schemaVersion).toBe(DEFAULT_OCTO_CONFIG.events.schemaVersion);
  });

  it("REPLACES retryPolicyDefault.retryOn (arrays do not concatenate)", () => {
    const result = loadOctoConfig(
      { octo: { retryPolicyDefault: { retryOn: ["transient"] } } },
      { logger: vi.fn() },
    );
    expect(result.retryPolicyDefault.retryOn).toEqual(["transient"]);
    expect(result.retryPolicyDefault.abandonOn).toEqual(
      DEFAULT_OCTO_CONFIG.retryPolicyDefault.abandonOn,
    );
    expect(result.retryPolicyDefault.maxAttempts).toBe(
      DEFAULT_OCTO_CONFIG.retryPolicyDefault.maxAttempts,
    );
  });

  it("overrides classifier.defaultMode and preserves the default task lists", () => {
    const result = loadOctoConfig(
      { octo: { classifier: { defaultMode: "research_then_plan" } } },
      { logger: vi.fn() },
    );
    expect(result.classifier.defaultMode).toBe("research_then_plan");
    expect(result.classifier.researchFirstTaskClasses).toEqual(
      DEFAULT_OCTO_CONFIG.classifier.researchFirstTaskClasses,
    );
    expect(result.classifier.directExecuteTaskClasses).toEqual(
      DEFAULT_OCTO_CONFIG.classifier.directExecuteTaskClasses,
    );
  });

  it("REPLACES classifier.researchFirstTaskClasses when provided", () => {
    const result = loadOctoConfig(
      {
        octo: {
          classifier: { researchFirstTaskClasses: ["architecture"] },
        },
      },
      { logger: vi.fn() },
    );
    expect(result.classifier.researchFirstTaskClasses).toEqual(["architecture"]);
  });

  it("REPLACES classifier.hints as a whole-map leaf", () => {
    const result = loadOctoConfig(
      {
        octo: {
          classifier: { hints: { custom_key: "custom_value" } },
        },
      },
      { logger: vi.fn() },
    );
    expect(result.classifier.hints).toEqual({
      custom_key: "custom_value",
    });
  });

  it("adds a habitat entry without overwriting other habitats in the map", () => {
    const result = loadOctoConfig(
      { octo: { habitats: { "laptop-01": { maxArms: 4 } } } },
      { logger: vi.fn() },
    );
    expect(result.habitats["laptop-01"]).toEqual({ maxArms: 4 });
    // Defaults has no habitats, so only the new one should be present.
    expect(Object.keys(result.habitats)).toEqual(["laptop-01"]);
  });

  it("takes each habitat value verbatim (no nested merge within habitat)", () => {
    const result = loadOctoConfig(
      {
        octo: {
          habitats: {
            "laptop-01": {
              maxArms: 4,
              labels: { zone: "home" },
            },
          },
        },
      },
      { logger: vi.fn() },
    );
    expect(result.habitats["laptop-01"]).toEqual({
      maxArms: 4,
      labels: { zone: "home" },
    });
  });
});

// ──────────────────────────────────────────────────────────────────────────
// Full-block override
// ──────────────────────────────────────────────────────────────────────────

describe("loadOctoConfig — full-block override", () => {
  it("round-trips a fully populated octo: block", () => {
    const full: OctoConfig = {
      enabled: true,
      storage: {
        registryPath: "custom/registry.sqlite",
        eventsPath: "custom/events.jsonl",
        eventsArchivePath: "custom/events-archive/",
        artifactsPath: "custom/artifacts/",
        nodeStateRoot: "custom/",
      },
      events: {
        retentionDays: 14,
        ingestRateLimit: 500,
        schemaVersion: 2,
      },
      lease: {
        renewIntervalS: 5,
        ttlS: 20,
        graceS: 10,
        sideEffectingGraceS: 30,
      },
      progress: {
        stallThresholdS: 120,
        autoTerminateAfterS: 3600,
      },
      scheduler: {
        weights: {
          stickiness: 4.0,
          locality: 3.0,
          preferredMatch: 2.5,
          loadBalance: 1.5,
          recentFailurePenalty: 2.5,
          crossAgentIdPenalty: 1.5,
        },
        defaultSpread: true,
      },
      quarantine: {
        maxRestarts: 5,
        nodeFailureWindow: 20,
        nodeFailureWindowS: 1200,
      },
      arm: {
        outputBufferBytes: 1048576,
        stdoutRolloverBytes: 33554432,
        stdoutRolloverKeep: 2,
        idleTimeoutS: 600,
        checkpointIntervalS: 30,
      },
      retryPolicyDefault: {
        maxAttempts: 5,
        backoff: "linear",
        initialDelayS: 2,
        maxDelayS: 120,
        multiplier: 1.5,
        retryOn: ["transient"],
        abandonOn: ["policy_denied"],
      },
      cost: {
        trackTokens: false,
        missionBudgetDefault: null,
        ptyHourlyRateProxyUsd: 0.5,
        modelRateTable: "custom-table",
      },
      auth: {
        loopbackAutoWriter: false,
        requireWriterForSideEffects: false,
      },
      policy: {
        enforcementActive: true,
        defaultProfileRef: "strict-profile",
      },
      classifier: {
        defaultMode: "research_then_plan",
        researchFirstTaskClasses: ["architecture"],
        directExecuteTaskClasses: ["small_local_edit"],
        hints: { key: "value" },
      },
      habitats: {
        "node-a": { maxArms: 8 },
      },
    };

    const result = loadOctoConfig({ octo: full }, { logger: vi.fn() });
    expect(result).toEqual(full);
    expect(Value.Check(OctoConfigSchema, result)).toBe(true);
  });
});

// ──────────────────────────────────────────────────────────────────────────
// Validation failures
// ──────────────────────────────────────────────────────────────────────────

describe("loadOctoConfig — validation failures", () => {
  it("throws when enabled is not a boolean", () => {
    expect(() =>
      loadOctoConfig({ octo: { enabled: "not a boolean" } }, { logger: vi.fn() }),
    ).toThrow(/enabled/);
  });

  it("throws when lease.ttlS is below the minimum", () => {
    expect(() => loadOctoConfig({ octo: { lease: { ttlS: -5 } } }, { logger: vi.fn() })).toThrow(
      /ttlS/,
    );
  });

  it("throws when classifier.defaultMode is an invalid enum value", () => {
    expect(() =>
      loadOctoConfig({ octo: { classifier: { defaultMode: "bogus_mode" } } }, { logger: vi.fn() }),
    ).toThrow(/defaultMode/);
  });

  it("throws on unknown top-level key (strict mode)", () => {
    expect(() =>
      loadOctoConfig({ octo: { unknown_top_level: true } }, { logger: vi.fn() }),
    ).toThrow(/Octopus config: validation failed/);
  });

  it("does not emit the info line when validation fails", () => {
    const logger = vi.fn();
    expect(() => loadOctoConfig({ octo: { enabled: "nope" } }, { logger })).toThrow();
    expect(logger).not.toHaveBeenCalled();
  });
});

// ──────────────────────────────────────────────────────────────────────────
// Shape rejections
// ──────────────────────────────────────────────────────────────────────────

describe("loadOctoConfig — shape rejections", () => {
  it("throws when octo: is a string", () => {
    expect(() => loadOctoConfig({ octo: "not an object" }, { logger: vi.fn() })).toThrow(
      /expected `octo` block to be an object/,
    );
  });

  it("throws when octo: is a number", () => {
    expect(() => loadOctoConfig({ octo: 42 }, { logger: vi.fn() })).toThrow(
      /expected `octo` block to be an object/,
    );
  });

  it("throws when octo: is an array", () => {
    expect(() => loadOctoConfig({ octo: [] }, { logger: vi.fn() })).toThrow(
      /expected `octo` block to be an object/,
    );
  });

  it("throws when rawOpenclawConfig itself is null", () => {
    expect(() =>
      loadOctoConfig(null as unknown as Record<string, unknown>, { logger: vi.fn() }),
    ).toThrow(/rawOpenclawConfig must be an object/);
  });
});

// ──────────────────────────────────────────────────────────────────────────
// Logger injection
// ──────────────────────────────────────────────────────────────────────────

describe("loadOctoConfig — logger injection", () => {
  it("calls the logger exactly once on a successful default load", () => {
    const logger = vi.fn();
    loadOctoConfig({}, { logger });
    expect(logger).toHaveBeenCalledTimes(1);
    expect(logger).toHaveBeenCalledWith("octopus orchestrator: enabled=false");
  });

  it("calls the logger exactly once on a successful enabled load", () => {
    const logger = vi.fn();
    loadOctoConfig({ octo: { enabled: true } }, { logger });
    expect(logger).toHaveBeenCalledTimes(1);
    expect(logger).toHaveBeenCalledWith("octopus orchestrator: enabled=false");
  });

  it("falls back to console.info when no logger is provided", () => {
    const spy = vi.spyOn(console, "info").mockImplementation(() => {});
    try {
      loadOctoConfig({});
      expect(spy).toHaveBeenCalledWith("octopus orchestrator: enabled=false");
    } finally {
      spy.mockRestore();
    }
  });
});
