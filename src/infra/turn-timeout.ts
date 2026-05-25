// Per-channel turn-timeout watchdog (D-GAP-2 Phase 1).
//
// A hung agent turn (model never responds, tool never returns, abort handler
// got swallowed) leaves the session stuck and silently consumes operator
// attention. This helper bounds a turn with a configurable `maxTurnMs`,
// invokes a caller-supplied `abort()` when the timer fires, and emits a
// single `briefing.timeout` event so the operator surface can show the
// occurrence once.
//
// The handle returned by `startTurnTimeout` is single-use: either the timer
// fires and aborts the turn, or the caller calls `dispose()` (a normal turn
// completion). Both paths are idempotent — `dispose()` after fire is a no-op,
// fire after `dispose()` is a no-op, and the briefing event is emitted at
// most once per handle.
//
// `resolveMaxTurnMs` coalesces a per-channel config value with a default and
// rejects non-finite / non-positive inputs so callers can pipe untrusted
// config in without their own guards.

import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import { normalizeOptionalString } from "../shared/string-coerce.js";
import { emitBriefingEvent, type BriefingTimeoutEvent } from "./briefing-events.js";

export const TURN_TIMEOUT_DEFAULT_MS = 5 * 60 * 1000;
export const TURN_TIMEOUT_MIN_MS = 1_000;
export const TURN_TIMEOUT_MAX_MS = 60 * 60 * 1000;

export type TurnTimeoutAbort = (info: TurnTimeoutAbortInfo) => void | Promise<void>;

export type TurnTimeoutAbortInfo = {
  turnKey: string;
  sessionKey: string;
  channel: string;
  maxTurnMs: number;
  elapsedMs: number;
};

export type StartTurnTimeoutRequest = {
  /** Owner session key (required). */
  sessionKey: string;
  /** Channel id (required). */
  channel: string;
  /**
   * Stable identifier for the turn (run id, message id, etc.). Used as the
   * deduplication key for the briefing event and exposed back to the abort
   * callback.
   */
  turnKey: string;
  /**
   * Effective per-channel max turn duration in milliseconds. Use
   * `resolveMaxTurnMs` to coalesce config + defaults before calling.
   */
  maxTurnMs: number;
  /**
   * Caller's abort function. Called exactly once when the timer fires;
   * exceptions are caught and surfaced in the briefing detail.
   */
  abort: TurnTimeoutAbort;
  /**
   * Optional clock seam for tests. Default: `Date.now`.
   */
  now?: () => number;
  /**
   * Optional timer seam for tests / fake timers. Defaults to global
   * `setTimeout` / `clearTimeout`.
   */
  setTimer?: (cb: () => void, ms: number) => unknown;
  clearTimer?: (timer: unknown) => void;
};

export type TurnTimeoutHandle = {
  /** The configured maxTurnMs that armed this handle. */
  maxTurnMs: number;
  /** True after the timer fired or `dispose()` was called. */
  isDisposed(): boolean;
  /** True after the timer fired and an abort was dispatched. */
  isFired(): boolean;
  /** Cancel the timer. No-op if the timer already fired or was disposed. */
  dispose(): void;
};

type TurnTimeoutFireOutcome = "ok" | "abort_failed";

type ActiveTimeoutEntry = {
  dispose: () => void;
};

const TURN_TIMEOUT_ACTIVE_KEY = Symbol.for("openclaw.turnTimeout.active.v1");
const TURN_TIMEOUT_FIRED_KEY = Symbol.for("openclaw.turnTimeout.fired.v1");
const MAX_FIRED_TRACKED = 1024;

function getActive(): Map<string, ActiveTimeoutEntry> {
  return resolveGlobalSingleton<Map<string, ActiveTimeoutEntry>>(
    TURN_TIMEOUT_ACTIVE_KEY,
    () => new Map<string, ActiveTimeoutEntry>(),
  );
}

function getFiredKeys(): Set<string> {
  return resolveGlobalSingleton<Set<string>>(TURN_TIMEOUT_FIRED_KEY, () => new Set<string>());
}

function rememberFired(turnKey: string): void {
  const fired = getFiredKeys();
  fired.add(turnKey);
  if (fired.size > MAX_FIRED_TRACKED) {
    const oldest = fired.values().next().value;
    if (typeof oldest === "string") {
      fired.delete(oldest);
    }
  }
}

function requireString(value: string | undefined | null, label: string): string {
  const trimmed = normalizeOptionalString(value);
  if (!trimmed) {
    throw new Error(`turn-timeout: ${label} is required`);
  }
  return trimmed;
}

function isPositiveFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

/**
 * Clamp a per-channel `maxTurnMs` (possibly undefined / invalid) against the
 * supplied default and the global min/max bounds. Returns the resolved value
 * and the source so callers can include it in telemetry / config dumps.
 */
export function resolveMaxTurnMs(
  channelMs: number | undefined | null,
  defaultMs: number = TURN_TIMEOUT_DEFAULT_MS,
): { maxTurnMs: number; source: "channel" | "default" | "fallback" } {
  if (isPositiveFiniteNumber(channelMs)) {
    const clamped = Math.max(TURN_TIMEOUT_MIN_MS, Math.min(TURN_TIMEOUT_MAX_MS, channelMs));
    return { maxTurnMs: clamped, source: "channel" };
  }
  if (isPositiveFiniteNumber(defaultMs)) {
    const clamped = Math.max(TURN_TIMEOUT_MIN_MS, Math.min(TURN_TIMEOUT_MAX_MS, defaultMs));
    return { maxTurnMs: clamped, source: "default" };
  }
  return { maxTurnMs: TURN_TIMEOUT_DEFAULT_MS, source: "fallback" };
}

/**
 * Arm a single-shot turn-timeout watchdog. Returns a handle the caller must
 * `dispose()` on normal turn completion. When the timer fires, `abort()` is
 * invoked exactly once and a single `briefing.timeout` event is emitted.
 *
 * Re-arming the same `turnKey` while a previous handle is still active
 * auto-disposes the previous handle first (last-arm wins) — without this,
 * the prior closure's timer would still be live and could fire a stale
 * abort/briefing for the new turn.
 */
export function startTurnTimeout(req: StartTurnTimeoutRequest): TurnTimeoutHandle {
  const sessionKey = requireString(req.sessionKey, "sessionKey");
  const channel = requireString(req.channel, "channel");
  const turnKey = requireString(req.turnKey, "turnKey");
  if (!isPositiveFiniteNumber(req.maxTurnMs)) {
    throw new Error("turn-timeout: maxTurnMs must be a positive finite number");
  }
  if (typeof req.abort !== "function") {
    throw new Error("turn-timeout: abort must be a function");
  }

  const maxTurnMs = req.maxTurnMs;
  const now = req.now ?? Date.now;
  const setTimer = req.setTimer ?? ((cb: () => void, ms: number) => setTimeout(cb, ms));
  const clearTimer = req.clearTimer ?? ((t: unknown) => clearTimeout(t as NodeJS.Timeout));

  const active = getActive();
  const startedAt = now();
  let disposed = false;
  let fired = false;
  let timer: unknown = null;

  // Fresh sentinel per call so cleanup() can identify _this_ handle's entry
  // and not stomp on a successor's registration.
  const entry: ActiveTimeoutEntry = { dispose: () => {} };

  const cleanup = () => {
    if (timer !== null) {
      try {
        clearTimer(timer);
      } catch {
        // Ignore — best-effort cleanup.
      }
      timer = null;
    }
    if (active.get(turnKey) === entry) {
      active.delete(turnKey);
    }
  };

  const emitTimeoutBriefing = (outcome: TurnTimeoutFireOutcome, errorMessage?: string): void => {
    const detail =
      outcome === "abort_failed"
        ? `abort dispatch failed${errorMessage ? `: ${errorMessage}` : ""}`
        : "abort dispatched";
    emitBriefingEvent({
      type: "briefing.timeout",
      sessionKey,
      channel,
      turnKey,
      maxTurnMs,
      elapsedMs: Math.max(0, now() - startedAt),
      detail,
    }) as BriefingTimeoutEvent;
  };

  const fire = () => {
    if (disposed || fired) {
      return;
    }
    fired = true;
    rememberFired(turnKey);
    const abortInfo: TurnTimeoutAbortInfo = {
      turnKey,
      sessionKey,
      channel,
      maxTurnMs,
      elapsedMs: Math.max(0, now() - startedAt),
    };

    let outcome: TurnTimeoutFireOutcome = "ok";
    let errorMessage: string | undefined;
    try {
      const result = req.abort(abortInfo);
      if (result && typeof result.then === "function") {
        result.catch((err: unknown) => {
          const msg = err instanceof Error ? err.message : String(err);
          console.error(`[turn-timeout] async abort error turnKey=${turnKey}: ${msg}`);
        });
      }
    } catch (err) {
      outcome = "abort_failed";
      errorMessage = err instanceof Error ? err.message : String(err);
      console.error(`[turn-timeout] abort threw turnKey=${turnKey}: ${errorMessage}`);
    }
    cleanup();
    emitTimeoutBriefing(outcome, errorMessage);
  };

  const disposeHandle = () => {
    if (disposed || fired) {
      return;
    }
    disposed = true;
    cleanup();
  };
  entry.dispose = disposeHandle;

  // Last-arm wins: dispose any previously armed handle for this turnKey
  // before we install the new one and start the timer.
  const previous = active.get(turnKey);
  if (previous && previous !== entry) {
    try {
      previous.dispose();
    } catch {
      // Best-effort; the previous closure tracks its own state.
    }
  }
  active.set(turnKey, entry);

  timer = setTimer(fire, maxTurnMs);

  return {
    maxTurnMs,
    isDisposed: () => disposed || fired,
    isFired: () => fired,
    dispose: disposeHandle,
  };
}

/** Peek whether a turn-timeout for this turn key has fired in this process. */
export function hasTurnTimeoutFired(turnKey: string): boolean {
  const key = normalizeOptionalString(turnKey);
  if (!key) {
    return false;
  }
  return getFiredKeys().has(key);
}

export function resetTurnTimeoutForTests(): void {
  getActive().clear();
  getFiredKeys().clear();
}
