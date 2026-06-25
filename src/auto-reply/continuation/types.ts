/**
 * Core type definitions for the continuation system.
 *
 * RFC: docs/design/continue-work-signal-v2.md
 *
 * These types are shared across signal parsing, scheduling, delegate dispatch,
 * state persistence, and tool definitions. They represent the contracts that
 * the rest of the continuation surface is built on.
 */

import type {
  ContinuationCrossSessionTargetingPolicy,
  ContinuationDelegateFanoutMode,
} from "./targeting-pure.js";

// ---------------------------------------------------------------------------
// Continuation signals — parsed from response text or captured from tool calls
// ---------------------------------------------------------------------------

/**
 * A parsed continuation signal from either bracket syntax or a tool call.
 *
 * Tool path: `continue_work()` sets kind="work", `continue_delegate()` sets kind="delegate".
 * Token path: `CONTINUE_WORK` / `CONTINUE_WORK:N` → kind="work",
 *             `[[CONTINUE_DELEGATE: task]]` → kind="delegate".
 *
 * Both paths converge into the same scheduler — the signal shape is identical
 * regardless of origin.
 */
export type ContinuationSignal =
  | {
      kind: "work";
      delayMs?: number;
      traceparent?: string;
    }
  | {
      kind: "delegate";
      task: string;
      delayMs?: number;
      silent?: boolean;
      silentWake?: boolean;
      postCompaction?: boolean;
      targetSessionKey?: string;
      targetSessionKeys?: string[];
      fanoutMode?: ContinuationDelegateFanoutMode;
      traceparent?: string;
      /**
       * Optional provider/model override for the spawned delegate. Omitted =>
       * the delegate inherits the dispatching session's model (existing
       * behavior). Same contract as `sessions_spawn(model)`.
       */
      model?: string;
    };

// ---------------------------------------------------------------------------
// Pending delegates — enqueued by continue_delegate tool, consumed post-response
// ---------------------------------------------------------------------------

/**
 * A delegate waiting to be dispatched after the current turn completes.
 * Enqueued by the `continue_delegate` tool during execution, consumed by
 * the delegate dispatch module after the response finalizes.
 *
 * `mode` is the single source of truth for silent/silent-wake/post-compaction
 * behaviour. Legacy persisted TaskFlow rows may still carry boolean flags, but
 * runtime objects never do.
 */
export type PendingContinuationDelegate = {
  task: string;
  delayMs?: number;
  mode?: "normal" | "silent" | "silent-wake" | "post-compaction";
  firstArmedAt?: number;
  targetSessionKey?: string;
  targetSessionKeys?: string[];
  fanoutMode?: ContinuationDelegateFanoutMode;
  traceparent?: string;
  /**
   * Optional provider/model override forwarded to the spawned delegate.
   * Omitted => inherit the dispatching session's model.
   */
  model?: string;
  /**
   * Internal TaskFlow metadata carried from consume → dispatch so downstream
   * spawn/release failures can flip the row from succeeded → failed without
   * re-querying or guessing revision state.
   */
  flowId?: string;
  expectedRevision?: number;
};

// ---------------------------------------------------------------------------
// Continuation runtime config — resolved from gateway config at use time
// ---------------------------------------------------------------------------

/**
 * Resolved continuation configuration. Read from `agents.defaults.continuation`
 * at each enforcement point (hot-reloadable).
 *
 * Note: no `generationGuardTolerance` field. The generation guard mechanism
 * was removed (2026-04-15): unrelated channel noise must not cancel
 * dispatched continuation work.
 */
export type ContinuationRuntimeConfig = {
  enabled: boolean;
  defaultDelayMs: number;
  minDelayMs: number;
  maxDelayMs: number;
  maxChainLength: number;
  costCapTokens: number;
  maxDelegatesPerTurn: number;
  /**
   * Max concurrent undelivered continue_work flows per session (#986).
   * Enforced at enqueue; orthogonal to maxChainLength (lineage depth) — this
   * bounds store pressure / the multi-continue_work flood foot-gun.
   */
  maxPendingWork: number;
  crossSessionTargeting: ContinuationCrossSessionTargetingPolicy;
  contextPressureThreshold?: number;
  earlyWarningBand?: number;
  /**
   * #990 busy-skip exp-backoff bounds (rate-cap, NOT a safety invariant).
   * `baseMs` = first re-arm delay, multiplied by `factor` per consecutive
   * busy-skip up to `ceilingMs` (the give-up rate-cap — the flow keeps deferring
   * at this rate forever, never dropped). Always populated by
   * resolveContinuationRuntimeConfig; optional on the type (like earlyWarningBand)
   * so hand-built fixtures may omit it.
   */
  busySkipBackoff?: { baseMs: number; ceilingMs: number; factor: number };
  /**
   * #990 orphan-reap confidence-gate floor (ms). An unended subagent run is
   * treated as confident-terminal (reap-eligible) only after it ages past this
   * cutoff; `undefined` uses the subagent-registry default. The per-run timeout
   * is always respected (a run is never reaped before its own timeout + grace).
   * The safety invariants (uncertain→quiesce, never-wrongful-reap) are NOT
   * tunable — only this confidence-window floor is.
   */
  orphanReapStaleCutoffMs?: number;
};

// ---------------------------------------------------------------------------
// Post-compaction delegate staging
// ---------------------------------------------------------------------------

/**
 * A delegate staged for release after compaction completes.
 * Serialized into the TaskFlow state payload by `buildDelegateState`
 * (see `delegate-store.ts`) — no longer lives on `SessionEntry`.
 * Released in the after-compaction lifecycle path with
 * `silentAnnounce: true` and `wakeOnReturn: true`.
 */
export type StagedPostCompactionDelegate = {
  task: string;
  stagedAt: number;
  firstArmedAt?: number;
  targetSessionKey?: string;
  targetSessionKeys?: string[];
  fanoutMode?: ContinuationDelegateFanoutMode;
  traceparent?: string;
  /** Optional provider/model override; omitted => inherit parent. */
  model?: string;
};

// ---------------------------------------------------------------------------
// continue_work tool-call request shape
// ---------------------------------------------------------------------------

/**
 * Captured by `continue_work()` during tool execution; consumed by the runner
 * in the same turn's post-response. Same-turn ephemeral — never persisted
 * across turn boundaries or gateway restarts.
 *
 * Single canonical definition used by signal extraction, the continue-work
 * tool, and delegate handling.
 */
export type ContinueWorkRequest = {
  reason: string;
  delaySeconds: number;
  traceparent?: string;
};

// ---------------------------------------------------------------------------
// Chain state — passed into scheduler / dispatch / persistence entry points
// ---------------------------------------------------------------------------

/**
 * Per-session continuation chain state — depth, start time, accumulated tokens.
 * Construct from a `SessionEntry` via `loadContinuationChainState(entry, turnTokens)`
 * in `./state.ts` rather than hand-rolling `?? 0` / `?? Date.now()` at each site.
 */
export type ChainState = {
  currentChainCount: number;
  chainStartedAt: number;
  accumulatedChainTokens: number;
  chainId?: string;
};
