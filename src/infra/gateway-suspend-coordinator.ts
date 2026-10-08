// Coordinates atomic host suspension preparation and terminal-policy-aware drain leases.
import { randomUUID } from "node:crypto";
import { err as resultError, ok, type Result } from "@openclaw/normalization-core/result";
import type {
  GatewaySuspendHandoffResult,
  GatewaySuspendPrepareParams,
  GatewaySuspendPrepareResult as GatewaySuspendPrepareWireResult,
  GatewaySuspendResumeResult as GatewaySuspendResumeWireResult,
  GatewaySuspendStatusResult as GatewaySuspendStatusWireResult,
} from "../../packages/gateway-protocol/src/index.js";
import {
  getGatewayRestartDrainSignal,
  getGatewaySuspendAdmissionPhase,
  isGatewayRestartDraining,
  tryBeginGatewaySuspendAdmission,
} from "../process/gateway-work-admission.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import {
  createGatewayActiveWorkSnapshot,
  type GatewayActiveWorkInspectors,
  type GatewayActiveWorkSnapshot,
} from "./gateway-active-work.js";

const GATEWAY_SUSPEND_TTL_MS = 2 * 60_000;
const GATEWAY_SUSPEND_RETRY_AFTER_MS = 20_000;
const GATEWAY_SCHEDULER_RECOVERY_RETRY_MS = 1_000;

type GatewaySuspendTerminalPolicy = NonNullable<GatewaySuspendPrepareParams["terminalPolicy"]>;

type GatewaySchedulerRecoveryResult = {
  status: "recovering";
  reason: "scheduler-resume-failed";
  retryAfterMs: number;
};

type GatewaySuspendPrepareResult =
  | GatewaySuspendPrepareWireResult
  | { status: "conflict"; expiresAtMs: number }
  | GatewaySchedulerRecoveryResult;

type GatewaySuspendStatusResult =
  | GatewaySuspendStatusWireResult
  | { status: "conflict"; expiresAtMs: number }
  | GatewaySchedulerRecoveryResult;

type GatewaySuspendResumeResult =
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

type HeldGatewaySuspension = GatewaySuspendCoordinatorEntryBase & {
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
  shutdown?: { signal: AbortSignal; phase: "interrupting" | "exiting" };
  commitAdmission?: () => boolean;
  nowMs: () => number;
};

/** Private identity of one live process-owning host iteration, never a wire token. */
export type GatewaySuspendHandoffOwner = {
  isCurrent: () => boolean;
  /** Transfers a validated suspension into this host's synchronous one-way shutdown. */
  commitStop?: () => void;
};

type GatewaySchedulerRecovery = GatewaySuspendCoordinatorEntryBase & {
  kind: "recovering";
};

type GatewaySuspendCoordinatorEntry = HeldGatewaySuspension | GatewaySchedulerRecovery;

type GatewaySuspendCoordinatorState = {
  current: GatewaySuspendCoordinatorEntry | null;
  retiredForLifecycleReset?: GatewaySuspendCoordinatorEntry | null;
};

const COORDINATOR_STATE = resolveGlobalSingleton(
  Symbol.for("openclaw.gatewaySuspendCoordinatorState"),
  (): GatewaySuspendCoordinatorState => ({
    current: null,
    retiredForLifecycleReset: null,
  }),
);

function schedulerRecoveryResult(): GatewaySchedulerRecoveryResult {
  return {
    status: "recovering",
    reason: "scheduler-resume-failed",
    retryAfterMs: GATEWAY_SCHEDULER_RECOVERY_RETRY_MS,
  };
}

function clearEntryTimer(entry: GatewaySuspendCoordinatorEntry): void {
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

function resumeAndReopen(entry: GatewaySuspendCoordinatorEntry): boolean {
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
  if (held.nowMs() < held.expiresAtMs && performance.now() < held.deadlineAtMs) {
    return held;
  }
  resumeAndReopen(held);
  return COORDINATOR_STATE.current;
}

function currentSuspension(): GatewaySuspendCoordinatorEntry | null {
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
function resumeSchedulingBeforeReopen(params: {
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

function armExpiry(held: Omit<HeldGatewaySuspension, "kind">): HeldGatewaySuspension {
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

function renewHeldSuspension(held: HeldGatewaySuspension, nowMs: number): void {
  held.expiresAtMs = nowMs + GATEWAY_SUSPEND_TTL_MS;
  held.deadlineAtMs = performance.now() + GATEWAY_SUSPEND_TTL_MS;
  scheduleResume(held, GATEWAY_SUSPEND_TTL_MS);
}

function refreshHeldSuspension(held: HeldGatewaySuspension): GatewayActiveWorkSnapshot | undefined {
  // Polls and renewals retain the update's terminal policy even after the first idle observation.
  const snapshot = createGatewayActiveWorkSnapshot(held.inspect, {
    ignoreTerminalSessions: held.terminalPolicy === "terminate",
  });
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

function heldPrepareResult(
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

/** Acquire an idle lease, or optionally preserve existing work behind a drain fence. */
export function prepareGatewaySuspend(params: {
  requestId: string;
  terminalPolicy?: GatewaySuspendTerminalPolicy;
  drain?: boolean;
  pauseScheduling: () => void;
  resumeScheduling: () => void;
  inspect?: Partial<GatewayActiveWorkInspectors>;
  nowMs?: () => number;
  createSuspensionId?: () => string;
  warn?: (message: string) => void;
}): GatewaySuspendPrepareResult {
  const terminalPolicy = params.terminalPolicy ?? "preserve";
  const drain = params.drain === true;
  const activeWorkOptions = {
    ignoreTerminalSessions: terminalPolicy === "terminate",
  };
  const nowMs = (params.nowMs ?? Date.now)();
  const deadlineAtMs = performance.now() + GATEWAY_SUSPEND_TTL_MS;
  const existing = currentSuspension();
  if (existing?.kind === "recovering") {
    return schedulerRecoveryResult();
  }
  if (existing) {
    if (
      existing.requestId !== params.requestId ||
      existing.terminalPolicy !== terminalPolicy ||
      existing.drain !== drain
    ) {
      return { status: "conflict", expiresAtMs: existing.expiresAtMs };
    }
    // Repeated preparation may renew a lease, never an already-armed interruption.
    if (!existing.handoff) {
      existing.nowMs = params.nowMs ?? Date.now;
      renewHeldSuspension(existing, nowMs);
    }
    const snapshot = refreshHeldSuspension(existing);
    if (!snapshot) {
      if (COORDINATOR_STATE.current?.kind === "recovering") {
        return schedulerRecoveryResult();
      }
      throw new Error("gateway suspension changed during preparation");
    }
    return heldPrepareResult(existing, snapshot);
  }

  const owner = {};
  let suspensionInvalidated = false;
  const admission = tryBeginGatewaySuspendAdmission(() => {
    suspensionInvalidated = true;
    const activeEntry = COORDINATOR_STATE.current;
    if (activeEntry?.owner !== owner) {
      return;
    }
    clearEntryTimer(activeEntry);
    COORDINATOR_STATE.current = null;
    // Restart drain must not resume the old scheduler while shutdown is in
    // flight. Keep its cleanup until the next in-process lifecycle begins.
    COORDINATOR_STATE.retiredForLifecycleReset = activeEntry;
    const signal = getGatewayRestartDrainSignal();
    if (activeEntry.kind === "held" && signal.aborted) {
      activeEntry.handoff = undefined;
      activeEntry.shutdown = { signal, phase: "interrupting" };
    }
  });
  if (!admission) {
    const snapshot = createGatewayActiveWorkSnapshot(params.inspect, activeWorkOptions);
    return {
      status: "busy",
      reason: "gateway-draining",
      retryAfterMs: GATEWAY_SUSPEND_RETRY_AFTER_MS,
      activeCount: snapshot.counts.totalActive,
      blockers: snapshot.blockers,
      writeCustody: snapshot.writeCustody,
    };
  }

  let schedulingPaused = false;
  let reopenAdmission = admission.rollback;
  const resume = () =>
    resumeSchedulingBeforeReopen({
      owner,
      resumeScheduling: params.resumeScheduling,
      reopenAdmission,
      isInvalidated: () => suspensionInvalidated,
      warn: params.warn,
    });
  try {
    params.pauseScheduling();
    schedulingPaused = true;
    const snapshot = createGatewayActiveWorkSnapshot(params.inspect, activeWorkOptions);
    if (
      (params.nowMs ?? Date.now)() >= nowMs + GATEWAY_SUSPEND_TTL_MS ||
      performance.now() >= deadlineAtMs
    ) {
      throw new Error("gateway suspension expired during preparation");
    }
    if (!snapshot.idle && !drain) {
      const resumed = resume();
      schedulingPaused = false;
      if (!resumed) {
        return schedulerRecoveryResult();
      }
      return {
        status: "busy",
        reason: "active-work",
        retryAfterMs: GATEWAY_SUSPEND_RETRY_AFTER_MS,
        activeCount: snapshot.counts.totalActive,
        blockers: snapshot.blockers,
        writeCustody: snapshot.writeCustody,
      };
    }
    const admissionTransition = snapshot.idle ? admission.commit : admission.drain;
    if (!admissionTransition()) {
      throw new Error("gateway suspension admission changed during preparation");
    }
    reopenAdmission = admission.release;
    const suspensionId = (params.createSuspensionId ?? randomUUID)();
    const expiresAtMs = nowMs + GATEWAY_SUSPEND_TTL_MS;
    const held = armExpiry({
      owner,
      requestId: params.requestId,
      terminalPolicy,
      drain,
      suspensionId,
      expiresAtMs,
      deadlineAtMs,
      inspect: params.inspect,
      commitAdmission: snapshot.idle ? undefined : admission.commit,
      reopenAdmission,
      resumeScheduling: params.resumeScheduling,
      nowMs: params.nowMs ?? Date.now,
      warn: params.warn,
    });
    COORDINATOR_STATE.current = held;
    return heldPrepareResult(held, snapshot);
  } catch (err) {
    if (schedulingPaused) {
      if (!resume()) {
        return schedulerRecoveryResult();
      }
    } else {
      reopenAdmission();
    }
    throw err;
  }
}

function handoffRefusal(held: HeldGatewaySuspension, owner: GatewaySuspendHandoffOwner) {
  if (
    COORDINATOR_STATE.current !== held ||
    held.nowMs() >= held.expiresAtMs ||
    performance.now() >= held.deadlineAtMs ||
    !owner.isCurrent()
  ) {
    return "gateway suspension or host iteration changed";
  }
  // READY retains this server-owned inspector too: final-chat writes can arrive
  // after preparation and must never be replaced by the process-only inventory.
  if (!held.inspect?.getTerminalPersistence) {
    return "gateway terminal persistence inspection is unavailable";
  }
  if (held.inspect.getTerminalPersistence() > 0) {
    return "gateway terminal persistence is still pending";
  }
  return undefined;
}

/** The authenticated handler verifies the process target before this synchronous commit. */
export function armGatewaySuspendHandoff(params: {
  suspensionId: string;
  owner: GatewaySuspendHandoffOwner;
  commit?: true;
}): Result<GatewaySuspendHandoffResult, string> {
  const committed = params.commit ? getRestartingSuspension() : undefined;
  if (
    committed?.suspensionId === params.suspensionId &&
    committed.committedStopOwner === params.owner
  ) {
    return ok({
      status: "committed",
      suspensionId: committed.suspensionId,
      expiresAtMs: committed.expiresAtMs,
    });
  }
  const held = COORDINATOR_STATE.current;
  if (held?.kind !== "held" || held.suspensionId !== params.suspensionId) {
    return resultError("gateway suspension id does not match");
  }
  const refusal = handoffRefusal(held, params.owner);
  if (refusal) {
    return resultError(refusal);
  }
  if (held.handoff && held.handoff !== params.owner) {
    return resultError("gateway suspension already belongs to another host iteration");
  }
  if (params.commit) {
    if (!params.owner.commitStop) {
      return resultError("gateway host does not support committed suspension stop");
    }
    const snapshot = createGatewayActiveWorkSnapshot(held.inspect, {
      ignoreTerminalSessions: held.terminalPolicy === "terminate",
    });
    if (snapshot.writeCustody.some(({ count }) => count > 0)) {
      return resultError("gateway write custody is still pending");
    }
    const changed = handoffRefusal(held, params.owner);
    if (changed) {
      return resultError(changed);
    }
    held.handoff = params.owner;
    try {
      params.owner.commitStop();
    } catch {
      // The callback may already have committed shutdown. Never reopen admission
      // or turn an unknown stop outcome into permission to replay native effects.
      return resultError("gateway suspension stop commitment outcome is uncertain");
    }
    const signal = getGatewayRestartDrainSignal();
    if (
      COORDINATOR_STATE.retiredForLifecycleReset !== held ||
      !signal.aborted ||
      held.shutdown?.signal !== signal ||
      !isGatewayRestartDraining()
    ) {
      return resultError("gateway suspension stop commitment outcome is uncertain");
    }
    held.committedStopOwner = params.owner;
    return ok({
      status: "committed",
      suspensionId: held.suspensionId,
      expiresAtMs: held.expiresAtMs,
    });
  }
  held.handoff = params.owner;
  return ok({ status: "armed", suspensionId: held.suspensionId, expiresAtMs: held.expiresAtMs });
}

/** Consume synchronously before restart drain invalidates suspension or retires the host. */
export function consumeGatewaySuspendHandoff(
  owner: GatewaySuspendHandoffOwner | undefined,
): Result<boolean, string> {
  const held = COORDINATOR_STATE.current;
  if (held?.kind !== "held" || !owner || held.handoff !== owner) {
    return ok(false);
  }
  held.handoff = undefined;
  const refusal = handoffRefusal(held, owner);
  return refusal ? resultError(refusal) : ok(true);
}

export function disarmGatewaySuspendHandoff(owner: GatewaySuspendHandoffOwner): void {
  const held = COORDINATOR_STATE.current;
  if (held?.kind === "held" && held.handoff === owner) {
    held.handoff = undefined;
  }
}

function getRestartingSuspension(): HeldGatewaySuspension | undefined {
  const retired = COORDINATOR_STATE.retiredForLifecycleReset;
  return retired?.kind === "held" && retired.shutdown?.signal === getGatewayRestartDrainSignal()
    ? retired
    : undefined;
}

/** Control reconnects retain authentication and never admit node or worker work. */
export function isGatewaySuspendControlAvailable(): boolean {
  const phase = getGatewaySuspendAdmissionPhase();
  return (
    getRestartingSuspension()?.shutdown?.phase === "interrupting" ||
    (!isGatewayRestartDraining() && (phase === "draining" || phase === "prepared"))
  );
}

/** Records teardown without renewing the retired lease or restoring its authority. */
export function markGatewaySuspendExiting(): void {
  const retired = getRestartingSuspension();
  if (retired?.shutdown) {
    retired.shutdown.phase = "exiting";
  }
}

export function getGatewaySuspendStatus(
  suspensionId: string,
  includeLifecycle = false,
): GatewaySuspendStatusResult {
  const retired = getRestartingSuspension();
  if (retired) {
    if (retired.suspensionId !== suspensionId) {
      return { status: "conflict", expiresAtMs: retired.expiresAtMs };
    }
    // Committed shutdown outlives the reversible lease. Only observation remains;
    // never run expiry recovery or commit its invalidated admission here.
    const snapshot = createGatewayActiveWorkSnapshot(retired.inspect, {
      ignoreTerminalSessions: retired.terminalPolicy === "terminate",
    });
    return {
      status: "draining",
      ...(includeLifecycle ? { ownerId: retired.requestId, phase: retired.shutdown!.phase } : {}),
      expiresAtMs: retired.expiresAtMs,
      activeCount: snapshot.counts.totalActive,
      blockers: snapshot.blockers,
      writeCustody: snapshot.writeCustody,
      retryAfterMs: GATEWAY_SUSPEND_RETRY_AFTER_MS,
    };
  }
  const held = currentSuspension();
  if (held?.kind === "recovering") {
    return schedulerRecoveryResult();
  }
  if (!held) {
    return { status: "running" };
  }
  if (held.suspensionId !== suspensionId) {
    return { status: "conflict", expiresAtMs: held.expiresAtMs };
  }
  const snapshot = refreshHeldSuspension(held);
  if (!snapshot) {
    return getGatewaySuspendStatus(suspensionId, includeLifecycle);
  }
  if (!snapshot.idle) {
    return {
      status: "draining",
      ...(includeLifecycle ? { ownerId: held.requestId, phase: "draining" as const } : {}),
      expiresAtMs: held.expiresAtMs,
      activeCount: snapshot.counts.totalActive,
      blockers: snapshot.blockers,
      writeCustody: snapshot.writeCustody,
      retryAfterMs: GATEWAY_SUSPEND_RETRY_AFTER_MS,
    };
  }
  return {
    status: "ready",
    ...(includeLifecycle ? { ownerId: held.requestId } : {}),
    expiresAtMs: held.expiresAtMs,
    writeCustody: snapshot.writeCustody,
  };
}

export function resumeGatewaySuspend(suspensionId: string): GatewaySuspendResumeResult {
  const retired = getRestartingSuspension();
  if (retired) {
    return {
      ok: false,
      reason: retired.suspensionId === suspensionId ? "gateway-restarting" : "suspension-mismatch",
    };
  }
  const held = currentSuspension();
  if (held?.kind === "recovering") {
    return {
      ok: false,
      reason: "scheduler-resume-failed",
      retryAfterMs: GATEWAY_SCHEDULER_RECOVERY_RETRY_MS,
    };
  }
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
  if (!resumeAndReopen(held)) {
    return {
      ok: false,
      reason: "scheduler-resume-failed",
      retryAfterMs: GATEWAY_SCHEDULER_RECOVERY_RETRY_MS,
    };
  }
  return {
    ok: true,
    status: "running",
    resumed: true,
  };
}

// An in-process restart rebuilds scheduler and admission ownership. Resume and
// discard the old suspension first so paused work cannot leak across lifecycles.
export function resetGatewaySuspendCoordinatorForLifecycleRestart(): void {
  const current = COORDINATOR_STATE.current;
  const retired = COORDINATOR_STATE.retiredForLifecycleReset;
  COORDINATOR_STATE.current = null;
  COORDINATOR_STATE.retiredForLifecycleReset = null;
  const entries = current && current !== retired ? [current, retired] : [current ?? retired];
  for (const entry of entries) {
    if (!entry) {
      continue;
    }
    clearEntryTimer(entry);
    try {
      entry.resumeScheduling();
    } catch (err) {
      entry.warn?.(`gateway scheduler resume failed during lifecycle reset: ${String(err)}`);
    }
    entry.reopenAdmission();
  }
}
