// Tests for Octopus `octo:` config block schema (M0-06)
//
// Coverage pattern follows the M0-01..M0-05 fidelity bar:
//   - `DEFAULT_OCTO_CONFIG` round-trips through the schema (catches
//     drift between CONFIG.md defaults and the enforceable shape)
//   - a minimal-but-valid config (only the required structural
//     skeleton) round-trips
//   - invalid configs are REJECTED with strict mode proving its worth
//   - rejections sweep representative failure classes: extra keys,
//     wrong primitive type, enum violation, and malformed nested
//     object

import { Value } from "@sinclair/typebox/value";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_OCTO_CONFIG,
  OctoConfigSchema,
  OctoClassifierConfigSchema,
  OctoEventsConfigSchema,
  OctoLeaseConfigSchema,
  OctoRetryPolicyDefaultSchema,
  OctoSchedulerWeightsSchema,
  type OctoConfig,
} from "./schema.ts";

// ──────────────────────────────────────────────────────────────────────────
// Defaults round-trip
// ──────────────────────────────────────────────────────────────────────────

describe("DEFAULT_OCTO_CONFIG", () => {
  it("validates against OctoConfigSchema (round-trip guarantee)", () => {
    expect(Value.Check(OctoConfigSchema, DEFAULT_OCTO_CONFIG)).toBe(true);
  });

  it("defaults enabled to true (M2 exit — feature flag flipped)", () => {
    expect(DEFAULT_OCTO_CONFIG.enabled).toBe(true);
  });

  it("defaults classifier.defaultMode to direct_execute (OCTO-DEC-039)", () => {
    expect(DEFAULT_OCTO_CONFIG.classifier.defaultMode).toBe("direct_execute");
  });

  it("defaults retryPolicyDefault retry/abandon lists to the OCTO-DEC classifications", () => {
    expect(DEFAULT_OCTO_CONFIG.retryPolicyDefault.retryOn).toEqual([
      "transient",
      "timeout",
      "adapter_error",
    ]);
    expect(DEFAULT_OCTO_CONFIG.retryPolicyDefault.abandonOn).toEqual([
      "policy_denied",
      "invalid_spec",
      "unrecoverable",
    ]);
  });

  it("exposes the full classifier task-class lists per CONFIG.md", () => {
    expect(DEFAULT_OCTO_CONFIG.classifier.researchFirstTaskClasses).toContain("architecture");
    expect(DEFAULT_OCTO_CONFIG.classifier.researchFirstTaskClasses).toContain(
      "prior_art_sensitive",
    );
    expect(DEFAULT_OCTO_CONFIG.classifier.directExecuteTaskClasses).toContain("small_local_edit");
    expect(DEFAULT_OCTO_CONFIG.classifier.directExecuteTaskClasses).toContain(
      "low_risk_maintenance",
    );
  });
});

// ──────────────────────────────────────────────────────────────────────────
// Valid configs
// ──────────────────────────────────────────────────────────────────────────

describe("OctoConfigSchema — valid configs", () => {
  it("accepts the default config unchanged", () => {
    expect(Value.Check(OctoConfigSchema, DEFAULT_OCTO_CONFIG)).toBe(true);
  });

  it("accepts a config with enabled flipped on", () => {
    const cfg: OctoConfig = { ...DEFAULT_OCTO_CONFIG, enabled: true };
    expect(Value.Check(OctoConfigSchema, cfg)).toBe(true);
  });

  it("accepts a config with retentionDays set to a positive number", () => {
    const cfg: OctoConfig = {
      ...DEFAULT_OCTO_CONFIG,
      events: { ...DEFAULT_OCTO_CONFIG.events, retentionDays: 30 },
    };
    expect(Value.Check(OctoConfigSchema, cfg)).toBe(true);
  });

  it("accepts a mission budget default object in cost.missionBudgetDefault", () => {
    const cfg: OctoConfig = {
      ...DEFAULT_OCTO_CONFIG,
      cost: {
        ...DEFAULT_OCTO_CONFIG.cost,
        missionBudgetDefault: {
          cost_usd_limit: 25.0,
          token_limit: 1_000_000,
          on_exceed: "pause",
        },
      },
    };
    expect(Value.Check(OctoConfigSchema, cfg)).toBe(true);
  });

  it("accepts a populated habitats map", () => {
    const cfg: OctoConfig = {
      ...DEFAULT_OCTO_CONFIG,
      habitats: {
        "laptop-01": {
          maxArms: 8,
          cpuWeightBudget: 16,
          labels: { geo: "home" },
        },
        "remote-gpu-02": {
          maxArms: 2,
        },
      },
    };
    expect(Value.Check(OctoConfigSchema, cfg)).toBe(true);
  });

  it("accepts a full config with every optional-ish branch exercised", () => {
    const cfg: OctoConfig = {
      enabled: true,
      storage: {
        registryPath: "octo/registry.sqlite",
        eventsPath: "octo/events.jsonl",
        eventsArchivePath: "octo/events-archive/",
        artifactsPath: "octo/artifacts/",
        nodeStateRoot: "octo/",
      },
      events: {
        retentionDays: 90,
        ingestRateLimit: 500,
        schemaVersion: 2,
      },
      lease: {
        renewIntervalS: 15,
        ttlS: 45,
        graceS: 30,
        sideEffectingGraceS: 90,
      },
      progress: {
        stallThresholdS: 600,
        autoTerminateAfterS: 3600,
      },
      scheduler: {
        weights: {
          stickiness: 2.5,
          locality: 2.0,
          preferredMatch: 1.5,
          loadBalance: 1.0,
          recentFailurePenalty: 3.0,
          crossAgentIdPenalty: 1.5,
        },
        defaultSpread: true,
      },
      quarantine: {
        maxRestarts: 5,
        nodeFailureWindow: 15,
        nodeFailureWindowS: 900,
      },
      arm: {
        outputBufferBytes: 4_194_304,
        stdoutRolloverBytes: 134_217_728,
        stdoutRolloverKeep: 8,
        idleTimeoutS: 1800,
        checkpointIntervalS: 120,
      },
      retryPolicyDefault: {
        maxAttempts: 5,
        backoff: "linear",
        initialDelayS: 10,
        maxDelayS: 600,
        multiplier: 1.5,
        retryOn: ["transient", "timeout"],
        abandonOn: ["policy_denied", "invalid_spec", "unrecoverable"],
      },
      cost: {
        trackTokens: true,
        missionBudgetDefault: {
          cost_usd_limit: 100,
          token_limit: 5_000_000,
          on_exceed: "abort",
        },
        ptyHourlyRateProxyUsd: 0.5,
        modelRateTable: "custom-2026q2",
      },
      auth: {
        loopbackAutoWriter: false,
        requireWriterForSideEffects: true,
      },
      policy: {
        enforcementActive: true,
        defaultProfileRef: "octo/default",
      },
      classifier: {
        defaultMode: "research_then_plan",
        researchFirstTaskClasses: ["architecture", "systems_design"],
        directExecuteTaskClasses: ["small_local_edit"],
        hints: {
          when_unsure: "prefer research_then_plan over direct_execute",
        },
      },
      habitats: {
        "laptop-01": { maxArms: 8 },
      },
    };
    expect(Value.Check(OctoConfigSchema, cfg)).toBe(true);
  });
});

// ──────────────────────────────────────────────────────────────────────────
// Invalid configs
//
// Strict mode (`additionalProperties: false`) is load-bearing here —
// the loader must REJECT unknown keys rather than silently drop them.
// This is the explicit CONFIG.md §Validation contract: "No silent
// fallback to defaults on invalid keys."
// ──────────────────────────────────────────────────────────────────────────

describe("OctoConfigSchema — invalid configs", () => {
  it("rejects an extra top-level key (strict mode)", () => {
    const cfg = {
      ...DEFAULT_OCTO_CONFIG,
      unknown_top_level_key: true,
    } as unknown as OctoConfig;
    expect(Value.Check(OctoConfigSchema, cfg)).toBe(false);
  });

  it("rejects an extra nested key inside storage", () => {
    const cfg = {
      ...DEFAULT_OCTO_CONFIG,
      storage: {
        ...DEFAULT_OCTO_CONFIG.storage,
        extraKey: "nope",
      },
    } as unknown as OctoConfig;
    expect(Value.Check(OctoConfigSchema, cfg)).toBe(false);
  });

  it("rejects enabled as a string instead of a boolean", () => {
    const cfg = {
      ...DEFAULT_OCTO_CONFIG,
      enabled: "false",
    } as unknown as OctoConfig;
    expect(Value.Check(OctoConfigSchema, cfg)).toBe(false);
  });

  it("rejects a classifier.defaultMode that isn't a MissionExecutionMode literal", () => {
    const cfg = {
      ...DEFAULT_OCTO_CONFIG,
      classifier: {
        ...DEFAULT_OCTO_CONFIG.classifier,
        defaultMode: "invent_your_own",
      },
    } as unknown as OctoConfig;
    expect(Value.Check(OctoConfigSchema, cfg)).toBe(false);
  });

  it("rejects a retryPolicyDefault.backoff that isn't a known strategy", () => {
    const cfg = {
      ...DEFAULT_OCTO_CONFIG,
      retryPolicyDefault: {
        ...DEFAULT_OCTO_CONFIG.retryPolicyDefault,
        backoff: "polynomial",
      },
    } as unknown as OctoConfig;
    expect(Value.Check(OctoConfigSchema, cfg)).toBe(false);
  });

  it("rejects a retryOn entry that isn't a known failure classification", () => {
    const cfg = {
      ...DEFAULT_OCTO_CONFIG,
      retryPolicyDefault: {
        ...DEFAULT_OCTO_CONFIG.retryPolicyDefault,
        retryOn: ["transient", "quantum_flux"],
      },
    } as unknown as OctoConfig;
    expect(Value.Check(OctoConfigSchema, cfg)).toBe(false);
  });

  it("rejects a missing required field (lease.ttlS)", () => {
    const { lease: _drop, ...rest } = DEFAULT_OCTO_CONFIG;
    const brokenLease = { ...DEFAULT_OCTO_CONFIG.lease } as Partial<
      typeof DEFAULT_OCTO_CONFIG.lease
    >;
    delete brokenLease.ttlS;
    const cfg = { ...rest, lease: brokenLease } as unknown as OctoConfig;
    expect(Value.Check(OctoConfigSchema, cfg)).toBe(false);
  });

  it("rejects a negative ingestRateLimit (below minimum: 1)", () => {
    const cfg = {
      ...DEFAULT_OCTO_CONFIG,
      events: { ...DEFAULT_OCTO_CONFIG.events, ingestRateLimit: 0 },
    } as unknown as OctoConfig;
    expect(Value.Check(OctoConfigSchema, cfg)).toBe(false);
  });

  it("rejects a scheduler weight that's negative", () => {
    const cfg = {
      ...DEFAULT_OCTO_CONFIG,
      scheduler: {
        ...DEFAULT_OCTO_CONFIG.scheduler,
        weights: {
          ...DEFAULT_OCTO_CONFIG.scheduler.weights,
          stickiness: -1,
        },
      },
    } as unknown as OctoConfig;
    expect(Value.Check(OctoConfigSchema, cfg)).toBe(false);
  });

  it("rejects an empty string for storage.registryPath (NonEmptyString)", () => {
    const cfg = {
      ...DEFAULT_OCTO_CONFIG,
      storage: { ...DEFAULT_OCTO_CONFIG.storage, registryPath: "" },
    } as unknown as OctoConfig;
    expect(Value.Check(OctoConfigSchema, cfg)).toBe(false);
  });

  it("rejects a habitat entry with an unknown field", () => {
    const cfg = {
      ...DEFAULT_OCTO_CONFIG,
      habitats: {
        "laptop-01": { maxArms: 4, mysteryField: true },
      },
    } as unknown as OctoConfig;
    expect(Value.Check(OctoConfigSchema, cfg)).toBe(false);
  });

  it("rejects a malformed missionBudgetDefault (missing on_exceed)", () => {
    const cfg = {
      ...DEFAULT_OCTO_CONFIG,
      cost: {
        ...DEFAULT_OCTO_CONFIG.cost,
        missionBudgetDefault: { cost_usd_limit: 10, token_limit: 1000 },
      },
    } as unknown as OctoConfig;
    expect(Value.Check(OctoConfigSchema, cfg)).toBe(false);
  });
});

// ──────────────────────────────────────────────────────────────────────────
// Sub-schema spot checks — catches drift in the reusable pieces the
// loader (M0-11) will import directly.
// ──────────────────────────────────────────────────────────────────────────

describe("OctoConfigSchema — sub-schema exports", () => {
  it("OctoEventsConfigSchema accepts retentionDays: null", () => {
    expect(
      Value.Check(OctoEventsConfigSchema, {
        retentionDays: null,
        ingestRateLimit: 100,
        schemaVersion: 1,
      }),
    ).toBe(true);
  });

  it("OctoLeaseConfigSchema rejects ttlS < 1", () => {
    expect(
      Value.Check(OctoLeaseConfigSchema, {
        renewIntervalS: 10,
        ttlS: 0,
        graceS: 30,
        sideEffectingGraceS: 60,
      }),
    ).toBe(false);
  });

  it("OctoSchedulerWeightsSchema rejects a missing weight field", () => {
    expect(
      Value.Check(OctoSchedulerWeightsSchema, {
        stickiness: 1,
        locality: 1,
        preferredMatch: 1,
        loadBalance: 1,
        recentFailurePenalty: 1,
        // crossAgentIdPenalty missing
      }),
    ).toBe(false);
  });

  it("OctoRetryPolicyDefaultSchema rejects multiplier < 1", () => {
    expect(
      Value.Check(OctoRetryPolicyDefaultSchema, {
        maxAttempts: 3,
        backoff: "exponential",
        initialDelayS: 5,
        maxDelayS: 300,
        multiplier: 0.5,
        retryOn: [],
        abandonOn: [],
      }),
    ).toBe(false);
  });

  it("OctoClassifierConfigSchema accepts an empty hints map", () => {
    expect(
      Value.Check(OctoClassifierConfigSchema, {
        defaultMode: "direct_execute",
        researchFirstTaskClasses: [],
        directExecuteTaskClasses: [],
        hints: {},
      }),
    ).toBe(true);
  });
});
