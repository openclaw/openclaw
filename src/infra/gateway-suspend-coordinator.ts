// Coordinates an atomic, refuse-only host suspension preparation lease.
import { randomUUID } from "node:crypto";
import type {
  GatewaySuspendPrepareResult as GatewaySuspendPrepareWireResult,
  GatewaySuspendResumeResult as GatewaySuspendResumeWireResult,
  GatewaySuspendStatusResult as GatewaySuspendStatusWireResult,
} from "../../packages/gateway-protocol/src/index.js";
import {
  tryBeginGatewaySuspendAdmission,
  type GatewaySuspendAdmissionLease,
} from "../process/gateway-work-admission.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import {
  createGatewayActiveWorkSnapshot,
  type GatewayActiveWorkInspectors,
  type GatewayActiveWorkSnapshot,
} from "./gateway-active-work.js";

export const GATEWAY_SUSPEND_TTL_MS = 2 * 60_000;
export const GATEWAY_SUSPEND_RETRY_AFTER_MS = 20_000;

export type GatewaySuspendPrepareResult =
  | GatewaySuspendPrepareWireResult
  | { status: "conflict"; expiresAtMs: number };

export type GatewaySuspendStatusResult =
  | GatewaySuspendStatusWireResult
  | { status: "conflict"; expiresAtMs: number };

export type GatewaySuspendResumeResult =
  | GatewaySuspendResumeWireResult
  | { ok: false; reason: "suspension-mismatch" }
  | { ok: false; reason: "scheduler-resume-failed"; message: string };

type HeldGatewaySuspension = {
  requestId: string;
  suspensionId: string;
  expiresAtMs: number;
  snapshot: GatewayActiveWorkSnapshot;
  admission: GatewaySuspendAdmissionLease;
  resumeScheduling: () => void;
  nowMs: () => number;
  warn?: (message: string) => void;
  timer: ReturnType<typeof setTimeout>;
};

type GatewaySuspendCoordinatorState = {
  held: HeldGatewaySuspension | null;
};

const COORDINATOR_STATE = resolveGlobalSingleton(
  Symbol.for("openclaw.gatewaySuspendCoordinatorState"),
  (): GatewaySuspendCoordinatorState => ({
    held: null,
  }),
);

function clearHeldTimer(held: HeldGatewaySuspension): void {
  clearTimeout(held.timer);
}

function scheduleHeldResumeRetry(held: HeldGatewaySuspension): void {
  clearHeldTimer(held);
  held.timer = setTimeout(() => expireHeldSuspension(held.suspensionId), 1_000);
  held.timer.unref?.();
}

function releaseHeldSuspension(held: HeldGatewaySuspension): {
  released: boolean;
  message?: string;
} {
  try {
    held.resumeScheduling();
  } catch (err) {
    const message = `gateway suspension scheduler resume failed: ${String(err)}`;
    held.warn?.(message);
    scheduleHeldResumeRetry(held);
    return { released: false, message };
  }
  clearHeldTimer(held);
  if (COORDINATOR_STATE.held === held) {
    COORDINATOR_STATE.held = null;
  }
  held.admission.release();
  return { released: true };
}

function expireHeldSuspension(suspensionId: string): void {
  const held = COORDINATOR_STATE.held;
  if (held?.suspensionId !== suspensionId) {
    return;
  }
  releaseHeldSuspension(held);
}

function normalizeExpiredHeldSuspension(held: HeldGatewaySuspension): HeldGatewaySuspension | null {
  if (held.nowMs() < held.expiresAtMs) {
    return held;
  }
  return releaseHeldSuspension(held).released ? null : held;
}

// Rollback stays fail-closed: scheduler recovery must finish before admission
// reopens, otherwise an old retry can resume scheduling under a newer lease.
function resumeSchedulingBeforeReopen(params: {
  resumeScheduling: () => void;
  reopenAdmission: () => boolean;
  isInvalidated: () => boolean;
  warn?: (message: string) => void;
}): void {
  if (params.isInvalidated()) {
    return;
  }
  try {
    params.resumeScheduling();
  } catch (err) {
    const message = `gateway scheduler resume failed after busy suspension: ${String(err)}`;
    params.warn?.(message);
    const timer = setTimeout(() => resumeSchedulingBeforeReopen(params), 1_000);
    timer.unref?.();
    return;
  }
  params.reopenAdmission();
}

function armExpiry(held: Omit<HeldGatewaySuspension, "timer">): HeldGatewaySuspension {
  const timer = setTimeout(() => expireHeldSuspension(held.suspensionId), GATEWAY_SUSPEND_TTL_MS);
  timer.unref?.();
  return { ...held, timer };
}

function renewHeldSuspension(held: HeldGatewaySuspension, nowMs: number): void {
  clearHeldTimer(held);
  held.expiresAtMs = nowMs + GATEWAY_SUSPEND_TTL_MS;
  held.timer = setTimeout(() => expireHeldSuspension(held.suspensionId), GATEWAY_SUSPEND_TTL_MS);
  held.timer.unref?.();
}

/** Acquire, inspect, and either roll back immediately or hold an idle fence. */
export function prepareGatewaySuspend(params: {
  requestId: string;
  pauseScheduling: () => void;
  resumeScheduling: () => void;
  inspect?: Partial<GatewayActiveWorkInspectors>;
  nowMs?: () => number;
  createSuspensionId?: () => string;
  warn?: (message: string) => void;
}): GatewaySuspendPrepareResult {
  const nowMs = (params.nowMs ?? Date.now)();
  const heldBeforeExpiryCheck = COORDINATOR_STATE.held;
  const existing = heldBeforeExpiryCheck
    ? normalizeExpiredHeldSuspension(heldBeforeExpiryCheck)
    : null;
  if (existing) {
    if (existing.requestId !== params.requestId) {
      return { status: "conflict", expiresAtMs: existing.expiresAtMs };
    }
    existing.nowMs = params.nowMs ?? Date.now;
    renewHeldSuspension(existing, nowMs);
    return {
      status: "ready",
      suspensionId: existing.suspensionId,
      expiresAtMs: existing.expiresAtMs,
      counts: existing.snapshot.counts,
      blockers: existing.snapshot.blockers,
    };
  }

  let suspensionInvalidated = false;
  const admission = tryBeginGatewaySuspendAdmission(() => {
    suspensionInvalidated = true;
    const held = COORDINATOR_STATE.held;
    if (!held) {
      return;
    }
    clearHeldTimer(held);
    COORDINATOR_STATE.held = null;
  });
  if (!admission) {
    const snapshot = createGatewayActiveWorkSnapshot(params.inspect);
    return {
      status: "busy",
      reason: "gateway-draining",
      retryAfterMs: GATEWAY_SUSPEND_RETRY_AFTER_MS,
      counts: snapshot.counts,
      blockers: snapshot.blockers,
    };
  }

  let schedulingPaused = false;
  let admissionCommitted = false;
  try {
    params.pauseScheduling();
    schedulingPaused = true;
    const snapshot = createGatewayActiveWorkSnapshot(params.inspect);
    if (!snapshot.idle) {
      resumeSchedulingBeforeReopen({
        resumeScheduling: params.resumeScheduling,
        reopenAdmission: admission.rollback,
        isInvalidated: () => suspensionInvalidated,
        warn: params.warn,
      });
      schedulingPaused = false;
      return {
        status: "busy",
        reason: "active-work",
        retryAfterMs: GATEWAY_SUSPEND_RETRY_AFTER_MS,
        counts: snapshot.counts,
        blockers: snapshot.blockers,
      };
    }
    if (!admission.commit()) {
      throw new Error("gateway suspension admission changed during preparation");
    }
    admissionCommitted = true;
    const suspensionId = (params.createSuspensionId ?? randomUUID)();
    const expiresAtMs = nowMs + GATEWAY_SUSPEND_TTL_MS;
    const held = armExpiry({
      requestId: params.requestId,
      suspensionId,
      expiresAtMs,
      snapshot,
      admission,
      resumeScheduling: params.resumeScheduling,
      nowMs: params.nowMs ?? Date.now,
      warn: params.warn,
    });
    COORDINATOR_STATE.held = held;
    return {
      status: "ready",
      suspensionId,
      expiresAtMs,
      counts: snapshot.counts,
      blockers: snapshot.blockers,
    };
  } catch (err) {
    if (schedulingPaused) {
      resumeSchedulingBeforeReopen({
        resumeScheduling: params.resumeScheduling,
        reopenAdmission: admissionCommitted ? admission.release : admission.rollback,
        isInvalidated: () => suspensionInvalidated,
        warn: params.warn,
      });
    } else if (admissionCommitted) {
      admission.release();
    } else {
      admission.rollback();
    }
    throw err;
  }
}

export function getGatewaySuspendStatus(suspensionId: string): GatewaySuspendStatusResult {
  const current = COORDINATOR_STATE.held;
  const held = current ? normalizeExpiredHeldSuspension(current) : null;
  if (!held) {
    return { status: "running" };
  }
  if (held.suspensionId !== suspensionId) {
    return { status: "conflict", expiresAtMs: held.expiresAtMs };
  }
  return { status: "ready", expiresAtMs: held.expiresAtMs };
}

export function resumeGatewaySuspend(suspensionId: string): GatewaySuspendResumeResult {
  const current = COORDINATOR_STATE.held;
  const held = current ? normalizeExpiredHeldSuspension(current) : null;
  if (!held) {
    return {
      ok: true,
      status: "running",
      resumed: false,
    };
  }
  if (held.suspensionId !== suspensionId) {
    return { ok: false, reason: "suspension-mismatch" };
  }
  const released = releaseHeldSuspension(held);
  if (!released.released) {
    return {
      ok: false,
      reason: "scheduler-resume-failed",
      message: released.message ?? "gateway suspension scheduler resume failed",
    };
  }
  return {
    ok: true,
    status: "running",
    resumed: true,
  };
}

export function resetGatewaySuspendCoordinatorForTest(): void {
  const held = COORDINATOR_STATE.held;
  if (held) {
    clearHeldTimer(held);
    COORDINATOR_STATE.held = null;
    try {
      held.resumeScheduling();
    } catch (err) {
      held.warn?.(`gateway scheduler resume failed during test reset: ${String(err)}`);
    }
    held.admission.release();
  }
  COORDINATOR_STATE.held = null;
}
