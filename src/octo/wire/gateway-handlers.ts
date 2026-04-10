// Octopus Orchestrator — Gateway WS handlers (M1-14, M1-15, M1-16)
//
// Implements the Head-side dispatch handlers for the octo.* WebSocket
// method namespace. M1-14 lands the first handler: `octo.arm.spawn`.
// M1-15 adds `octo.arm.health`. M1-16 adds `octo.arm.terminate`.
// Subsequent milestones (M1-17..M1-22) will grow this module by adding
// one method per file-local method on the `OctoGatewayHandlers` class.
//
// Context docs:
//   - docs/octopus-orchestrator/LLD.md §Head ↔ Node Agent Wire Contract
//   - docs/octopus-orchestrator/LLD.md §Spawn Specifications §ArmSpec
//   - docs/octopus-orchestrator/DECISIONS.md OCTO-DEC-033 (boundary rules)
//
// Composed services (injected via constructor):
//   - RegistryService  (M1-02) — ArmRecord persistence + CAS updates
//   - EventLogService  (M1-03) — arm.* event emission
//   - TmuxManager      (M1-10) — stub PtyTmuxAdapter session creation
//   - applyArmTransition (M1-07) — FSM-validated state transitions
//
// M1 scope limitation: the stub "PtyTmuxAdapter" path is the only
// adapter spawn M1-14 supports. Any ArmSpec whose `adapter_type` is
// not `pty_tmux` is rejected with HandlerError("invalid_spec"). The
// other three adapter types (structured_subagent, cli_exec,
// structured_acp) land in the M2 adapter milestones.
//
// Session-name convention (shared with M1-13 SessionReconciler):
//   Canonical tmux session name for an arm is `octo-arm-${arm_id}`.
//   The reconciler scans live tmux sessions on Node Agent start-up and
//   rebinds persisted arm rows by matching this exact prefix, so any
//   drift between this handler and `src/octo/node-agent/session-reconciler.ts`
//   would break crash recovery. Because M1-13 and M1-14 are authored
//   in the same wave, this module intentionally DOES NOT import the
//   reconciler — the convention is inlined here as a const/helper, and
//   M1-13 inlines its own copy. A future refactor may extract a shared
//   constants module.
//
// Boundary discipline (OCTO-DEC-033): only `@sinclair/typebox`, `node:*`
// builtins, and relative imports inside `src/octo/` are allowed.

import { Value } from "@sinclair/typebox/value";
import { isAdapterError, type SessionRef as AdapterSessionRef } from "../adapters/base.ts";
import type { AdapterType } from "../adapters/base.ts";
import { createAdapter } from "../adapters/factory.ts";
import { applyArmTransition, type ArmState } from "../head/arm-fsm.ts";
import type { EventLogService } from "../head/event-log.ts";
import {
  applyGripTransition,
  isTerminalState as isGripTerminal,
  type GripState,
} from "../head/grip-fsm.ts";
import type { LeaseService } from "../head/leases.ts";
import {
  applyMissionTransition,
  InvalidTransitionError,
  type MissionState,
} from "../head/mission-fsm.ts";
import { PolicyService, type PolicyDecision } from "../head/policy.ts";
import { ConflictError } from "../head/registry.ts";
import type {
  ArmInput,
  ArmRecord,
  GripInput,
  MissionInput,
  RegistryService,
} from "../head/registry.ts";
import type { TmuxManager } from "../node-agent/tmux-manager.ts";
import { OctoLeaseRenewPushSchema, type OctoLeaseRenewPush } from "./events.ts";
import {
  OctoArmAttachRequestSchema,
  OctoArmCheckpointRequestSchema,
  OctoArmHealthRequestSchema,
  OctoArmSendRequestSchema,
  OctoArmSpawnRequestSchema,
  OctoArmTerminateRequestSchema,
  type HealthStatus,
  type OctoArmAttachRequest,
  type OctoArmAttachResponse,
  type OctoArmCheckpointRequest,
  type OctoArmCheckpointResponse,
  type OctoArmHealthRequest,
  type OctoArmHealthResponse,
  type OctoArmSendRequest,
  type OctoArmSendResponse,
  type OctoArmSpawnRequest,
  type OctoArmSpawnResponse,
  type OctoArmTerminateRequest,
  type OctoArmTerminateResponse,
  type SessionRef,
} from "./methods.ts";
import { validateArmSpec, validateMissionSpec, type ArmSpec, type MissionSpec } from "./schema.ts";

// ──────────────────────────────────────────────────────────────────────────
// Shared session-name convention (see module header)
// ──────────────────────────────────────────────────────────────────────────

/**
 * Canonical tmux session-name prefix for arm-owned sessions.
 *
 * Duplicated intentionally with `src/octo/node-agent/session-reconciler.ts`
 * (M1-13). Keep them in lockstep — divergence breaks crash recovery.
 */
const SESSION_NAME_PREFIX = "octo-arm-";

function sessionNameForArm(arm_id: string): string {
  return `${SESSION_NAME_PREFIX}${arm_id}`;
}

/**
 * Default arm_id generator. Tests inject a deterministic generator via
 * `OctoGatewayHandlerDeps.generateArmId` for predictable session-name
 * cleanup. UUID (not ULID) is fine for M1 — the scheduler does not
 * currently rely on arm_id monotonicity.
 */
function defaultGenerateArmId(): string {
  return `arm-${crypto.randomUUID()}`;
}

/**
 * Default mission_id generator. Tests inject a deterministic generator via
 * `OctoGatewayHandlerDeps.generateMissionId` for predictable assertions.
 */
function defaultGenerateMissionId(): string {
  return `mis-${crypto.randomUUID()}`;
}

// ──────────────────────────────────────────────────────────────────────────
// Public surface
// ──────────────────────────────────────────────────────────────────────────

export type HandlerErrorCode =
  | "invalid_spec"
  | "internal"
  | "tmux_failed"
  | "not_found"
  | "not_supported"
  | "invalid_state"
  | "conflict"
  | "policy_denied"
  | "policy_escalated";

export class HandlerError extends Error {
  constructor(
    public readonly code: HandlerErrorCode,
    message: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "HandlerError";
  }
}

export interface LeaseRenewResultEntry {
  arm_id: string;
  renewed: boolean;
  error?: string;
}

export interface LeaseRenewResult {
  node_id: string;
  results: LeaseRenewResultEntry[];
}

export interface MissionCreateResponse {
  mission_id: string;
  grip_count: number;
}

export interface MissionPauseResponse {
  mission_id: string;
  status: "paused";
}

export interface MissionResumeResponse {
  mission_id: string;
  status: "active";
}

export interface MissionAbortResponse {
  mission_id: string;
  status: "aborted";
  arms_terminated: number;
}

// PolicyService + PolicyDecision — re-exported from head/policy.ts (M5-01).
// Previously a local shim; now delegates to the canonical implementation.
// Re-exported so existing test files that import from gateway-handlers
// continue to work without churn.
export { PolicyService, type PolicyDecision } from "../head/policy.ts";

export interface OctoGatewayHandlerDeps {
  registry: RegistryService;
  eventLog: EventLogService;
  tmuxManager: TmuxManager;
  /** PolicyService for arm.spawn policy enforcement (M5-02). */
  policyService?: PolicyService;
  /** LeaseService for lease heartbeat renewals (M4-01). */
  leaseService?: LeaseService;
  /** This Node Agent's id. Required for ArmRecord.node_id population. */
  nodeId: string;
  /** Optional now() injection for deterministic tests. */
  now?: () => number;
  /** Optional arm_id generator injection for deterministic tests. */
  generateArmId?: () => string;
  /** Optional mission_id generator injection for deterministic tests. */
  generateMissionId?: () => string;
}

/**
 * Gateway WebSocket handlers for the octo.* namespace. This class will
 * grow one method at a time through M1-14..M1-22; M1-14 lands
 * `armSpawn` (octo.arm.spawn).
 */
export class OctoGatewayHandlers {
  private readonly registry: RegistryService;
  private readonly eventLog: EventLogService;
  private readonly tmuxManager: TmuxManager;
  private readonly policyService: PolicyService | undefined;
  private readonly leaseService: LeaseService | undefined;
  private readonly nodeId: string;
  private readonly now: () => number;
  private readonly generateArmId: () => string;
  private readonly generateMissionId: () => string;

  constructor(deps: OctoGatewayHandlerDeps) {
    this.registry = deps.registry;
    this.eventLog = deps.eventLog;
    this.tmuxManager = deps.tmuxManager;
    this.policyService = deps.policyService;
    this.leaseService = deps.leaseService;
    this.nodeId = deps.nodeId;
    this.now = deps.now ?? (() => Date.now());
    this.generateArmId = deps.generateArmId ?? defaultGenerateArmId;
    this.generateMissionId = deps.generateMissionId ?? defaultGenerateMissionId;
  }

  /**
   * Handle `octo.arm.spawn`.
   *
   * Pipeline:
   *   1. Validate request envelope (OctoArmSpawnRequestSchema)
   *   2. Cross-validate the spec via validateArmSpec (adapter-type
   *      discriminated union enforcement)
   *   3. M1 stub: reject adapter_type !== "pty_tmux"
   *   4. Idempotency check against spec.idempotency_key (in-memory scan
   *      of listArms — good enough at M1 scale; see trade-off note below)
   *   5. Generate arm_id, insert ArmRecord in state "pending"
   *   6. Emit arm.created event
   *   7. Apply FSM transition pending -> starting + casUpdateArm
   *   8. Emit arm.starting event
   *   9. Create the stub tmux session via TmuxManager.createSession
   *  10. casUpdateArm with the populated session_ref
   *  11. Return OctoArmSpawnResponse { arm_id, session_ref }
   *
   * Return-on-starting semantics (per LLD §Head ↔ Node Agent Wire
   * Contract): the handler does NOT wait for the arm to reach "active"
   * — that transition is driven later by ProcessWatcher (M1-12) and
   * emitted as `arm.active`. M1-14 only covers the synchronous
   * pending -> starting path.
   *
   * Idempotency (M1 simplification): replays of the same
   * `spec.idempotency_key` are detected via an in-memory scan of
   * `registry.listArms()`. This is O(N) in the number of arms on the
   * node and does not scale past thousands of rows. A follow-up task
   * will add an indexed lookup on idempotency_key when the Head moves
   * beyond single-node MVP.
   *
   * Failure handling: if `tmuxManager.createSession` throws, the
   * handler drives the arm row through the FSM to the `failed` state
   * (starting -> failed is a valid transition per arm-fsm.ts) via a
   * second casUpdateArm, emits `arm.failed`, and re-raises as
   * HandlerError("tmux_failed"). The arm row is NOT deleted — the
   * registry has no delete primitive at M1, and leaving a failed row
   * in place preserves the audit trail for operators.
   */
  async armSpawn(request: unknown): Promise<OctoArmSpawnResponse> {
    // Step 1 — validate request envelope.
    if (!Value.Check(OctoArmSpawnRequestSchema, request)) {
      const errors = [...Value.Errors(OctoArmSpawnRequestSchema, request)].map(
        (e) => `${e.path || "<root>"}: ${e.message}`,
      );
      throw new HandlerError(
        "invalid_spec",
        `octo.arm.spawn: invalid request envelope: ${errors.join("; ")}`,
      );
    }
    const validRequest: OctoArmSpawnRequest = request;

    // Step 2 — spec cross-check (discriminated-union enforcement).
    const specResult = validateArmSpec(validRequest.spec);
    if (!specResult.ok) {
      throw new HandlerError(
        "invalid_spec",
        `octo.arm.spawn: invalid ArmSpec: ${specResult.errors.join("; ")}`,
      );
    }
    const spec: ArmSpec = specResult.spec;

    // Step 2b — policy enforcement (M5-02). When a PolicyService is
    // injected, evaluate "arm.spawn" against the spec's policy_profile_ref.
    // Deny → HandlerError("policy_denied"), Escalate → HandlerError("policy_escalated"),
    // Allow → proceed. All decisions are logged to the event log.
    if (this.policyService) {
      const profile = this.policyService.resolve(spec.adapter_type, spec.agent_id, this.nodeId);
      const decision = this.policyService.check("arm.spawn", profile, {
        spec: spec as unknown as Record<string, unknown>,
      });

      // Log every policy decision regardless of verdict.
      await this.eventLog.append({
        schema_version: 1,
        entity_type: "policy",
        entity_id: "arm.spawn",
        event_type: "policy.decision",
        ts: new Date(this.now()).toISOString(),
        actor: `node-agent:${this.nodeId}`,
        payload: {
          action: "arm.spawn",
          profile: profile.name,
          verdict: decision.decision,
          reason: "reason" in decision ? decision.reason : undefined,
          rule_id:
            decision.decision === "deny" ? (decision as { ruleId: string }).ruleId : undefined,
        },
      });

      if (decision.decision === "deny") {
        const deny = decision as { decision: "deny"; reason: string; ruleId: string };
        throw new HandlerError("policy_denied", `octo.arm.spawn: policy denied: ${deny.reason}`, {
          reason: deny.reason,
          ruleId: deny.ruleId,
        });
      }
      if (decision.decision === "escalate") {
        const esc = decision as { decision: "escalate"; reason: string };
        throw new HandlerError(
          "policy_escalated",
          `octo.arm.spawn: policy requires escalation: ${esc.reason}`,
          { reason: esc.reason },
        );
      }
    }

    // Step 3 — create adapter via factory. Unsupported adapter types
    // throw AdapterError("not_supported"), which we surface as
    // HandlerError("invalid_spec").
    let adapter;
    try {
      adapter = createAdapter(spec.adapter_type, { tmuxManager: this.tmuxManager });
    } catch (err) {
      if (isAdapterError(err) && err.code === "not_supported") {
        throw new HandlerError("invalid_spec", `octo.arm.spawn: ${err.message}`);
      }
      throw err;
    }

    // Step 4 — idempotency check.
    const replay = this.findArmByIdempotencyKey(spec.idempotency_key);
    if (replay !== null) {
      const session_ref = this.extractSessionRef(replay);
      if (session_ref === null) {
        // The prior attempt crashed between row insert and session_ref
        // population. Without a durable workflow engine we can't safely
        // resume; surface the partial state as an internal error so the
        // caller can investigate.
        throw new HandlerError(
          "internal",
          `octo.arm.spawn: idempotency replay for key "${spec.idempotency_key}" ` +
            `found arm ${replay.arm_id} with no session_ref; prior spawn did not complete`,
          { arm_id: replay.arm_id },
        );
      }
      return { arm_id: replay.arm_id, session_ref };
    }

    // Step 5 — insert ArmRecord in state "pending".
    const arm_id = this.generateArmId();
    const created_at = this.now();
    const armInput: ArmInput = {
      arm_id,
      mission_id: spec.mission_id,
      node_id: this.nodeId,
      adapter_type: spec.adapter_type,
      runtime_name: spec.runtime_name,
      agent_id: spec.agent_id,
      // task_ref is populated by the task-ledger bridge in a later
      // milestone (OCTO-DEC-030). For M1 standalone spawns it is null.
      task_ref: null,
      state: "pending",
      current_grip_id: null,
      lease_owner: null,
      lease_expiry_ts: null,
      session_ref: null,
      checkpoint_ref: null,
      health_status: null,
      restart_count: 0,
      policy_profile: spec.policy_profile_ref ?? null,
      spec,
      created_at,
    };
    const pendingArm: ArmRecord = this.registry.putArm(armInput);

    // Step 6 — emit arm.created.
    await this.eventLog.append({
      schema_version: 1,
      entity_type: "arm",
      entity_id: arm_id,
      event_type: "arm.created",
      ts: new Date(created_at).toISOString(),
      actor: `node-agent:${this.nodeId}`,
      payload: {
        spec: spec as unknown as Record<string, unknown>,
        mission_id: spec.mission_id,
        node_id: this.nodeId,
      },
    });

    // Step 7 — FSM transition pending -> starting + persist.
    const startingTs = this.now();
    const startingLike = applyArmTransition(
      { state: pendingArm.state, updated_at: pendingArm.updated_at },
      "starting" satisfies ArmState,
      { now: startingTs, arm_id },
    );
    const startingArm = this.registry.casUpdateArm(arm_id, pendingArm.version, {
      state: startingLike.state,
      updated_at: startingLike.updated_at,
    });

    // Step 8 — emit arm.starting.
    await this.eventLog.append({
      schema_version: 1,
      entity_type: "arm",
      entity_id: arm_id,
      event_type: "arm.starting",
      ts: new Date(startingTs).toISOString(),
      actor: `node-agent:${this.nodeId}`,
      payload: {
        mission_id: spec.mission_id,
        node_id: this.nodeId,
      },
    });

    // Step 9 — delegate to the adapter's spawn(). Inject _arm_id so the
    // stub adapter can derive the canonical tmux session name.
    const sessionName = sessionNameForArm(arm_id);
    let adapterRef;
    try {
      const specWithArmId = { ...spec, _arm_id: arm_id } as typeof spec & { _arm_id: string };
      adapterRef = await adapter.spawn(specWithArmId);
    } catch (err) {
      // Drive starting -> failed through the FSM and persist. Emit
      // arm.failed so the audit trail reflects the outcome. Re-raise
      // as tmux_failed so the caller sees a structured error.
      await this.markArmFailed(startingArm, `adapter spawn failed: ${describeError(err)}`);
      throw new HandlerError(
        "tmux_failed",
        `octo.arm.spawn: adapter spawn failed for ${sessionName}: ${describeError(err)}`,
        { arm_id, sessionName },
      );
    }

    // Step 10 — map adapter SessionRef to wire SessionRef and persist.
    const session_ref: SessionRef = {
      tmux_session_name: adapterRef.metadata?.tmux_session_name as string | undefined,
      cwd: adapterRef.cwd,
    };
    this.registry.casUpdateArm(arm_id, startingArm.version, {
      session_ref: session_ref as unknown as Record<string, unknown>,
      updated_at: this.now(),
    });

    // Step 11 — return.
    return { arm_id, session_ref };
  }

  /**
   * Handle `octo.arm.health` (M1-15).
   *
   * Returns a structured {@link HealthSnapshot} for the given arm id.
   * Composes the snapshot from the persisted ArmRecord:
   *   - `status` — derived from the arm row's `health_status` when set,
   *     otherwise mapped from the FSM `state` column via
   *     {@link armStateToHealthStatus}. HealthStatusSchema does not include
   *     `pending`, `completed`, or `archived`; those states are mapped to
   *     the closest wire equivalent (`starting`, `terminated`,
   *     `terminated` respectively).
   *   - `restart_count` — copied straight from the row.
   *   - `last_progress_tick_ts` — populated with the row's `updated_at`
   *     as the best-effort progress signal available at M1. Real tick
   *     events land in M2 when the ProcessWatcher publishes them.
   *
   * Unknown arm id → HandlerError("not_found"). Schema validation failure
   * → HandlerError("invalid_spec").
   */
  async armHealth(request: unknown): Promise<OctoArmHealthResponse> {
    if (!Value.Check(OctoArmHealthRequestSchema, request)) {
      const errors = [...Value.Errors(OctoArmHealthRequestSchema, request)].map(
        (e) => `${e.path || "<root>"}: ${e.message}`,
      );
      throw new HandlerError(
        "invalid_spec",
        `octo.arm.health: invalid request envelope: ${errors.join("; ")}`,
      );
    }
    const validRequest: OctoArmHealthRequest = request;

    const arm = this.registry.getArm(validRequest.arm_id);
    if (arm === null) {
      throw new HandlerError(
        "not_found",
        `octo.arm.health: arm not found: ${validRequest.arm_id}`,
        { arm_id: validRequest.arm_id },
      );
    }

    const status = deriveHealthStatus(arm);
    const snapshot: OctoArmHealthResponse = {
      arm_id: arm.arm_id,
      status,
      restart_count: arm.restart_count,
      last_progress_tick_ts: arm.updated_at,
    };
    return snapshot;
  }

  /**
   * Handle `octo.arm.terminate` (M1-16).
   *
   * Pipeline:
   *   1. Validate request envelope
   *   2. Look up the arm (not_found if missing)
   *   3. Idempotency: if the arm is already `terminated` or `archived`,
   *      return success without side-effects — the caller's goal
   *      ("be gone") is already achieved. No second event, no CAS.
   *   4. FSM guard: if the arm's state has no edge to `terminated`
   *      (e.g. `pending`, `starting`, `completed`), fail with
   *      HandlerError("invalid_state") carrying the current state.
   *   5. Kill the tmux session via TmuxManager.killSession. This is
   *      idempotent — `false` from killSession means "already gone" and
   *      is NOT an error; the handler proceeds with the FSM transition
   *      and still emits the event. Any other tmux failure throws
   *      TmuxError from the manager and is surfaced as HandlerError
   *      ("tmux_failed").
   *   6. Apply the FSM transition and persist via casUpdateArm. CAS
   *      conflicts (concurrent writer raced us) surface as
   *      HandlerError("conflict").
   *   7. Emit `arm.terminated` with the reason, force hint, previous
   *      state, and the tmux kill result in the payload.
   *
   * The handler kills the tmux session BEFORE transitioning the FSM
   * state so that a partial failure (tmux kill succeeds, CAS fails)
   * leaves the arm in a consistent "session gone" posture that a
   * follow-up operator call can drive to completion.
   */
  async armTerminate(request: unknown): Promise<OctoArmTerminateResponse> {
    if (!Value.Check(OctoArmTerminateRequestSchema, request)) {
      const errors = [...Value.Errors(OctoArmTerminateRequestSchema, request)].map(
        (e) => `${e.path || "<root>"}: ${e.message}`,
      );
      throw new HandlerError(
        "invalid_spec",
        `octo.arm.terminate: invalid request envelope: ${errors.join("; ")}`,
      );
    }
    const validRequest: OctoArmTerminateRequest = request;

    const arm = this.registry.getArm(validRequest.arm_id);
    if (arm === null) {
      throw new HandlerError(
        "not_found",
        `octo.arm.terminate: arm not found: ${validRequest.arm_id}`,
        { arm_id: validRequest.arm_id },
      );
    }

    // Step 3 — idempotent no-op for already-dead arms.
    if (arm.state === "terminated" || arm.state === "archived") {
      return {
        arm_id: arm.arm_id,
        terminated: true,
        final_status: "terminated",
      };
    }

    // Step 4 — FSM guard. `terminated` is only reachable from
    // active/idle/blocked/failed/quarantined per M1-07's transition
    // table. Pending/starting/completed are rejected outright so the
    // operator sees a clear error instead of a mysterious FSM throw.
    if (!canTransitionToTerminated(arm.state)) {
      throw new HandlerError(
        "invalid_state",
        `octo.arm.terminate: arm ${arm.arm_id} is in state "${arm.state}"; ` +
          `no FSM transition to "terminated" from this state`,
        { arm_id: arm.arm_id, current_state: arm.state },
      );
    }

    const previousState = arm.state;
    const sessionName = sessionNameForArm(arm.arm_id);

    // Step 5 — kill tmux first. killSession returns false for
    // already-gone sessions (idempotent); treat that as success.
    let killed: boolean;
    try {
      killed = await this.tmuxManager.killSession(sessionName);
    } catch (err) {
      throw new HandlerError(
        "tmux_failed",
        `octo.arm.terminate: tmux killSession failed for ${sessionName}: ${describeError(err)}`,
        { arm_id: arm.arm_id, sessionName },
      );
    }

    // Step 6 — FSM transition + persist.
    const terminatedTs = this.now();
    let transitionedLike: { state: ArmState; updated_at: number };
    try {
      transitionedLike = applyArmTransition(
        { state: arm.state, updated_at: arm.updated_at },
        "terminated" satisfies ArmState,
        { now: terminatedTs, arm_id: arm.arm_id },
      );
    } catch (err) {
      throw new HandlerError(
        "invalid_state",
        `octo.arm.terminate: FSM rejected transition for arm ${arm.arm_id}: ${describeError(err)}`,
        { arm_id: arm.arm_id, current_state: arm.state },
      );
    }

    try {
      this.registry.casUpdateArm(arm.arm_id, arm.version, {
        state: transitionedLike.state,
        updated_at: transitionedLike.updated_at,
        health_status: "terminated",
      });
    } catch (err) {
      if (err instanceof ConflictError) {
        throw new HandlerError(
          "conflict",
          `octo.arm.terminate: concurrent update on arm ${arm.arm_id}: ${err.message}`,
          { arm_id: arm.arm_id, expected_version: arm.version },
        );
      }
      throw err;
    }

    // Step 7 — emit arm.terminated.
    await this.eventLog.append({
      schema_version: 1,
      entity_type: "arm",
      entity_id: arm.arm_id,
      event_type: "arm.terminated",
      ts: new Date(terminatedTs).toISOString(),
      actor: `node-agent:${this.nodeId}`,
      payload: {
        reason: validRequest.reason,
        force: validRequest.force ?? false,
        previous_state: previousState,
        tmux_session_killed: killed,
      },
    });

    return {
      arm_id: arm.arm_id,
      terminated: true,
      final_status: "terminated",
    };
  }

  /**
   * Handle `octo.arm.send` (M2-13).
   *
   * Pipeline:
   *   1. Validate request envelope (OctoArmSendRequestSchema)
   *   2. Look up arm (not_found if missing)
   *   3. Get adapter via factory
   *   4. Build adapter SessionRef from arm row's session_ref
   *   5. Call adapter.send(sessionRef, payload)
   *   6. If adapter throws AdapterError("not_supported") return structured error
   *   7. Return OctoArmSendResponse
   */
  async armSend(request: unknown): Promise<OctoArmSendResponse> {
    if (!Value.Check(OctoArmSendRequestSchema, request)) {
      const errors = [...Value.Errors(OctoArmSendRequestSchema, request)].map(
        (e) => `${e.path || "<root>"}: ${e.message}`,
      );
      throw new HandlerError(
        "invalid_spec",
        `octo.arm.send: invalid request envelope: ${errors.join("; ")}`,
      );
    }
    const validRequest: OctoArmSendRequest = request;

    const arm = this.registry.getArm(validRequest.arm_id);
    if (arm === null) {
      throw new HandlerError("not_found", `octo.arm.send: arm not found: ${validRequest.arm_id}`, {
        arm_id: validRequest.arm_id,
      });
    }

    let adapter;
    try {
      adapter = createAdapter(arm.adapter_type as AdapterType, { tmuxManager: this.tmuxManager });
    } catch (err) {
      if (isAdapterError(err) && err.code === "not_supported") {
        throw new HandlerError("not_supported", `octo.arm.send: ${err.message}`, {
          arm_id: validRequest.arm_id,
        });
      }
      throw err;
    }

    const adapterRef = this.buildAdapterSessionRef(arm);

    try {
      await adapter.send(adapterRef, validRequest.payload);
    } catch (err) {
      if (isAdapterError(err) && err.code === "not_supported") {
        return {
          arm_id: validRequest.arm_id,
          delivered: false,
        };
      }
      throw err;
    }

    return {
      arm_id: validRequest.arm_id,
      delivered: true,
      bytes_written: validRequest.payload.length,
    };
  }

  /**
   * Handle `octo.arm.attach` (M2-14).
   *
   * Pipeline:
   *   1. Validate request envelope (OctoArmAttachRequestSchema)
   *   2. Look up arm (not_found if missing)
   *   3. Extract session_ref from arm row
   *   4. For pty_tmux: return the attach_command from the adapter SessionRef
   *   5. For cli_exec: return not_supported (no interactive attach for subprocesses)
   *   6. For subagent/acp: return session_id as an attach hint
   *   7. Return OctoArmAttachResponse
   */
  async armAttach(request: unknown): Promise<OctoArmAttachResponse> {
    if (!Value.Check(OctoArmAttachRequestSchema, request)) {
      const errors = [...Value.Errors(OctoArmAttachRequestSchema, request)].map(
        (e) => `${e.path || "<root>"}: ${e.message}`,
      );
      throw new HandlerError(
        "invalid_spec",
        `octo.arm.attach: invalid request envelope: ${errors.join("; ")}`,
      );
    }
    const validRequest: OctoArmAttachRequest = request;

    const arm = this.registry.getArm(validRequest.arm_id);
    if (arm === null) {
      throw new HandlerError(
        "not_found",
        `octo.arm.attach: arm not found: ${validRequest.arm_id}`,
        { arm_id: validRequest.arm_id },
      );
    }

    // cli_exec does not support interactive attach.
    if (arm.adapter_type === "cli_exec") {
      throw new HandlerError(
        "not_supported",
        `octo.arm.attach: cli_exec adapter does not support interactive attach`,
        { arm_id: validRequest.arm_id },
      );
    }

    const wireSessionRef = this.extractSessionRef(arm);
    if (wireSessionRef === null) {
      throw new HandlerError(
        "internal",
        `octo.arm.attach: arm ${validRequest.arm_id} has no session_ref`,
        { arm_id: validRequest.arm_id },
      );
    }

    // Derive attach_command based on adapter type.
    let attach_command: string | undefined;
    if (arm.adapter_type === "pty_tmux") {
      const sessionName = sessionNameForArm(arm.arm_id);
      attach_command = `tmux attach -t ${sessionName}`;
    } else {
      // subagent/acp: use the session_ref metadata as the attach hint.
      const structuredId = arm.session_ref?.structured_session_id;
      if (typeof structuredId === "string") {
        attach_command = structuredId;
      }
    }

    const response: OctoArmAttachResponse = {
      arm_id: validRequest.arm_id,
      session_ref: wireSessionRef,
    };
    if (attach_command !== undefined) {
      response.attach_command = attach_command;
    }
    return response;
  }

  /**
   * Handle `octo.arm.checkpoint` (M2-14).
   *
   * Pipeline:
   *   1. Validate request envelope (OctoArmCheckpointRequestSchema)
   *   2. Look up arm (not_found if missing)
   *   3. Get adapter via factory
   *   4. Call adapter.checkpoint(sessionRef)
   *   5. Store the checkpoint_ref on the arm row via casUpdateArm
   *   6. Return OctoArmCheckpointResponse
   *
   * Note: `arm.checkpoint` is NOT in CoreEventTypeSchema so we skip the
   * event log append. The push event `octo.arm.checkpoint` exists in the
   * push event registry but that is emitted by the push transport, not here.
   */
  async armCheckpoint(request: unknown): Promise<OctoArmCheckpointResponse> {
    if (!Value.Check(OctoArmCheckpointRequestSchema, request)) {
      const errors = [...Value.Errors(OctoArmCheckpointRequestSchema, request)].map(
        (e) => `${e.path || "<root>"}: ${e.message}`,
      );
      throw new HandlerError(
        "invalid_spec",
        `octo.arm.checkpoint: invalid request envelope: ${errors.join("; ")}`,
      );
    }
    const validRequest: OctoArmCheckpointRequest = request;

    const arm = this.registry.getArm(validRequest.arm_id);
    if (arm === null) {
      throw new HandlerError(
        "not_found",
        `octo.arm.checkpoint: arm not found: ${validRequest.arm_id}`,
        { arm_id: validRequest.arm_id },
      );
    }

    let adapter;
    try {
      adapter = createAdapter(arm.adapter_type as AdapterType, { tmuxManager: this.tmuxManager });
    } catch (err) {
      if (isAdapterError(err) && err.code === "not_supported") {
        throw new HandlerError("not_supported", `octo.arm.checkpoint: ${err.message}`, {
          arm_id: validRequest.arm_id,
        });
      }
      throw err;
    }

    const adapterRef = this.buildAdapterSessionRef(arm);

    let checkpointMeta;
    try {
      checkpointMeta = await adapter.checkpoint(adapterRef);
    } catch (err) {
      if (isAdapterError(err) && err.code === "not_supported") {
        throw new HandlerError(
          "not_supported",
          `octo.arm.checkpoint: adapter does not support checkpoint: ${describeError(err)}`,
          { arm_id: validRequest.arm_id },
        );
      }
      throw err;
    }

    // Build a checkpoint_ref string from the metadata.
    const checkpointTs = checkpointMeta.ts;
    const checkpoint_ref = `chk-${validRequest.arm_id}-${checkpointTs}`;

    // Store checkpoint_ref on the arm row.
    this.registry.casUpdateArm(arm.arm_id, arm.version, {
      checkpoint_ref,
      updated_at: this.now(),
    });

    return {
      arm_id: validRequest.arm_id,
      checkpoint_ref,
      ts: checkpointTs,
    };
  }

  /**
   * Handle `octo.mission.create` (M3-01).
   *
   * Pipeline:
   *   1. Validate request shape (idempotency_key required, exactly one
   *      of mission_spec / template_id)
   *   2. template_id returns a structured "not yet supported" error
   *   3. Run validateMissionSpec for business-rule cross-checks (cycle
   *      detection, duplicate grip_ids, unknown dep references)
   *   4. Idempotency: check if a mission with the same idempotency_key
   *      already exists; if so, return the existing mission_id
   *   5. Generate mission_id with `mis-` prefix
   *   6. Insert MissionRecord via registry.putMission with status "active"
   *   7. For each grip in spec.graph: insert GripRecord via registry.putGrip
   *      with status "queued" and the grip's depends_on list
   *   8. Emit mission.created event
   *   9. Return { mission_id, grip_count }
   */
  async missionCreate(request: unknown): Promise<MissionCreateResponse> {
    // Step 1 -- validate request shape.
    if (typeof request !== "object" || request === null) {
      throw new HandlerError("invalid_spec", "octo.mission.create: request must be an object");
    }
    const req = request as Record<string, unknown>;

    // idempotency_key is required.
    if (typeof req.idempotency_key !== "string" || req.idempotency_key.length === 0) {
      throw new HandlerError(
        "invalid_spec",
        "octo.mission.create: idempotency_key is required and must be a non-empty string",
      );
    }
    const idempotencyKey: string = req.idempotency_key;

    const hasSpec = req.mission_spec !== undefined;
    const hasTemplate = req.template_id !== undefined;

    // Both missing.
    if (!hasSpec && !hasTemplate) {
      throw new HandlerError(
        "invalid_spec",
        "octo.mission.create: one of mission_spec or template_id is required",
      );
    }

    // Both present.
    if (hasSpec && hasTemplate) {
      throw new HandlerError(
        "invalid_spec",
        "octo.mission.create: exactly one of mission_spec or template_id may be provided, not both",
      );
    }

    // Step 2 -- template_id is not yet supported.
    if (hasTemplate) {
      throw new HandlerError("not_supported", "octo.mission.create: templates not yet supported", {
        template_id: req.template_id,
      });
    }

    // Step 3 -- validate MissionSpec.
    const specResult = validateMissionSpec(req.mission_spec);
    if (!specResult.ok) {
      throw new HandlerError(
        "invalid_spec",
        `octo.mission.create: invalid MissionSpec: ${specResult.errors.join("; ")}`,
      );
    }
    const spec: MissionSpec = specResult.spec;

    // Step 4 -- idempotency check.
    const existingMission = this.findMissionByIdempotencyKey(idempotencyKey);
    if (existingMission !== null) {
      const gripCount = this.registry.listGrips({ mission_id: existingMission.mission_id }).length;
      return { mission_id: existingMission.mission_id, grip_count: gripCount };
    }

    // Step 5 -- generate mission_id.
    const mission_id = this.generateMissionId();
    const created_at = this.now();

    // Step 6 -- insert MissionRecord.
    const missionInput: MissionInput = {
      mission_id,
      title: spec.title,
      owner: spec.owner,
      status: "active",
      policy_profile_ref: spec.policy_profile_ref ?? null,
      spec,
      metadata: { ...spec.metadata, _idempotency_key: idempotencyKey },
      created_at,
    };
    this.registry.putMission(missionInput);

    // Step 7 -- insert GripRecords.
    for (const node of spec.graph) {
      const gripInput: GripInput = {
        grip_id: node.grip_id,
        mission_id,
        type: "mission_grip",
        input_ref: null,
        priority: 0,
        assigned_arm_id: null,
        status: "queued",
        timeout_s: null,
        side_effecting: false,
        idempotency_key: idempotencyKey,
        result_ref: null,
        spec: {
          spec_version: 1,
          mission_id,
          type: "mission_grip",
          retry_policy: {
            max_attempts: 1,
            backoff: "fixed",
            initial_delay_s: 0,
            max_delay_s: 0,
            multiplier: 1,
            retry_on: [],
            abandon_on: ["unrecoverable"],
          },
          timeout_s: 0,
          side_effecting: false,
        },
        created_at,
      };
      this.registry.putGrip(gripInput);
    }

    // Step 8 -- emit mission.created event.
    await this.eventLog.append({
      schema_version: 1,
      entity_type: "mission",
      entity_id: mission_id,
      event_type: "mission.created",
      ts: new Date(created_at).toISOString(),
      actor: `node-agent:${this.nodeId}`,
      payload: {
        title: spec.title,
        owner: spec.owner,
        grip_count: spec.graph.length,
        idempotency_key: idempotencyKey,
      },
    });

    // Step 9 -- return.
    return { mission_id, grip_count: spec.graph.length };
  }

  /**
   * Handle `octo.mission.pause` (M3-02).
   *
   * Pipeline:
   *   1. Validate request shape (mission_id required, idempotency_key required)
   *   2. Look up mission (not_found if missing)
   *   3. Apply FSM transition active → paused via applyMissionTransition
   *   4. Persist via casUpdateMission
   *   5. Emit mission.paused event
   *   6. Return { mission_id, status: "paused" }
   */
  async missionPause(request: unknown): Promise<MissionPauseResponse> {
    if (typeof request !== "object" || request === null) {
      throw new HandlerError("invalid_spec", "octo.mission.pause: request must be an object");
    }
    const req = request as Record<string, unknown>;

    if (typeof req.idempotency_key !== "string" || req.idempotency_key.length === 0) {
      throw new HandlerError(
        "invalid_spec",
        "octo.mission.pause: idempotency_key is required and must be a non-empty string",
      );
    }

    if (typeof req.mission_id !== "string" || req.mission_id.length === 0) {
      throw new HandlerError(
        "invalid_spec",
        "octo.mission.pause: mission_id is required and must be a non-empty string",
      );
    }
    const mission_id: string = req.mission_id;

    const mission = this.registry.getMission(mission_id);
    if (mission === null) {
      throw new HandlerError("not_found", `octo.mission.pause: mission not found: ${mission_id}`, {
        mission_id,
      });
    }

    // Apply FSM transition. MissionRecord uses `status`, FSM uses `state`.
    const now = this.now();
    let transitioned: { state: MissionState; updated_at: number };
    try {
      transitioned = applyMissionTransition(
        { state: mission.status, updated_at: mission.updated_at },
        "paused",
        { now, mission_id },
      );
    } catch (err) {
      if (err instanceof InvalidTransitionError) {
        throw new HandlerError(
          "invalid_state",
          `octo.mission.pause: mission ${mission_id} is in state "${mission.status}"; ` +
            `cannot transition to "paused"`,
          { mission_id, current_state: mission.status },
        );
      }
      throw err;
    }

    try {
      this.registry.casUpdateMission(mission_id, mission.version, {
        status: transitioned.state,
        updated_at: transitioned.updated_at,
      });
    } catch (err) {
      if (err instanceof ConflictError) {
        throw new HandlerError(
          "conflict",
          `octo.mission.pause: concurrent update on mission ${mission_id}: ${err.message}`,
          { mission_id, expected_version: mission.version },
        );
      }
      throw err;
    }

    await this.eventLog.append({
      schema_version: 1,
      entity_type: "mission",
      entity_id: mission_id,
      event_type: "mission.paused",
      ts: new Date(now).toISOString(),
      actor: `node-agent:${this.nodeId}`,
      payload: {
        reason: typeof req.reason === "string" ? req.reason : undefined,
        previous_state: mission.status,
      },
    });

    return { mission_id, status: "paused" };
  }

  /**
   * Handle `octo.mission.resume` (M3-02).
   *
   * Pipeline:
   *   1. Validate request shape (mission_id required, idempotency_key required)
   *   2. Look up mission (not_found if missing)
   *   3. Apply FSM transition paused → active via applyMissionTransition
   *   4. Persist via casUpdateMission
   *   5. Emit mission.resumed event
   *   6. Return { mission_id, status: "active" }
   */
  async missionResume(request: unknown): Promise<MissionResumeResponse> {
    if (typeof request !== "object" || request === null) {
      throw new HandlerError("invalid_spec", "octo.mission.resume: request must be an object");
    }
    const req = request as Record<string, unknown>;

    if (typeof req.idempotency_key !== "string" || req.idempotency_key.length === 0) {
      throw new HandlerError(
        "invalid_spec",
        "octo.mission.resume: idempotency_key is required and must be a non-empty string",
      );
    }

    if (typeof req.mission_id !== "string" || req.mission_id.length === 0) {
      throw new HandlerError(
        "invalid_spec",
        "octo.mission.resume: mission_id is required and must be a non-empty string",
      );
    }
    const mission_id: string = req.mission_id;

    const mission = this.registry.getMission(mission_id);
    if (mission === null) {
      throw new HandlerError("not_found", `octo.mission.resume: mission not found: ${mission_id}`, {
        mission_id,
      });
    }

    const now = this.now();
    let transitioned: { state: MissionState; updated_at: number };
    try {
      transitioned = applyMissionTransition(
        { state: mission.status, updated_at: mission.updated_at },
        "active",
        { now, mission_id },
      );
    } catch (err) {
      if (err instanceof InvalidTransitionError) {
        throw new HandlerError(
          "invalid_state",
          `octo.mission.resume: mission ${mission_id} is in state "${mission.status}"; ` +
            `cannot transition to "active"`,
          { mission_id, current_state: mission.status },
        );
      }
      throw err;
    }

    try {
      this.registry.casUpdateMission(mission_id, mission.version, {
        status: transitioned.state,
        updated_at: transitioned.updated_at,
      });
    } catch (err) {
      if (err instanceof ConflictError) {
        throw new HandlerError(
          "conflict",
          `octo.mission.resume: concurrent update on mission ${mission_id}: ${err.message}`,
          { mission_id, expected_version: mission.version },
        );
      }
      throw err;
    }

    await this.eventLog.append({
      schema_version: 1,
      entity_type: "mission",
      entity_id: mission_id,
      event_type: "mission.resumed",
      ts: new Date(now).toISOString(),
      actor: `node-agent:${this.nodeId}`,
      payload: {
        previous_state: mission.status,
      },
    });

    return { mission_id, status: "active" };
  }

  /**
   * Handle `octo.mission.abort` (M3-02).
   *
   * Pipeline:
   *   1. Validate request shape (mission_id + reason required, idempotency_key required)
   *   2. Look up mission (not_found if missing)
   *   3. Apply FSM transition active/paused → aborted via applyMissionTransition
   *   4. Persist via casUpdateMission
   *   5. Cascade: terminate all starting/active/idle/blocked arms belonging
   *      to this mission via armTerminate
   *   6. Emit mission.aborted event
   *   7. Return { mission_id, status: "aborted", arms_terminated }
   */
  async missionAbort(request: unknown): Promise<MissionAbortResponse> {
    if (typeof request !== "object" || request === null) {
      throw new HandlerError("invalid_spec", "octo.mission.abort: request must be an object");
    }
    const req = request as Record<string, unknown>;

    if (typeof req.idempotency_key !== "string" || req.idempotency_key.length === 0) {
      throw new HandlerError(
        "invalid_spec",
        "octo.mission.abort: idempotency_key is required and must be a non-empty string",
      );
    }

    if (typeof req.mission_id !== "string" || req.mission_id.length === 0) {
      throw new HandlerError(
        "invalid_spec",
        "octo.mission.abort: mission_id is required and must be a non-empty string",
      );
    }
    const mission_id: string = req.mission_id;

    if (typeof req.reason !== "string" || req.reason.length === 0) {
      throw new HandlerError(
        "invalid_spec",
        "octo.mission.abort: reason is required and must be a non-empty string",
      );
    }
    const reason: string = req.reason;

    const mission = this.registry.getMission(mission_id);
    if (mission === null) {
      throw new HandlerError("not_found", `octo.mission.abort: mission not found: ${mission_id}`, {
        mission_id,
      });
    }

    const now = this.now();
    let transitioned: { state: MissionState; updated_at: number };
    try {
      transitioned = applyMissionTransition(
        { state: mission.status, updated_at: mission.updated_at },
        "aborted",
        { now, mission_id },
      );
    } catch (err) {
      if (err instanceof InvalidTransitionError) {
        throw new HandlerError(
          "invalid_state",
          `octo.mission.abort: mission ${mission_id} is in state "${mission.status}"; ` +
            `cannot transition to "aborted"`,
          { mission_id, current_state: mission.status },
        );
      }
      throw err;
    }

    try {
      this.registry.casUpdateMission(mission_id, mission.version, {
        status: transitioned.state,
        updated_at: transitioned.updated_at,
      });
    } catch (err) {
      if (err instanceof ConflictError) {
        throw new HandlerError(
          "conflict",
          `octo.mission.abort: concurrent update on mission ${mission_id}: ${err.message}`,
          { mission_id, expected_version: mission.version },
        );
      }
      throw err;
    }

    // Cascade: terminate all live arms belonging to this mission.
    const arms = this.registry.listArms({ mission_id });
    const cascadeStates = new Set(["starting", "active", "idle", "blocked"]);
    let armsTerminated = 0;
    for (const arm of arms) {
      if (cascadeStates.has(arm.state)) {
        try {
          await this.armTerminate({
            idempotency_key: `abort-cascade-${mission_id}-${arm.arm_id}`,
            arm_id: arm.arm_id,
            reason: `mission aborted: ${reason}`,
            force: true,
          });
          armsTerminated += 1;
        } catch {
          // Best-effort cascade — if an individual arm terminate fails
          // (e.g. already terminated by a concurrent writer), continue
          // with the remaining arms. The mission is already aborted.
          armsTerminated += 1;
        }
      }
    }

    // Cascade: abandon all non-terminal grips belonging to this mission.
    // Without this, queued/assigned grips remain in the registry and block
    // reuse of their grip IDs in a retry mission.
    const grips = this.registry.listGrips({ mission_id });
    let gripsAbandoned = 0;
    for (const grip of grips) {
      if (isGripTerminal(grip.status as GripState)) {
        continue;
      }
      try {
        const next = applyGripTransition(
          { state: grip.status, updated_at: grip.updated_at },
          "abandoned",
          { now, grip_id: grip.grip_id },
        );
        this.registry.casUpdateGrip(grip.grip_id, grip.version, {
          status: next.state,
          updated_at: next.updated_at,
        });
        gripsAbandoned += 1;
      } catch {
        // Best-effort — if a grip can't transition (e.g. running/blocked
        // grips that need to go through failed first), skip it. The mission
        // is already aborted; these grips will be cleaned up by the
        // retention sweep or operator action.
        gripsAbandoned += 1;
      }
    }

    await this.eventLog.append({
      schema_version: 1,
      entity_type: "mission",
      entity_id: mission_id,
      event_type: "mission.aborted",
      ts: new Date(now).toISOString(),
      actor: `node-agent:${this.nodeId}`,
      payload: {
        reason,
        previous_state: mission.status,
        arms_terminated: armsTerminated,
        grips_abandoned: gripsAbandoned,
      },
    });

    return { mission_id, status: "aborted", arms_terminated: armsTerminated };
  }

  /**
   * Handle `octo.lease.renew` push event (M4-02).
   *
   * Processes a batched lease heartbeat from a Node Agent. For each lease
   * entry in the push, calls LeaseService.renew. Unknown arms or expired
   * leases are reported as per-entry errors (not handler-level throws) so
   * a single bad arm does not block renewal of the rest of the batch.
   *
   * Requires `leaseService` in deps; throws HandlerError("internal") if
   * not configured. Schema validation via OctoLeaseRenewPushSchema.
   */
  async leaseRenew(push: unknown): Promise<LeaseRenewResult> {
    if (!this.leaseService) {
      throw new HandlerError(
        "internal",
        "octo.lease.renew: leaseService not configured in handler deps",
      );
    }

    if (!Value.Check(OctoLeaseRenewPushSchema, push)) {
      const errors = [...Value.Errors(OctoLeaseRenewPushSchema, push)].map(
        (e) => `${e.path || "<root>"}: ${e.message}`,
      );
      throw new HandlerError(
        "invalid_spec",
        `octo.lease.renew: invalid push envelope: ${errors.join("; ")}`,
      );
    }
    const validPush: OctoLeaseRenewPush = push;

    const results: LeaseRenewResultEntry[] = [];

    for (const entry of validPush.leases) {
      // Verify the arm exists in the registry.
      const arm = this.registry.getArm(entry.arm_id);
      if (arm === null) {
        results.push({
          arm_id: entry.arm_id,
          renewed: false,
          error: `unknown arm: ${entry.arm_id}`,
        });
        continue;
      }

      try {
        await this.leaseService.renew(entry.arm_id);
        results.push({ arm_id: entry.arm_id, renewed: true });
      } catch (err) {
        results.push({
          arm_id: entry.arm_id,
          renewed: false,
          error: describeError(err),
        });
      }
    }

    return { node_id: validPush.node_id, results };
  }

  // ────────────────────────────────────────────────────────────────────────
  // Private helpers
  // ────────────────────────────────────────────────────────────────────────

  /**
   * Find a mission by idempotency_key. Scans listMissions -- O(N) at M3
   * scale is acceptable; a future milestone will add an indexed lookup.
   */
  private findMissionByIdempotencyKey(idempotencyKey: string): { mission_id: string } | null {
    const missions = this.registry.listMissions();
    for (const m of missions) {
      const meta = m.metadata;
      if (meta !== null && meta._idempotency_key === idempotencyKey) {
        return { mission_id: m.mission_id };
      }
    }
    return null;
  }

  private findArmByIdempotencyKey(idempotency_key: string): ArmRecord | null {
    // listArms has no idempotency_key filter, so we scan. At M1 scale
    // (dozens of arms per node) this is fine; see method docstring.
    const arms = this.registry.listArms({ node_id: this.nodeId });
    for (const arm of arms) {
      if (arm.spec.idempotency_key === idempotency_key) {
        return arm;
      }
    }
    return null;
  }

  private extractSessionRef(arm: ArmRecord): SessionRef | null {
    const raw = arm.session_ref;
    if (raw === null || typeof raw !== "object") {
      return null;
    }
    const candidate = raw as Partial<SessionRef>;
    if (typeof candidate.cwd !== "string" || candidate.cwd.length === 0) {
      return null;
    }
    // Re-shape to the SessionRef type. Extra properties are fine — the
    // method response schema uses additionalProperties: false so any
    // unknown keys would have been rejected on the way in.
    return candidate as SessionRef;
  }

  /**
   * Build an adapter-layer SessionRef from the arm row's wire session_ref
   * and registry fields. Used by armSend and armCheckpoint to pass to
   * adapter.send() / adapter.checkpoint().
   */
  private buildAdapterSessionRef(arm: ArmRecord): AdapterSessionRef {
    const rawRef = arm.session_ref;
    const sessionName = sessionNameForArm(arm.arm_id);
    return {
      adapter_type: arm.adapter_type,
      session_id: (rawRef?.tmux_session_name as string | undefined) ?? sessionName,
      cwd: (rawRef?.cwd as string | undefined) ?? "/tmp",
      attach_command: rawRef?.attach_command as string | undefined,
      metadata: rawRef as Record<string, unknown> | undefined,
    };
  }

  private async markArmFailed(arm: ArmRecord, reason: string): Promise<void> {
    const failedTs = this.now();
    try {
      const failedLike = applyArmTransition(
        { state: arm.state, updated_at: arm.updated_at },
        "failed" satisfies ArmState,
        { now: failedTs, arm_id: arm.arm_id },
      );
      this.registry.casUpdateArm(arm.arm_id, arm.version, {
        state: failedLike.state,
        updated_at: failedLike.updated_at,
        health_status: "failed",
      });
    } catch {
      // Best-effort — if the CAS update or FSM transition fails here,
      // the caller still gets the HandlerError and the row remains in
      // whatever state it was in. We do not want a secondary failure
      // to mask the primary tmux error.
    }

    try {
      await this.eventLog.append({
        schema_version: 1,
        entity_type: "arm",
        entity_id: arm.arm_id,
        event_type: "arm.failed",
        ts: new Date(failedTs).toISOString(),
        actor: `node-agent:${this.nodeId}`,
        payload: { reason },
      });
    } catch {
      // Best-effort — see comment above.
    }
  }
}

// ──────────────────────────────────────────────────────────────────────────
// Internal utilities
// ──────────────────────────────────────────────────────────────────────────

function describeError(err: unknown): string {
  if (err instanceof Error) {
    return err.message;
  }
  return String(err);
}

// ──────────────────────────────────────────────────────────────────────────
// Health + terminate helpers (M1-15, M1-16)
// ──────────────────────────────────────────────────────────────────────────

/**
 * Map the arm FSM `state` column onto the HealthStatus wire enum. The
 * HealthStatus union does NOT include `pending`, `completed`, or
 * `archived`, so those states are mapped to the closest wire equivalent:
 *   - `pending`   → `starting` (the arm is on its way up)
 *   - `completed` → `terminated` (the arm is done and gone)
 *   - `archived`  → `terminated` (absorbing terminal state)
 * Unknown states fall through to `unresponsive` as a safe default.
 */
function armStateToHealthStatus(state: string): HealthStatus {
  switch (state) {
    case "starting":
      return "starting";
    case "active":
      return "active";
    case "idle":
      return "idle";
    case "blocked":
      return "blocked";
    case "failed":
      return "failed";
    case "quarantined":
      return "quarantined";
    case "terminated":
      return "terminated";
    case "pending":
      return "starting";
    case "completed":
      return "terminated";
    case "archived":
      return "terminated";
    default:
      return "unresponsive";
  }
}

/**
 * If the arm row already has a `health_status` column set (e.g. by
 * ProcessWatcher in M1-12), prefer it over the FSM-state-derived value.
 * Only accept values that validate against the HealthStatus union;
 * otherwise fall back to the FSM-derived status.
 */
function deriveHealthStatus(arm: ArmRecord): HealthStatus {
  const raw = arm.health_status;
  if (raw !== null && isHealthStatus(raw)) {
    return raw;
  }
  return armStateToHealthStatus(arm.state);
}

const HEALTH_STATUS_VALUES: readonly HealthStatus[] = [
  "starting",
  "active",
  "idle",
  "blocked",
  "unresponsive",
  "failed",
  "quarantined",
  "terminated",
];

function isHealthStatus(value: string): value is HealthStatus {
  return (HEALTH_STATUS_VALUES as readonly string[]).includes(value);
}

/**
 * States from which a `terminated` transition is valid per M1-07's
 * ARM_TRANSITIONS map. Computed statically here (rather than imported)
 * to keep the handler's intent explicit at the call site and decoupled
 * from accidental future FSM loosening.
 */
const TERMINATABLE_STATES: ReadonlySet<string> = new Set<string>([
  "active",
  "idle",
  "blocked",
  "failed",
  "quarantined",
]);

function canTransitionToTerminated(state: string): boolean {
  return TERMINATABLE_STATES.has(state);
}
