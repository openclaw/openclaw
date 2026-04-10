// Octopus Orchestrator — Gateway WS event schemas (M0-05)
//
// TypeBox schemas for the octo.* push events sent from Node Agents to the
// Head over the existing OpenClaw Gateway WebSocket transport, and for the
// canonical EventEnvelope that represents an append-only entry in the
// Octopus event log. See:
//   - docs/octopus-orchestrator/LLD.md §Event Schema
//   - docs/octopus-orchestrator/LLD.md §Head ↔ Node Agent Wire Contract
//   - docs/octopus-orchestrator/DECISIONS.md OCTO-DEC-018 (event schema versioning)
//
// Two surfaces defined here:
//
//   1. EventEnvelope — the canonical log record shape. Every state
//      transition is written as an append-only event matching this shape.
//      The envelope carries schema_version (OCTO-DEC-018) so migrations
//      can replay older events through the canonical transform table.
//
//   2. Push event wire frames (six octo.* push events) — the messages
//      Node Agents send to the Head. Some push events carry an
//      EventEnvelope directly (octo.arm.state); others carry shape
//      specific to the push (octo.arm.output carries stream chunks,
//      octo.lease.renew carries a lease heartbeat batch, etc.).
//
// Per existing Gateway invariant, push events are NOT replayed at the
// transport layer on client gap. Durability lives in the control plane
// event log (this envelope), not the wire. Node Agents persist unacked
// transitions to a per-node sidecar log until the Head acknowledges.

import { Type, type Static } from "@sinclair/typebox";
import { NonEmptyString } from "./primitives.ts";

// ══════════════════════════════════════════════════════════════════════════
// Entity type + core event type enums
// ══════════════════════════════════════════════════════════════════════════

// EventEntityType — eight canonical entity types per LLD §Event Schema.
// Used as the discriminator on EventEnvelope and as a filter key on the
// event log query interface.
export const EventEntityTypeSchema = Type.Union([
  Type.Literal("mission"),
  Type.Literal("arm"),
  Type.Literal("grip"),
  Type.Literal("claim"),
  Type.Literal("lease"),
  Type.Literal("artifact"),
  Type.Literal("operator"),
  Type.Literal("policy"),
]);
export type EventEntityType = Static<typeof EventEntityTypeSchema>;

// CoreEventType — 37 canonical event types per LLD §Event Schema §Core
// event types. Grouped by entity category:
//   - Arm (12)
//   - Grip (8)
//   - Mission (6)
//   - Claim / lease / artifact (6)
//   - Operator / policy (5)
//
// New event types can be ADDED without bumping schema_version per
// OCTO-DEC-018's additive-change discipline. Removing or retyping
// existing event types requires a schema_version bump + migration.
export const CoreEventTypeSchema = Type.Union([
  // Arm state transitions (12)
  Type.Literal("arm.created"),
  Type.Literal("arm.starting"),
  Type.Literal("arm.active"),
  Type.Literal("arm.idle"),
  Type.Literal("arm.blocked"),
  Type.Literal("arm.failed"),
  Type.Literal("arm.quarantined"),
  Type.Literal("arm.completed"),
  Type.Literal("arm.terminated"),
  Type.Literal("arm.archived"),
  Type.Literal("arm.reattached"),
  Type.Literal("arm.recovered"),
  // Grip state transitions (8)
  Type.Literal("grip.created"),
  Type.Literal("grip.assigned"),
  Type.Literal("grip.running"),
  Type.Literal("grip.blocked"),
  Type.Literal("grip.failed"),
  Type.Literal("grip.completed"),
  Type.Literal("grip.abandoned"),
  Type.Literal("grip.ambiguous"),
  // Mission state transitions (6)
  Type.Literal("mission.created"),
  Type.Literal("mission.paused"),
  Type.Literal("mission.resumed"),
  Type.Literal("mission.completed"),
  Type.Literal("mission.aborted"),
  Type.Literal("mission.archived"),
  // Claim / lease / artifact (6)
  Type.Literal("claim.acquired"),
  Type.Literal("claim.released"),
  Type.Literal("claim.expired"),
  Type.Literal("lease.renewed"),
  Type.Literal("lease.expired"),
  Type.Literal("artifact.recorded"),
  // Operator / policy (5)
  Type.Literal("operator.intervened"),
  Type.Literal("operator.approved"),
  Type.Literal("operator.rejected"),
  Type.Literal("operator.terminated"),
  Type.Literal("policy.decision"),
]);
export type CoreEventType = Static<typeof CoreEventTypeSchema>;

// Explicit canonical array of all 37 event types. Used by test sweeps
// and by any future code that needs to iterate over the full set.
export const CORE_EVENT_TYPES: readonly CoreEventType[] = [
  "arm.created",
  "arm.starting",
  "arm.active",
  "arm.idle",
  "arm.blocked",
  "arm.failed",
  "arm.quarantined",
  "arm.completed",
  "arm.terminated",
  "arm.archived",
  "arm.reattached",
  "arm.recovered",
  "grip.created",
  "grip.assigned",
  "grip.running",
  "grip.blocked",
  "grip.failed",
  "grip.completed",
  "grip.abandoned",
  "grip.ambiguous",
  "mission.created",
  "mission.paused",
  "mission.resumed",
  "mission.completed",
  "mission.aborted",
  "mission.archived",
  "claim.acquired",
  "claim.released",
  "claim.expired",
  "lease.renewed",
  "lease.expired",
  "artifact.recorded",
  "operator.intervened",
  "operator.approved",
  "operator.rejected",
  "operator.terminated",
  "policy.decision",
];

// Explicit canonical array of entity types.
export const EVENT_ENTITY_TYPES: readonly EventEntityType[] = [
  "mission",
  "arm",
  "grip",
  "claim",
  "lease",
  "artifact",
  "operator",
  "policy",
];

// ══════════════════════════════════════════════════════════════════════════
// EventEnvelope — the canonical log record
// ══════════════════════════════════════════════════════════════════════════

// Every state transition is written as an append-only envelope. The
// payload shape is event-type-specific and versioned by schema_version
// (OCTO-DEC-018). At the envelope level we accept any object-shaped
// payload — per-event-type validation is applied at a higher layer
// (EventLogService in M1-03) that knows which payload schema matches
// which event_type.
//
// causation_id is the event_id that caused this one; absent for root
// events. correlation_id groups related events across entities, usually
// set to mission_id for mission-driven flows.
export const EventEnvelopeSchema = Type.Object(
  {
    // ULID — monotonic, sortable, unique. Format not further constrained
    // at the envelope layer; the EventLogService generates these.
    event_id: NonEmptyString,
    schema_version: Type.Integer({ minimum: 1 }),
    entity_type: EventEntityTypeSchema,
    entity_id: NonEmptyString,
    event_type: CoreEventTypeSchema,
    // ISO 8601 with millisecond precision, UTC. NonEmptyString at the
    // envelope layer; format validation is a higher-layer concern.
    ts: NonEmptyString,
    actor: NonEmptyString,
    causation_id: Type.Optional(NonEmptyString),
    correlation_id: Type.Optional(NonEmptyString),
    // Free-form object payload. Event-type-specific validation applied
    // at the EventLogService layer (M1-03) via a lookup table.
    payload: Type.Record(Type.String(), Type.Unknown()),
  },
  { additionalProperties: false },
);
export type EventEnvelope = Static<typeof EventEnvelopeSchema>;

// ══════════════════════════════════════════════════════════════════════════
// Shared push event primitives
// ══════════════════════════════════════════════════════════════════════════

// Output stream kind for octo.arm.output chunks. `structured` is used
// when the adapter produces structured events (e.g. claude -p
// --output-format stream-json produces structured chunks, not raw
// stdout bytes).
export const OutputStreamKindSchema = Type.Union([
  Type.Literal("stdout"),
  Type.Literal("stderr"),
  Type.Literal("structured"),
]);
export type OutputStreamKind = Static<typeof OutputStreamKindSchema>;

// A single output chunk. `bytes` is the length, `text` is the captured
// content (when capturable as text — binary PTY output may set bytes
// without text). At least one of bytes or text should be present; the
// schema does not enforce this (would require a cross-check) but
// consumers should handle both cases.
export const OutputChunkSchema = Type.Object(
  {
    stream: OutputStreamKindSchema,
    bytes: Type.Optional(Type.Integer({ minimum: 0 })),
    text: Type.Optional(Type.String()),
    ts: NonEmptyString,
  },
  { additionalProperties: false },
);
export type OutputChunk = Static<typeof OutputChunkSchema>;

// Cost metadata emitted by structured runtimes (subagent, ACP,
// cli_exec with structured output format). Per LLD §Cost Accounting
// §CostRecord. Optional on output push events because PTY arms do
// not produce cost metadata.
export const CostMetadataSchema = Type.Object(
  {
    provider: Type.Optional(NonEmptyString),
    model: Type.Optional(NonEmptyString),
    input_tokens: Type.Optional(Type.Integer({ minimum: 0 })),
    output_tokens: Type.Optional(Type.Integer({ minimum: 0 })),
    cache_hit_tokens: Type.Optional(Type.Integer({ minimum: 0 })),
    cost_usd: Type.Optional(Type.Number({ minimum: 0 })),
  },
  { additionalProperties: false },
);
export type CostMetadata = Static<typeof CostMetadataSchema>;

// Anomaly kinds for octo.anomaly push events. Enumerated explicitly so
// the scheduler can reason about them deterministically and the
// observability layer can route alerts by kind.
export const AnomalyKindSchema = Type.Union([
  Type.Literal("orphaned_session"),
  Type.Literal("missing_expected_session"),
  Type.Literal("duplicate_execution"),
  Type.Literal("version_mismatch"),
  Type.Literal("policy_violation"),
  Type.Literal("stale_claim"),
  Type.Literal("other"),
]);
export type AnomalyKind = Static<typeof AnomalyKindSchema>;

export const AnomalySeveritySchema = Type.Union([
  Type.Literal("info"),
  Type.Literal("warning"),
  Type.Literal("error"),
  Type.Literal("critical"),
]);
export type AnomalySeverity = Static<typeof AnomalySeveritySchema>;

// Reference to an entity affected by an anomaly — entity_type + entity_id
// pair, same discriminator the EventEnvelope uses.
export const EntityRefSchema = Type.Object(
  {
    entity_type: EventEntityTypeSchema,
    entity_id: NonEmptyString,
  },
  { additionalProperties: false },
);
export type EntityRef = Static<typeof EntityRefSchema>;

// ══════════════════════════════════════════════════════════════════════════
// Push event schemas (Node Agent → Head)
// ══════════════════════════════════════════════════════════════════════════

// octo.arm.state — Node Agent pushes an arm state transition. The
// transition is a canonical log-worthy EventEnvelope that the Head
// appends to the event log after validation.
export const OctoArmStatePushSchema = Type.Object(
  {
    envelope: EventEnvelopeSchema,
  },
  { additionalProperties: false },
);
export type OctoArmStatePush = Static<typeof OctoArmStatePushSchema>;

// octo.arm.output — Node Agent pushes streaming output chunks from a
// live arm. The sequence number is per-arm monotonic so the Head can
// detect gaps. `truncated: true` signals that chunks were dropped due
// to backpressure (the full output is still on disk in the node's
// rolling file per LLD §Backpressure).
export const OctoArmOutputPushSchema = Type.Object(
  {
    arm_id: NonEmptyString,
    sequence: Type.Integer({ minimum: 0 }),
    truncated: Type.Optional(Type.Boolean()),
    chunks: Type.Array(OutputChunkSchema),
    cost_metadata: Type.Optional(CostMetadataSchema),
  },
  { additionalProperties: false },
);
export type OctoArmOutputPush = Static<typeof OctoArmOutputPushSchema>;

// octo.arm.checkpoint — Node Agent signals a checkpoint was recorded.
// The checkpoint_ref is an opaque handle the Head can use to fetch the
// full checkpoint blob from the artifact store.
export const OctoArmCheckpointPushSchema = Type.Object(
  {
    arm_id: NonEmptyString,
    checkpoint_ref: NonEmptyString,
    ts: NonEmptyString,
    summary: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);
export type OctoArmCheckpointPush = Static<typeof OctoArmCheckpointPushSchema>;

// octo.lease.renew — Node Agent heartbeat carrying lease expiry
// extensions for one or more arms. Batched so a node with many arms
// can renew all their leases in a single message.
export const OctoLeaseRenewPushSchema = Type.Object(
  {
    node_id: NonEmptyString,
    ts: NonEmptyString,
    leases: Type.Array(
      Type.Object(
        {
          arm_id: NonEmptyString,
          lease_expiry_ts: NonEmptyString,
        },
        { additionalProperties: false },
      ),
      { minItems: 1 },
    ),
  },
  { additionalProperties: false },
);
export type OctoLeaseRenewPush = Static<typeof OctoLeaseRenewPushSchema>;

// octo.node.telemetry — periodic node health and load snapshot. Feeds
// the scheduler's node capacity tracking and the observability layer's
// load metrics.
export const OctoNodeTelemetryPushSchema = Type.Object(
  {
    node_id: NonEmptyString,
    ts: NonEmptyString,
    active_arms: Type.Integer({ minimum: 0 }),
    idle_arms: Type.Integer({ minimum: 0 }),
    capacity_used: Type.Optional(Type.Number({ minimum: 0, maximum: 1 })),
    load_avg: Type.Optional(Type.Number({ minimum: 0 })),
  },
  { additionalProperties: false },
);
export type OctoNodeTelemetryPush = Static<typeof OctoNodeTelemetryPushSchema>;

// octo.anomaly — reconciliation anomalies and unexpected conditions
// surfaced by the Node Agent's SessionReconciler or by adapters.
// Severity determines how the Head responds (info -> log only;
// warning -> operator notification; error -> quarantine affected
// arms; critical -> page operator).
export const OctoAnomalyPushSchema = Type.Object(
  {
    kind: AnomalyKindSchema,
    severity: AnomalySeveritySchema,
    description: NonEmptyString,
    node_id: Type.Optional(NonEmptyString),
    affected_entities: Type.Optional(Type.Array(EntityRefSchema)),
    ts: NonEmptyString,
  },
  { additionalProperties: false },
);
export type OctoAnomalyPush = Static<typeof OctoAnomalyPushSchema>;

// ══════════════════════════════════════════════════════════════════════════
// Push event registry
//
// Canonical map of push event name to TypeBox schema. Used by the
// Gateway WS handler (M1-14) to route pushes from Node Agents, and by
// tests to sweep over all push events. Adding a new push event here
// makes it visible to both dispatch and tests in one step.
// ══════════════════════════════════════════════════════════════════════════

export const OCTO_PUSH_EVENT_REGISTRY = {
  "octo.arm.state": OctoArmStatePushSchema,
  "octo.arm.output": OctoArmOutputPushSchema,
  "octo.arm.checkpoint": OctoArmCheckpointPushSchema,
  "octo.lease.renew": OctoLeaseRenewPushSchema,
  "octo.node.telemetry": OctoNodeTelemetryPushSchema,
  "octo.anomaly": OctoAnomalyPushSchema,
} as const;

export type OctoPushEventName = keyof typeof OCTO_PUSH_EVENT_REGISTRY;

export const OCTO_PUSH_EVENT_NAMES: readonly OctoPushEventName[] = Object.keys(
  OCTO_PUSH_EVENT_REGISTRY,
) as readonly OctoPushEventName[];
