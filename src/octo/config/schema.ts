// Octopus Orchestrator — `octo:` config block schema (M0-06)
//
// TypeBox schema for the `octo:` block that appears in
// ~/.openclaw/openclaw.json. The full block shape and defaults are
// defined in docs/octopus-orchestrator/CONFIG.md (the binding spec);
// this file is the enforceable schema that the Gateway startup path
// (M0-11 loader) validates against.
//
// Conventions (per top-of-M0 schema conventions block in TASKS.md):
//   - strict mode everywhere: every Type.Object uses
//     `{ additionalProperties: false }` so unknown keys at any nesting
//     level cause loader rejection with a clear error (CONFIG.md
//     §Validation: "No silent fallback to defaults on invalid keys")
//   - NonEmptyString reuse for all string-shaped identifier fields
//   - reuse existing wire/schema primitives where semantically
//     identical (BackoffStrategy, FailureClassification,
//     MissionBudget, MissionExecutionMode) rather than re-declaring
//   - DEFAULT_OCTO_CONFIG is exported as a const object that itself
//     round-trips through the schema (verified by tests). The loader
//     (M0-11) will deep-merge user-provided values over these
//     defaults.
//   - TypeBox `default` is informational only; real default
//     propagation lives in the loader, not the schema.
//
// Cross-references:
//   - CONFIG.md §Top-level schema (full block with defaults)
//   - CONFIG.md §Validation (strict-error policy)
//   - LLD.md §Lease Algorithm, §Scheduler Algorithm, §Backpressure,
//     §Retry and Backoff, §Cost Accounting
//   - DECISIONS.md OCTO-DEC-010 (storage paths), OCTO-DEC-007 (lease
//     windows), OCTO-DEC-039 (research-driven execution classifier)

import { Type, type Static } from "@sinclair/typebox";
import { NonEmptyString } from "../wire/primitives.ts";
import {
  BackoffStrategySchema,
  FailureClassificationSchema,
  MissionBudgetSchema,
  MissionExecutionModeSchema,
} from "../wire/schema.ts";

// ══════════════════════════════════════════════════════════════════════════
// Storage — on-disk locations (all relative to OPENCLAW_STATE_DIR or
// ~/.openclaw per OCTO-DEC-010)
// ══════════════════════════════════════════════════════════════════════════

export const OctoStorageConfigSchema = Type.Object(
  {
    registryPath: NonEmptyString,
    eventsPath: NonEmptyString,
    eventsArchivePath: NonEmptyString,
    artifactsPath: NonEmptyString,
    // per-node sidecars land under <nodeStateRoot>/node-<nodeId>/
    nodeStateRoot: NonEmptyString,
  },
  { additionalProperties: false },
);
export type OctoStorageConfig = Static<typeof OctoStorageConfigSchema>;

// ══════════════════════════════════════════════════════════════════════════
// Events — event log retention, rate limiting, and schema versioning
// ══════════════════════════════════════════════════════════════════════════

export const OctoEventsConfigSchema = Type.Object(
  {
    // null = keep indefinitely; number = days before archive+prune
    retentionDays: Type.Union([Type.Null(), Type.Integer({ minimum: 1 })]),
    // events/sec/arm ceiling before the agent drops+emits an anomaly
    ingestRateLimit: Type.Integer({ minimum: 1 }),
    // OCTO-DEC-018 schema versioning — bumped on breaking payload
    // changes; additive event types do not bump this.
    schemaVersion: Type.Integer({ minimum: 1 }),
  },
  { additionalProperties: false },
);
export type OctoEventsConfig = Static<typeof OctoEventsConfigSchema>;

// ══════════════════════════════════════════════════════════════════════════
// Lease model — see LLD §Lease Algorithm, OCTO-DEC-007
//
// Lease windows are split by grip side-effecting classification: non
// side-effecting grips get a shorter grace window (they can be retried
// safely), side-effecting grips get a longer one (to reduce the risk
// of duplicate effects during scheduler-side hand-offs).
// ══════════════════════════════════════════════════════════════════════════

export const OctoLeaseConfigSchema = Type.Object(
  {
    renewIntervalS: Type.Integer({ minimum: 1 }),
    ttlS: Type.Integer({ minimum: 1 }),
    graceS: Type.Integer({ minimum: 0 }),
    sideEffectingGraceS: Type.Integer({ minimum: 0 }),
  },
  { additionalProperties: false },
);
export type OctoLeaseConfig = Static<typeof OctoLeaseConfigSchema>;

// ══════════════════════════════════════════════════════════════════════════
// Progress watchdog — see LLD §Forward-Progress Heartbeat
//
// `stallThresholdS` seconds without a progress tick flips the arm to
// blocked. `autoTerminateAfterS: null` means only an operator can
// resolve a blocked arm (the conservative default for M0/M1).
// ══════════════════════════════════════════════════════════════════════════

export const OctoProgressConfigSchema = Type.Object(
  {
    stallThresholdS: Type.Integer({ minimum: 1 }),
    autoTerminateAfterS: Type.Union([Type.Null(), Type.Integer({ minimum: 1 })]),
  },
  { additionalProperties: false },
);
export type OctoProgressConfig = Static<typeof OctoProgressConfigSchema>;

// ══════════════════════════════════════════════════════════════════════════
// Scheduler — see LLD §Scheduler Algorithm
//
// Weights are exposed so operators can tune the scheduler's trade-offs
// without code changes. All weights are non-negative; their relative
// magnitudes determine the scheduler's preference shape.
// ══════════════════════════════════════════════════════════════════════════

export const OctoSchedulerWeightsSchema = Type.Object(
  {
    stickiness: Type.Number({ minimum: 0 }),
    locality: Type.Number({ minimum: 0 }),
    preferredMatch: Type.Number({ minimum: 0 }),
    loadBalance: Type.Number({ minimum: 0 }),
    recentFailurePenalty: Type.Number({ minimum: 0 }),
    crossAgentIdPenalty: Type.Number({ minimum: 0 }),
  },
  { additionalProperties: false },
);
export type OctoSchedulerWeights = Static<typeof OctoSchedulerWeightsSchema>;

export const OctoSchedulerConfigSchema = Type.Object(
  {
    weights: OctoSchedulerWeightsSchema,
    // Global default for spread placement. Per-mission override
    // remains allowed on MissionSpec.
    defaultSpread: Type.Boolean(),
  },
  { additionalProperties: false },
);
export type OctoSchedulerConfig = Static<typeof OctoSchedulerConfigSchema>;

// ══════════════════════════════════════════════════════════════════════════
// Quarantine — restart/failure ceilings before an arm is pulled out of
// the scheduling pool
// ══════════════════════════════════════════════════════════════════════════

export const OctoQuarantineConfigSchema = Type.Object(
  {
    maxRestarts: Type.Integer({ minimum: 0 }),
    nodeFailureWindow: Type.Integer({ minimum: 1 }),
    nodeFailureWindowS: Type.Integer({ minimum: 1 }),
  },
  { additionalProperties: false },
);
export type OctoQuarantineConfig = Static<typeof OctoQuarantineConfigSchema>;

// ══════════════════════════════════════════════════════════════════════════
// Arm resource ceilings — in-memory ring, rolling stdout files, idle
// timeout, checkpoint cadence. See LLD §Backpressure.
// ══════════════════════════════════════════════════════════════════════════

export const OctoArmConfigSchema = Type.Object(
  {
    outputBufferBytes: Type.Integer({ minimum: 1 }),
    stdoutRolloverBytes: Type.Integer({ minimum: 1 }),
    stdoutRolloverKeep: Type.Integer({ minimum: 1 }),
    idleTimeoutS: Type.Integer({ minimum: 1 }),
    checkpointIntervalS: Type.Integer({ minimum: 1 }),
  },
  { additionalProperties: false },
);
export type OctoArmConfig = Static<typeof OctoArmConfigSchema>;

// ══════════════════════════════════════════════════════════════════════════
// Retry policy default — used for grips that don't supply their own
// RetryPolicy on GripSpec. Reuses BackoffStrategy + FailureClassification
// enums from wire/schema.ts so the config block and wire schemas agree
// on the domain vocabulary.
//
// Note: the field names here are camelCase (config convention) while
// the wire schema's RetryPolicySchema uses snake_case (wire
// convention). This is intentional — config is human-edited JSON5,
// wire contracts are machine messages. The loader is responsible for
// translating the camelCase block into the snake_case runtime default
// that GripSpec consumption references.
// ══════════════════════════════════════════════════════════════════════════

export const OctoRetryPolicyDefaultSchema = Type.Object(
  {
    maxAttempts: Type.Integer({ minimum: 1 }),
    backoff: BackoffStrategySchema,
    initialDelayS: Type.Number({ minimum: 0 }),
    maxDelayS: Type.Number({ minimum: 0 }),
    multiplier: Type.Number({ minimum: 1 }),
    retryOn: Type.Array(FailureClassificationSchema),
    abandonOn: Type.Array(FailureClassificationSchema),
  },
  { additionalProperties: false },
);
export type OctoRetryPolicyDefault = Static<typeof OctoRetryPolicyDefaultSchema>;

// ══════════════════════════════════════════════════════════════════════════
// Cost accounting — see LLD §Cost Accounting
//
// `missionBudgetDefault` reuses MissionBudgetSchema so a null/object
// union here stays in lockstep with the mission-level budget shape.
// `ptyHourlyRateProxyUsd` is an optional PTY-arm cost proxy (PTY
// adapters don't emit CostMetadata, so this is the only way to
// attribute PTY runtime to a budget).
// `modelRateTable` names a rate table file in rate-tables/; the
// loader resolves the path.
// ══════════════════════════════════════════════════════════════════════════

export const OctoCostConfigSchema = Type.Object(
  {
    trackTokens: Type.Boolean(),
    missionBudgetDefault: Type.Union([Type.Null(), MissionBudgetSchema]),
    ptyHourlyRateProxyUsd: Type.Union([Type.Null(), Type.Number({ minimum: 0 })]),
    modelRateTable: NonEmptyString,
  },
  { additionalProperties: false },
);
export type OctoCostConfig = Static<typeof OctoCostConfigSchema>;

// ══════════════════════════════════════════════════════════════════════════
// Operator authorization — loopback autowriter and side-effect
// gating. Device-token `octo.writer` capability is the production
// authorization surface (OCTO-DEC-029 supersession of the tools.elevated
// misuse). These config fields live here, not in the core auth config,
// so operators can tune octopus authorization independently.
// ══════════════════════════════════════════════════════════════════════════

export const OctoAuthConfigSchema = Type.Object(
  {
    loopbackAutoWriter: Type.Boolean(),
    requireWriterForSideEffects: Type.Boolean(),
  },
  { additionalProperties: false },
);
export type OctoAuthConfig = Static<typeof OctoAuthConfigSchema>;

// ══════════════════════════════════════════════════════════════════════════
// Policy — scheduler/policy/sandbox inheritance. `enforcementActive`
// flips on in Milestone 5; before then the policy layer logs decisions
// but does not block. `defaultProfileRef: null` means "use the inherited
// OpenClaw tools.exec profile without octopus-specific overlay".
// ══════════════════════════════════════════════════════════════════════════

export const OctoPolicyConfigSchema = Type.Object(
  {
    enforcementActive: Type.Boolean(),
    defaultProfileRef: Type.Union([Type.Null(), NonEmptyString]),
  },
  { additionalProperties: false },
);
export type OctoPolicyConfig = Static<typeof OctoPolicyConfigSchema>;

// ══════════════════════════════════════════════════════════════════════════
// Classifier — research-driven execution hints (OCTO-DEC-039)
//
// Hints consumed by the agent-side classifier before mission creation.
// NOT read by the Head — the Head only stores and validates
// MissionSpec.execution_mode on the submitted mission. Operators tune
// these to shift classifier behavior without code changes.
//
// `defaultMode` reuses MissionExecutionModeSchema so the enum stays
// singly-sourced. `hints` is a free-form string map (classifier reads
// it opportunistically).
// ══════════════════════════════════════════════════════════════════════════

export const OctoClassifierConfigSchema = Type.Object(
  {
    defaultMode: MissionExecutionModeSchema,
    researchFirstTaskClasses: Type.Array(NonEmptyString),
    directExecuteTaskClasses: Type.Array(NonEmptyString),
    hints: Type.Record(Type.String(), Type.String()),
  },
  { additionalProperties: false },
);
export type OctoClassifierConfig = Static<typeof OctoClassifierConfigSchema>;

// ══════════════════════════════════════════════════════════════════════════
// Habitat — per-node override block. Each habitat is indexed by
// nodeId. Fields are optional so operators can override selectively.
// `labels` is a free-form string->string map for scheduler locality
// matching.
// ══════════════════════════════════════════════════════════════════════════

export const OctoHabitatConfigSchema = Type.Object(
  {
    maxArms: Type.Optional(Type.Integer({ minimum: 0 })),
    cpuWeightBudget: Type.Optional(Type.Number({ minimum: 0 })),
    labels: Type.Optional(Type.Record(Type.String(), Type.String())),
  },
  { additionalProperties: false },
);
export type OctoHabitatConfig = Static<typeof OctoHabitatConfigSchema>;

// ══════════════════════════════════════════════════════════════════════════
// Top-level octo: block
//
// All nested objects are REQUIRED at the schema layer — the loader
// (M0-11) applies DEFAULT_OCTO_CONFIG via deep-merge so user blocks
// can omit any subset. The schema validates the SHAPE of the merged
// result, not the user input directly. This keeps the schema crisp
// (no nested Type.Optional blizzard) while still letting users write
// `{ enabled: true }` and have it Just Work.
//
// `enabled: true` is the default after M2 exit (was false through
// Milestone 1; flipped per CONFIG.md §Feature flag).
// ══════════════════════════════════════════════════════════════════════════

export const OctoConfigSchema = Type.Object(
  {
    enabled: Type.Boolean(),
    storage: OctoStorageConfigSchema,
    events: OctoEventsConfigSchema,
    lease: OctoLeaseConfigSchema,
    progress: OctoProgressConfigSchema,
    scheduler: OctoSchedulerConfigSchema,
    quarantine: OctoQuarantineConfigSchema,
    arm: OctoArmConfigSchema,
    retryPolicyDefault: OctoRetryPolicyDefaultSchema,
    cost: OctoCostConfigSchema,
    auth: OctoAuthConfigSchema,
    policy: OctoPolicyConfigSchema,
    classifier: OctoClassifierConfigSchema,
    // habitats is indexed by nodeId (free-form string)
    habitats: Type.Record(Type.String(), OctoHabitatConfigSchema),
  },
  { additionalProperties: false },
);
export type OctoConfig = Static<typeof OctoConfigSchema>;

// ══════════════════════════════════════════════════════════════════════════
// DEFAULT_OCTO_CONFIG
//
// Exported const that matches CONFIG.md §Top-level schema exactly. The
// M0-11 loader deep-merges user-provided values over this. Tests
// verify this const itself validates against OctoConfigSchema — this
// is the round-trip guarantee that catches drift between CONFIG.md
// documentation and the enforceable schema.
//
// When CONFIG.md changes, update this const AND the schema in lockstep
// and re-run the tests.
// ══════════════════════════════════════════════════════════════════════════

export const DEFAULT_OCTO_CONFIG: OctoConfig = {
  enabled: true,
  storage: {
    registryPath: "octo/registry.sqlite",
    eventsPath: "octo/events.jsonl",
    eventsArchivePath: "octo/events-archive/",
    artifactsPath: "octo/artifacts/",
    nodeStateRoot: "octo/",
  },
  events: {
    retentionDays: null,
    ingestRateLimit: 200,
    schemaVersion: 1,
  },
  lease: {
    renewIntervalS: 10,
    ttlS: 30,
    graceS: 30,
    sideEffectingGraceS: 60,
  },
  progress: {
    stallThresholdS: 300,
    autoTerminateAfterS: null,
  },
  scheduler: {
    weights: {
      stickiness: 3.0,
      locality: 2.0,
      preferredMatch: 1.5,
      loadBalance: 1.0,
      recentFailurePenalty: 2.0,
      crossAgentIdPenalty: 1.0,
    },
    defaultSpread: false,
  },
  quarantine: {
    maxRestarts: 3,
    nodeFailureWindow: 10,
    nodeFailureWindowS: 600,
  },
  arm: {
    outputBufferBytes: 2097152,
    stdoutRolloverBytes: 67108864,
    stdoutRolloverKeep: 4,
    idleTimeoutS: 900,
    checkpointIntervalS: 60,
  },
  retryPolicyDefault: {
    maxAttempts: 3,
    backoff: "exponential",
    initialDelayS: 5,
    maxDelayS: 300,
    multiplier: 2.0,
    retryOn: ["transient", "timeout", "adapter_error"],
    abandonOn: ["policy_denied", "invalid_spec", "unrecoverable"],
  },
  cost: {
    trackTokens: true,
    missionBudgetDefault: null,
    ptyHourlyRateProxyUsd: null,
    modelRateTable: "default",
  },
  auth: {
    loopbackAutoWriter: true,
    requireWriterForSideEffects: true,
  },
  policy: {
    enforcementActive: true,
    defaultProfileRef: null,
  },
  classifier: {
    defaultMode: "direct_execute",
    researchFirstTaskClasses: [
      "architecture",
      "systems_design",
      "performance_optimization",
      "unfamiliar_codebase",
      "unfamiliar_domain",
      "build_vs_buy",
      "protocol_integration",
      "prior_art_sensitive",
    ],
    directExecuteTaskClasses: [
      "small_local_edit",
      "obvious_bug_fix",
      "routine_refactor",
      "tightly_scoped_impl",
      "low_risk_maintenance",
    ],
    hints: {},
  },
  habitats: {},
};
