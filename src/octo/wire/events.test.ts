// Octopus Orchestrator — Gateway WS event schema tests (M0-05)
//
// Covers:
//   - EventEnvelope validation: canonical envelope per entity_type (8 tests)
//   - EventEnvelope rejection: unknown entity_type, unknown event_type,
//     unknown top-level field, missing required fields (parameterized),
//     invalid schema_version
//   - CoreEventType validation: all 37 literals accepted, unknown rejected
//   - Push event schemas: canonical accept + focused reject tests for
//     each of the six octo.* push events
//   - OCTO_PUSH_EVENT_REGISTRY invariants

import { Value } from "@sinclair/typebox/value";
import { describe, expect, it } from "vitest";
import {
  CORE_EVENT_TYPES,
  CoreEventTypeSchema,
  EVENT_ENTITY_TYPES,
  EventEntityTypeSchema,
  EventEnvelopeSchema,
  OCTO_PUSH_EVENT_NAMES,
  OCTO_PUSH_EVENT_REGISTRY,
  OctoAnomalyPushSchema,
  OctoArmCheckpointPushSchema,
  OctoArmOutputPushSchema,
  OctoArmStatePushSchema,
  OctoLeaseRenewPushSchema,
  OctoNodeTelemetryPushSchema,
  type CoreEventType,
  type EventEntityType,
  type EventEnvelope,
} from "./events.ts";

// ──────────────────────────────────────────────────────────────────────────
// EventEnvelope fixtures — one canonical envelope per entity_type
// ──────────────────────────────────────────────────────────────────────────

const CANONICAL_EVENT_TYPE_PER_ENTITY: Record<EventEntityType, CoreEventType> = {
  mission: "mission.created",
  arm: "arm.active",
  grip: "grip.running",
  claim: "claim.acquired",
  lease: "lease.renewed",
  artifact: "artifact.recorded",
  operator: "operator.approved",
  policy: "policy.decision",
};

function envelopeFor(entity: EventEntityType): EventEnvelope {
  return {
    event_id: "01HXYZ000000000000000ABCDE",
    schema_version: 1,
    entity_type: entity,
    entity_id: `${entity}-test-001`,
    event_type: CANONICAL_EVENT_TYPE_PER_ENTITY[entity],
    ts: "2026-04-09T17:35:00.000Z",
    actor: "system",
    payload: { note: "canonical test envelope" },
  };
}

// ──────────────────────────────────────────────────────────────────────────
// EventEntityTypeSchema + EventEnvelope (envelope shape)
// ──────────────────────────────────────────────────────────────────────────

describe("EventEntityTypeSchema", () => {
  for (const entity of EVENT_ENTITY_TYPES) {
    it(`accepts "${entity}"`, () => {
      expect(Value.Check(EventEntityTypeSchema, entity)).toBe(true);
    });
  }

  it("rejects an unknown entity type", () => {
    expect(Value.Check(EventEntityTypeSchema, "node")).toBe(false);
  });

  it("rejects a non-string value", () => {
    expect(Value.Check(EventEntityTypeSchema, 0)).toBe(false);
  });
});

describe("CoreEventTypeSchema", () => {
  it("lists all 37 canonical event types", () => {
    expect(CORE_EVENT_TYPES).toHaveLength(37);
  });

  it("groups match LLD §Core event types (12 arm, 8 grip, 6 mission, 6 claim/lease/artifact, 5 operator/policy)", () => {
    expect(CORE_EVENT_TYPES.filter((t) => t.startsWith("arm."))).toHaveLength(12);
    expect(CORE_EVENT_TYPES.filter((t) => t.startsWith("grip."))).toHaveLength(8);
    expect(CORE_EVENT_TYPES.filter((t) => t.startsWith("mission."))).toHaveLength(6);
    expect(
      CORE_EVENT_TYPES.filter(
        (t) => t.startsWith("claim.") || t.startsWith("lease.") || t.startsWith("artifact."),
      ),
    ).toHaveLength(6);
    expect(
      CORE_EVENT_TYPES.filter((t) => t.startsWith("operator.") || t.startsWith("policy.")),
    ).toHaveLength(5);
  });

  describe("accepts every canonical event type literal", () => {
    for (const eventType of CORE_EVENT_TYPES) {
      it(`accepts "${eventType}"`, () => {
        expect(Value.Check(CoreEventTypeSchema, eventType)).toBe(true);
      });
    }
  });

  it("rejects an unknown event type literal", () => {
    expect(Value.Check(CoreEventTypeSchema, "arm.yolo")).toBe(false);
  });
});

describe("EventEnvelopeSchema (round-trip per entity type)", () => {
  describe("accepts a canonical envelope for each entity type", () => {
    for (const entity of EVENT_ENTITY_TYPES) {
      it(`accepts a canonical ${entity} envelope`, () => {
        expect(Value.Check(EventEnvelopeSchema, envelopeFor(entity))).toBe(true);
      });
    }
  });

  it("accepts an envelope with optional causation_id present", () => {
    const envelope = envelopeFor("arm");
    envelope.causation_id = "01HXYZ000000000000000PARENT";
    expect(Value.Check(EventEnvelopeSchema, envelope)).toBe(true);
  });

  it("accepts an envelope with optional correlation_id present", () => {
    const envelope = envelopeFor("grip");
    envelope.correlation_id = "m-12345";
    expect(Value.Check(EventEnvelopeSchema, envelope)).toBe(true);
  });

  it("accepts an envelope with an empty payload object", () => {
    const envelope = envelopeFor("arm");
    envelope.payload = {};
    expect(Value.Check(EventEnvelopeSchema, envelope)).toBe(true);
  });

  describe("rejects invalid envelopes (strict mode)", () => {
    it("rejects an envelope with an unknown top-level field", () => {
      const envelope = envelopeFor("arm") as Record<string, unknown>;
      envelope["__typo__"] = true;
      expect(Value.Check(EventEnvelopeSchema, envelope)).toBe(false);
    });

    it("rejects an envelope with an unknown entity_type", () => {
      const envelope = {
        ...envelopeFor("arm"),
        entity_type: "node" as unknown as EventEntityType,
      };
      expect(Value.Check(EventEnvelopeSchema, envelope)).toBe(false);
    });

    it("rejects an envelope with an unknown event_type", () => {
      const envelope = {
        ...envelopeFor("arm"),
        event_type: "arm.yolo" as unknown as CoreEventType,
      };
      expect(Value.Check(EventEnvelopeSchema, envelope)).toBe(false);
    });

    it("rejects an envelope with schema_version < 1", () => {
      const envelope = { ...envelopeFor("arm"), schema_version: 0 };
      expect(Value.Check(EventEnvelopeSchema, envelope)).toBe(false);
    });

    it("rejects an envelope with non-integer schema_version", () => {
      const envelope = { ...envelopeFor("arm"), schema_version: 1.5 };
      expect(Value.Check(EventEnvelopeSchema, envelope)).toBe(false);
    });

    it("rejects an envelope with empty event_id", () => {
      const envelope = { ...envelopeFor("arm"), event_id: "" };
      expect(Value.Check(EventEnvelopeSchema, envelope)).toBe(false);
    });

    it("rejects an envelope where payload is not an object (string)", () => {
      const envelope = {
        ...envelopeFor("arm"),
        payload: "not an object" as unknown as Record<string, unknown>,
      };
      expect(Value.Check(EventEnvelopeSchema, envelope)).toBe(false);
    });

    // Parameterized required-field rejection coverage
    const REQUIRED_ENVELOPE_FIELDS = [
      "event_id",
      "schema_version",
      "entity_type",
      "entity_id",
      "event_type",
      "ts",
      "actor",
      "payload",
    ] as const;

    describe("rejects an envelope missing a required field", () => {
      for (const fieldName of REQUIRED_ENVELOPE_FIELDS) {
        it(`rejects when ${fieldName} is missing`, () => {
          const envelope = envelopeFor("arm") as Record<string, unknown>;
          const copy = { ...envelope };
          delete copy[fieldName];
          expect(Value.Check(EventEnvelopeSchema, copy)).toBe(false);
        });
      }
    });
  });
});

// ══════════════════════════════════════════════════════════════════════════
// Push event schemas
// ══════════════════════════════════════════════════════════════════════════

describe("OCTO_PUSH_EVENT_REGISTRY", () => {
  it("lists all 6 required push event names", () => {
    const expected = [
      "octo.arm.state",
      "octo.arm.output",
      "octo.arm.checkpoint",
      "octo.lease.renew",
      "octo.node.telemetry",
      "octo.anomaly",
    ] as const;
    expect(OCTO_PUSH_EVENT_NAMES).toHaveLength(expected.length);
    for (const name of expected) {
      expect(OCTO_PUSH_EVENT_NAMES).toContain(name);
    }
  });

  it("has a non-undefined schema for every registered push event", () => {
    for (const name of OCTO_PUSH_EVENT_NAMES) {
      expect(OCTO_PUSH_EVENT_REGISTRY[name]).toBeDefined();
    }
  });
});

describe("octo.arm.state push", () => {
  it("accepts a canonical state push carrying an envelope", () => {
    const push = { envelope: envelopeFor("arm") };
    expect(Value.Check(OctoArmStatePushSchema, push)).toBe(true);
  });

  it("rejects a state push missing envelope", () => {
    expect(Value.Check(OctoArmStatePushSchema, {})).toBe(false);
  });

  it("rejects a state push with a malformed envelope", () => {
    const push = { envelope: { ...envelopeFor("arm"), entity_type: "node" } };
    expect(Value.Check(OctoArmStatePushSchema, push)).toBe(false);
  });
});

describe("octo.arm.output push", () => {
  it("accepts a canonical stdout-chunk push", () => {
    const push = {
      arm_id: "arm-0001",
      sequence: 42,
      chunks: [
        {
          stream: "stdout" as const,
          text: "hello from the arm",
          bytes: 18,
          ts: "2026-04-09T17:35:01.000Z",
        },
      ],
    };
    expect(Value.Check(OctoArmOutputPushSchema, push)).toBe(true);
  });

  it("accepts a push with multiple chunks across stdout/stderr/structured", () => {
    const push = {
      arm_id: "arm-0001",
      sequence: 43,
      chunks: [
        { stream: "stdout" as const, text: "a", ts: "2026-04-09T17:35:02.000Z" },
        { stream: "stderr" as const, text: "b", ts: "2026-04-09T17:35:02.100Z" },
        { stream: "structured" as const, text: '{"type":"ok"}', ts: "2026-04-09T17:35:02.200Z" },
      ],
    };
    expect(Value.Check(OctoArmOutputPushSchema, push)).toBe(true);
  });

  it("accepts a push with cost_metadata from a structured runtime", () => {
    const push = {
      arm_id: "arm-0001",
      sequence: 44,
      chunks: [],
      cost_metadata: {
        provider: "anthropic",
        model: "claude-opus-4-6",
        input_tokens: 1200,
        output_tokens: 340,
        cost_usd: 0.045,
      },
    };
    expect(Value.Check(OctoArmOutputPushSchema, push)).toBe(true);
  });

  it("accepts a push with truncated: true indicating backpressure drop", () => {
    const push = {
      arm_id: "arm-0001",
      sequence: 45,
      truncated: true,
      chunks: [],
    };
    expect(Value.Check(OctoArmOutputPushSchema, push)).toBe(true);
  });

  it("rejects a push missing arm_id", () => {
    const push = { sequence: 1, chunks: [] };
    expect(Value.Check(OctoArmOutputPushSchema, push)).toBe(false);
  });

  it("rejects a chunk with an invalid stream kind", () => {
    const push = {
      arm_id: "arm-0001",
      sequence: 1,
      chunks: [{ stream: "teletype", ts: "2026-04-09T17:35:00.000Z" }],
    };
    expect(Value.Check(OctoArmOutputPushSchema, push)).toBe(false);
  });
});

describe("octo.arm.checkpoint push", () => {
  it("accepts a canonical checkpoint push", () => {
    const push = {
      arm_id: "arm-0001",
      checkpoint_ref: "ckpt://arm-0001/20260409T173500Z",
      ts: "2026-04-09T17:35:00.000Z",
      summary: "refactored 3 files",
    };
    expect(Value.Check(OctoArmCheckpointPushSchema, push)).toBe(true);
  });

  it("accepts a checkpoint push without optional summary", () => {
    const push = {
      arm_id: "arm-0001",
      checkpoint_ref: "ckpt://arm-0001/next",
      ts: "2026-04-09T17:35:00.000Z",
    };
    expect(Value.Check(OctoArmCheckpointPushSchema, push)).toBe(true);
  });

  it("rejects a checkpoint push missing checkpoint_ref", () => {
    const push = { arm_id: "arm-0001", ts: "2026-04-09T17:35:00.000Z" };
    expect(Value.Check(OctoArmCheckpointPushSchema, push)).toBe(false);
  });
});

describe("octo.lease.renew push", () => {
  it("accepts a lease renew with a single arm", () => {
    const push = {
      node_id: "laptop-01",
      ts: "2026-04-09T17:35:00.000Z",
      leases: [{ arm_id: "arm-0001", lease_expiry_ts: "2026-04-09T17:35:30.000Z" }],
    };
    expect(Value.Check(OctoLeaseRenewPushSchema, push)).toBe(true);
  });

  it("accepts a batch lease renew with multiple arms", () => {
    const push = {
      node_id: "laptop-01",
      ts: "2026-04-09T17:35:00.000Z",
      leases: [
        { arm_id: "arm-0001", lease_expiry_ts: "2026-04-09T17:35:30.000Z" },
        { arm_id: "arm-0002", lease_expiry_ts: "2026-04-09T17:35:30.000Z" },
        { arm_id: "arm-0003", lease_expiry_ts: "2026-04-09T17:35:30.000Z" },
      ],
    };
    expect(Value.Check(OctoLeaseRenewPushSchema, push)).toBe(true);
  });

  it("rejects a lease renew with an empty leases array", () => {
    const push = { node_id: "laptop-01", ts: "2026-04-09T17:35:00.000Z", leases: [] };
    expect(Value.Check(OctoLeaseRenewPushSchema, push)).toBe(false);
  });

  it("rejects a lease entry with an unknown field", () => {
    const push = {
      node_id: "laptop-01",
      ts: "2026-04-09T17:35:00.000Z",
      leases: [
        {
          arm_id: "arm-0001",
          lease_expiry_ts: "2026-04-09T17:35:30.000Z",
          extra: true,
        },
      ],
    };
    expect(Value.Check(OctoLeaseRenewPushSchema, push)).toBe(false);
  });
});

describe("octo.node.telemetry push", () => {
  it("accepts a canonical telemetry push", () => {
    const push = {
      node_id: "laptop-01",
      ts: "2026-04-09T17:35:00.000Z",
      active_arms: 3,
      idle_arms: 1,
      capacity_used: 0.5,
      load_avg: 1.2,
    };
    expect(Value.Check(OctoNodeTelemetryPushSchema, push)).toBe(true);
  });

  it("accepts a telemetry push without optional capacity_used / load_avg", () => {
    const push = {
      node_id: "laptop-01",
      ts: "2026-04-09T17:35:00.000Z",
      active_arms: 0,
      idle_arms: 0,
    };
    expect(Value.Check(OctoNodeTelemetryPushSchema, push)).toBe(true);
  });

  it("rejects a telemetry push with a negative active_arms count", () => {
    const push = {
      node_id: "laptop-01",
      ts: "2026-04-09T17:35:00.000Z",
      active_arms: -1,
      idle_arms: 0,
    };
    expect(Value.Check(OctoNodeTelemetryPushSchema, push)).toBe(false);
  });

  it("rejects a telemetry push with capacity_used > 1.0", () => {
    const push = {
      node_id: "laptop-01",
      ts: "2026-04-09T17:35:00.000Z",
      active_arms: 5,
      idle_arms: 0,
      capacity_used: 1.5,
    };
    expect(Value.Check(OctoNodeTelemetryPushSchema, push)).toBe(false);
  });
});

describe("octo.anomaly push", () => {
  it("accepts a canonical orphaned-session anomaly", () => {
    const push = {
      kind: "orphaned_session" as const,
      severity: "warning" as const,
      description: "found tmux session with no matching arm record",
      node_id: "laptop-01",
      affected_entities: [{ entity_type: "arm" as const, entity_id: "arm-unknown-001" }],
      ts: "2026-04-09T17:35:00.000Z",
    };
    expect(Value.Check(OctoAnomalyPushSchema, push)).toBe(true);
  });

  it("accepts every anomaly kind", () => {
    const kinds = [
      "orphaned_session",
      "missing_expected_session",
      "duplicate_execution",
      "version_mismatch",
      "policy_violation",
      "stale_claim",
      "other",
    ] as const;
    for (const kind of kinds) {
      const push = {
        kind,
        severity: "info" as const,
        description: `test ${kind}`,
        ts: "2026-04-09T17:35:00.000Z",
      };
      expect(Value.Check(OctoAnomalyPushSchema, push)).toBe(true);
    }
  });

  it("accepts every severity level", () => {
    const severities = ["info", "warning", "error", "critical"] as const;
    for (const severity of severities) {
      const push = {
        kind: "other" as const,
        severity,
        description: `test ${severity}`,
        ts: "2026-04-09T17:35:00.000Z",
      };
      expect(Value.Check(OctoAnomalyPushSchema, push)).toBe(true);
    }
  });

  it("rejects an anomaly with an invalid kind literal", () => {
    const push = {
      kind: "something_else" as unknown as "other",
      severity: "warning" as const,
      description: "x",
      ts: "2026-04-09T17:35:00.000Z",
    };
    expect(Value.Check(OctoAnomalyPushSchema, push)).toBe(false);
  });

  it("rejects an anomaly missing description", () => {
    const push = {
      kind: "other" as const,
      severity: "info" as const,
      ts: "2026-04-09T17:35:00.000Z",
    };
    expect(Value.Check(OctoAnomalyPushSchema, push)).toBe(false);
  });
});
