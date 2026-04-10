// Octopus Orchestrator — Node Agent SessionReconciler (M1-13)
//
// References:
//   - LLD.md §SessionReconciler behavior (line 533) — the binding
//     contract this module implements. On startup (or periodic audit)
//     the Node Agent enumerates live tmux sessions, compares them
//     against persisted ArmRecords for this node, and produces a
//     structured report of recovered arms, orphaned sessions, and
//     missing-expected sessions.
//   - LLD.md §Recovery Flows §2 ("Node restart") — the operational
//     scenario this serves. After a Node Agent reboot we need to
//     discover tmux sessions, restore local arm mapping, and emit
//     reconciliation events so the Head can re-synchronise its view.
//   - LLD.md §Node Agent Internals (line ~522) — module layout.
//   - src/octo/wire/events.ts — AnomalyKindSchema / AnomalySeveritySchema
//     define the anomaly vocabulary we emit as structured records. The
//     two kinds this reconciler produces are `orphaned_session` and
//     `missing_expected_session`, plus `other` for FSM drift.
//   - DECISIONS.md OCTO-DEC-033 — no imports from src/infra/** or other
//     upstream OpenClaw internals. This file depends only on relative
//     sibling modules inside src/octo/.
//
// ──────────────────────────────────────────────────────────────────────
// Session-name convention
// ──────────────────────────────────────────────────────────────────────
//
// Per HLD §"tmux as a Foundational Substrate" we derive a stable tmux
// session name from the arm_id so the reconciler can do a pure string
// match without consulting any sidecar index. The canonical form is:
//
//     `${sessionNamePrefix}${arm_id}`
//
// where `sessionNamePrefix` defaults to `"octo-arm-"`. The prefix is
// configurable on the reconciler (SessionReconcilerOptions.sessionNamePrefix)
// so that tests can use a per-run prefix to stay isolated from real
// sessions on the developer's machine. M1-14 (spawn handler) will USE
// the same prefix convention when it creates sessions; keeping both
// sides of the naming contract in one place is deliberate.
//
// arm_ids are assumed to contain only characters tmux accepts in
// session names (alphanumerics, hyphens, underscores). The Registry
// does not enforce this today; if a downstream producer uses a
// tmux-unsafe arm_id the TmuxManager validation at session-create time
// will reject it before the reconciler ever sees it.
//
// ──────────────────────────────────────────────────────────────────────
// arm.recovered vs arm.reattached
// ──────────────────────────────────────────────────────────────────────
//
// Both events live in CoreEventTypeSchema (src/octo/wire/events.ts) and
// are related but distinct:
//
//   - `arm.recovered` — this reconciler's output. A persisted ArmRecord
//     was matched to a live tmux session on startup. The arm is moved
//     from "starting/blocked/etc." back to `active` (when the FSM
//     allows), and the caller will emit arm.recovered for each match.
//
//   - `arm.reattached` — a narrower scenario where an already-active
//     arm rebinds to a session it was temporarily detached from
//     (e.g. after a pane ownership transfer). Not produced here.
//
// SessionReconciler returns structured outcomes; the Node Agent main
// loop (the caller) is responsible for actually emitting events to the
// wire. In particular:
//
//   - `octo.anomaly` is a PUSH EVENT (OctoAnomalyPushSchema), NOT an
//     entry in CoreEventTypeSchema. The reconciler does NOT push to
//     the Head itself — it produces ReconciliationOutcome records and
//     the caller decides whether to forward them upstream, log them
//     locally, or both.
//
// ──────────────────────────────────────────────────────────────────────
// Policy discipline: surface, do not enforce
// ──────────────────────────────────────────────────────────────────────
//
// Orphans (live sessions with no matching arm row) are NOT auto-killed
// by this module. Missing-expected arms (rows in `active`/`idle`/etc.
// with no live session) are NOT auto-failed. Both are policy decisions
// that belong to the operator and/or a higher policy layer; the
// reconciler's job is to surface the discrepancy as a typed anomaly
// record so that layer can act on it. Auto-enforcement here would
// violate OCTO-DEC-033's "surface, don't enforce" boundary discipline.

import {
  applyArmTransition,
  InvalidTransitionError,
  isArmState,
  type ArmState,
} from "../head/arm-fsm.ts";
import type { RegistryService, ArmRecord } from "../head/registry.ts";
import { ConflictError } from "../head/registry.ts";
import type { TmuxManager, TmuxSessionInfo } from "./tmux-manager.ts";

// ══════════════════════════════════════════════════════════════════════
// Public types
// ══════════════════════════════════════════════════════════════════════

/**
 * Default prefix used to tag Octopus-managed tmux sessions. Tests
 * override this via {@link SessionReconcilerOptions.sessionNamePrefix}.
 */
export const DEFAULT_SESSION_NAME_PREFIX = "octo-arm-";

/**
 * Arm states that, per the FSM, imply a live tmux session SHOULD exist
 * on the owning Node Agent. Arms outside this set (pending before
 * spawn, any terminal state, or a failure-bucket state) are not
 * expected to have a live session and therefore do NOT produce a
 * "missing_expected_session" anomaly when absent.
 *
 * `pending` is deliberately excluded: an arm in `pending` has not yet
 * been scheduled for spawn. `failed` and `quarantined` are excluded
 * because those states represent arms that have already lost their
 * session (the FSM transitions out of active/starting/etc. into
 * failed/quarantined when the session is gone).
 */
export const EXPECTED_LIVE_SESSION_STATES: ReadonlySet<ArmState> = new Set<ArmState>([
  "starting",
  "active",
  "idle",
  "blocked",
]);

export interface SessionReconcilerOptions {
  /**
   * This Node Agent's `node_id`. Used to filter the registry to arms
   * belonging to this node so a reconciler on host A never touches
   * arms bound to host B.
   */
  nodeId: string;

  /**
   * Prefix used to identify Octopus-managed tmux sessions among the
   * full enumerated set. Sessions not matching the prefix are ignored
   * (they belong to other tmux users on the machine and are out of
   * scope for reconciliation). Defaults to {@link DEFAULT_SESSION_NAME_PREFIX}.
   */
  sessionNamePrefix?: string;

  /**
   * Optional now() injection for deterministic tests. Used as the
   * timestamp on every outcome record and as the `now` field passed
   * into {@link applyArmTransition}.
   */
  now?: () => number;

  /**
   * Optional structured logger. SessionReconciler calls this with
   * `{ level, message, ...details }` for noteworthy non-fatal events
   * (CAS conflicts, FSM drift). If not provided, messages are
   * swallowed silently — the return value of `reconcile()` is the
   * authoritative structured output.
   */
  logger?: (entry: {
    level: "info" | "warn" | "error";
    message: string;
    details?: Record<string, unknown>;
  }) => void;
}

/**
 * A single outcome produced by {@link SessionReconciler.reconcile}.
 * The caller (Node Agent main loop) decides what to do with each —
 * emit a wire event, log it, push an anomaly to the Head, etc.
 */
export type ReconciliationOutcome =
  | {
      kind: "recovered";
      arm_id: string;
      session_name: string;
      previous_state: string;
      new_state: ArmState;
      /** True if the FSM transition was applied; false if the arm was
       *  already in `active` / `idle` and we left it alone. */
      transition_applied: boolean;
      ts: number;
    }
  | {
      kind: "anomaly";
      anomaly_kind: "orphaned_session" | "missing_expected_session" | "other";
      severity: "info" | "warning" | "error" | "critical";
      description: string;
      session_name?: string;
      affected_arm_id?: string;
      ts: number;
    };

export interface ReconciliationReport {
  outcomes: ReconciliationOutcome[];
  recovered_count: number;
  orphan_count: number;
  missing_count: number;
  other_anomaly_count: number;
  total_live_sessions: number;
  total_persisted_arms: number;
}

// ══════════════════════════════════════════════════════════════════════
// SessionReconciler
// ══════════════════════════════════════════════════════════════════════

export class SessionReconciler {
  private readonly sessionNamePrefix: string;
  private readonly nowFn: () => number;

  constructor(
    private readonly tmuxManager: TmuxManager,
    private readonly registry: RegistryService,
    private readonly opts: SessionReconcilerOptions,
  ) {
    if (typeof opts.nodeId !== "string" || opts.nodeId.length === 0) {
      throw new Error("SessionReconciler: nodeId must be a non-empty string");
    }
    this.sessionNamePrefix = opts.sessionNamePrefix ?? DEFAULT_SESSION_NAME_PREFIX;
    if (this.sessionNamePrefix.length === 0) {
      throw new Error("SessionReconciler: sessionNamePrefix must not be empty");
    }
    this.nowFn = opts.now ?? (() => Date.now());
  }

  /**
   * Compute the canonical tmux session name for the given arm_id. The
   * inverse is {@link armIdFromSessionName}.
   */
  sessionNameForArm(arm_id: string): string {
    return `${this.sessionNamePrefix}${arm_id}`;
  }

  /**
   * Extract the arm_id from a session name, or return null if the
   * name does not match the configured prefix. A non-null return is
   * guaranteed to be the exact substring after the prefix; no further
   * validation is performed here.
   */
  armIdFromSessionName(session_name: string): string | null {
    if (!session_name.startsWith(this.sessionNamePrefix)) {
      return null;
    }
    const suffix = session_name.slice(this.sessionNamePrefix.length);
    if (suffix.length === 0) {
      return null;
    }
    return suffix;
  }

  /**
   * Run a single reconciliation pass. See the file header for the
   * algorithm description. This method does NOT push anything to the
   * wire — it returns a structured report and the caller decides what
   * to do with each outcome.
   *
   * Throws if the underlying enumeration calls fail catastrophically
   * (tmux unavailable, SQLite corrupt). Per-arm failures (CAS conflict,
   * FSM drift) are caught and surfaced as outcomes; they do NOT abort
   * the whole reconciliation.
   */
  async reconcile(): Promise<ReconciliationReport> {
    // Step 1: snapshot the world. tmux enumeration is async; the
    // registry call is sync. Kick off the async one first so the sync
    // query overlaps with tmux subprocess startup.
    const liveSessionsPromise = this.tmuxManager.enumerateExisting();
    const allArms = this.registry.listArms({ node_id: this.opts.nodeId });
    const liveSessions = await liveSessionsPromise;

    // Step 2: filter live sessions to those matching the prefix and
    // index them by the embedded arm_id.
    const liveByArmId = new Map<string, TmuxSessionInfo>();
    for (const session of liveSessions) {
      const arm_id = this.armIdFromSessionName(session.name);
      if (arm_id === null) {
        continue;
      }
      // If two sessions somehow claim the same arm_id the later one
      // wins the map slot; both names would appear in the orphan check
      // only if no arm row exists. We surface the collision via the
      // outcomes path indirectly — duplicate sessions are rare enough
      // that M1 does not model them explicitly (M1-13 acceptance does
      // not require duplicate detection).
      liveByArmId.set(arm_id, session);
    }

    // Step 3: partition the arm rows. Expected-live arms are those the
    // FSM says SHOULD currently own a tmux session. Everything else is
    // skipped — neither a match nor a missing anomaly.
    const expectedLiveArms = new Map<string, ArmRecord>();
    for (const arm of allArms) {
      if (isArmState(arm.state) && EXPECTED_LIVE_SESSION_STATES.has(arm.state)) {
        expectedLiveArms.set(arm.arm_id, arm);
      }
    }

    const outcomes: ReconciliationOutcome[] = [];
    let recovered_count = 0;
    let orphan_count = 0;
    let missing_count = 0;
    let other_anomaly_count = 0;

    // Step 4a: matches — for every expected-live arm with a live
    // session, attempt the recovery transition.
    for (const [arm_id, arm] of expectedLiveArms) {
      const session = liveByArmId.get(arm_id);
      if (session === undefined) {
        continue;
      }
      const outcome = this.recoverMatchedArm(arm, session);
      outcomes.push(outcome);
      if (outcome.kind === "recovered") {
        recovered_count++;
      } else {
        // recoverMatchedArm only ever returns "recovered" or an
        // anomaly-with-kind-other on FSM drift / CAS conflict. Count
        // the drift under other_anomaly_count.
        other_anomaly_count++;
      }
    }

    // Step 4b: orphans — live sessions with the Octopus prefix but no
    // matching arm row in ANY state (not just expected-live). An
    // orphan is ANY live session whose embedded arm_id is not present
    // in the full arm set for this node, OR is present in a terminal
    // state (at which point the session should have been torn down).
    const allArmsById = new Map<string, ArmRecord>();
    for (const arm of allArms) {
      allArmsById.set(arm.arm_id, arm);
    }
    for (const [arm_id, session] of liveByArmId) {
      const arm = allArmsById.get(arm_id);
      if (arm === undefined) {
        outcomes.push({
          kind: "anomaly",
          anomaly_kind: "orphaned_session",
          severity: "warning",
          description: `tmux session "${session.name}" (arm_id=${arm_id}) has no matching ArmRecord on node=${this.opts.nodeId}`,
          session_name: session.name,
          affected_arm_id: arm_id,
          ts: this.nowFn(),
        });
        orphan_count++;
        this.log("warn", "orphaned_session detected", {
          session_name: session.name,
          arm_id,
          node_id: this.opts.nodeId,
        });
        continue;
      }
      // Arm exists but is in a state that does NOT expect a live
      // session — that's also an orphan (the session should have been
      // killed when the arm moved to failed/completed/terminated/etc.).
      if (!isArmState(arm.state) || !EXPECTED_LIVE_SESSION_STATES.has(arm.state)) {
        outcomes.push({
          kind: "anomaly",
          anomaly_kind: "orphaned_session",
          severity: "warning",
          description: `tmux session "${session.name}" exists but arm ${arm_id} is in state=${arm.state} which does not expect a live session`,
          session_name: session.name,
          affected_arm_id: arm_id,
          ts: this.nowFn(),
        });
        orphan_count++;
        this.log("warn", "orphaned_session (arm in non-live state)", {
          session_name: session.name,
          arm_id,
          arm_state: arm.state,
        });
      }
    }

    // Step 4c: missing — expected-live arms with no matching live
    // session. Surface as missing_expected_session anomalies.
    for (const [arm_id, arm] of expectedLiveArms) {
      if (liveByArmId.has(arm_id)) {
        continue;
      }
      outcomes.push({
        kind: "anomaly",
        anomaly_kind: "missing_expected_session",
        severity: "warning",
        description: `ArmRecord ${arm_id} is in state=${arm.state} on node=${this.opts.nodeId} but no matching tmux session was found`,
        affected_arm_id: arm_id,
        ts: this.nowFn(),
      });
      missing_count++;
      this.log("warn", "missing_expected_session detected", {
        arm_id,
        arm_state: arm.state,
        node_id: this.opts.nodeId,
      });
    }

    return {
      outcomes,
      recovered_count,
      orphan_count,
      missing_count,
      other_anomaly_count,
      total_live_sessions: liveSessions.length,
      total_persisted_arms: allArms.length,
    };
  }

  // ────────────────────────────────────────────────────────────────────
  // Internal helpers
  // ────────────────────────────────────────────────────────────────────

  /**
   * Handle the "arm row + live session matched" case. Applies the
   * recovery state transition via ArmFSM when needed, persists via
   * CAS update, and returns a single ReconciliationOutcome.
   *
   * Rules:
   *   - If the arm is already `active` or `idle`, the FSM is a no-op.
   *     We still emit a "recovered" outcome so the caller can log /
   *     emit `arm.recovered` for auditability, but `transition_applied`
   *     is false and the row version is NOT bumped.
   *   - Otherwise we attempt `applyArmTransition(arm, "active")`. For
   *     any arm in `starting` / `blocked` this is a valid FSM edge.
   *     For states where `active` is unreachable in one step (e.g.
   *     `pending`, which the expected-live filter excludes but FSM
   *     drift could conceivably produce) the FSM throws
   *     InvalidTransitionError; we catch it and return an anomaly
   *     outcome of kind `other`.
   *   - ConflictError from CAS update is caught and returned as an
   *     `other` anomaly so the caller is informed but the pass
   *     continues.
   */
  private recoverMatchedArm(arm: ArmRecord, session: TmuxSessionInfo): ReconciliationOutcome {
    const ts = this.nowFn();
    const previous_state = arm.state;

    // Already in a steady-live state → no FSM transition needed.
    if (arm.state === "active" || arm.state === "idle") {
      this.log("info", "arm already in live state, no transition applied", {
        arm_id: arm.arm_id,
        session_name: session.name,
        arm_state: arm.state,
      });
      return {
        kind: "recovered",
        arm_id: arm.arm_id,
        session_name: session.name,
        previous_state,
        new_state: arm.state,
        transition_applied: false,
        ts,
      };
    }

    let nextState: ArmState;
    try {
      const transitioned = applyArmTransition(arm, "active", {
        now: ts,
        arm_id: arm.arm_id,
      });
      nextState = transitioned.state;
    } catch (err) {
      if (err instanceof InvalidTransitionError) {
        this.log("warn", "FSM rejected recovery transition", {
          arm_id: arm.arm_id,
          from: err.from,
          to: err.to,
        });
        return {
          kind: "anomaly",
          anomaly_kind: "other",
          severity: "error",
          description: `FSM drift: arm ${arm.arm_id} is in state=${previous_state}, matched session "${session.name}", but active is not reachable in one step (${err.message})`,
          session_name: session.name,
          affected_arm_id: arm.arm_id,
          ts,
        };
      }
      throw err;
    }

    try {
      this.registry.casUpdateArm(arm.arm_id, arm.version, {
        state: nextState,
      });
    } catch (err) {
      if (err instanceof ConflictError) {
        this.log("warn", "CAS conflict during recovery — skipping arm", {
          arm_id: arm.arm_id,
          expected_version: arm.version,
          actual_version: err.actualVersion,
        });
        return {
          kind: "anomaly",
          anomaly_kind: "other",
          severity: "warning",
          description: `CAS conflict recovering arm ${arm.arm_id}: expected version=${arm.version}, actual=${err.actualVersion ?? "null"}`,
          session_name: session.name,
          affected_arm_id: arm.arm_id,
          ts,
        };
      }
      throw err;
    }

    return {
      kind: "recovered",
      arm_id: arm.arm_id,
      session_name: session.name,
      previous_state,
      new_state: nextState,
      transition_applied: true,
      ts,
    };
  }

  private log(
    level: "info" | "warn" | "error",
    message: string,
    details?: Record<string, unknown>,
  ): void {
    if (this.opts.logger !== undefined) {
      this.opts.logger({ level, message, details });
    }
  }
}
