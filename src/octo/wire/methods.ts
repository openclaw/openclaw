// Octopus Orchestrator — Gateway WS method schemas (M0-04)
//
// TypeBox request/response schemas for the `octo.*` method namespace
// exchanged between the Head and Node Agents over the existing OpenClaw
// Gateway WebSocket transport. See:
//   - docs/octopus-orchestrator/HLD.md §OpenClaw Integration Foundation
//     (Node Agent wire contract + `octo.*` namespace)
//   - docs/octopus-orchestrator/LLD.md §Head ↔ Node Agent Wire Contract
//   - docs/octopus-orchestrator/DECISIONS.md OCTO-DEC-003 (namespace)
//   - docs/octopus-orchestrator/DECISIONS.md OCTO-DEC-017 (spec validation)
//
// Methods (Head → Node Agent):
//   octo.arm.spawn          — launch an arm under an ArmSpec
//   octo.arm.attach         — open operator attach stream
//   octo.arm.send           — deliver input to a live arm
//   octo.arm.checkpoint     — force checkpoint flush
//   octo.arm.terminate      — terminate an arm with reason
//   octo.arm.health         — current health snapshot
//   octo.node.capabilities  — capability manifest
//   octo.node.reconcile     — force session reconciliation pass
//
// Idempotency: side-effecting methods (spawn, send, checkpoint, terminate,
// reconcile) require `idempotency_key: NonEmptyString` in their params.
// Read-only methods (attach, health, capabilities) do not.
//
// ArmSpec reuse: `octo.arm.spawn` request params wrap the full ArmSpec
// from schema.ts — the schema is the single source of truth for what a
// spawnable arm looks like.
//
// TODO (M1-14): when the handler lands, add `validateOctoArmSpawnRequest`
// and similar helpers that combine the TypeBox method check with the
// spec-level cross-check (validateArmSpec for spawn, etc.).

import { Type, type Static } from "@sinclair/typebox";
import { NonEmptyString } from "./primitives.ts";
import { ArmSpecSchema } from "./schema.ts";

// ──────────────────────────────────────────────────────────────────────────
// Shared primitive types used across multiple method schemas
// ──────────────────────────────────────────────────────────────────────────

// Stable arm identifier — opaque string assigned by the Head at spawn time
export const ArmIdSchema = NonEmptyString;

// Stable node identifier — opaque string issued during pairing
export const NodeIdSchema = NonEmptyString;

// Runtime session handle returned by adapters (subagent session key,
// tmux session name, ACP session id, subprocess pid indicator)
export const SessionRefSchema = Type.Object(
  {
    structured_session_id: Type.Optional(NonEmptyString),
    tmux_session_name: Type.Optional(NonEmptyString),
    pty_pid: Type.Optional(Type.Integer({ minimum: 1 })),
    cwd: NonEmptyString,
    worktree_path: Type.Optional(NonEmptyString),
    attach_command: Type.Optional(NonEmptyString),
    recovery_metadata: Type.Optional(Type.Record(Type.String(), Type.String())),
    /** Adapter-assigned session identity (pid, session key, etc.). */
    session_id: Type.Optional(NonEmptyString),
  },
  { additionalProperties: false },
);
export type SessionRef = Static<typeof SessionRefSchema>;

// Normalized health snapshot returned by octo.arm.health and
// indirectly by several other methods
export const HealthStatusSchema = Type.Union([
  Type.Literal("starting"),
  Type.Literal("active"),
  Type.Literal("idle"),
  Type.Literal("blocked"),
  Type.Literal("unresponsive"),
  Type.Literal("failed"),
  Type.Literal("quarantined"),
  Type.Literal("terminated"),
]);
export type HealthStatus = Static<typeof HealthStatusSchema>;

export const HealthSnapshotSchema = Type.Object(
  {
    arm_id: ArmIdSchema,
    status: HealthStatusSchema,
    last_progress_tick_ts: Type.Optional(Type.Integer({ minimum: 0 })),
    last_lease_renewal_ts: Type.Optional(Type.Integer({ minimum: 0 })),
    restart_count: Type.Integer({ minimum: 0 }),
    notes: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);
export type HealthSnapshot = Static<typeof HealthSnapshotSchema>;

// Capability manifest entry for `octo.node.capabilities`
export const NodeCapacitySchema = Type.Object(
  {
    max_arms: Type.Integer({ minimum: 0 }),
    current_arms: Type.Integer({ minimum: 0 }),
    cpu_weight_budget: Type.Optional(Type.Number({ minimum: 0 })),
  },
  { additionalProperties: false },
);

export const NodeCapabilitiesSchema = Type.Object(
  {
    node_id: NodeIdSchema,
    agent_id: NonEmptyString,
    capabilities: Type.Array(NonEmptyString),
    capacity: NodeCapacitySchema,
  },
  { additionalProperties: false },
);
export type NodeCapabilities = Static<typeof NodeCapabilitiesSchema>;

// ──────────────────────────────────────────────────────────────────────────
// octo.arm.spawn
// ──────────────────────────────────────────────────────────────────────────

export const OctoArmSpawnRequestSchema = Type.Object(
  {
    idempotency_key: NonEmptyString,
    spec: ArmSpecSchema,
  },
  { additionalProperties: false },
);
export type OctoArmSpawnRequest = Static<typeof OctoArmSpawnRequestSchema>;

export const OctoArmSpawnResponseSchema = Type.Object(
  {
    arm_id: ArmIdSchema,
    session_ref: SessionRefSchema,
  },
  { additionalProperties: false },
);
export type OctoArmSpawnResponse = Static<typeof OctoArmSpawnResponseSchema>;

// ──────────────────────────────────────────────────────────────────────────
// octo.arm.attach
//
// Read-only stream handle. The actual data flows through push events
// (octo.arm.output) filtered by arm_id; the attach request itself is
// just a subscription registration.
// ──────────────────────────────────────────────────────────────────────────

export const OctoArmAttachRequestSchema = Type.Object(
  {
    arm_id: ArmIdSchema,
    include_history_bytes: Type.Optional(Type.Integer({ minimum: 0 })),
  },
  { additionalProperties: false },
);
export type OctoArmAttachRequest = Static<typeof OctoArmAttachRequestSchema>;

export const OctoArmAttachResponseSchema = Type.Object(
  {
    arm_id: ArmIdSchema,
    attach_command: Type.Optional(NonEmptyString),
    session_ref: SessionRefSchema,
  },
  { additionalProperties: false },
);
export type OctoArmAttachResponse = Static<typeof OctoArmAttachResponseSchema>;

// ──────────────────────────────────────────────────────────────────────────
// octo.arm.send
// ──────────────────────────────────────────────────────────────────────────

export const OctoArmSendInputKindSchema = Type.Union([
  Type.Literal("message"),
  Type.Literal("keys"),
  Type.Literal("stdin"),
]);
export type OctoArmSendInputKind = Static<typeof OctoArmSendInputKindSchema>;

export const OctoArmSendRequestSchema = Type.Object(
  {
    idempotency_key: NonEmptyString,
    arm_id: ArmIdSchema,
    kind: OctoArmSendInputKindSchema,
    payload: Type.String(),
  },
  { additionalProperties: false },
);
export type OctoArmSendRequest = Static<typeof OctoArmSendRequestSchema>;

export const OctoArmSendResponseSchema = Type.Object(
  {
    arm_id: ArmIdSchema,
    delivered: Type.Boolean(),
    bytes_written: Type.Optional(Type.Integer({ minimum: 0 })),
  },
  { additionalProperties: false },
);
export type OctoArmSendResponse = Static<typeof OctoArmSendResponseSchema>;

// ──────────────────────────────────────────────────────────────────────────
// octo.arm.checkpoint
// ──────────────────────────────────────────────────────────────────────────

export const OctoArmCheckpointRequestSchema = Type.Object(
  {
    idempotency_key: NonEmptyString,
    arm_id: ArmIdSchema,
  },
  { additionalProperties: false },
);
export type OctoArmCheckpointRequest = Static<typeof OctoArmCheckpointRequestSchema>;

export const OctoArmCheckpointResponseSchema = Type.Object(
  {
    arm_id: ArmIdSchema,
    checkpoint_ref: NonEmptyString,
    ts: Type.Integer({ minimum: 0 }),
  },
  { additionalProperties: false },
);
export type OctoArmCheckpointResponse = Static<typeof OctoArmCheckpointResponseSchema>;

// ──────────────────────────────────────────────────────────────────────────
// octo.arm.terminate
// ──────────────────────────────────────────────────────────────────────────

export const OctoArmTerminateRequestSchema = Type.Object(
  {
    idempotency_key: NonEmptyString,
    arm_id: ArmIdSchema,
    reason: NonEmptyString,
    force: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false },
);
export type OctoArmTerminateRequest = Static<typeof OctoArmTerminateRequestSchema>;

export const OctoArmTerminateResponseSchema = Type.Object(
  {
    arm_id: ArmIdSchema,
    terminated: Type.Boolean(),
    final_status: HealthStatusSchema,
  },
  { additionalProperties: false },
);
export type OctoArmTerminateResponse = Static<typeof OctoArmTerminateResponseSchema>;

// ──────────────────────────────────────────────────────────────────────────
// octo.arm.health
// ──────────────────────────────────────────────────────────────────────────

export const OctoArmHealthRequestSchema = Type.Object(
  {
    arm_id: ArmIdSchema,
  },
  { additionalProperties: false },
);
export type OctoArmHealthRequest = Static<typeof OctoArmHealthRequestSchema>;

export const OctoArmHealthResponseSchema = HealthSnapshotSchema;
export type OctoArmHealthResponse = Static<typeof OctoArmHealthResponseSchema>;

// ──────────────────────────────────────────────────────────────────────────
// octo.node.capabilities
// ──────────────────────────────────────────────────────────────────────────

export const OctoNodeCapabilitiesRequestSchema = Type.Object(
  {
    node_id: Type.Optional(NodeIdSchema),
  },
  { additionalProperties: false },
);
export type OctoNodeCapabilitiesRequest = Static<typeof OctoNodeCapabilitiesRequestSchema>;

export const OctoNodeCapabilitiesResponseSchema = NodeCapabilitiesSchema;
export type OctoNodeCapabilitiesResponse = Static<typeof OctoNodeCapabilitiesResponseSchema>;

// ──────────────────────────────────────────────────────────────────────────
// octo.node.reconcile
// ──────────────────────────────────────────────────────────────────────────

export const OctoNodeReconcileRequestSchema = Type.Object(
  {
    idempotency_key: NonEmptyString,
    node_id: Type.Optional(NodeIdSchema),
    dry_run: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false },
);
export type OctoNodeReconcileRequest = Static<typeof OctoNodeReconcileRequestSchema>;

export const OctoNodeReconcileResponseSchema = Type.Object(
  {
    node_id: NodeIdSchema,
    reconciled_count: Type.Integer({ minimum: 0 }),
    anomaly_count: Type.Integer({ minimum: 0 }),
    ts: Type.Integer({ minimum: 0 }),
  },
  { additionalProperties: false },
);
export type OctoNodeReconcileResponse = Static<typeof OctoNodeReconcileResponseSchema>;

// ──────────────────────────────────────────────────────────────────────────
// Method registry — canonical list of every octo.* method
//
// Maps method name strings to their request/response schema pair plus a
// flag indicating whether the method is side-effecting (and therefore
// requires an idempotency_key). Used by the Gateway handler dispatcher
// and by tests that need to iterate over all methods.
//
// Do not add a method here without adding its request/response schemas
// above. When new methods are added (e.g. octo.mission.* in future
// milestones), extend this table.
// ──────────────────────────────────────────────────────────────────────────

export const OCTO_METHOD_REGISTRY = {
  "octo.arm.spawn": {
    request: OctoArmSpawnRequestSchema,
    response: OctoArmSpawnResponseSchema,
    sideEffecting: true,
  },
  "octo.arm.attach": {
    request: OctoArmAttachRequestSchema,
    response: OctoArmAttachResponseSchema,
    sideEffecting: false,
  },
  "octo.arm.send": {
    request: OctoArmSendRequestSchema,
    response: OctoArmSendResponseSchema,
    sideEffecting: true,
  },
  "octo.arm.checkpoint": {
    request: OctoArmCheckpointRequestSchema,
    response: OctoArmCheckpointResponseSchema,
    sideEffecting: true,
  },
  "octo.arm.terminate": {
    request: OctoArmTerminateRequestSchema,
    response: OctoArmTerminateResponseSchema,
    sideEffecting: true,
  },
  "octo.arm.health": {
    request: OctoArmHealthRequestSchema,
    response: OctoArmHealthResponseSchema,
    sideEffecting: false,
  },
  "octo.node.capabilities": {
    request: OctoNodeCapabilitiesRequestSchema,
    response: OctoNodeCapabilitiesResponseSchema,
    sideEffecting: false,
  },
  "octo.node.reconcile": {
    request: OctoNodeReconcileRequestSchema,
    response: OctoNodeReconcileResponseSchema,
    sideEffecting: true,
  },
} as const;

export type OctoMethodName = keyof typeof OCTO_METHOD_REGISTRY;

export const OCTO_METHOD_NAMES: readonly OctoMethodName[] = Object.keys(
  OCTO_METHOD_REGISTRY,
) as readonly OctoMethodName[];
