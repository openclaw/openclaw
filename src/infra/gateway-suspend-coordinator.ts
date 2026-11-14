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
// Drain preparation waits for persistence, then hands running work to committed
// shutdown. Reconnects do not extend its deadline; freeze retains its own TTL.
const GATEWAY_SUSPEND_DRAIN_BUDGET_MS = 45_000;
const GATEWAY_SUSPEND_BUSY_RETRY_AFTER_MS = 20_000;
const GATEWAY_SUSPEND_DRAIN_POLL_MS = 5_000;

type GatewaySuspendTerminalPolicy = NonNullable<GatewaySuspendPrepareParams["terminalPolicy"]>;

type GatewaySuspendPrepareResult =
  | GatewaySuspendPrepareWireResult
  | { status: "conflict"; expiresAtMs: number };

type GatewaySuspendStatusResult =
  | GatewaySuspendStatusWireResult
  | { status: "conflict"; expiresAtMs: number };

type GatewaySuspendResumeResult =
  | GatewaySuspendResumeWireResult
  | { ok: false; reason: "suspension-mismatch" }
  | { ok: false; reason: "gateway-restarting" };

type HeldGatewaySuspension = {
  owner: object;
  resumeScheduling: () => void;
  reopenAdmission: (reason?: string) => boolean;
  warn?: (message: string) => void;
  timer?: ReturnType<typeof setTimeout>;
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

type GatewaySuspendCoordinatorState = {
  current: HeldGatewaySuspension | null;
  retiredForLifecycleReset?: HeldGatewaySuspension | null;
};

const COORDINATOR_STATE = resolveGlobalSingleton(
  Symbol.for("openclaw.gatewaySuspendCoordinatorState"),
  (): GatewaySuspendCoordinatorState => ({
    current: null,
    retiredForLifecycleReset: null,
  }),
);

function clearEntryTimer(entry: HeldGatewaySuspension): void {
  if (entry.timer) {
    clearTimeout(entry.timer);
    entry.timer = undefined;
  }
}

function scheduleResume(entry: HeldGatewaySuspension, delayMs: number): void {
  clearEntryTimer(entry);
  entry.timer = setTimeout(() => {
    if (COORDINATOR_STATE.current === entry) {
      resumeAndReopen(entry, "expired");
    }
  }, delayMs);
  entry.timer.unref?.();
}

function resumeAndReopen(entry: HeldGatewaySuspension, reason = "resume"): void {
  if (reason === "expired") {
    entry.warn?.(
      `gateway suspension ${entry.drain ? "drain deadline" : "lease"} expired owner=${JSON.stringify(entry.requestId)} leaseId=${JSON.stringify(entry.suspensionId)}; reopening admission`,
    );
  }
  clearEntryTimer(entry);
  resumeSchedulingBeforeReopen({
    resumeScheduling: entry.resumeScheduling,
    reopenAdmission: () => entry.reopenAdmission(reason),
    isInvalidated: () => COORDINATOR_STATE.current !== entry,
    warn: entry.warn,
  });
  if (COORDINATOR_STATE.current === entry) {
    COORDINATOR_STATE.current = null;
  }
}

function normalizeExpiredHeldSuspension(held: HeldGatewaySuspension): HeldGatewaySuspension | null {
  if (held.nowMs() < held.expiresAtMs && performance.now() < held.deadlineAtMs) {
    return held;
  }
  resumeAndReopen(held, "expired");
  return COORDINATOR_STATE.current;
}

function currentSuspension(): HeldGatewaySuspension | null {
  const current = COORDINATOR_STATE.current;
  return current ? normalizeExpiredHeldSuspension(current) : null;
}

function resumeSchedulingBeforeReopen(params: {
  resumeScheduling: () => void;
  reopenAdmission: (reason?: string) => boolean;
  isInvalidated: () => boolean;
  warn?: (message: string) => void;
}): void {
  if (params.isInvalidated()) {
    return;
  }
  try {
    params.resumeScheduling();
  } catch (err) {
    params.warn?.("gateway scheduler resume failed; retry scheduling through cron: " + String(err));
  }
  if (!params.isInvalidated()) {
    params.reopenAdmission();
  }
}

function armExpiry(entry: HeldGatewaySuspension): HeldGatewaySuspension {
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

function suspensionReady(drain: boolean, snapshot: GatewayActiveWorkSnapshot): boolean {
  return drain ? snapshot.writeCustody.every(({ count }) => count === 0) : snapshot.idle;
}

function refreshHeldSuspension(held: HeldGatewaySuspension): GatewayActiveWorkSnapshot | undefined {
  // Polls and renewals retain the update's terminal policy even after the first idle observation.
  const snapshot = createGatewayActiveWorkSnapshot(held.inspect, {
    ignoreTerminalSessions: held.terminalPolicy === "terminate",
  });
  if (COORDINATOR_STATE.current !== held || normalizeExpiredHeldSuspension(held) !== held) {
    return undefined;
  }
  if (suspensionReady(held.drain, snapshot)) {
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
  return suspensionReady(held.drain, snapshot)
    ? { status: "ready", ...result }
    : { status: "draining", ...result, retryAfterMs: GATEWAY_SUSPEND_DRAIN_POLL_MS };
}

/** Freeze only idle work; drain preparation leaves running work for committed shutdown. */
export function prepareGatewaySuspend(params: {
  requestId: string;
  terminalPolicy?: GatewaySuspendTerminalPolicy;
  drain?: boolean;
  pauseScheduling: () => void;
  resumeScheduling: () => void;
  inspect?: Partial<GatewayActiveWorkInspectors>;
  nowMs?: () => number;
  createSuspensionId?: () => string;
  caller?: string;
  warn?: (message: string) => void;
}): GatewaySuspendPrepareResult {
  const terminalPolicy = params.terminalPolicy ?? "preserve";
  const drain = params.drain === true;
  const activeWorkOptions = {
    ignoreTerminalSessions: terminalPolicy === "terminate",
  };
  const nowMs = (params.nowMs ?? Date.now)();
  const ttlMs = drain ? GATEWAY_SUSPEND_DRAIN_BUDGET_MS : GATEWAY_SUSPEND_TTL_MS;
  const deadlineAtMs = performance.now() + ttlMs;
  const existing = currentSuspension();
  if (existing) {
    if (
      existing.requestId !== params.requestId ||
      existing.terminalPolicy !== terminalPolicy ||
      existing.drain !== drain
    ) {
      return { status: "conflict", expiresAtMs: existing.expiresAtMs };
    }
    // Drain admission has an absolute deadline, including after becoming ready.
    if (!existing.drain && !existing.handoff) {
      existing.nowMs = params.nowMs ?? Date.now;
      renewHeldSuspension(existing, nowMs);
    }
    const snapshot = refreshHeldSuspension(existing);
    if (!snapshot) {
      throw new Error("gateway suspension changed during preparation");
    }
    return heldPrepareResult(existing, snapshot);
  }

  const owner = {};
  const suspensionId = (params.createSuspensionId ?? randomUUID)();
  let suspensionInvalidated = false;
  const admission = tryBeginGatewaySuspendAdmission(
    () => {
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
      if (signal.aborted) {
        activeEntry.handoff = undefined;
        activeEntry.shutdown = { signal, phase: "interrupting" };
      }
    },
    {
      owner: params.requestId,
      leaseId: suspensionId,
      caller: params.caller ?? "in-process",
      reason: drain ? "drain" : "freeze",
    },
  );
  if (!admission) {
    const snapshot = createGatewayActiveWorkSnapshot(params.inspect, activeWorkOptions);
    return {
      status: "busy",
      reason: "gateway-draining",
      retryAfterMs: GATEWAY_SUSPEND_BUSY_RETRY_AFTER_MS,
      activeCount: snapshot.counts.totalActive,
      blockers: snapshot.blockers,
      writeCustody: snapshot.writeCustody,
    };
  }

  let schedulingPaused = false;
  let reopenAdmission = admission.rollback;
  const resume = () =>
    resumeSchedulingBeforeReopen({
      resumeScheduling: params.resumeScheduling,
      reopenAdmission,
      isInvalidated: () => suspensionInvalidated,
      warn: params.warn,
    });
  try {
    params.pauseScheduling();
    schedulingPaused = true;
    const snapshot = createGatewayActiveWorkSnapshot(params.inspect, activeWorkOptions);
    if ((params.nowMs ?? Date.now)() >= nowMs + ttlMs || performance.now() >= deadlineAtMs) {
      throw new Error("gateway suspension expired during preparation");
    }
    if (!snapshot.idle && !drain) {
      resume();
      schedulingPaused = false;
      return {
        status: "busy",
        reason: "active-work",
        retryAfterMs: GATEWAY_SUSPEND_BUSY_RETRY_AFTER_MS,
        activeCount: snapshot.counts.totalActive,
        blockers: snapshot.blockers,
        writeCustody: snapshot.writeCustody,
      };
    }
    const ready = suspensionReady(drain, snapshot);
    const admissionTransition = ready ? admission.commit : admission.drain;
    if (!admissionTransition()) {
      throw new Error("gateway suspension admission changed during preparation");
    }
    reopenAdmission = admission.release;
    const expiresAtMs = nowMs + ttlMs;
    const held = armExpiry({
      owner,
      requestId: params.requestId,
      terminalPolicy,
      drain,
      suspensionId,
      expiresAtMs,
      deadlineAtMs,
      inspect: params.inspect,
      commitAdmission: ready ? undefined : admission.commit,
      reopenAdmission,
      resumeScheduling: params.resumeScheduling,
      nowMs: params.nowMs ?? Date.now,
      warn: params.warn,
    });
    COORDINATOR_STATE.current = held;
    return heldPrepareResult(held, snapshot);
  } catch (err) {
    if (schedulingPaused) {
      resume();
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
  const snapshot = createGatewayActiveWorkSnapshot(held.inspect, {
    ignoreTerminalSessions: held.terminalPolicy === "terminate",
  });
  if (snapshot.counts.terminalPersistence > 0) {
    return "gateway terminal persistence is still pending";
  }
  if (snapshot.writeCustody.some(({ count }) => count > 0)) {
    return "gateway write custody is still pending";
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
  if (!held || held.suspensionId !== params.suspensionId) {
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
  if (!held || !owner || held.handoff !== owner) {
    return ok(false);
  }
  held.handoff = undefined;
  const refusal = handoffRefusal(held, owner);
  return refusal ? resultError(refusal) : ok(true);
}

export function disarmGatewaySuspendHandoff(owner: GatewaySuspendHandoffOwner): void {
  const held = COORDINATOR_STATE.current;
  if (held?.handoff === owner) {
    held.handoff = undefined;
  }
}

function getRestartingSuspension(): HeldGatewaySuspension | undefined {
  const retired = COORDINATOR_STATE.retiredForLifecycleReset;
  return retired?.shutdown?.signal === getGatewayRestartDrainSignal() ? retired : undefined;
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
  const held = retired ?? currentSuspension();
  if (!held) {
    return { status: "running" };
  }
  if (held.suspensionId !== suspensionId) {
    return { status: "conflict", expiresAtMs: held.expiresAtMs };
  }
  // Committed shutdown outlives the reversible lease. Only observation remains;
  // never run expiry recovery or commit its invalidated admission here.
  const snapshot = retired
    ? createGatewayActiveWorkSnapshot(held.inspect, {
        ignoreTerminalSessions: held.terminalPolicy === "terminate",
      })
    : refreshHeldSuspension(held);
  if (!snapshot) {
    return getGatewaySuspendStatus(suspensionId, includeLifecycle);
  }
  if (retired || !suspensionReady(held.drain, snapshot)) {
    return {
      status: "draining",
      ...(includeLifecycle
        ? {
            ownerId: held.requestId,
            phase: retired ? retired.shutdown!.phase : ("draining" as const),
          }
        : {}),
      expiresAtMs: held.expiresAtMs,
      activeCount: snapshot.counts.totalActive,
      blockers: snapshot.blockers,
      writeCustody: snapshot.writeCustody,
      retryAfterMs: GATEWAY_SUSPEND_DRAIN_POLL_MS,
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
  if (held && held.suspensionId !== suspensionId) {
    return { ok: false, reason: "suspension-mismatch" };
  }
  if (held) {
    resumeAndReopen(held);
  }
  return {
    ok: true,
    status: "running",
    resumed: held !== null,
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
    entry.reopenAdmission("lifecycle-reset");
  }
}
