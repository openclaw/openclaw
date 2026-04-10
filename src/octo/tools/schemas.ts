// Octopus Orchestrator — agent tool parameter schemas (M0-08)
//
// TypeBox parameter schemas for the 16 Octopus agent tools exposed to
// natural-language agents through the OpenClaw tool registry. See:
//   - docs/octopus-orchestrator/INTEGRATION.md §1 Agent tool surface
//   - docs/octopus-orchestrator/LLD.md §Agent tool surface
//   - docs/octopus-orchestrator/DECISIONS.md OCTO-DEC-028 (tool surface
//     rationale — read-only vs writer partition, 8+8=16 total)
//   - docs/octopus-orchestrator/DECISIONS.md OCTO-DEC-039 (mission
//     execution_mode classifier output on octo_mission_create)
//
// DRY / reuse discipline
// ----------------------
// Tool parameters are thin wrappers over the already-defined ArmSpec,
// GripSpec, and MissionSpec TypeBox schemas from `../wire/schema.ts` and
// the `octo.*` Gateway WS method request schemas in `../wire/methods.ts`.
// Agents see the same schemas operators see. One source of truth.
//
// When a tool has a direct correspondence with a wire method (e.g.
// `octo_arm_spawn` ≈ `OctoArmSpawnRequest`), the parameter shape matches
// the wire request shape — we do NOT redeclare ArmSpec/GripSpec/MissionSpec
// fields here.
//
// Idempotency discipline
// ----------------------
// Every writer tool requires `idempotency_key: NonEmptyString` as a
// required parameter (per INTEGRATION.md §1 and DECISIONS.md OCTO-DEC-028).
// Read-only tools must NOT require it. The registry partition below and
// the test sweep in `schemas.test.ts` enforce this.
//
// Strict mode
// -----------
// Every `Type.Object` uses `{ additionalProperties: false }`. Unknown
// fields are rejected at the tool boundary — this is the agent-facing
// contract and must never silently accept typos.
//
// TODO (M1-14): when the Gateway tool registry handler lands, wire this
// registry into agent tool registration and add per-tool validate<Name>
// cross-check functions where business rules exceed TypeBox (e.g. the
// mission_create template XOR rule handled by validateOctoMissionCreateParams
// below).

import { Type, type Static, type TSchema } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { ArmIdSchema, NodeIdSchema, OctoArmSendInputKindSchema } from "../wire/methods.ts";
import { NonEmptyString } from "../wire/primitives.ts";
import { ArmSpecSchema, MissionSpecSchema, MissionExecutionModeSchema } from "../wire/schema.ts";

// ──────────────────────────────────────────────────────────────────────────
// Shared optional primitives for list/filter tools
//
// Kept local (not promoted to primitives.ts) because they are tool-surface
// pagination/filter conventions, not wire primitives. If the Gateway WS
// method schemas grow matching list endpoints, these can be lifted.
// ──────────────────────────────────────────────────────────────────────────

const LimitSchema = Type.Integer({ minimum: 1, maximum: 1000 });
const CursorSchema = NonEmptyString;
const LabelsSchema = Type.Record(Type.String(), Type.String());

// ══════════════════════════════════════════════════════════════════════════
// Read-only tools (8)
// ══════════════════════════════════════════════════════════════════════════

// ──────────────────────────────────────────────────────────────────────────
// octo_status — wraps octo.status
// Snapshot of active arms, queued grips, healthy nodes, mission count.
// All filters are optional; the empty object `{}` is a valid call.
// ──────────────────────────────────────────────────────────────────────────

export const OctoStatusParamsSchema = Type.Object(
  {
    mission_id: Type.Optional(NonEmptyString),
    node_id: Type.Optional(NodeIdSchema),
  },
  { additionalProperties: false },
);
export type OctoStatusParams = Static<typeof OctoStatusParamsSchema>;

// ──────────────────────────────────────────────────────────────────────────
// octo_mission_list — wraps octo.mission.list
// List missions visible to the caller's agent id, with optional filters.
// ──────────────────────────────────────────────────────────────────────────

export const OctoMissionListParamsSchema = Type.Object(
  {
    agent_id: Type.Optional(NonEmptyString),
    status: Type.Optional(NonEmptyString),
    execution_mode: Type.Optional(MissionExecutionModeSchema),
    labels: Type.Optional(LabelsSchema),
    limit: Type.Optional(LimitSchema),
    cursor: Type.Optional(CursorSchema),
  },
  { additionalProperties: false },
);
export type OctoMissionListParams = Static<typeof OctoMissionListParamsSchema>;

// ──────────────────────────────────────────────────────────────────────────
// octo_mission_show — wraps octo.mission.show
// Mission detail including grip graph and current budget state.
// ──────────────────────────────────────────────────────────────────────────

export const OctoMissionShowParamsSchema = Type.Object(
  {
    mission_id: NonEmptyString,
  },
  { additionalProperties: false },
);
export type OctoMissionShowParams = Static<typeof OctoMissionShowParamsSchema>;

// ──────────────────────────────────────────────────────────────────────────
// octo_arm_list — wraps octo.arm.list
// Filter by mission, node, state, labels.
// ──────────────────────────────────────────────────────────────────────────

export const OctoArmListParamsSchema = Type.Object(
  {
    mission_id: Type.Optional(NonEmptyString),
    node_id: Type.Optional(NodeIdSchema),
    state: Type.Optional(NonEmptyString),
    labels: Type.Optional(LabelsSchema),
    limit: Type.Optional(LimitSchema),
    cursor: Type.Optional(CursorSchema),
  },
  { additionalProperties: false },
);
export type OctoArmListParams = Static<typeof OctoArmListParamsSchema>;

// ──────────────────────────────────────────────────────────────────────────
// octo_arm_show — wraps octo.arm.show
// Arm detail including current grip, lease, checkpoint, recent output.
// ──────────────────────────────────────────────────────────────────────────

export const OctoArmShowParamsSchema = Type.Object(
  {
    arm_id: ArmIdSchema,
  },
  { additionalProperties: false },
);
export type OctoArmShowParams = Static<typeof OctoArmShowParamsSchema>;

// ──────────────────────────────────────────────────────────────────────────
// octo_grip_list — wraps octo.grip.list
// Grip detail with dependencies and status.
// ──────────────────────────────────────────────────────────────────────────

export const OctoGripListParamsSchema = Type.Object(
  {
    mission_id: Type.Optional(NonEmptyString),
    status: Type.Optional(NonEmptyString),
    labels: Type.Optional(LabelsSchema),
    limit: Type.Optional(LimitSchema),
    cursor: Type.Optional(CursorSchema),
  },
  { additionalProperties: false },
);
export type OctoGripListParams = Static<typeof OctoGripListParamsSchema>;

// ──────────────────────────────────────────────────────────────────────────
// octo_events_tail — wraps octo.events.tail
// Bounded event tail, filterable by entity.
// ──────────────────────────────────────────────────────────────────────────

export const OctoEventsTailParamsSchema = Type.Object(
  {
    entity_type: Type.Optional(NonEmptyString),
    entity_id: Type.Optional(NonEmptyString),
    since_event_id: Type.Optional(NonEmptyString),
    limit: Type.Optional(LimitSchema),
  },
  { additionalProperties: false },
);
export type OctoEventsTailParams = Static<typeof OctoEventsTailParamsSchema>;

// ──────────────────────────────────────────────────────────────────────────
// octo_claims_list — wraps octo.claims.list
// Current claims with owner and expiry.
// ──────────────────────────────────────────────────────────────────────────

export const OctoClaimsListParamsSchema = Type.Object(
  {
    resource_type: Type.Optional(NonEmptyString),
    resource_key: Type.Optional(NonEmptyString),
    owner_arm_id: Type.Optional(ArmIdSchema),
    mission_id: Type.Optional(NonEmptyString),
    limit: Type.Optional(LimitSchema),
  },
  { additionalProperties: false },
);
export type OctoClaimsListParams = Static<typeof OctoClaimsListParamsSchema>;

// ══════════════════════════════════════════════════════════════════════════
// Writer tools (8)
//
// All writer tools require `idempotency_key: NonEmptyString`. This is
// enforced at the bare schema layer (not via an optional validator) so
// the dispatcher cannot forget it.
// ══════════════════════════════════════════════════════════════════════════

// ──────────────────────────────────────────────────────────────────────────
// octo_mission_create — wraps octo.mission.create
//
// Agents call this with either:
//   - an inline `mission_spec: MissionSpec`, OR
//   - a `template_id: NonEmptyString` plus optional `template_args`.
//
// The XOR rule (exactly one of mission_spec / template_id) cannot be
// expressed in a single TypeBox object schema without a tagged-union
// refactor. We use the M0-01/M0-02/M0-03 pattern: declare both fields
// as optional at the bare schema layer, and enforce the XOR in
// `validateOctoMissionCreateParams` below. Callers that care about
// correctness should use the validator; the bare schema is for tooling
// that needs a single TSchema handle (agent tool registry, JSON schema
// export, etc.).
//
// `execution_mode` is the classifier output per OCTO-DEC-039. The agent
// runs the classifier ahead of mission creation; the Head stores whatever
// mode the agent sets. Absent defaults to `direct_execute`.
// ──────────────────────────────────────────────────────────────────────────

export const OctoMissionCreateParamsSchema = Type.Object(
  {
    idempotency_key: NonEmptyString,
    // XOR: exactly one of mission_spec / template_id must be present.
    // Enforced by validateOctoMissionCreateParams, not by TypeBox alone.
    mission_spec: Type.Optional(MissionSpecSchema),
    template_id: Type.Optional(NonEmptyString),
    template_args: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
    execution_mode: Type.Optional(MissionExecutionModeSchema),
  },
  { additionalProperties: false },
);
export type OctoMissionCreateParams = Static<typeof OctoMissionCreateParamsSchema>;

export type OctoMissionCreateParamsValidationResult =
  | { ok: true; params: OctoMissionCreateParams }
  | { ok: false; errors: readonly string[] };

export function validateOctoMissionCreateParams(
  input: unknown,
): OctoMissionCreateParamsValidationResult {
  if (!Value.Check(OctoMissionCreateParamsSchema, input)) {
    const errs = [...Value.Errors(OctoMissionCreateParamsSchema, input)].map(
      (e) => `${e.path || "<root>"}: ${e.message}`,
    );
    return { ok: false, errors: errs };
  }
  const params = input;
  const hasSpec = params.mission_spec !== undefined;
  const hasTemplate = params.template_id !== undefined;
  if (hasSpec && hasTemplate) {
    return {
      ok: false,
      errors: [
        "octo_mission_create: exactly one of mission_spec or template_id may be provided, not both",
      ],
    };
  }
  if (!hasSpec && !hasTemplate) {
    return {
      ok: false,
      errors: ["octo_mission_create: one of mission_spec or template_id is required"],
    };
  }
  if (!hasTemplate && params.template_args !== undefined) {
    return {
      ok: false,
      errors: ["octo_mission_create: template_args is only valid when template_id is provided"],
    };
  }
  return { ok: true, params };
}

// ──────────────────────────────────────────────────────────────────────────
// octo_mission_pause — wraps octo.mission.pause
// ──────────────────────────────────────────────────────────────────────────

export const OctoMissionPauseParamsSchema = Type.Object(
  {
    idempotency_key: NonEmptyString,
    mission_id: NonEmptyString,
    reason: Type.Optional(NonEmptyString),
  },
  { additionalProperties: false },
);
export type OctoMissionPauseParams = Static<typeof OctoMissionPauseParamsSchema>;

// ──────────────────────────────────────────────────────────────────────────
// octo_mission_resume — wraps octo.mission.resume
// ──────────────────────────────────────────────────────────────────────────

export const OctoMissionResumeParamsSchema = Type.Object(
  {
    idempotency_key: NonEmptyString,
    mission_id: NonEmptyString,
  },
  { additionalProperties: false },
);
export type OctoMissionResumeParams = Static<typeof OctoMissionResumeParamsSchema>;

// ──────────────────────────────────────────────────────────────────────────
// octo_mission_abort — wraps octo.mission.abort
// Abort requires a non-empty reason for the audit log.
// ──────────────────────────────────────────────────────────────────────────

export const OctoMissionAbortParamsSchema = Type.Object(
  {
    idempotency_key: NonEmptyString,
    mission_id: NonEmptyString,
    reason: NonEmptyString,
  },
  { additionalProperties: false },
);
export type OctoMissionAbortParams = Static<typeof OctoMissionAbortParamsSchema>;

// ──────────────────────────────────────────────────────────────────────────
// octo_arm_spawn — wraps octo.arm.spawn
//
// Parameter shape matches OctoArmSpawnRequestSchema from wire/methods.ts:
// `idempotency_key` + `spec: ArmSpecSchema`. We do not redeclare ArmSpec
// fields. Note: ArmSpec itself already carries an inner `idempotency_key`
// (because every spawn is side-effecting at the arm layer) — that is a
// separate concern from the tool-level idempotency_key, which guards the
// agent→Head call itself. Both are required and may hold the same value.
// ──────────────────────────────────────────────────────────────────────────

export const OctoArmSpawnParamsSchema = Type.Object(
  {
    idempotency_key: NonEmptyString,
    spec: ArmSpecSchema,
  },
  { additionalProperties: false },
);
export type OctoArmSpawnParams = Static<typeof OctoArmSpawnParamsSchema>;

// ──────────────────────────────────────────────────────────────────────────
// octo_arm_send — wraps octo.arm.send
//
// Parameter shape matches OctoArmSendRequestSchema: kind + payload. We
// reuse OctoArmSendInputKindSchema rather than redeclaring the literal
// union.
// ──────────────────────────────────────────────────────────────────────────

export const OctoArmSendParamsSchema = Type.Object(
  {
    idempotency_key: NonEmptyString,
    arm_id: ArmIdSchema,
    kind: OctoArmSendInputKindSchema,
    payload: Type.String(),
  },
  { additionalProperties: false },
);
export type OctoArmSendParams = Static<typeof OctoArmSendParamsSchema>;

// ──────────────────────────────────────────────────────────────────────────
// octo_arm_terminate — wraps octo.arm.terminate
// Mirrors OctoArmTerminateRequestSchema; reason is required for audit.
// ──────────────────────────────────────────────────────────────────────────

export const OctoArmTerminateParamsSchema = Type.Object(
  {
    idempotency_key: NonEmptyString,
    arm_id: ArmIdSchema,
    reason: NonEmptyString,
    force: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false },
);
export type OctoArmTerminateParams = Static<typeof OctoArmTerminateParamsSchema>;

// ──────────────────────────────────────────────────────────────────────────
// octo_grip_reassign — wraps octo.grip.reassign
// Move a grip to a different arm/node. At least one target is required
// in practice, but the bare schema allows neither (the handler will
// reject an all-undefined reassign when the M3 handler lands).
// ──────────────────────────────────────────────────────────────────────────

export const OctoGripReassignParamsSchema = Type.Object(
  {
    idempotency_key: NonEmptyString,
    grip_id: NonEmptyString,
    target_arm_id: Type.Optional(ArmIdSchema),
    target_node_id: Type.Optional(NodeIdSchema),
    reason: Type.Optional(NonEmptyString),
  },
  { additionalProperties: false },
);
export type OctoGripReassignParams = Static<typeof OctoGripReassignParamsSchema>;

// ══════════════════════════════════════════════════════════════════════════
// Tool registry — canonical list of every octo_* agent tool
//
// Maps the tool name strings (as agents see them) to the params schema
// and the read-only / writer partition. Consumed by:
//   - tests in schemas.test.ts (iterate 16/16)
//   - M1-14 Gateway agent tool registration (registers these with the
//     OpenClaw tool registry so natural-language agents can call them)
//
// Partition invariants enforced by tests:
//   - exactly 16 tools
//   - exactly 8 read-only + 8 writer
//   - every writer tool's params schema requires idempotency_key
//   - no read-only tool's minimal valid call carries idempotency_key
// ══════════════════════════════════════════════════════════════════════════

export type OctoToolKind = "read_only" | "writer";

export interface OctoToolRegistryEntry {
  readonly params: TSchema;
  readonly kind: OctoToolKind;
}

export const OCTO_TOOL_SCHEMA_REGISTRY = {
  // Read-only
  octo_status: { params: OctoStatusParamsSchema, kind: "read_only" },
  octo_mission_list: { params: OctoMissionListParamsSchema, kind: "read_only" },
  octo_mission_show: { params: OctoMissionShowParamsSchema, kind: "read_only" },
  octo_arm_list: { params: OctoArmListParamsSchema, kind: "read_only" },
  octo_arm_show: { params: OctoArmShowParamsSchema, kind: "read_only" },
  octo_grip_list: { params: OctoGripListParamsSchema, kind: "read_only" },
  octo_events_tail: { params: OctoEventsTailParamsSchema, kind: "read_only" },
  octo_claims_list: { params: OctoClaimsListParamsSchema, kind: "read_only" },
  // Writer
  octo_mission_create: { params: OctoMissionCreateParamsSchema, kind: "writer" },
  octo_mission_pause: { params: OctoMissionPauseParamsSchema, kind: "writer" },
  octo_mission_resume: { params: OctoMissionResumeParamsSchema, kind: "writer" },
  octo_mission_abort: { params: OctoMissionAbortParamsSchema, kind: "writer" },
  octo_arm_spawn: { params: OctoArmSpawnParamsSchema, kind: "writer" },
  octo_arm_send: { params: OctoArmSendParamsSchema, kind: "writer" },
  octo_arm_terminate: { params: OctoArmTerminateParamsSchema, kind: "writer" },
  octo_grip_reassign: { params: OctoGripReassignParamsSchema, kind: "writer" },
} as const satisfies Record<string, OctoToolRegistryEntry>;

export type OctoToolName = keyof typeof OCTO_TOOL_SCHEMA_REGISTRY;

export const OCTO_TOOL_NAMES: readonly OctoToolName[] = Object.keys(
  OCTO_TOOL_SCHEMA_REGISTRY,
) as readonly OctoToolName[];

export const OCTO_READ_ONLY_TOOL_NAMES: readonly OctoToolName[] = OCTO_TOOL_NAMES.filter(
  (name) => OCTO_TOOL_SCHEMA_REGISTRY[name].kind === "read_only",
);

export const OCTO_WRITER_TOOL_NAMES: readonly OctoToolName[] = OCTO_TOOL_NAMES.filter(
  (name) => OCTO_TOOL_SCHEMA_REGISTRY[name].kind === "writer",
);
