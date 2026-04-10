// Octopus Orchestrator — wire schemas
//
// This file defines the TypeBox schemas for the primary spec objects
// exchanged over the Head ↔ Node Agent wire contract: ArmSpec, GripSpec,
// and MissionSpec. See:
//   - docs/octopus-orchestrator/LLD.md §Spawn Specifications
//   - docs/octopus-orchestrator/LLD.md §Retry and Backoff
//   - docs/octopus-orchestrator/DECISIONS.md OCTO-DEC-017 (spec validation)
//   - docs/octopus-orchestrator/DECISIONS.md OCTO-DEC-036 (adapter preference)
//   - docs/octopus-orchestrator/DECISIONS.md OCTO-DEC-037 (cli_exec adapter)
//
// Current state:
//   - M0-01: ArmSpec schema + validateArmSpec (done)
//   - M0-02: GripSpec schema + validateGripSpec (done)
//   - M0-03: MissionSpec schema + validateMissionSpec (this task)

import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { NonEmptyString } from "./primitives.ts";

// ──────────────────────────────────────────────────────────────────────────
// Adapter type enum
//
// Four adapter types, preference-ordered per OCTO-DEC-036:
//   - structured_subagent: OpenClaw's own native subagent runtime, primary
//     for OpenClaw-owned model work under OpenClaw's own API terms
//   - cli_exec:            spawn a CLI tool with its own structured output
//                          mode (e.g. `claude -p --output-format stream-json`);
//                          primary path for external agentic coding tools
//   - pty_tmux:            drive an interactive TUI tool via PTY inside a
//                          tmux session; primary for TUI-only tools and
//                          universal fallback
//   - structured_acp:      ACP harness via acpx; available but opt-in only,
//                          never the default path for external coding tools
//
// Note: house style (see src/agents/schema/typebox.ts) prefers a stringEnum
// helper for provider safety, but M0-01's acceptance criteria explicitly
// calls for `Type.Union` of literal strings so we stay with that here. A
// future task can port to the stringEnum helper if provider anyOf rejection
// becomes a concern in wire contexts.
// ──────────────────────────────────────────────────────────────────────────

export const AdapterTypeSchema = Type.Union([
  Type.Literal("structured_subagent"),
  Type.Literal("cli_exec"),
  Type.Literal("pty_tmux"),
  Type.Literal("structured_acp"),
]);
export type AdapterType = Static<typeof AdapterTypeSchema>;

// ──────────────────────────────────────────────────────────────────────────
// Per-adapter runtime options (discriminated union)
//
// Each adapter has its own shape of runtime options; the ArmSpec carries
// the one that matches its adapter_type. The discriminant is the
// `adapter_type` field on the ArmSpec itself, not inside runtime_options.
// ──────────────────────────────────────────────────────────────────────────

// All runtime_options schemas are strict (additionalProperties: false) so
// unknown fields are rejected. Without this, the SubagentRuntimeOptions
// shape — which has all-optional fields — would match any bag of unknown
// fields, making the union trivially permissive.

export const SubagentRuntimeOptionsSchema = Type.Object(
  {
    model: Type.Optional(Type.String()),
    thinking: Type.Optional(Type.String()),
    runTimeoutSeconds: Type.Optional(Type.Integer({ minimum: 0 })),
    cleanup: Type.Optional(Type.Union([Type.Literal("delete"), Type.Literal("keep")])),
  },
  { additionalProperties: false },
);

export const CliExecRuntimeOptionsSchema = Type.Object(
  {
    command: NonEmptyString,
    args: Type.Optional(Type.Array(Type.String())),
    structuredOutputFormat: Type.Optional(
      Type.Union([
        Type.Literal("stream-json"),
        Type.Literal("json"),
        Type.Literal("ndjson"),
        Type.Literal("none"),
      ]),
    ),
    // OCTO-DEC-038 resolved: initial_input lives exclusively on
    // ArmSpec top-level. All adapters consume it from there. The
    // cli_exec adapter passes it via CLI args or stdin (M2-07 send()),
    // reading from spec.initial_input -- not from runtime_options.
    stdinMode: Type.Optional(
      Type.Union([Type.Literal("open"), Type.Literal("closed"), Type.Literal("prompt")]),
    ),
    runTimeoutSeconds: Type.Optional(Type.Integer({ minimum: 0 })),
    maxStdoutBytes: Type.Optional(Type.Integer({ minimum: 0 })),
  },
  { additionalProperties: false },
);

export const PtyTmuxRuntimeOptionsSchema = Type.Object(
  {
    command: NonEmptyString,
    args: Type.Optional(Type.Array(Type.String())),
    tmuxSessionName: Type.Optional(Type.String()),
    captureCols: Type.Optional(Type.Integer({ minimum: 1 })),
    captureRows: Type.Optional(Type.Integer({ minimum: 1 })),
    idleTimeoutS: Type.Optional(Type.Integer({ minimum: 0 })),
  },
  { additionalProperties: false },
);

export const StructuredAcpRuntimeOptionsSchema = Type.Object(
  {
    acpxHarness: NonEmptyString,
    model: Type.Optional(Type.String()),
    permissions: Type.Optional(Type.String()),
    thread: Type.Optional(Type.Boolean()),
    mode: Type.Optional(Type.Union([Type.Literal("run"), Type.Literal("session")])),
    bindConversation: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false },
);

// The runtime_options union. This is intentionally NOT a properly-tagged
// TypeBox discriminated union — at the schema layer we accept any of the
// four shapes, and a cross-check (validateArmSpec, below) enforces the
// match between adapter_type and the runtime_options shape.
//
// TODO (M1-14): refactor ArmSpecSchema into a proper Type.Union of four
// tagged variants once the octo.arm.spawn handler is implemented and we
// have concrete usage context for the discriminated union shape. The
// refactor was deferred from M0-01 to avoid locking in a design without
// downstream context. Until then, validateArmSpec() provides correctness
// and makes it impossible to submit an ArmSpec with mismatched adapter_type
// and runtime_options.
export const RuntimeOptionsSchema = Type.Union([
  SubagentRuntimeOptionsSchema,
  CliExecRuntimeOptionsSchema,
  PtyTmuxRuntimeOptionsSchema,
  StructuredAcpRuntimeOptionsSchema,
]);

// Lookup table used by validateArmSpec for the cross-check. Keyed by the
// literal adapter_type string; values are the corresponding per-adapter
// runtime_options schemas.
const RuntimeOptionsByAdapter = {
  structured_subagent: SubagentRuntimeOptionsSchema,
  cli_exec: CliExecRuntimeOptionsSchema,
  pty_tmux: PtyTmuxRuntimeOptionsSchema,
  structured_acp: StructuredAcpRuntimeOptionsSchema,
} as const;

// ──────────────────────────────────────────────────────────────────────────
// Resource hints (optional scheduling inputs)
// ──────────────────────────────────────────────────────────────────────────

export const ResourceHintsSchema = Type.Object(
  {
    cpu_weight: Type.Optional(Type.Number({ minimum: 0 })),
    memory_mb_hint: Type.Optional(Type.Integer({ minimum: 0 })),
    expected_runtime_s: Type.Optional(Type.Integer({ minimum: 0 })),
  },
  { additionalProperties: false },
);

// ──────────────────────────────────────────────────────────────────────────
// ArmSpec — the input to octo.arm.spawn
//
// Every field mapped from LLD.md §Spawn Specifications §ArmSpec. Strict
// mode (additionalProperties: false) rejects typos and unknown fields at
// the wire boundary — this is the primary API contract and must not
// silently accept malformed input.
// ──────────────────────────────────────────────────────────────────────────

export const ArmSpecSchema = Type.Object(
  {
    spec_version: Type.Integer({ minimum: 1 }),
    mission_id: NonEmptyString,
    adapter_type: AdapterTypeSchema,
    runtime_name: NonEmptyString,
    agent_id: NonEmptyString,
    desired_habitat: Type.Optional(NonEmptyString),
    desired_capabilities: Type.Optional(Type.Array(NonEmptyString)),
    cwd: NonEmptyString,
    worktree_path: Type.Optional(NonEmptyString),
    env: Type.Optional(Type.Record(Type.String(), Type.String())),
    initial_input: Type.Optional(Type.String()),
    policy_profile_ref: Type.Optional(NonEmptyString),
    resource_hints: Type.Optional(ResourceHintsSchema),
    idempotency_key: NonEmptyString,
    labels: Type.Optional(Type.Record(Type.String(), Type.String())),
    runtime_options: RuntimeOptionsSchema,
  },
  { additionalProperties: false },
);
export type ArmSpec = Static<typeof ArmSpecSchema>;

// ──────────────────────────────────────────────────────────────────────────
// validateArmSpec — TypeBox check + runtime cross-check
//
// The schema-level `RuntimeOptionsSchema` is a plain `Type.Union` and does
// not enforce that `adapter_type` matches the corresponding runtime_options
// shape. Without a cross-check, an ArmSpec with `adapter_type: "cli_exec"`
// and subagent-shaped runtime_options would pass validation — a real bug.
//
// This function does two passes:
//   1. Full ArmSpec validation against ArmSpecSchema (TypeBox strict check)
//   2. Cross-check: validate runtime_options against the per-adapter schema
//      selected by adapter_type
//
// Callers (the octo.arm.spawn handler in M1-14, adapter spawn methods,
// tests) should use `validateArmSpec` rather than `Value.Check(ArmSpecSchema, ...)`
// directly. The bare schema check is preserved as an export for cases that
// genuinely want the weaker semantics.
//
// TODO (M1-14): when we refactor ArmSpecSchema into a proper tagged union
// of four variants, this function can collapse into a single TypeBox check
// and the RuntimeOptionsByAdapter table becomes unnecessary.
// ──────────────────────────────────────────────────────────────────────────

export type ArmSpecValidationResult =
  | { ok: true; spec: ArmSpec }
  | { ok: false; errors: readonly string[] };

export function validateArmSpec(input: unknown): ArmSpecValidationResult {
  // Pass 1: full ArmSpec schema check
  if (!Value.Check(ArmSpecSchema, input)) {
    const errs = [...Value.Errors(ArmSpecSchema, input)].map(
      (e) => `${e.path || "<root>"}: ${e.message}`,
    );
    return { ok: false, errors: errs };
  }

  // At this point the runtime shape is guaranteed by the schema; narrow the
  // type for the cross-check.
  const spec = input;

  // Pass 2: cross-check runtime_options against the per-adapter schema
  // selected by adapter_type.
  const runtimeSchema = RuntimeOptionsByAdapter[spec.adapter_type];
  if (!Value.Check(runtimeSchema, spec.runtime_options)) {
    const errs = [...Value.Errors(runtimeSchema, spec.runtime_options)].map(
      (e) => `runtime_options${e.path || ""}: ${e.message} (adapter_type is ${spec.adapter_type})`,
    );
    return { ok: false, errors: errs };
  }

  return { ok: true, spec };
}

// ══════════════════════════════════════════════════════════════════════════
// GripSpec — the input to grip creation (M0-02)
// ══════════════════════════════════════════════════════════════════════════

// ──────────────────────────────────────────────────────────────────────────
// Failure classifications and retry policy
//
// Per LLD §Retry and Backoff. Every adapter failure is classified into one
// of six categories; the RetryPolicy specifies which categories trigger
// retry and which trigger abandonment. The lists are kept as explicit
// enums (not free-form strings) so the scheduler can reason about them
// deterministically.
// ──────────────────────────────────────────────────────────────────────────

export const FailureClassificationSchema = Type.Union([
  Type.Literal("transient"),
  Type.Literal("timeout"),
  Type.Literal("adapter_error"),
  Type.Literal("policy_denied"),
  Type.Literal("invalid_spec"),
  Type.Literal("unrecoverable"),
]);
export type FailureClassification = Static<typeof FailureClassificationSchema>;

export const BackoffStrategySchema = Type.Union([
  Type.Literal("exponential"),
  Type.Literal("linear"),
  Type.Literal("fixed"),
]);
export type BackoffStrategy = Static<typeof BackoffStrategySchema>;

export const RetryPolicySchema = Type.Object(
  {
    max_attempts: Type.Integer({ minimum: 1 }),
    backoff: BackoffStrategySchema,
    initial_delay_s: Type.Number({ minimum: 0 }),
    max_delay_s: Type.Number({ minimum: 0 }),
    multiplier: Type.Number({ minimum: 1 }),
    retry_on: Type.Array(FailureClassificationSchema),
    abandon_on: Type.Array(FailureClassificationSchema),
  },
  { additionalProperties: false },
);
export type RetryPolicy = Static<typeof RetryPolicySchema>;

// ──────────────────────────────────────────────────────────────────────────
// Claim request — pre-declared resource claims on a GripSpec
//
// Per LLD §ClaimRecord. `required_claims[]` on a GripSpec is the set of
// claims the scheduler will try to acquire before placing the grip on an
// arm. If any claim cannot be acquired (because another arm holds it),
// the grip remains in the queue.
// ──────────────────────────────────────────────────────────────────────────

export const ResourceTypeSchema = Type.Union([
  Type.Literal("file"),
  Type.Literal("dir"),
  Type.Literal("branch"),
  Type.Literal("port"),
  Type.Literal("task-key"),
]);
export type ResourceType = Static<typeof ResourceTypeSchema>;

export const ClaimModeSchema = Type.Union([Type.Literal("exclusive"), Type.Literal("shared-read")]);
export type ClaimMode = Static<typeof ClaimModeSchema>;

export const ClaimRequestSchema = Type.Object(
  {
    resource_type: ResourceTypeSchema,
    resource_key: NonEmptyString,
    mode: ClaimModeSchema,
  },
  { additionalProperties: false },
);
export type ClaimRequest = Static<typeof ClaimRequestSchema>;

// ──────────────────────────────────────────────────────────────────────────
// GripSpec — the input to grip creation
//
// Every field mapped from LLD.md §Spawn Specifications §GripSpec. Strict
// mode (additionalProperties: false) rejects typos at the wire boundary.
//
// Conditional validation note: `idempotency_key` is declared OPTIONAL at
// the schema level but is **required** when `side_effecting: true`. The
// conditional rule is enforced by `validateGripSpec` (below), not by the
// bare schema. This mirrors the ArmSpec discriminated-union cross-check
// pattern from M0-01 — bare schema accepts a superset; the validator
// function enforces the business rule.
// ──────────────────────────────────────────────────────────────────────────

export const GripSpecSchema = Type.Object(
  {
    spec_version: Type.Integer({ minimum: 1 }),
    mission_id: NonEmptyString,
    type: NonEmptyString,
    input_ref: Type.Optional(NonEmptyString),
    desired_capabilities: Type.Optional(Type.Array(NonEmptyString)),
    priority: Type.Optional(Type.Integer()),
    retry_policy: RetryPolicySchema,
    timeout_s: Type.Integer({ minimum: 0 }),
    side_effecting: Type.Boolean(),
    required_claims: Type.Optional(Type.Array(ClaimRequestSchema)),
    // idempotency_key is conditionally required (see validateGripSpec).
    // Schema-level: optional NonEmptyString. Validator-level: required
    // when side_effecting: true.
    idempotency_key: Type.Optional(NonEmptyString),
    labels: Type.Optional(Type.Record(Type.String(), Type.String())),
  },
  { additionalProperties: false },
);
export type GripSpec = Static<typeof GripSpecSchema>;

// ──────────────────────────────────────────────────────────────────────────
// validateGripSpec — TypeBox check + side_effecting cross-check
//
// Enforces the conditional rule: `idempotency_key` must be present (and
// non-empty, per NonEmptyString) when `side_effecting: true`. This rule
// cannot be expressed in a single TypeBox object schema without a full
// discriminated-union refactor (deferred per the same M1-14 pattern as
// ArmSpec); in the meantime, `validateGripSpec` is the canonical entry
// point that callers should use — not `Value.Check(GripSpecSchema, ...)`.
//
// Consistency note with ArmSpec: ArmSpec's `idempotency_key` is
// unconditionally required (because every `octo.arm.spawn` is
// side-effecting). GripSpec's rule is conditional because non-side-
// effecting grips (reads, queries, analysis) do not need idempotency.
// ──────────────────────────────────────────────────────────────────────────

export type GripSpecValidationResult =
  | { ok: true; spec: GripSpec }
  | { ok: false; errors: readonly string[] };

export function validateGripSpec(input: unknown): GripSpecValidationResult {
  // Pass 1: full GripSpec schema check
  if (!Value.Check(GripSpecSchema, input)) {
    const errs = [...Value.Errors(GripSpecSchema, input)].map(
      (e) => `${e.path || "<root>"}: ${e.message}`,
    );
    return { ok: false, errors: errs };
  }

  const spec = input;

  // Pass 2: side_effecting cross-check — idempotency_key required when true.
  if (spec.side_effecting && !spec.idempotency_key) {
    return {
      ok: false,
      errors: ["idempotency_key is required when side_effecting is true (per LLD §GripSpec)"],
    };
  }

  return { ok: true, spec };
}

// ══════════════════════════════════════════════════════════════════════════
// MissionSpec — the input to mission creation (M0-03)
// ══════════════════════════════════════════════════════════════════════════

// ──────────────────────────────────────────────────────────────────────────
// Mission budget — optional per-mission cost/token cap
//
// Per LLD §Cost Accounting §Mission budget (OCTO-DEC-022). When present,
// the Head enforces the limit on every `arm.output` event carrying cost
// metadata. `on_exceed` determines the action: pause stops new grip
// assignment but lets existing arms finish; abort terminates live arms;
// warn_only emits a budget_warning event without changing state.
//
// PTY/tmux arms do not emit cost metadata — budget enforcement uses an
// optional time-based proxy (see CONFIG.md ptyHourlyRateProxyUsd) or
// simply does not apply.
// ──────────────────────────────────────────────────────────────────────────

export const MissionBudgetOnExceedSchema = Type.Union([
  Type.Literal("pause"),
  Type.Literal("abort"),
  Type.Literal("warn_only"),
]);
export type MissionBudgetOnExceed = Static<typeof MissionBudgetOnExceedSchema>;

export const MissionBudgetSchema = Type.Object(
  {
    cost_usd_limit: Type.Number({ minimum: 0 }),
    token_limit: Type.Integer({ minimum: 0 }),
    on_exceed: MissionBudgetOnExceedSchema,
  },
  { additionalProperties: false },
);
export type MissionBudget = Static<typeof MissionBudgetSchema>;

// ──────────────────────────────────────────────────────────────────────────
// Mission graph node
//
// Per LLD §Mission Graph Schema. A mission is a DAG of grips; each node
// references a grip_id and declares its dependencies. The graph is
// structurally validated by `validateMissionSpec` — cycles, duplicate
// grip_ids, and unknown depends_on references are all rejected there.
//
// `blocks_mission_on_failure` is optional at the schema layer; per LLD it
// defaults to `true` at consumption time (i.e., any grip failure aborts
// the mission unless explicitly declared non-blocking). The Head applies
// the default when constructing the runtime mission state.
//
// `fan_out_group` is operator visualization metadata only — the scheduler
// does not use it for placement decisions.
// ──────────────────────────────────────────────────────────────────────────

export const MissionGraphNodeSchema = Type.Object(
  {
    grip_id: NonEmptyString,
    depends_on: Type.Array(NonEmptyString),
    fan_out_group: Type.Optional(NonEmptyString),
    blocks_mission_on_failure: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false },
);
export type MissionGraphNode = Static<typeof MissionGraphNodeSchema>;

// ──────────────────────────────────────────────────────────────────────────
// Mission execution mode (M0-04.1, OCTO-DEC-039)
//
// Per PRD Principle #9 and LLD §Research-Driven Execution Pipeline,
// missions carry an optional execution_mode that determines the shape
// of the mission graph. An agent-side classifier chooses the mode
// before mission creation and pre-populates the graph with the
// appropriate research/synthesis/design/implementation grips.
//
// When absent, the implicit default is `direct_execute` (narrow, local,
// clearly specified tasks). This preserves backward compatibility with
// existing mission creation flows that do not classify.
//
// The Head does not generate grips from the mode — it stores and
// validates whatever graph the classifier submits. The mode serves as
// metadata describing the classifier's intent and as a filter for
// operator surfaces like `openclaw octo mission list --mode
// research_then_design_then_execute`.
// ──────────────────────────────────────────────────────────────────────────

export const MissionExecutionModeSchema = Type.Union([
  Type.Literal("direct_execute"),
  Type.Literal("research_then_plan"),
  Type.Literal("research_then_design_then_execute"),
  Type.Literal("compare_implementations"),
  Type.Literal("validate_prior_art_then_execute"),
]);
export type MissionExecutionMode = Static<typeof MissionExecutionModeSchema>;

// ──────────────────────────────────────────────────────────────────────────
// MissionSpec — the input to mission creation
//
// Every field mapped from LLD.md §Core Domain Objects §MissionRecord and
// §Mission Graph Schema. Fields that are runtime state (mission_id,
// status, arm_ids, grip_ids, created_ts, updated_ts) are NOT part of the
// spec — they are assigned by the Head at creation time.
//
// `metadata.source` is a conventional key per OCTO-DEC-014/030 and
// INTEGRATION.md §Automation trigger surfaces, taking values like
// `cron | flow | hook | standing_order | cli | operator`. The schema
// itself does not enforce the key set because metadata is free-form.
//
// `execution_mode` is optional per OCTO-DEC-039. When absent, the
// classifier was not run or the task was narrow enough to skip it; the
// implicit default is `direct_execute`.
// ──────────────────────────────────────────────────────────────────────────

const MISSION_METADATA_MAX_KEYS = 50;
const MISSION_GRAPH_MAX_NODES = 1024;
const MISSION_LABELS_MAX_KEYS = 50;

export const MissionSpecSchema = Type.Object(
  {
    spec_version: Type.Integer({ minimum: 1 }),
    title: NonEmptyString,
    owner: NonEmptyString,
    execution_mode: Type.Optional(MissionExecutionModeSchema),
    policy_profile_ref: Type.Optional(NonEmptyString),
    metadata: Type.Optional(
      Type.Record(Type.String(), Type.String(), {
        maxProperties: MISSION_METADATA_MAX_KEYS,
      }),
    ),
    budget: Type.Optional(MissionBudgetSchema),
    graph: Type.Array(MissionGraphNodeSchema, {
      minItems: 1,
      maxItems: MISSION_GRAPH_MAX_NODES,
    }),
    labels: Type.Optional(
      Type.Record(Type.String(), Type.String(), {
        maxProperties: MISSION_LABELS_MAX_KEYS,
      }),
    ),
  },
  { additionalProperties: false },
);
export type MissionSpec = Static<typeof MissionSpecSchema>;

// ──────────────────────────────────────────────────────────────────────────
// validateMissionSpec — TypeBox check + graph integrity cross-checks
//
// The bare MissionSpecSchema cannot express the four graph-integrity
// rules that a valid mission must satisfy:
//   1. No duplicate grip_ids in the graph
//   2. Every depends_on reference points at a grip_id in the same graph
//   3. No cycles (the graph is a DAG)
//   4. The graph is non-empty (this one IS in the bare schema via minItems)
//
// validateMissionSpec runs the TypeBox check first, then sequentially
// runs the three integrity checks. Rejection includes the specific
// offending grip_ids or cycle-creating edges so operators get actionable
// errors.
//
// Cycle detection uses Kahn's algorithm (iterative topological sort via
// in-degree tracking). A cycle exists iff the algorithm cannot process
// all nodes. This is simpler than DFS-based three-color marking and
// sufficient — we do not need to report the exact cycle path for
// rejection, just the fact of the cycle.
//
// TODO (M1-14 or M3 mission handler task): extend with additional
// semantic checks (budget reasonableness, at-least-one-root-grip, etc.)
// as real usage surfaces them. The current four checks cover the
// concrete bugs the LLD §Graph rules section calls out.
// ──────────────────────────────────────────────────────────────────────────

export type MissionSpecValidationResult =
  | { ok: true; spec: MissionSpec }
  | { ok: false; errors: readonly string[] };

function findDuplicateGripIds(graph: readonly MissionGraphNode[]): readonly string[] {
  const seen = new Set<string>();
  const dups = new Set<string>();
  for (const node of graph) {
    if (seen.has(node.grip_id)) {
      dups.add(node.grip_id);
    }
    seen.add(node.grip_id);
  }
  return [...dups];
}

function findUnknownDepends(graph: readonly MissionGraphNode[]): readonly string[] {
  const allIds = new Set(graph.map((n) => n.grip_id));
  const unknown: string[] = [];
  for (const node of graph) {
    for (const dep of node.depends_on) {
      if (!allIds.has(dep)) {
        unknown.push(`${node.grip_id} -> ${dep}`);
      }
    }
  }
  return unknown;
}

function graphHasCycle(graph: readonly MissionGraphNode[]): boolean {
  // Kahn's algorithm: repeatedly remove nodes with in-degree 0. If any
  // node remains unprocessed at the end, the graph has a cycle.
  //
  // Edge semantics: depends_on(X, Y) means X waits for Y, so there is an
  // edge Y -> X (Y must complete before X). in-degree of X counts how
  // many predecessors it has.

  const inDegree = new Map<string, number>();
  const adjacency = new Map<string, string[]>();

  for (const node of graph) {
    inDegree.set(node.grip_id, 0);
    adjacency.set(node.grip_id, []);
  }
  for (const node of graph) {
    for (const dep of node.depends_on) {
      // Only count edges to nodes that exist in the graph — unknown deps
      // are flagged by findUnknownDepends before we get here, but we
      // skip them defensively in case this function is called alone.
      if (!adjacency.has(dep)) {
        continue;
      }
      adjacency.get(dep)!.push(node.grip_id);
      inDegree.set(node.grip_id, (inDegree.get(node.grip_id) ?? 0) + 1);
    }
  }

  const queue: string[] = [];
  for (const [id, degree] of inDegree) {
    if (degree === 0) {
      queue.push(id);
    }
  }

  let processed = 0;
  while (queue.length > 0) {
    const id = queue.shift()!;
    processed++;
    for (const neighbor of adjacency.get(id) ?? []) {
      const newDegree = (inDegree.get(neighbor) ?? 0) - 1;
      inDegree.set(neighbor, newDegree);
      if (newDegree === 0) {
        queue.push(neighbor);
      }
    }
  }

  return processed !== inDegree.size;
}

export function validateMissionSpec(input: unknown): MissionSpecValidationResult {
  // Pass 1: full MissionSpec schema check
  if (!Value.Check(MissionSpecSchema, input)) {
    const errs = [...Value.Errors(MissionSpecSchema, input)].map(
      (e) => `${e.path || "<root>"}: ${e.message}`,
    );
    return { ok: false, errors: errs };
  }

  const spec = input;

  // Pass 2: graph integrity — duplicate grip_ids
  const duplicates = findDuplicateGripIds(spec.graph);
  if (duplicates.length > 0) {
    return {
      ok: false,
      errors: [`mission graph has duplicate grip_ids: ${duplicates.join(", ")}`],
    };
  }

  // Pass 3: graph integrity — unknown depends_on references
  const unknownRefs = findUnknownDepends(spec.graph);
  if (unknownRefs.length > 0) {
    return {
      ok: false,
      errors: [`mission graph depends_on references unknown grip_ids: ${unknownRefs.join(", ")}`],
    };
  }

  // Pass 4: graph integrity — no cycles
  if (graphHasCycle(spec.graph)) {
    return {
      ok: false,
      errors: ["mission graph contains a cycle (depends_on forms a closed loop)"],
    };
  }

  return { ok: true, spec };
}
