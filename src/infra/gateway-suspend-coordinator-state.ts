import type {
  GatewaySuspendPrepareParams,
  GatewaySuspendPrepareResult as GatewaySuspendPrepareWireResult,
  GatewaySuspendResumeResult as GatewaySuspendResumeWireResult,
  GatewaySuspendStatusResult as GatewaySuspendStatusWireResult,
} from "../../packages/gateway-protocol/src/index.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import {
  createGatewayActiveWorkSnapshot,
  type GatewayActiveWorkInspectors,
  type GatewayActiveWorkSnapshot,
} from "./gateway-active-work.js";
import { createGatewaySuspendReaderCustody } from "./gateway-suspend-reader-custody.js";

export const GATEWAY_SUSPEND_TTL_MS = 2 * 60_000;
export const GATEWAY_SUSPEND_RETRY_AFTER_MS = 20_000;
const GATEWAY_SCHEDULER_RECOVERY_RETRY_MS = 1_000;

export type GatewaySuspendTerminalPolicy = NonNullable<
  GatewaySuspendPrepareParams["terminalPolicy"]
>;

type GatewaySchedulerRecoveryResult = {
  status: "recovering";
  reason: "scheduler-resume-failed";
  retryAfterMs: number;
};

export type GatewaySuspendPrepareResult =
  | GatewaySuspendPrepareWireResult
  | { status: "conflict"; expiresAtMs: number }
  | GatewaySchedulerRecoveryResult;

export type GatewaySuspendStatusResult =
  | GatewaySuspendStatusWireResult
  | { status: "conflict"; expiresAtMs: number }
  | GatewaySchedulerRecoveryResult;

export type GatewaySuspendResumeResult =
  | GatewaySuspendResumeWireResult
  | { ok: false; reason: "suspension-mismatch" }
  | { ok: false; reason: "gateway-restarting" }
  | { ok: false; reason: "scheduler-resume-failed"; retryAfterMs: number };

type GatewaySuspendCoordinatorEntryBase = {
  owner: object;
  resumeScheduling: () => void;
  reopenAdmission: () => boolean;
  warn?: (message: string) => void;
  timer?: ReturnType<typeof setTimeout>;
  timerGeneration?: number;
};

export type HeldGatewaySuspension = GatewaySuspendCoordinatorEntryBase & {
  kind: "held";
  requestId: string;
  terminalPolicy: GatewaySuspendTerminalPolicy;
  drain: boolean;
  suspensionId: string;
  expiresAtMs: number;
  deadlineAtMs: number;
  inspect?: Partial<GatewayActiveWorkInspectors>;
  handoff?: GatewaySuspendHandoffOwner;
  committedStopOwner?: GatewaySuspendHandoffOwner;
  reader?: ReturnType<typeof createGatewaySuspendReaderCustody>;
  shutdown?: { signal: AbortSignal; phase: "interrupting" | "exiting" };
  commitAdmission?: () => boolean;
  nowMs: () => number;
};

/** Private identity of one live process-owning host iteration, never a wire token. */
export type GatewaySuspendHandoffOwner = {
  isCurrent: () => boolean;
  /** Transfers a validated suspension into this host's synchronous one-way shutdown. */
  commitStop?: () => void;
  prepareReader?: import("../gateway/server-public.js").GatewayServer["prepareReader"];
  retireReader?: () => void;
};

type GatewaySchedulerRecovery = GatewaySuspendCoordinatorEntryBase & {
  kind: "recovering";
};

type GatewaySuspendCoordinatorEntry = HeldGatewaySuspension | GatewaySchedulerRecovery;

export type GatewaySuspendPreparation = GatewaySuspendCoordinatorEntryBase & {
  kind: "preparing";
  invalidate: () => void;
};

type GatewaySuspendCoordinatorState = {
  current: GatewaySuspendCoordinatorEntry | null;
  preparing?: GatewaySuspendPreparation | null;
  retiredForLifecycleReset?: GatewaySuspendCoordinatorEntry | GatewaySuspendPreparation | null;
};

export const COORDINATOR_STATE = resolveGlobalSingleton(
  Symbol.for("openclaw.gatewaySuspendCoordinatorState"),
  (): GatewaySuspendCoordinatorState => ({
    current: null,
    retiredForLifecycleReset: null,
  }),
);

export function schedulerRecoveryResult(): GatewaySchedulerRecoveryResult {
  return {
    status: "recovering",
    reason: "scheduler-resume-failed",
    retryAfterMs: GATEWAY_SCHEDULER_RECOVERY_RETRY_MS,
  };
}

export function schedulerResumeFailure(): GatewaySuspendResumeResult {
  return {
    ok: false,
    reason: "scheduler-resume-failed",
    retryAfterMs: GATEWAY_SCHEDULER_RECOVERY_RETRY_MS,
  };
}

export function clearEntryTimer(entry: GatewaySuspendCoordinatorEntryBase): void {
  entry.timerGeneration = (entry.timerGeneration ?? 0) + 1;
  if (entry.timer) {
    clearTimeout(entry.timer);
    entry.timer = undefined;
  }
}

function scheduleResume(entry: GatewaySuspendCoordinatorEntry, delayMs: number): void {
  clearEntryTimer(entry);
  const generation = entry.timerGeneration;
  entry.timer = setTimeout(() => {
    if (entry.timerGeneration === generation && COORDINATOR_STATE.current === entry) {
      resumeAndReopen(entry);
    }
  }, delayMs);
  entry.timer.unref?.();
}

export function resumeAndReopen(entry: GatewaySuspendCoordinatorEntry): boolean {
  try {
    entry.resumeScheduling();
  } catch (err) {
    entry.warn?.(`gateway scheduler recovery failed: ${String(err)}`);
    enterSchedulerRecovery(entry);
    return false;
  }
  if (COORDINATOR_STATE.current !== entry) {
    return true;
  }
  if (!entry.reopenAdmission()) {
    entry.warn?.("gateway scheduler recovery could not reopen admission");
    enterSchedulerRecovery(entry);
    return false;
  }
  clearEntryTimer(entry);
  COORDINATOR_STATE.current = null;
  return true;
}

function enterSchedulerRecovery(entry: GatewaySuspendCoordinatorEntry): void {
  if (COORDINATOR_STATE.current !== entry) {
    return;
  }
  if (entry.kind === "recovering") {
    scheduleResume(entry, GATEWAY_SCHEDULER_RECOVERY_RETRY_MS);
    return;
  }
  clearEntryTimer(entry);
  const recovery: GatewaySchedulerRecovery = {
    kind: "recovering",
    owner: entry.owner,
    resumeScheduling: entry.resumeScheduling,
    reopenAdmission: entry.reopenAdmission,
    warn: entry.warn,
  };
  COORDINATOR_STATE.current = recovery;
  scheduleResume(recovery, GATEWAY_SCHEDULER_RECOVERY_RETRY_MS);
}

function normalizeExpiredHeldSuspension(
  held: HeldGatewaySuspension,
): GatewaySuspendCoordinatorEntry | null {
  if (held.reader) {
    // Native retirement owns expiry after this one-way transfer. It must never
    // resume scheduling when a replacement or its final snapshot fails.
    return held;
  }
  if (held.nowMs() < held.expiresAtMs && performance.now() < held.deadlineAtMs) {
    return held;
  }
  resumeAndReopen(held);
  return COORDINATOR_STATE.current;
}

export function currentSuspension(): GatewaySuspendCoordinatorEntry | null {
  const current = COORDINATOR_STATE.current;
  return current?.kind === "held" ? normalizeExpiredHeldSuspension(current) : current;
}

function armSchedulerRecovery(
  recovery: Omit<GatewaySchedulerRecovery, "kind">,
): GatewaySchedulerRecovery {
  const entry: GatewaySchedulerRecovery = { kind: "recovering", ...recovery };
  scheduleResume(entry, GATEWAY_SCHEDULER_RECOVERY_RETRY_MS);
  return entry;
}

// Rollback stays fail-closed: scheduler recovery must finish before admission
// reopens, otherwise an old retry can resume scheduling under a newer lease.
export function resumeSchedulingBeforeReopen(params: {
  owner: object;
  resumeScheduling: () => void;
  reopenAdmission: () => boolean;
  isInvalidated: () => boolean;
  warn?: (message: string) => void;
}): boolean {
  if (params.isInvalidated()) {
    return true;
  }
  try {
    params.resumeScheduling();
  } catch (err) {
    params.warn?.(`gateway scheduler resume failed during suspension rollback: ${String(err)}`);
    COORDINATOR_STATE.current = armSchedulerRecovery({
      owner: params.owner,
      resumeScheduling: params.resumeScheduling,
      reopenAdmission: params.reopenAdmission,
      warn: params.warn,
    });
    return false;
  }
  if (!params.isInvalidated()) {
    params.reopenAdmission();
  }
  return true;
}

export function armExpiry(held: Omit<HeldGatewaySuspension, "kind">): HeldGatewaySuspension {
  const entry: HeldGatewaySuspension = { kind: "held", ...held };
  // Inspection consumes the lease budget even if the wall clock moves back.
  const remainingMs = Math.min(
    entry.expiresAtMs - entry.nowMs(),
    entry.deadlineAtMs - performance.now(),
  );
  if (remainingMs <= 0) {
    throw new Error("gateway suspension expired during preparation");
  }
  scheduleResume(entry, Math.ceil(remainingMs));
  return entry;
}

export function renewHeldSuspension(held: HeldGatewaySuspension, nowMs: number): void {
  held.expiresAtMs = nowMs + GATEWAY_SUSPEND_TTL_MS;
  held.deadlineAtMs = performance.now() + GATEWAY_SUSPEND_TTL_MS;
  scheduleResume(held, GATEWAY_SUSPEND_TTL_MS);
}

// Reader custody freezes work observations; the native receipt proves completed joins.
export function heldWorkSnapshot(held: HeldGatewaySuspension): GatewayActiveWorkSnapshot {
  return (
    held.reader?.snapshot ??
    createGatewayActiveWorkSnapshot(held.inspect, {
      ignoreTerminalSessions: held.terminalPolicy === "terminate",
    })
  );
}

export function refreshHeldSuspension(
  held: HeldGatewaySuspension,
): GatewayActiveWorkSnapshot | undefined {
  // Polls and renewals retain the update's terminal policy even after the first idle observation.
  const snapshot = heldWorkSnapshot(held);
  if (COORDINATOR_STATE.current !== held || normalizeExpiredHeldSuspension(held) !== held) {
    return undefined;
  }
  if (snapshot.idle) {
    if (held.commitAdmission?.() === false) {
      throw new Error("gateway suspension admission changed during drain completion");
    }
    // Late terminal writes reopen observation, never the committed admission fence.
    held.commitAdmission = undefined;
  }
  return snapshot;
}

export function heldPrepareResult(
  held: HeldGatewaySuspension,
  snapshot: GatewayActiveWorkSnapshot,
): GatewaySuspendPrepareWireResult {
  const result = {
    suspensionId: held.suspensionId,
    expiresAtMs: held.expiresAtMs,
    activeCount: snapshot.counts.totalActive,
    blockers: snapshot.blockers,
    writeCustody: snapshot.writeCustody,
  };
  return snapshot.idle
    ? { status: "ready", ...result }
    : { status: "draining", ...result, retryAfterMs: GATEWAY_SUSPEND_RETRY_AFTER_MS };
}
