// Octopus Orchestrator — wire schema tests (M0-01 + M0-02)
//
// Covers ArmSpec (M0-01) and GripSpec (M0-02):
//   - ArmSpecSchema validation: canonical valid spec per adapter type
//   - ArmSpecSchema rejection: unknown top-level fields (strict mode),
//     invalid adapter_type literal, missing required fields (every required
//     field exercised individually), invalid runtime_options shape
//   - validateArmSpec cross-check: adapter_type / runtime_options mismatch
//     is rejected at the validator layer even though the bare schema would
//     accept it (see TODO in schema.ts about the M1-14 discriminated-union
//     refactor)
//   - GripSpecSchema validation: canonical valid specs with and without
//     side_effecting, with required_claims, with full retry_policy
//   - GripSpecSchema rejection: unknown top-level field, invalid backoff
//     strategy, invalid failure classification in retry_on, invalid
//     resource_type or claim mode in required_claims, missing required
//     fields (parameterized)
//   - validateGripSpec cross-check: rejects side_effecting: true without
//     idempotency_key, accepts side_effecting: false without idempotency_key

import { Value } from "@sinclair/typebox/value";
import { describe, expect, it } from "vitest";
import {
  ArmSpecSchema,
  type ArmSpec,
  validateArmSpec,
  GripSpecSchema,
  type GripSpec,
  validateGripSpec,
  MissionSpecSchema,
  type MissionSpec,
  validateMissionSpec,
  MissionExecutionModeSchema,
  type MissionExecutionMode,
} from "./schema.ts";

// ──────────────────────────────────────────────────────────────────────────
// Fixture builders — one valid ArmSpec per adapter type
// ──────────────────────────────────────────────────────────────────────────

const baseRequiredFields = {
  spec_version: 1,
  mission_id: "m-test",
  agent_id: "home",
  cwd: "/repos/test",
  idempotency_key: "idem-test-0001",
} as const;

function validSubagentArm(): ArmSpec {
  return {
    ...baseRequiredFields,
    adapter_type: "structured_subagent",
    runtime_name: "openclaw-subagent",
    runtime_options: {
      model: "claude-opus-4-6",
      thinking: "medium",
      runTimeoutSeconds: 600,
      cleanup: "keep",
    },
  };
}

function validCliExecArm(): ArmSpec {
  return {
    ...baseRequiredFields,
    adapter_type: "cli_exec",
    runtime_name: "claude-code",
    initial_input: "fix the bug in auth.ts",
    runtime_options: {
      command: "claude",
      args: ["-p", "--output-format", "stream-json"],
      structuredOutputFormat: "stream-json",
      stdinMode: "closed",
      runTimeoutSeconds: 900,
      maxStdoutBytes: 16 * 1024 * 1024,
    },
  };
}

function validPtyTmuxArm(): ArmSpec {
  return {
    ...baseRequiredFields,
    adapter_type: "pty_tmux",
    runtime_name: "tmux:bash",
    runtime_options: {
      command: "bash",
      args: ["-c", "npm test"],
      tmuxSessionName: "octo-test",
      captureCols: 120,
      captureRows: 40,
      idleTimeoutS: 300,
    },
  };
}

function validStructuredAcpArm(): ArmSpec {
  return {
    ...baseRequiredFields,
    adapter_type: "structured_acp",
    runtime_name: "acpx:claude",
    runtime_options: {
      acpxHarness: "claude",
      model: "claude-opus-4-6",
      mode: "run",
    },
  };
}

// ──────────────────────────────────────────────────────────────────────────
// Tests
// ──────────────────────────────────────────────────────────────────────────

// List of every required field on ArmSpec. Used to parameterize the
// "rejects missing required field" test so we catch regressions if any of
// these get accidentally wrapped in Type.Optional in the future.
const REQUIRED_FIELDS = [
  "spec_version",
  "mission_id",
  "adapter_type",
  "runtime_name",
  "agent_id",
  "cwd",
  "idempotency_key",
  "runtime_options",
] as const;

describe("ArmSpecSchema (bare TypeBox validation)", () => {
  describe("accepts valid specs", () => {
    it("validates a canonical structured_subagent spec", () => {
      expect(Value.Check(ArmSpecSchema, validSubagentArm())).toBe(true);
    });

    it("validates a canonical cli_exec spec (the primary path for external coding tools)", () => {
      expect(Value.Check(ArmSpecSchema, validCliExecArm())).toBe(true);
    });

    it("validates a canonical pty_tmux spec", () => {
      expect(Value.Check(ArmSpecSchema, validPtyTmuxArm())).toBe(true);
    });

    it("validates a canonical structured_acp spec (opt-in adapter)", () => {
      expect(Value.Check(ArmSpecSchema, validStructuredAcpArm())).toBe(true);
    });
  });

  describe("rejects invalid specs (strict mode)", () => {
    it("rejects an ArmSpec with an unknown top-level field", () => {
      // S1 regression test: without strict mode (additionalProperties: false)
      // on ArmSpecSchema, typos and unknown fields would silently pass.
      const spec = validCliExecArm();
      const bad = { ...spec, __typo_field__: true } as unknown;
      expect(Value.Check(ArmSpecSchema, bad)).toBe(false);
    });

    it("rejects an ArmSpec with an invalid adapter_type literal", () => {
      const spec = validCliExecArm();
      const bad = {
        ...spec,
        adapter_type: "not_a_real_adapter" as unknown as ArmSpec["adapter_type"],
      };
      expect(Value.Check(ArmSpecSchema, bad)).toBe(false);
    });

    it("rejects an ArmSpec where runtime_options does not match any adapter shape", () => {
      const spec = validCliExecArm();
      const bad = {
        ...spec,
        runtime_options: {
          this_field_does_not_exist_in_any_adapter: true,
        } as unknown as ArmSpec["runtime_options"],
      };
      expect(Value.Check(ArmSpecSchema, bad)).toBe(false);
    });

    // Parameterized required-field coverage: one test per required field.
    // Catches the regression "someone wrapped a required field in
    // Type.Optional without thinking" across all 8 required fields.
    describe("rejects an ArmSpec missing a required field", () => {
      for (const fieldName of REQUIRED_FIELDS) {
        it(`rejects when ${fieldName} is missing`, () => {
          const spec = validCliExecArm() as Record<string, unknown>;
          const copy = { ...spec };
          delete copy[fieldName];
          expect(Value.Check(ArmSpecSchema, copy)).toBe(false);
        });
      }
    });
  });
});

describe("validateArmSpec (TypeBox check + adapter_type cross-check)", () => {
  describe("accepts matched adapter_type + runtime_options combinations", () => {
    it("accepts a valid structured_subagent spec", () => {
      const result = validateArmSpec(validSubagentArm());
      expect(result.ok).toBe(true);
    });

    it("accepts a valid cli_exec spec", () => {
      const result = validateArmSpec(validCliExecArm());
      expect(result.ok).toBe(true);
    });

    it("accepts a valid pty_tmux spec", () => {
      const result = validateArmSpec(validPtyTmuxArm());
      expect(result.ok).toBe(true);
    });

    it("accepts a valid structured_acp spec", () => {
      const result = validateArmSpec(validStructuredAcpArm());
      expect(result.ok).toBe(true);
    });
  });

  describe("rejects mismatched adapter_type + runtime_options combinations", () => {
    // S3 regression tests: the bare schema accepts these because
    // RuntimeOptionsSchema is a plain Type.Union that does not enforce
    // adapter_type discrimination. validateArmSpec's cross-check catches
    // them.

    it("rejects adapter_type=cli_exec with subagent-shaped runtime_options", () => {
      const subagentOptions = validSubagentArm().runtime_options;
      // Build an ArmSpec that claims cli_exec but carries subagent options
      const bad = {
        ...baseRequiredFields,
        adapter_type: "cli_exec" as const,
        runtime_name: "claude-code",
        runtime_options: subagentOptions,
      };
      const result = validateArmSpec(bad);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.errors.join(" ")).toMatch(/runtime_options/);
      }
    });

    it("rejects adapter_type=pty_tmux with structured_acp-shaped runtime_options", () => {
      const acpOptions = validStructuredAcpArm().runtime_options;
      const bad = {
        ...baseRequiredFields,
        adapter_type: "pty_tmux" as const,
        runtime_name: "tmux:bash",
        runtime_options: acpOptions,
      };
      const result = validateArmSpec(bad);
      expect(result.ok).toBe(false);
    });

    it("rejects adapter_type=structured_subagent with cli_exec-shaped runtime_options", () => {
      const cliOptions = validCliExecArm().runtime_options;
      const bad = {
        ...baseRequiredFields,
        adapter_type: "structured_subagent" as const,
        runtime_name: "openclaw-subagent",
        runtime_options: cliOptions,
      };
      const result = validateArmSpec(bad);
      expect(result.ok).toBe(false);
    });
  });

  describe("reports structured errors on failure", () => {
    it("returns ok:false with an errors array when the schema check fails", () => {
      const result = validateArmSpec({ spec_version: 1 } as unknown);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.errors.length).toBeGreaterThan(0);
      }
    });

    it("returns ok:true with the typed spec when validation passes", () => {
      const result = validateArmSpec(validCliExecArm());
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.spec.adapter_type).toBe("cli_exec");
        expect(result.spec.mission_id).toBe("m-test");
      }
    });
  });
});

// ══════════════════════════════════════════════════════════════════════════
// GripSpec tests (M0-02)
// ══════════════════════════════════════════════════════════════════════════

// ──────────────────────────────────────────────────────────────────────────
// GripSpec fixture builders
// ──────────────────────────────────────────────────────────────────────────

const defaultRetryPolicy = {
  max_attempts: 3,
  backoff: "exponential" as const,
  initial_delay_s: 5,
  max_delay_s: 300,
  multiplier: 2,
  retry_on: ["transient" as const, "timeout" as const, "adapter_error" as const],
  abandon_on: ["policy_denied" as const, "invalid_spec" as const, "unrecoverable" as const],
};

function validReadOnlyGrip(): GripSpec {
  return {
    spec_version: 1,
    mission_id: "m-test",
    type: "code-review",
    retry_policy: defaultRetryPolicy,
    timeout_s: 900,
    side_effecting: false,
    // Intentionally no idempotency_key — allowed for side_effecting: false
  };
}

function validSideEffectingGrip(): GripSpec {
  return {
    spec_version: 1,
    mission_id: "m-test",
    type: "refactor",
    input_ref: "artifact://audit-report-001",
    desired_capabilities: ["runtime.subagent", "tool.git"],
    priority: 10,
    retry_policy: defaultRetryPolicy,
    timeout_s: 3600,
    side_effecting: true,
    idempotency_key: "grip-idem-0001",
    required_claims: [
      { resource_type: "dir", resource_key: "/repo/src/auth", mode: "exclusive" },
      { resource_type: "branch", resource_key: "fix/auth-tokens", mode: "exclusive" },
    ],
    labels: { mission: "auth-refactor", owner: "home" },
  };
}

// List of every unconditionally-required GripSpec field. Parameterized
// rejection tests ensure all of them trip validation when absent.
// Note: idempotency_key is NOT in this list — it is conditionally required
// (only when side_effecting: true) and is tested separately via
// validateGripSpec.
const GRIP_REQUIRED_FIELDS = [
  "spec_version",
  "mission_id",
  "type",
  "retry_policy",
  "timeout_s",
  "side_effecting",
] as const;

describe("GripSpecSchema (bare TypeBox validation)", () => {
  describe("accepts valid grips", () => {
    it("validates a canonical read-only (non-side-effecting) grip", () => {
      expect(Value.Check(GripSpecSchema, validReadOnlyGrip())).toBe(true);
    });

    it("validates a canonical side_effecting grip with idempotency_key", () => {
      expect(Value.Check(GripSpecSchema, validSideEffectingGrip())).toBe(true);
    });

    it("validates a grip with required_claims covering all resource types", () => {
      const grip = validSideEffectingGrip();
      grip.required_claims = [
        { resource_type: "file", resource_key: "/repo/a.ts", mode: "exclusive" },
        { resource_type: "dir", resource_key: "/repo/src", mode: "shared-read" },
        { resource_type: "branch", resource_key: "main", mode: "exclusive" },
        { resource_type: "port", resource_key: "8080", mode: "exclusive" },
        { resource_type: "task-key", resource_key: "nightly-sweep", mode: "exclusive" },
      ];
      expect(Value.Check(GripSpecSchema, grip)).toBe(true);
    });

    it("validates a grip whose retry_policy uses all failure classifications", () => {
      const grip = validReadOnlyGrip();
      grip.retry_policy = {
        ...defaultRetryPolicy,
        retry_on: ["transient", "timeout", "adapter_error"],
        abandon_on: ["policy_denied", "invalid_spec", "unrecoverable"],
      };
      expect(Value.Check(GripSpecSchema, grip)).toBe(true);
    });
  });

  describe("rejects invalid grips (strict mode)", () => {
    it("rejects a grip with an unknown top-level field", () => {
      const grip = validReadOnlyGrip();
      const bad = { ...grip, __typo_field__: true } as unknown;
      expect(Value.Check(GripSpecSchema, bad)).toBe(false);
    });

    it("rejects an invalid backoff strategy literal", () => {
      const grip = validReadOnlyGrip();
      const bad = {
        ...grip,
        retry_policy: { ...grip.retry_policy, backoff: "quadratic" as unknown as "exponential" },
      };
      expect(Value.Check(GripSpecSchema, bad)).toBe(false);
    });

    it("rejects an invalid failure classification in retry_on", () => {
      const grip = validReadOnlyGrip();
      const bad = {
        ...grip,
        retry_policy: {
          ...grip.retry_policy,
          retry_on: [
            "transient",
            "mystery_error",
          ] as unknown as GripSpec["retry_policy"]["retry_on"],
        },
      };
      expect(Value.Check(GripSpecSchema, bad)).toBe(false);
    });

    it("rejects an invalid resource_type in required_claims", () => {
      const grip = validSideEffectingGrip();
      const bad = {
        ...grip,
        required_claims: [
          {
            resource_type: "database" as unknown as "file",
            resource_key: "users",
            mode: "exclusive" as const,
          },
        ],
      };
      expect(Value.Check(GripSpecSchema, bad)).toBe(false);
    });

    it("rejects an invalid claim mode", () => {
      const grip = validSideEffectingGrip();
      const bad = {
        ...grip,
        required_claims: [
          {
            resource_type: "file" as const,
            resource_key: "/repo/a.ts",
            mode: "read-write" as unknown as "exclusive",
          },
        ],
      };
      expect(Value.Check(GripSpecSchema, bad)).toBe(false);
    });

    it("rejects a retry_policy with an unknown field (strict mode)", () => {
      const grip = validReadOnlyGrip();
      const bad = {
        ...grip,
        retry_policy: {
          ...grip.retry_policy,
          unknown_field: 1,
        } as unknown as GripSpec["retry_policy"],
      };
      expect(Value.Check(GripSpecSchema, bad)).toBe(false);
    });

    it("rejects a retry_policy missing max_attempts", () => {
      const grip = validReadOnlyGrip();
      const { max_attempts: _removed, ...partialRetry } = grip.retry_policy;
      const bad = {
        ...grip,
        retry_policy: partialRetry as unknown as GripSpec["retry_policy"],
      };
      expect(Value.Check(GripSpecSchema, bad)).toBe(false);
    });

    // Parameterized required-field coverage for the six unconditionally-
    // required GripSpec fields.
    describe("rejects a grip missing a required field", () => {
      for (const fieldName of GRIP_REQUIRED_FIELDS) {
        it(`rejects when ${fieldName} is missing`, () => {
          const grip = validSideEffectingGrip() as Record<string, unknown>;
          const copy = { ...grip };
          delete copy[fieldName];
          expect(Value.Check(GripSpecSchema, copy)).toBe(false);
        });
      }
    });
  });
});

describe("validateGripSpec (TypeBox check + side_effecting cross-check)", () => {
  describe("accepts valid grips", () => {
    it("accepts a side_effecting: false grip without idempotency_key", () => {
      const result = validateGripSpec(validReadOnlyGrip());
      expect(result.ok).toBe(true);
    });

    it("accepts a side_effecting: true grip with idempotency_key", () => {
      const result = validateGripSpec(validSideEffectingGrip());
      expect(result.ok).toBe(true);
    });

    it("accepts a side_effecting: false grip even when idempotency_key is present", () => {
      // idempotency_key is allowed on non-side-effecting grips; it is just
      // not required. Operators may still supply one for their own tracking.
      const grip = validReadOnlyGrip();
      const withKey: GripSpec = { ...grip, idempotency_key: "optional-key" };
      const result = validateGripSpec(withKey);
      expect(result.ok).toBe(true);
    });
  });

  describe("rejects side_effecting grips without idempotency_key", () => {
    it("rejects side_effecting: true when idempotency_key is missing", () => {
      const grip = validSideEffectingGrip();
      const bad: GripSpec = { ...grip };
      delete bad.idempotency_key;
      const result = validateGripSpec(bad);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.errors.join(" ")).toMatch(/idempotency_key/);
      }
    });

    it("rejects side_effecting: true when idempotency_key is an empty string", () => {
      // NonEmptyString at the schema layer should reject this — confirming
      // both layers cooperate correctly.
      const grip = validSideEffectingGrip();
      const bad = { ...grip, idempotency_key: "" };
      const result = validateGripSpec(bad);
      expect(result.ok).toBe(false);
    });
  });

  describe("reports structured errors on failure", () => {
    it("returns ok:false with an errors array on schema failure", () => {
      const result = validateGripSpec({ spec_version: 1 } as unknown);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.errors.length).toBeGreaterThan(0);
      }
    });

    it("returns ok:true with the typed spec when validation passes", () => {
      const result = validateGripSpec(validSideEffectingGrip());
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.spec.side_effecting).toBe(true);
        expect(result.spec.mission_id).toBe("m-test");
        expect(result.spec.idempotency_key).toBe("grip-idem-0001");
      }
    });
  });
});

// ══════════════════════════════════════════════════════════════════════════
// MissionSpec tests (M0-03)
// ══════════════════════════════════════════════════════════════════════════

// ──────────────────────────────────────────────────────────────────────────
// MissionSpec fixture builders
// ──────────────────────────────────────────────────────────────────────────

function validMinimalMission(): MissionSpec {
  return {
    spec_version: 1,
    title: "Test minimal mission",
    owner: "operator:home",
    graph: [
      {
        grip_id: "g-1",
        depends_on: [],
      },
    ],
  };
}

function validLinearMission(): MissionSpec {
  // A -> B -> C
  return {
    spec_version: 1,
    title: "Test linear mission",
    owner: "operator:home",
    graph: [
      { grip_id: "g-a", depends_on: [] },
      { grip_id: "g-b", depends_on: ["g-a"] },
      { grip_id: "g-c", depends_on: ["g-b"] },
    ],
  };
}

function validFanOutMission(): MissionSpec {
  // A -> [B, C, D]
  return {
    spec_version: 1,
    title: "Test fan-out mission",
    owner: "operator:home",
    graph: [
      { grip_id: "g-a", depends_on: [] },
      { grip_id: "g-b", depends_on: ["g-a"], fan_out_group: "batch-1" },
      { grip_id: "g-c", depends_on: ["g-a"], fan_out_group: "batch-1" },
      { grip_id: "g-d", depends_on: ["g-a"], fan_out_group: "batch-1" },
    ],
  };
}

function validFanInMission(): MissionSpec {
  // [A, B] -> C
  return {
    spec_version: 1,
    title: "Test fan-in mission",
    owner: "operator:home",
    graph: [
      { grip_id: "g-a", depends_on: [] },
      { grip_id: "g-b", depends_on: [] },
      { grip_id: "g-c", depends_on: ["g-a", "g-b"] },
    ],
  };
}

function validFullMission(): MissionSpec {
  return {
    spec_version: 1,
    title: "limn-api security audit + fix",
    owner: "whatsapp:+15555550123",
    policy_profile_ref: "strict-refactor",
    metadata: {
      source: "operator",
      repo: "limn-api",
      scope: "src/auth",
    },
    budget: {
      cost_usd_limit: 40.0,
      token_limit: 2000000,
      on_exceed: "pause",
    },
    graph: [
      { grip_id: "g-audit", depends_on: [], blocks_mission_on_failure: true },
      {
        grip_id: "g-fix-py",
        depends_on: ["g-audit"],
        fan_out_group: "fix",
        blocks_mission_on_failure: false,
      },
      {
        grip_id: "g-fix-ts",
        depends_on: ["g-audit"],
        fan_out_group: "fix",
        blocks_mission_on_failure: false,
      },
      { grip_id: "g-verify", depends_on: ["g-fix-py", "g-fix-ts"] },
    ],
    labels: { mission_type: "security-sweep", owner_team: "home" },
  };
}

const MISSION_REQUIRED_FIELDS = ["spec_version", "title", "owner", "graph"] as const;

describe("MissionSpecSchema (bare TypeBox validation)", () => {
  describe("accepts valid missions", () => {
    it("validates a minimal mission (single grip, no deps)", () => {
      expect(Value.Check(MissionSpecSchema, validMinimalMission())).toBe(true);
    });

    it("validates a linear-chain mission (A -> B -> C)", () => {
      expect(Value.Check(MissionSpecSchema, validLinearMission())).toBe(true);
    });

    it("validates a fan-out mission (A -> [B, C, D])", () => {
      expect(Value.Check(MissionSpecSchema, validFanOutMission())).toBe(true);
    });

    it("validates a fan-in mission ([A, B] -> C)", () => {
      expect(Value.Check(MissionSpecSchema, validFanInMission())).toBe(true);
    });

    it("validates a full mission with budget, metadata, labels, fan-out groups", () => {
      expect(Value.Check(MissionSpecSchema, validFullMission())).toBe(true);
    });
  });

  describe("rejects invalid missions (strict mode)", () => {
    it("rejects a mission with an unknown top-level field", () => {
      const m = validMinimalMission();
      const bad = { ...m, __typo_field__: true } as unknown;
      expect(Value.Check(MissionSpecSchema, bad)).toBe(false);
    });

    it("rejects a mission with an empty graph", () => {
      const m = validMinimalMission();
      const bad = { ...m, graph: [] };
      expect(Value.Check(MissionSpecSchema, bad)).toBe(false);
    });

    it("rejects a graph node with an unknown field", () => {
      const m = validMinimalMission();
      const bad = {
        ...m,
        graph: [{ ...m.graph[0], __typo__: 1 } as unknown as MissionSpec["graph"][number]],
      };
      expect(Value.Check(MissionSpecSchema, bad)).toBe(false);
    });

    it("rejects a mission with an invalid budget on_exceed literal", () => {
      const m = validFullMission();
      const bad = {
        ...m,
        budget: {
          ...m.budget!,
          on_exceed: "yell" as unknown as "pause",
        },
      };
      expect(Value.Check(MissionSpecSchema, bad)).toBe(false);
    });

    it("rejects a mission with an incomplete budget (missing on_exceed)", () => {
      const m = validFullMission();
      const { on_exceed: _removed, ...partialBudget } = m.budget!;
      const bad = { ...m, budget: partialBudget as unknown as MissionSpec["budget"] };
      expect(Value.Check(MissionSpecSchema, bad)).toBe(false);
    });

    it("rejects a mission with a budget carrying an unknown field", () => {
      const m = validFullMission();
      const bad = {
        ...m,
        budget: { ...m.budget!, extra_budget_field: 1 } as unknown as MissionSpec["budget"],
      };
      expect(Value.Check(MissionSpecSchema, bad)).toBe(false);
    });

    describe("rejects a mission missing a required field", () => {
      for (const fieldName of MISSION_REQUIRED_FIELDS) {
        it(`rejects when ${fieldName} is missing`, () => {
          const m = validFullMission() as Record<string, unknown>;
          const copy = { ...m };
          delete copy[fieldName];
          expect(Value.Check(MissionSpecSchema, copy)).toBe(false);
        });
      }
    });
  });
});

describe("validateMissionSpec (TypeBox check + graph integrity cross-checks)", () => {
  describe("accepts valid missions", () => {
    it("accepts a minimal mission", () => {
      expect(validateMissionSpec(validMinimalMission()).ok).toBe(true);
    });

    it("accepts a linear-chain mission", () => {
      expect(validateMissionSpec(validLinearMission()).ok).toBe(true);
    });

    it("accepts a fan-out mission", () => {
      expect(validateMissionSpec(validFanOutMission()).ok).toBe(true);
    });

    it("accepts a fan-in mission", () => {
      expect(validateMissionSpec(validFanInMission()).ok).toBe(true);
    });

    it("accepts a full mission with budget, metadata, and labels", () => {
      expect(validateMissionSpec(validFullMission()).ok).toBe(true);
    });

    it("accepts a diamond mission (A -> [B, C] -> D) — still a DAG", () => {
      const diamond: MissionSpec = {
        spec_version: 1,
        title: "Diamond",
        owner: "operator:home",
        graph: [
          { grip_id: "g-a", depends_on: [] },
          { grip_id: "g-b", depends_on: ["g-a"] },
          { grip_id: "g-c", depends_on: ["g-a"] },
          { grip_id: "g-d", depends_on: ["g-b", "g-c"] },
        ],
      };
      expect(validateMissionSpec(diamond).ok).toBe(true);
    });
  });

  describe("rejects graph integrity violations", () => {
    it("rejects a mission with duplicate grip_ids in the graph", () => {
      const m: MissionSpec = {
        spec_version: 1,
        title: "Dup",
        owner: "operator:home",
        graph: [
          { grip_id: "g-same", depends_on: [] },
          { grip_id: "g-same", depends_on: [] },
        ],
      };
      const result = validateMissionSpec(m);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.errors.join(" ")).toMatch(/duplicate/);
        expect(result.errors.join(" ")).toMatch(/g-same/);
      }
    });

    it("rejects a mission with an unknown depends_on reference", () => {
      const m: MissionSpec = {
        spec_version: 1,
        title: "Unknown dep",
        owner: "operator:home",
        graph: [{ grip_id: "g-a", depends_on: ["g-does-not-exist"] }],
      };
      const result = validateMissionSpec(m);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.errors.join(" ")).toMatch(/unknown grip_ids/);
        expect(result.errors.join(" ")).toMatch(/g-does-not-exist/);
      }
    });

    it("rejects a mission with a self-loop cycle (A -> A)", () => {
      const m: MissionSpec = {
        spec_version: 1,
        title: "Self-loop",
        owner: "operator:home",
        graph: [{ grip_id: "g-a", depends_on: ["g-a"] }],
      };
      const result = validateMissionSpec(m);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.errors.join(" ")).toMatch(/cycle/);
      }
    });

    it("rejects a mission with a 2-cycle (A <-> B)", () => {
      const m: MissionSpec = {
        spec_version: 1,
        title: "2-cycle",
        owner: "operator:home",
        graph: [
          { grip_id: "g-a", depends_on: ["g-b"] },
          { grip_id: "g-b", depends_on: ["g-a"] },
        ],
      };
      const result = validateMissionSpec(m);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.errors.join(" ")).toMatch(/cycle/);
      }
    });

    it("rejects a mission with a 3-cycle (A -> B -> C -> A)", () => {
      const m: MissionSpec = {
        spec_version: 1,
        title: "3-cycle",
        owner: "operator:home",
        graph: [
          { grip_id: "g-a", depends_on: ["g-c"] },
          { grip_id: "g-b", depends_on: ["g-a"] },
          { grip_id: "g-c", depends_on: ["g-b"] },
        ],
      };
      const result = validateMissionSpec(m);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.errors.join(" ")).toMatch(/cycle/);
      }
    });

    it("rejects a mission where only part of the graph has a cycle", () => {
      // A -> B (linear, ok)
      // C <-> D (cycle, should reject)
      const m: MissionSpec = {
        spec_version: 1,
        title: "Partial cycle",
        owner: "operator:home",
        graph: [
          { grip_id: "g-a", depends_on: [] },
          { grip_id: "g-b", depends_on: ["g-a"] },
          { grip_id: "g-c", depends_on: ["g-d"] },
          { grip_id: "g-d", depends_on: ["g-c"] },
        ],
      };
      const result = validateMissionSpec(m);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.errors.join(" ")).toMatch(/cycle/);
      }
    });
  });

  describe("reports structured errors on failure", () => {
    it("returns ok:false with an errors array on schema failure", () => {
      const result = validateMissionSpec({ spec_version: 1 } as unknown);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.errors.length).toBeGreaterThan(0);
      }
    });

    it("returns ok:true with the typed spec when validation passes", () => {
      const result = validateMissionSpec(validFullMission());
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.spec.title).toBe("limn-api security audit + fix");
        expect(result.spec.graph.length).toBe(4);
        expect(result.spec.budget?.on_exceed).toBe("pause");
      }
    });
  });
});

// ══════════════════════════════════════════════════════════════════════════
// MissionExecutionMode tests (M0-04.1, OCTO-DEC-039)
// ══════════════════════════════════════════════════════════════════════════

// The five execution modes per OCTO-DEC-039. A parameterized test asserts
// that each is accepted as a valid value of MissionSpec.execution_mode and
// that the MissionExecutionModeSchema accepts each literal directly.
const VALID_EXECUTION_MODES = [
  "direct_execute",
  "research_then_plan",
  "research_then_design_then_execute",
  "compare_implementations",
  "validate_prior_art_then_execute",
] as const satisfies readonly MissionExecutionMode[];

describe("MissionExecutionModeSchema", () => {
  describe("accepts every valid mode literal", () => {
    for (const mode of VALID_EXECUTION_MODES) {
      it(`accepts "${mode}"`, () => {
        expect(Value.Check(MissionExecutionModeSchema, mode)).toBe(true);
      });
    }
  });

  it("rejects an invalid mode literal", () => {
    expect(Value.Check(MissionExecutionModeSchema, "yolo_execute")).toBe(false);
  });

  it("rejects a non-string value", () => {
    expect(Value.Check(MissionExecutionModeSchema, 42)).toBe(false);
  });

  it("rejects the empty string", () => {
    expect(Value.Check(MissionExecutionModeSchema, "")).toBe(false);
  });
});

describe("MissionSpec.execution_mode (optional field)", () => {
  describe("accepts missions carrying each valid mode", () => {
    for (const mode of VALID_EXECUTION_MODES) {
      it(`accepts a mission with execution_mode=${mode}`, () => {
        const mission: MissionSpec = {
          ...validMinimalMission(),
          execution_mode: mode,
        };
        expect(Value.Check(MissionSpecSchema, mission)).toBe(true);
      });
    }
  });

  it("accepts a mission without execution_mode (the default/backward-compat path)", () => {
    // This is the same assertion as the M0-03 minimal-mission test, but
    // rewritten here as an explicit check that the optional field does not
    // break the no-classifier flow.
    const mission = validMinimalMission();
    expect("execution_mode" in mission).toBe(false);
    expect(Value.Check(MissionSpecSchema, mission)).toBe(true);
  });

  it("accepts a full mission with execution_mode alongside budget and metadata", () => {
    const mission: MissionSpec = {
      ...validFullMission(),
      execution_mode: "research_then_design_then_execute",
    };
    expect(Value.Check(MissionSpecSchema, mission)).toBe(true);
  });

  it("rejects a mission with an invalid execution_mode literal", () => {
    const mission = {
      ...validMinimalMission(),
      execution_mode: "yolo_execute" as unknown as MissionExecutionMode,
    };
    expect(Value.Check(MissionSpecSchema, mission)).toBe(false);
  });

  it("rejects a mission where execution_mode is a number", () => {
    const mission = {
      ...validMinimalMission(),
      execution_mode: 1 as unknown as MissionExecutionMode,
    };
    expect(Value.Check(MissionSpecSchema, mission)).toBe(false);
  });

  it("validateMissionSpec accepts a valid mission with execution_mode", () => {
    const mission: MissionSpec = {
      ...validFullMission(),
      execution_mode: "research_then_design_then_execute",
    };
    const result = validateMissionSpec(mission);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.spec.execution_mode).toBe("research_then_design_then_execute");
    }
  });

  it("validateMissionSpec rejects a mission with an invalid execution_mode", () => {
    const mission = {
      ...validMinimalMission(),
      execution_mode: "yolo_execute" as unknown as MissionExecutionMode,
    };
    const result = validateMissionSpec(mission);
    expect(result.ok).toBe(false);
  });
});
