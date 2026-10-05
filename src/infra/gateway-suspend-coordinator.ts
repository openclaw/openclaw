// Coordinates atomic host suspension preparation and terminal-policy-aware drain leases.
import { randomUUID } from "node:crypto";
import { err as resultError, ok, type Result } from "@openclaw/normalization-core/result";
import type { GatewaySuspendHandoffResult } from "../../packages/gateway-protocol/src/index.js";
import {
  getGatewayRestartDrainSignal,
  getGatewaySuspendAdmissionPhase,
  isGatewayRestartDraining,
  tryBeginGatewaySuspendAdmission,
} from "../process/gateway-work-admission.js";
import {
  createGatewayActiveWorkSnapshot,
  type GatewayActiveWorkInspectors,
} from "./gateway-active-work.js";
import {
  GATEWAY_SUSPEND_TTL_MS,
  GATEWAY_SUSPEND_RETRY_AFTER_MS,
  type GatewaySuspendTerminalPolicy,
  type GatewaySuspendPrepareResult,
  type GatewaySuspendStatusResult,
  type GatewaySuspendResumeResult,
  type HeldGatewaySuspension,
  type GatewaySuspendHandoffOwner,
  type GatewaySuspendPreparation,
  COORDINATOR_STATE,
  schedulerRecoveryResult,
  schedulerResumeFailure,
  clearEntryTimer,
  resumeAndReopen,
  currentSuspension,
  resumeSchedulingBeforeReopen,
  armExpiry,
  renewHeldSuspension,
  heldWorkSnapshot,
  refreshHeldSuspension,
  heldPrepareResult,
} from "./gateway-suspend-coordinator-state.js";
import { createGatewaySuspendReaderCustody } from "./gateway-suspend-reader-custody.js";

export type { GatewaySuspendHandoffOwner } from "./gateway-suspend-coordinator-state.js";

/** Acquire an idle lease, or optionally preserve existing work behind a drain fence. */
export async function prepareGatewaySuspend(params: {
  requestId: string;
  terminalPolicy?: GatewaySuspendTerminalPolicy;
  drain?: boolean;
  pauseScheduling: () => void;
  resumeScheduling: () => void;
  inspect?: Partial<GatewayActiveWorkInspectors>;
  nowMs?: () => number;
  createSuspensionId?: () => string;
  warn?: (message: string) => void;
  beforeDrain?: (assertCurrent: () => void) => Promise<void>;
  assertCurrent?: () => void;
}): Promise<GatewaySuspendPrepareResult> {
  const terminalPolicy = params.terminalPolicy ?? "preserve";
  params.assertCurrent?.();
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
    if (!existing.handoff && !existing.reader) {
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
    const activeEntry = COORDINATOR_STATE.current ?? COORDINATOR_STATE.preparing;
    if (activeEntry?.owner !== owner) {
      return;
    }
    clearEntryTimer(activeEntry);
    COORDINATOR_STATE.current = null;
    COORDINATOR_STATE.preparing = null;
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
  const preparation: GatewaySuspendPreparation = {
    kind: "preparing",
    owner,
    resumeScheduling: params.resumeScheduling,
    reopenAdmission: () => reopenAdmission(),
    warn: params.warn,
    invalidate: () => {
      suspensionInvalidated = true;
    },
  };
  COORDINATOR_STATE.preparing = preparation;
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
    let snapshot = createGatewayActiveWorkSnapshot(params.inspect, activeWorkOptions);
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
    if (params.beforeDrain) {
      const remainingMs = Math.min(
        nowMs + GATEWAY_SUSPEND_TTL_MS - (params.nowMs ?? Date.now)(),
        deadlineAtMs - performance.now(),
      );
      const timerGeneration = (preparation.timerGeneration ?? 0) + 1;
      preparation.timerGeneration = timerGeneration;
      preparation.timer = setTimeout(
        () => {
          if (
            preparation.timerGeneration !== timerGeneration ||
            COORDINATOR_STATE.preparing !== preparation
          ) {
            return;
          }
          clearEntryTimer(preparation);
          resume();
          preparation.invalidate();
          if (COORDINATOR_STATE.preparing === preparation) {
            COORDINATOR_STATE.preparing = null;
          }
        },
        Math.max(0, Math.ceil(remainingMs)),
      );
      preparation.timer.unref?.();
      const assertCurrent = () => {
        params.assertCurrent?.();
        if (
          suspensionInvalidated ||
          COORDINATOR_STATE.preparing !== preparation ||
          isGatewayRestartDraining() ||
          (params.nowMs ?? Date.now)() >= nowMs + GATEWAY_SUSPEND_TTL_MS ||
          performance.now() >= deadlineAtMs
        ) {
          throw new Error("gateway suspension changed before restart intent capture");
        }
      };
      await params.beforeDrain(assertCurrent);
      assertCurrent();
      snapshot = createGatewayActiveWorkSnapshot(params.inspect, activeWorkOptions);
    }
    params.assertCurrent?.();
    if (!(snapshot.idle ? admission.commit() : admission.drain())) {
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
  } finally {
    clearEntryTimer(preparation);
    if (COORDINATOR_STATE.preparing === preparation) {
      COORDINATOR_STATE.preparing = null;
    }
  }
}

function handoffRefusal(held: HeldGatewaySuspension, owner: GatewaySuspendHandoffOwner) {
  if (held.reader) {
    return "gateway writer retirement is irreversible";
  }
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

/** Transfers one exact, drained suspension to its native process owner. */
export async function prepareGatewaySuspendedReader(params: {
  suspensionId: string;
  request: import("../gateway/server-public.js").GatewayReaderRequest;
  owner: GatewaySuspendHandoffOwner;
  assertCurrent: () => void;
}): Promise<import("../gateway/server-public.js").GatewayReaderReceipt> {
  const held = COORDINATOR_STATE.current ?? getRestartingSuspension();
  if (
    held?.kind !== "held" ||
    held.suspensionId !== params.suspensionId ||
    !params.owner.prepareReader
  ) {
    throw new Error("Exact prepared suspension and native reader owner are required");
  }
  params.assertCurrent();
  if (!params.owner.isCurrent()) {
    throw new Error("Gateway host reader owner changed");
  }
  const expiresAtMs = params.request.expiresAtMs;
  const reader = held.reader;
  if (reader) {
    if (reader.owner !== params.owner || reader.expiresAtMs !== params.request.expiresAtMs) {
      throw new Error("Gateway reader retirement is already bound to another deadline or owner");
    }
    reader.assertCurrent();
    const receipt = await reader.receipt;
    reader.assertCurrent();
    return receipt;
  }
  const snapshot = refreshHeldSuspension(held);
  if (
    held.terminalPolicy !== "terminate" ||
    !held.drain ||
    !snapshot?.idle ||
    snapshot.writeCustody.some((section) => section.count > 0)
  ) {
    throw new Error("Gateway reader retirement requires drained work and settled write custody");
  }
  if (!Number.isSafeInteger(expiresAtMs) || expiresAtMs <= Date.now()) {
    throw new Error("Gateway reader replacement deadline has expired");
  }
  clearEntryTimer(held);
  held.handoff = undefined;
  // Install custody before invoking an async native join, including synchronous refusal.
  held.reader = createGatewaySuspendReaderCustody({
    owner: params.owner,
    request: params.request,
    snapshot,
    getCurrent: () =>
      (COORDINATOR_STATE.current ?? getRestartingSuspension()) === held ? held.reader : undefined,
  });
  return await held.reader.receipt;
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
    const snapshot = heldWorkSnapshot(retired);
    return {
      status: "draining",
      ...(includeLifecycle ? { ownerId: retired.requestId, phase: retired.shutdown!.phase } : {}),
      expiresAtMs: retired.reader?.expiresAtMs ?? retired.expiresAtMs,
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
    expiresAtMs: held.reader?.expiresAtMs ?? held.expiresAtMs,
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
  if (held?.kind === "held" && held.reader) {
    return { ok: false, reason: "gateway-restarting" };
  }
  if (held?.kind === "recovering") {
    return schedulerResumeFailure();
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
    return schedulerResumeFailure();
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
  const preparing = COORDINATOR_STATE.preparing;
  COORDINATOR_STATE.current = null;
  COORDINATOR_STATE.preparing = null;
  COORDINATOR_STATE.retiredForLifecycleReset = null;
  const entries = new Set([current, retired, preparing]);
  for (const entry of entries) {
    if (!entry) {
      continue;
    }
    if (entry.kind === "preparing") {
      entry.invalidate();
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
