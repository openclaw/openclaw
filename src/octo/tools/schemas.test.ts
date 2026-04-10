// Octopus Orchestrator — agent tool parameter schema tests (M0-08)
//
// Covers:
//   - OCTO_TOOL_SCHEMA_REGISTRY has exactly 16 tools (8 read-only + 8 writer)
//   - Every tool has a minimal valid params shape that TypeBox accepts
//   - Every writer tool REJECTS params missing idempotency_key
//   - Every writer tool REJECTS params with empty-string idempotency_key
//     (NonEmptyString discipline)
//   - No read-only tool requires idempotency_key (the minimal valid call
//     passes without it)
//   - Strict mode: every tool rejects unknown top-level fields
//   - validateOctoMissionCreateParams enforces the mission_spec / template_id
//     XOR rule
//   - Tool-specific spot checks (arm_spawn reuses ArmSpecSchema; arm_send
//     rejects invalid kind; events_tail accepts empty object)

import { Value } from "@sinclair/typebox/value";
import { describe, expect, it } from "vitest";
import type { ArmSpec, MissionSpec } from "../wire/schema.ts";
import {
  OCTO_READ_ONLY_TOOL_NAMES,
  OCTO_TOOL_NAMES,
  OCTO_TOOL_SCHEMA_REGISTRY,
  OCTO_WRITER_TOOL_NAMES,
  OctoArmSendParamsSchema,
  OctoArmSpawnParamsSchema,
  OctoEventsTailParamsSchema,
  OctoMissionCreateParamsSchema,
  validateOctoMissionCreateParams,
  type OctoToolName,
} from "./schemas.ts";

// ──────────────────────────────────────────────────────────────────────────
// Canonical fixtures
// ──────────────────────────────────────────────────────────────────────────

function canonicalArmSpec(): ArmSpec {
  return {
    spec_version: 1,
    mission_id: "m-test",
    adapter_type: "cli_exec",
    runtime_name: "claude-code",
    agent_id: "home",
    cwd: "/repos/test",
    idempotency_key: "arm-inner-0001",
    runtime_options: {
      command: "claude",
      args: ["-p", "--output-format", "stream-json"],
      structuredOutputFormat: "stream-json",
    },
  };
}

function canonicalMissionSpec(): MissionSpec {
  return {
    spec_version: 1,
    title: "Refactor auth module",
    owner: "home",
    graph: [
      { grip_id: "g-root", depends_on: [] },
      { grip_id: "g-child", depends_on: ["g-root"] },
    ],
  };
}

// Minimal-but-valid params for each of the 16 tools. Writer tools include
// the required `idempotency_key`. Used by the parameterized sweeps below.
const VALID_EXAMPLES: Record<OctoToolName, Record<string, unknown>> = {
  // Read-only
  octo_status: {},
  octo_mission_list: {},
  octo_mission_show: { mission_id: "m-0001" },
  octo_arm_list: {},
  octo_arm_show: { arm_id: "arm-0001" },
  octo_grip_list: {},
  octo_events_tail: {},
  octo_claims_list: {},
  // Writer
  octo_mission_create: {
    idempotency_key: "k-create-0001",
    mission_spec: canonicalMissionSpec(),
  },
  octo_mission_pause: {
    idempotency_key: "k-pause-0001",
    mission_id: "m-0001",
  },
  octo_mission_resume: {
    idempotency_key: "k-resume-0001",
    mission_id: "m-0001",
  },
  octo_mission_abort: {
    idempotency_key: "k-abort-0001",
    mission_id: "m-0001",
    reason: "operator requested",
  },
  octo_arm_spawn: {
    idempotency_key: "k-spawn-0001",
    spec: canonicalArmSpec(),
  },
  octo_arm_send: {
    idempotency_key: "k-send-0001",
    arm_id: "arm-0001",
    kind: "message",
    payload: "follow up",
  },
  octo_arm_terminate: {
    idempotency_key: "k-term-0001",
    arm_id: "arm-0001",
    reason: "operator requested",
  },
  octo_grip_reassign: {
    idempotency_key: "k-reassign-0001",
    grip_id: "g-0001",
    target_arm_id: "arm-0002",
  },
};

// ──────────────────────────────────────────────────────────────────────────
// Registry invariants
// ──────────────────────────────────────────────────────────────────────────

describe("OCTO_TOOL_SCHEMA_REGISTRY invariants", () => {
  it("contains exactly 16 tools", () => {
    expect(OCTO_TOOL_NAMES).toHaveLength(16);
  });

  it("partitions into 8 read-only tools", () => {
    expect(OCTO_READ_ONLY_TOOL_NAMES).toHaveLength(8);
    expect(OCTO_READ_ONLY_TOOL_NAMES).toEqual(
      expect.arrayContaining([
        "octo_status",
        "octo_mission_list",
        "octo_mission_show",
        "octo_arm_list",
        "octo_arm_show",
        "octo_grip_list",
        "octo_events_tail",
        "octo_claims_list",
      ]),
    );
  });

  it("partitions into 8 writer tools", () => {
    expect(OCTO_WRITER_TOOL_NAMES).toHaveLength(8);
    expect(OCTO_WRITER_TOOL_NAMES).toEqual(
      expect.arrayContaining([
        "octo_mission_create",
        "octo_mission_pause",
        "octo_mission_resume",
        "octo_mission_abort",
        "octo_arm_spawn",
        "octo_arm_send",
        "octo_arm_terminate",
        "octo_grip_reassign",
      ]),
    );
  });

  it("read-only and writer partitions are disjoint and cover the full set", () => {
    const union = new Set<OctoToolName>([...OCTO_READ_ONLY_TOOL_NAMES, ...OCTO_WRITER_TOOL_NAMES]);
    expect(union.size).toBe(16);
    for (const name of OCTO_READ_ONLY_TOOL_NAMES) {
      expect(OCTO_WRITER_TOOL_NAMES).not.toContain(name);
    }
  });

  it("every registry entry has both params schema and kind", () => {
    for (const name of OCTO_TOOL_NAMES) {
      const entry = OCTO_TOOL_SCHEMA_REGISTRY[name];
      expect(entry).toBeDefined();
      expect(entry.params).toBeDefined();
      expect(entry.kind === "read_only" || entry.kind === "writer").toBe(true);
    }
  });

  it("VALID_EXAMPLES has an entry for every registered tool", () => {
    for (const name of OCTO_TOOL_NAMES) {
      expect(VALID_EXAMPLES[name]).toBeDefined();
    }
    expect(Object.keys(VALID_EXAMPLES)).toHaveLength(16);
  });
});

// ──────────────────────────────────────────────────────────────────────────
// Parameterized valid-shape sweep (one per tool)
// ──────────────────────────────────────────────────────────────────────────

describe("valid-shape sweep", () => {
  for (const name of OCTO_TOOL_NAMES) {
    it(`${name}: minimal valid params passes`, () => {
      const entry = OCTO_TOOL_SCHEMA_REGISTRY[name];
      expect(Value.Check(entry.params, VALID_EXAMPLES[name])).toBe(true);
    });
  }
});

// ──────────────────────────────────────────────────────────────────────────
// Strict mode sweep: every tool rejects unknown top-level fields
// ──────────────────────────────────────────────────────────────────────────

describe("strict mode sweep", () => {
  for (const name of OCTO_TOOL_NAMES) {
    it(`${name}: rejects unknown top-level field`, () => {
      const entry = OCTO_TOOL_SCHEMA_REGISTRY[name];
      const withExtra = { ...VALID_EXAMPLES[name], extra_key: "nope" };
      expect(Value.Check(entry.params, withExtra)).toBe(false);
    });
  }
});

// ──────────────────────────────────────────────────────────────────────────
// Writer tools: idempotency_key discipline (8 rejection tests, one per)
// ──────────────────────────────────────────────────────────────────────────

describe("writer tools require idempotency_key", () => {
  for (const name of OCTO_WRITER_TOOL_NAMES) {
    it(`${name}: rejects params missing idempotency_key`, () => {
      const entry = OCTO_TOOL_SCHEMA_REGISTRY[name];
      const { idempotency_key: _removed, ...withoutKey } = VALID_EXAMPLES[name];
      expect(Value.Check(entry.params, withoutKey)).toBe(false);
    });

    it(`${name}: rejects params with empty-string idempotency_key`, () => {
      const entry = OCTO_TOOL_SCHEMA_REGISTRY[name];
      const withEmpty = { ...VALID_EXAMPLES[name], idempotency_key: "" };
      expect(Value.Check(entry.params, withEmpty)).toBe(false);
    });
  }
});

// ──────────────────────────────────────────────────────────────────────────
// Read-only tools: must NOT require idempotency_key
//
// The minimal valid example for every read-only tool is constructed
// WITHOUT idempotency_key. If any read-only schema accidentally started
// requiring it, that example would fail. We additionally confirm that
// adding an `idempotency_key` field to a read-only call is REJECTED by
// strict mode — read-only tools should not leak writer fields.
// ──────────────────────────────────────────────────────────────────────────

describe("read-only tools do not require idempotency_key", () => {
  for (const name of OCTO_READ_ONLY_TOOL_NAMES) {
    it(`${name}: minimal valid call has no idempotency_key`, () => {
      expect(VALID_EXAMPLES[name]).not.toHaveProperty("idempotency_key");
    });

    it(`${name}: rejects params that carry an idempotency_key (strict mode)`, () => {
      const entry = OCTO_TOOL_SCHEMA_REGISTRY[name];
      const withKey = { ...VALID_EXAMPLES[name], idempotency_key: "k" };
      expect(Value.Check(entry.params, withKey)).toBe(false);
    });
  }
});

// ──────────────────────────────────────────────────────────────────────────
// octo_mission_create: XOR between mission_spec and template_id
//
// The bare schema allows both/neither (it cannot express the rule); the
// validator enforces it.
// ──────────────────────────────────────────────────────────────────────────

describe("validateOctoMissionCreateParams XOR rule", () => {
  it("accepts inline mission_spec alone", () => {
    const result = validateOctoMissionCreateParams({
      idempotency_key: "k",
      mission_spec: canonicalMissionSpec(),
    });
    expect(result.ok).toBe(true);
  });

  it("accepts template_id alone", () => {
    const result = validateOctoMissionCreateParams({
      idempotency_key: "k",
      template_id: "refactor-audit",
    });
    expect(result.ok).toBe(true);
  });

  it("accepts template_id with template_args", () => {
    const result = validateOctoMissionCreateParams({
      idempotency_key: "k",
      template_id: "refactor-audit",
      template_args: { repo: "main", scope: "src/" },
    });
    expect(result.ok).toBe(true);
  });

  it("accepts execution_mode override with inline mission_spec", () => {
    const result = validateOctoMissionCreateParams({
      idempotency_key: "k",
      mission_spec: canonicalMissionSpec(),
      execution_mode: "research_then_design_then_execute",
    });
    expect(result.ok).toBe(true);
  });

  it("rejects when both mission_spec and template_id are present", () => {
    const result = validateOctoMissionCreateParams({
      idempotency_key: "k",
      mission_spec: canonicalMissionSpec(),
      template_id: "refactor-audit",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.join(" ")).toMatch(/exactly one/i);
    }
  });

  it("rejects when neither mission_spec nor template_id is present", () => {
    const result = validateOctoMissionCreateParams({
      idempotency_key: "k",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.join(" ")).toMatch(/one of/i);
    }
  });

  it("rejects template_args without template_id", () => {
    const result = validateOctoMissionCreateParams({
      idempotency_key: "k",
      mission_spec: canonicalMissionSpec(),
      template_args: { foo: "bar" },
    });
    expect(result.ok).toBe(false);
  });

  it("rejects when idempotency_key is missing (passes through to bare schema)", () => {
    const result = validateOctoMissionCreateParams({
      mission_spec: canonicalMissionSpec(),
    });
    expect(result.ok).toBe(false);
  });

  it("rejects invalid execution_mode literal", () => {
    const result = validateOctoMissionCreateParams({
      idempotency_key: "k",
      mission_spec: canonicalMissionSpec(),
      execution_mode: "turbo_mode",
    });
    expect(result.ok).toBe(false);
  });
});

// ──────────────────────────────────────────────────────────────────────────
// Tool-specific spot checks
// ──────────────────────────────────────────────────────────────────────────

describe("octo_arm_spawn reuses ArmSpecSchema", () => {
  it("accepts a valid canonical ArmSpec in the spec field", () => {
    const params = { idempotency_key: "k", spec: canonicalArmSpec() };
    expect(Value.Check(OctoArmSpawnParamsSchema, params)).toBe(true);
  });

  it("rejects a malformed spec (bare ArmSpec check catches it)", () => {
    const params = { idempotency_key: "k", spec: { spec_version: 1 } };
    expect(Value.Check(OctoArmSpawnParamsSchema, params)).toBe(false);
  });

  it("rejects a spec whose runtime_options is of an unknown shape", () => {
    const spec = canonicalArmSpec();
    const params = {
      idempotency_key: "k",
      spec: { ...spec, runtime_options: { totally: "bogus" } },
    };
    expect(Value.Check(OctoArmSpawnParamsSchema, params)).toBe(false);
  });
});

describe("octo_arm_send kind/payload discipline", () => {
  it("accepts a keys-kind send", () => {
    const params = {
      idempotency_key: "k",
      arm_id: "arm-0001",
      kind: "keys",
      payload: "C-c",
    };
    expect(Value.Check(OctoArmSendParamsSchema, params)).toBe(true);
  });

  it("rejects a send with unknown kind literal", () => {
    const params = {
      idempotency_key: "k",
      arm_id: "arm-0001",
      kind: "teletype",
      payload: "x",
    };
    expect(Value.Check(OctoArmSendParamsSchema, params)).toBe(false);
  });

  it("rejects a send missing kind", () => {
    const params = {
      idempotency_key: "k",
      arm_id: "arm-0001",
      payload: "x",
    };
    expect(Value.Check(OctoArmSendParamsSchema, params)).toBe(false);
  });

  it("rejects a send missing payload", () => {
    const params = {
      idempotency_key: "k",
      arm_id: "arm-0001",
      kind: "message",
    };
    expect(Value.Check(OctoArmSendParamsSchema, params)).toBe(false);
  });
});

describe("octo_events_tail all-optional shape", () => {
  it("accepts an empty object", () => {
    expect(Value.Check(OctoEventsTailParamsSchema, {})).toBe(true);
  });

  it("accepts a fully populated filter", () => {
    const params = {
      entity_type: "arm",
      entity_id: "arm-0001",
      since_event_id: "evt-123",
      limit: 100,
    };
    expect(Value.Check(OctoEventsTailParamsSchema, params)).toBe(true);
  });

  it("rejects limit outside allowed range", () => {
    expect(Value.Check(OctoEventsTailParamsSchema, { limit: 0 })).toBe(false);
    expect(Value.Check(OctoEventsTailParamsSchema, { limit: 1001 })).toBe(false);
  });
});

describe("octo_mission_create bare schema accepts both shapes", () => {
  it("accepts inline mission_spec via bare schema", () => {
    const params = { idempotency_key: "k", mission_spec: canonicalMissionSpec() };
    expect(Value.Check(OctoMissionCreateParamsSchema, params)).toBe(true);
  });

  it("accepts template_id via bare schema", () => {
    const params = { idempotency_key: "k", template_id: "t-1" };
    expect(Value.Check(OctoMissionCreateParamsSchema, params)).toBe(true);
  });

  it("bare schema accepts both fields (validator enforces XOR)", () => {
    const params = {
      idempotency_key: "k",
      mission_spec: canonicalMissionSpec(),
      template_id: "t-1",
    };
    // Bare schema passes; validator rejects (tested separately above).
    expect(Value.Check(OctoMissionCreateParamsSchema, params)).toBe(true);
  });
});
