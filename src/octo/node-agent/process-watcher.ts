// Octopus Orchestrator — Node Agent ProcessWatcher (M1-12)
//
// References:
//   - LLD.md §"Node Agent Internals" — ProcessWatcher is one of the six
//     Node Agent modules; it is the component responsible for detecting
//     arm process exits and surfacing them as structured events.
//   - LLD.md §"Recovery Flows" §3 (Arm crash) — step 1 is "process
//     watcher detects exit"; step 2 is "capture final logs and exit
//     reason". M1-12 implements step 1 and the "exit reason" half of
//     step 2 (the log-capture half is a separate concern handled by the
//     pty_tmux adapter's capture-pane plumbing).
//   - HLD.md §"tmux as a Foundational Substrate" — arms run inside
//     detached tmux sessions so they survive Node Agent restarts.
//   - DECISIONS.md OCTO-DEC-033 — this file depends only on node:
//     builtins and a relative import of TmuxManager. No imports from
//     src/infra/* (OpenClaw upstream).
//
// --- Detection mechanism: poll + sentinel file ------------------------
//
// tmux has no native push notification of "session ended with exit code
// N". The three options we considered:
//
//   A. Poll listSessions() for session disappearance. Simple but CANNOT
//      recover the exit code — M1-12 acceptance explicitly requires the
//      exit code in the event payload.
//   B. tmux `set-hook session-closed`. Runs inside the tmux server, so
//      exporting the exit code still needs a side channel (file). The
//      hook syntax is finicky and the complexity isn't worth it for the
//      value delivered here.
//   C. Wrap the user command at spawn time to write `$?` to a sentinel
//      file on exit, then poll BOTH the sentinel file (for the code)
//      AND listSessions() (to detect abnormal termination where the
//      wrapper never ran). CHOSEN.
//
// ProcessWatcher does NOT do the wrapping itself — the caller (the
// future M1-14 arm.spawn handler) is responsible for composing the
// wrapped startup command and passing the sentinel path to watch().
// ProcessWatcher just watches.
//
// --- Session-gone-without-sentinel ------------------------------------
//
// If the tmux session disappears before a sentinel file is written, we
// cannot know the exit code. We still emit a `failed` event with
// `exit_code: null` and `reason: "session_terminated_no_sentinel"` so
// the Node Agent can react (requeue / fail grip per policy, per
// Recovery Flows §3 step 5). This is the "abnormal exit" path.
//
// --- Contract summary -------------------------------------------------
//
//   - `completed`: exit_code === 0 from sentinel
//   - `failed`: exit_code !== 0 from sentinel OR session gone with no
//     sentinel OR sentinel content unparseable OR catastrophic tmux
//     query failure
//
// The caller subscribes via `on("process", handler)` and distinguishes
// the two via the discriminated `type` field.

import { EventEmitter } from "node:events";
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { TmuxManager } from "./tmux-manager.ts";

/**
 * Options for constructing a {@link ProcessWatcher}.
 */
export interface ProcessWatcherOptions {
  /**
   * Poll interval in milliseconds. The watcher checks every active
   * target on each tick. Default: 250ms.
   */
  pollIntervalMs?: number;
  /**
   * {@link TmuxManager} instance used to query live sessions. If not
   * provided, a fresh `new TmuxManager()` is constructed.
   */
  tmuxManager?: TmuxManager;
}

/**
 * A single arm/session pair the watcher is tracking.
 */
export interface WatchTarget {
  /** Opaque arm identifier — carried through into the emitted event. */
  arm_id: string;
  /** tmux session name the arm is running in. */
  session_name: string;
  /**
   * Absolute path to the sentinel file the spawn wrapper will write
   * the exit code to on clean exit. See the file header for the
   * wrapping contract.
   */
  exit_sentinel_path: string;
}

/**
 * Discriminated union of events emitted on the `"process"` channel.
 *
 *   - `completed`: the sentinel reported exit_code 0.
 *   - `failed`: the sentinel reported a non-zero exit code, OR the
 *     session disappeared without writing a sentinel, OR the sentinel
 *     content could not be parsed, OR the tmux query itself failed.
 */
export type ProcessWatcherEvent =
  | {
      type: "completed";
      arm_id: string;
      session_name: string;
      exit_code: 0;
      ts: string;
    }
  | {
      type: "failed";
      arm_id: string;
      session_name: string;
      exit_code: number | null;
      reason: string;
      ts: string;
    };

const DEFAULT_POLL_INTERVAL_MS = 250;

/**
 * ProcessWatcher — polls a set of (arm_id, session_name, sentinel_path)
 * tuples and emits `"process"` events when any of them transitions to
 * a terminal state (completed / failed).
 *
 * Not safe for cross-process sharing — each Node Agent owns exactly one
 * instance. Internally single-threaded: the poll loop is a plain
 * `setInterval` callback that serializes all detection work.
 */
export class ProcessWatcher extends EventEmitter {
  private readonly pollIntervalMs: number;
  private readonly tmuxManager: TmuxManager;
  private readonly targets: Map<string, WatchTarget>;
  private intervalHandle: ReturnType<typeof setInterval> | null;
  private pollInFlight: boolean;

  constructor(opts: ProcessWatcherOptions = {}) {
    super();
    this.pollIntervalMs = opts.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    if (!Number.isFinite(this.pollIntervalMs) || this.pollIntervalMs <= 0) {
      throw new Error(
        `ProcessWatcher: pollIntervalMs must be a positive number, got ${opts.pollIntervalMs}`,
      );
    }
    this.tmuxManager = opts.tmuxManager ?? new TmuxManager();
    this.targets = new Map();
    this.intervalHandle = null;
    this.pollInFlight = false;
  }

  /**
   * Begin watching a target. Idempotent per `arm_id`: calling `watch`
   * twice with the same arm_id replaces the prior entry (tests and
   * operator-driven restart flows both want this behavior).
   *
   * If this is the first target and the poll loop is not running, the
   * loop is started.
   */
  watch(target: WatchTarget): void {
    if (typeof target.arm_id !== "string" || target.arm_id.length === 0) {
      throw new Error("ProcessWatcher.watch: arm_id must be a non-empty string");
    }
    if (typeof target.session_name !== "string" || target.session_name.length === 0) {
      throw new Error("ProcessWatcher.watch: session_name must be a non-empty string");
    }
    if (typeof target.exit_sentinel_path !== "string" || target.exit_sentinel_path.length === 0) {
      throw new Error("ProcessWatcher.watch: exit_sentinel_path must be a non-empty string");
    }
    this.targets.set(target.arm_id, { ...target });
    this.ensureLoopRunning();
  }

  /**
   * Stop watching a specific target without emitting any event. Used
   * by the terminate/cancel flow where the caller has already decided
   * the arm's fate and does not want a spurious `failed` event when
   * the session is torn down.
   *
   * If the target set becomes empty as a result, the poll loop halts.
   */
  unwatch(arm_id: string): void {
    this.targets.delete(arm_id);
    if (this.targets.size === 0) {
      this.haltLoop();
    }
  }

  /**
   * Halt the poll loop and clear the target set. No events are emitted
   * for remaining targets. Call this on Node Agent shutdown.
   */
  stop(): void {
    this.targets.clear();
    this.haltLoop();
  }

  /**
   * True iff the poll loop is currently scheduled.
   */
  isRunning(): boolean {
    return this.intervalHandle !== null;
  }

  /**
   * Number of currently-watched targets. Exposed for tests and
   * operator introspection.
   */
  watchedCount(): number {
    return this.targets.size;
  }

  private ensureLoopRunning(): void {
    if (this.intervalHandle !== null) {
      return;
    }
    this.intervalHandle = setInterval(() => {
      void this.tick();
    }, this.pollIntervalMs);
  }

  private haltLoop(): void {
    if (this.intervalHandle !== null) {
      clearInterval(this.intervalHandle);
      this.intervalHandle = null;
    }
  }

  /**
   * One poll cycle. Two-phase:
   *
   *   1. For every target, check the sentinel file. If present, read
   *      and emit. This is checked FIRST so a fast-exiting process
   *      that both wrote the sentinel AND caused the session to end
   *      is classified as a clean exit (the sentinel is authoritative).
   *   2. For every remaining target (no sentinel yet), check whether
   *      the tmux session is still alive. If the session is gone,
   *      emit `failed` with `exit_code: null`.
   *
   * All synchronous exceptions are caught so a single bad target
   * cannot kill the interval.
   */
  private async tick(): Promise<void> {
    if (this.pollInFlight) {
      return;
    }
    this.pollInFlight = true;
    try {
      // Snapshot the target list — handlers may mutate it.
      const snapshot = Array.from(this.targets.values());

      // Phase 1: sentinel checks.
      const stillPending: WatchTarget[] = [];
      for (const target of snapshot) {
        // The target may have been removed mid-iteration by a prior
        // emit handler; skip if so.
        if (!this.targets.has(target.arm_id)) {
          continue;
        }
        const handled = this.checkSentinel(target);
        if (!handled) {
          stillPending.push(target);
        }
      }

      if (stillPending.length === 0) {
        if (this.targets.size === 0) {
          this.haltLoop();
        }
        return;
      }

      // Phase 2: session liveness check. Single listSessions() call
      // batches all pending targets.
      let liveNames: Set<string>;
      try {
        const names = await this.tmuxManager.listSessions();
        liveNames = new Set(names);
      } catch (err) {
        // Catastrophic tmux failure — fail ALL watched targets with a
        // descriptive reason and halt the loop. The Node Agent will
        // restart the watcher once tmux is healthy again.
        const msg = err instanceof Error ? err.message : String(err);
        const failReason = `tmux_query_failed: ${msg}`;
        const allPending = Array.from(this.targets.values());
        for (const t of allPending) {
          this.targets.delete(t.arm_id);
          this.safeEmitFailed(t, null, failReason);
        }
        this.haltLoop();
        return;
      }

      for (const target of stillPending) {
        if (!this.targets.has(target.arm_id)) {
          continue;
        }
        if (liveNames.has(target.session_name)) {
          continue; // still running — wait for next tick
        }
        // Session gone but sentinel never appeared. Give the sentinel
        // ONE last look in case of the fs/tmux ordering race where the
        // session exited between phase 1 and phase 2 and the sentinel
        // was written in the meantime.
        const handled = this.checkSentinel(target);
        if (handled) {
          continue;
        }
        this.targets.delete(target.arm_id);
        this.safeEmitFailed(target, null, "session_terminated_no_sentinel");
      }

      if (this.targets.size === 0) {
        this.haltLoop();
      }
    } finally {
      this.pollInFlight = false;
    }
  }

  /**
   * Returns true iff the sentinel was found, consumed, and emitted.
   * Returns false if the sentinel does not yet exist (the normal
   * "process still running" case).
   *
   * On ANY parsing or read error, emits `failed` and returns true
   * (the sentinel is considered consumed so we stop retrying it).
   */
  private checkSentinel(target: WatchTarget): boolean {
    let content: string;
    try {
      if (!existsSync(target.exit_sentinel_path)) {
        return false;
      }
      content = readFileSync(target.exit_sentinel_path, "utf8");
    } catch {
      // Race: existsSync returned true but read failed (file
      // disappeared, permission flip, etc.). Treat as "not yet ready"
      // so we re-check next tick; if something is truly broken, the
      // session-gone path will eventually reap it.
      return false;
    }

    // Consume the sentinel so a stray file from a prior run cannot
    // re-fire for a restarted arm with the same id.
    try {
      unlinkSync(target.exit_sentinel_path);
    } catch {
      // Best effort — the wrapping caller may have already cleaned
      // up, or the file may already be gone. Either way, we have the
      // content and will emit below.
    }

    this.targets.delete(target.arm_id);

    const trimmed = content.trim();
    if (trimmed.length === 0) {
      this.safeEmitFailed(target, null, "sentinel_unparseable: <empty>");
      return true;
    }
    // Parse as a signed integer. Reject anything that isn't purely
    // digits (with optional leading minus) to avoid leniency traps
    // like "7abc" → 7.
    if (!/^-?\d+$/.test(trimmed)) {
      this.safeEmitFailed(target, null, `sentinel_unparseable: ${JSON.stringify(trimmed)}`);
      return true;
    }
    const code = Number.parseInt(trimmed, 10);
    if (!Number.isFinite(code)) {
      this.safeEmitFailed(target, null, `sentinel_unparseable: ${JSON.stringify(trimmed)}`);
      return true;
    }

    const ts = new Date().toISOString();
    if (code === 0) {
      const evt: ProcessWatcherEvent = {
        type: "completed",
        arm_id: target.arm_id,
        session_name: target.session_name,
        exit_code: 0,
        ts,
      };
      this.safeEmit(evt);
    } else {
      this.safeEmitFailed(target, code, `exit_code_${code}`);
    }
    return true;
  }

  private safeEmitFailed(target: WatchTarget, exit_code: number | null, reason: string): void {
    const evt: ProcessWatcherEvent = {
      type: "failed",
      arm_id: target.arm_id,
      session_name: target.session_name,
      exit_code,
      reason,
      ts: new Date().toISOString(),
    };
    this.safeEmit(evt);
  }

  private safeEmit(evt: ProcessWatcherEvent): void {
    try {
      this.emit("process", evt);
    } catch {
      // A handler threw — we deliberately swallow it so the poll loop
      // stays alive. Handler errors are the handler's problem; the
      // watcher's contract is to keep watching.
    }
  }
}
