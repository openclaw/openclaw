import { randomUUID } from "node:crypto";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { isEmbeddedRunHandleCompacting } from "../agents/embedded-agent-runner/runs.probes.js";
import { racePromiseWithAbortSignal } from "../infra/abort-signal.js";
import { notifyGatewayWorkMetricsChanged } from "../infra/gateway-work-metrics-events.js";
import { diagnosticLogger as diag, logSessionStateChange } from "../logging/diagnostic-runtime.js";
import {
  isDiagnosticSessionStateCurrent,
  peekDiagnosticSessionState,
  type SessionRef,
  type SessionStateValue,
} from "../logging/diagnostic-session-state.js";
import { normalizeAgentId, parseAgentSessionKey } from "../routing/session-key.js";
import { assertTurnAdmission } from "./session-controller.admission-rule.js";
import {
  REPLY_RUN_IDLE_SETTLE_TIMEOUT_MS,
  ReplyRunAlreadyActiveError,
  type ReplyBackendHandle,
  type ReplyOperation,
  type ReplyOperationPhase,
  type SessionControllerMailboxClaim,
  type ReplyRunAdmissionSource,
  type SessionControllerEntry,
  type ReplyRunCompletionObservation,
  sessionControllerOperationState,
} from "./session-controller.contracts.js";
import {
  getSessionControllerEntryForOperation,
  isCurrentSessionControllerOperation,
} from "./session-controller.identity.js";
import * as controllerStorage from "./session-controller.storage.js";
import { sessionTargetOwnersMatch, type SessionTarget } from "./session-controller.target.js";

export {
  sessionControllers,
  controllerEntryByOperation,
  lifecycleAdmissionByOperation,
  evictReplyOperationByOperation,
  operationsByUpstreamAbortSignal,
  producerCompletionByOperation,
} from "./session-controller.storage.js";
export type {
  ReplyRunAdmissionSource,
  SessionControllerEntry,
  ReplyOperationAdmission,
} from "./session-controller.contracts.js";
export { waitForReplyBarrierSettlement } from "./session-controller.settlement.js";

/** Read the exact current owner's internal observations, never a replacement's state. */
export function readSessionControllerOperationState(operation: ReplyOperation | undefined) {
  const active = operation && controllerStorage.controllerEntryByOperation.get(operation)?.active;
  return active && active === operation ? active[sessionControllerOperationState] : undefined;
}

/** Physical scope participates in selection, not just later writer validation. */
export function findSessionControllerEntries(
  key: string,
  target?: SessionTarget,
): SessionControllerEntry[] {
  const normalizedKey = key.trim();
  const exact = target ? undefined : controllerStorage.sessionControllers.get(normalizedKey);
  if (exact) {
    return [exact];
  }
  const aliases = target?.aliases ?? [normalizedKey];
  const candidates = new Set(
    aliases.flatMap((alias) => [
      ...(controllerStorage.sessionControllerEntriesByAlias.get(alias) ?? []),
    ]),
  );
  const matches = [...candidates].filter(
    (entry) =>
      (!target || !entry.target || sessionTargetOwnersMatch(entry.target, target)) &&
      aliases.some((alias) => entry.aliases.has(alias)),
  );
  if (matches.length > 1) {
    diag.warn(
      `ambiguous session controller identity: sessionKey=${key.trim()} entryIds=${matches
        .map((entry) => entry.id)
        .toSorted()
        .join(",")}`,
    );
  }
  return matches;
}
export function findSessionControllerEntry(
  key: string,
  target?: SessionTarget,
): SessionControllerEntry | undefined {
  const exact = controllerStorage.sessionControllers.get(key);
  // Registry IDs are private and never substituted for operation.key.
  if (exact && exact.id !== exact.key && !target) {
    return exact;
  }
  // Key-only lookup can overlap across stores while logical aliases and rekeys remain live.
  const matches = findSessionControllerEntries(key, target);
  return matches.length === 1 ? matches[0] : undefined;
}
export function bindSessionControllerEntryTarget(
  entry: SessionControllerEntry,
  target: SessionTarget,
): void {
  if (entry.target && entry.target.storeScope !== target.storeScope) {
    throw new Error("Cannot move a controller between physical stores");
  }
  if (entry.target && !sessionTargetOwnersMatch(entry.target, target)) {
    throw new Error("Cannot move a controller between agent owners");
  }
  const competing = findSessionControllerEntries(target.sessionKey, target).filter(
    (candidate) => candidate !== entry,
  );
  if (competing.length) {
    throw new Error("Physical session already has a different controller owner");
  }
  for (const alias of target.aliases) {
    if (
      alias !== target.incarnation &&
      ![...(entry.lifecycle?.operations ?? [])].some((operation) =>
        operation.hasOwnedSessionId(alias),
      )
    ) {
      entry.logicalAliases.add(alias);
    }
  }
  // Nested logical lookups must retain the owner's prepared physical store and agent.
  const agentId = target.agentId ?? entry.target?.agentId;
  const physicalStorePath = target.physicalStorePath ?? entry.target?.physicalStorePath;
  entry.target =
    agentId !== target.agentId || physicalStorePath !== target.physicalStorePath
      ? Object.freeze({ ...target, agentId, physicalStorePath })
      : target;
  const storeEntries =
    controllerStorage.sessionControllerEntriesByStore.get(target.storeScope) ?? new Set();
  storeEntries.add(entry);
  controllerStorage.sessionControllerEntriesByStore.set(target.storeScope, storeEntries);
  refreshSessionControllerEntryAliases(entry);
}
export function refreshSessionControllerEntryAliases(entry: SessionControllerEntry): void {
  const previousAliases = entry.aliases;
  entry.aliases = new Set(entry.logicalAliases);
  if (entry.target?.incarnation) {
    entry.aliases.add(entry.target.incarnation);
  }
  for (const target of entry.lifecycle?.targets.keys() ?? []) {
    for (const alias of target.aliases) {
      entry.aliases.add(alias);
    }
  }
  for (const operation of entry.lifecycle?.operations ?? []) {
    for (const id of operation.captureOwnedSessionIds()) {
      entry.aliases.add(id);
    }
  }
  if (entry.active) {
    for (const id of entry.active.captureOwnedSessionIds()) {
      entry.aliases.add(id);
    }
  }
  unindexSessionControllerAliases(entry, previousAliases);
  if (controllerStorage.sessionControllers.get(entry.id) !== entry) {
    return;
  }
  for (const alias of entry.aliases) {
    addSessionControllerEntryAlias(entry, alias);
  }
}
function unindexSessionControllerAliases(entry: SessionControllerEntry, aliases: Set<string>) {
  for (const alias of aliases) {
    const entries = controllerStorage.sessionControllerEntriesByAlias.get(alias);
    entries?.delete(entry);
    if (entries?.size === 0) {
      controllerStorage.sessionControllerEntriesByAlias.delete(alias);
    }
  }
}

/** Adds a learned incarnation to the exact alias index. */
export function addSessionControllerEntryAlias(entry: SessionControllerEntry, alias: string): void {
  entry.aliases.add(alias);
  const entries = controllerStorage.sessionControllerEntriesByAlias.get(alias) ?? new Set();
  entries.add(entry);
  controllerStorage.sessionControllerEntriesByAlias.set(alias, entries);
}
export function getSessionControllerEntry(
  key: string,
  target?: SessionTarget,
): SessionControllerEntry {
  const canonicalKey = normalizeOptionalString(key);
  if (!canonicalKey) {
    throw new Error("Session controller requires a canonical session key");
  }
  const registered = controllerStorage.sessionControllers.get(canonicalKey);
  if (registered && !target) {
    return registered;
  }
  const matches = findSessionControllerEntries(canonicalKey, target);
  if (matches.length > 1) {
    if (matches.some((entry) => entry.active)) {
      throw new ReplyRunAlreadyActiveError(canonicalKey);
    }
    throw new Error("Session controller identity requires a physical store scope");
  }
  let entry = matches[0];
  if (!entry) {
    entry = {
      id: randomUUID(),
      key: canonicalKey,
      aliases: new Set([canonicalKey]),
      logicalAliases: new Set([canonicalKey]),
      waiters: new Set(),
      observations: new Set(),
    };
    controllerStorage.sessionControllers.set(entry.id, entry);
    addSessionControllerEntryAlias(entry, canonicalKey);
  }
  if (target) {
    bindSessionControllerEntryTarget(entry, target);
  }
  return entry;
}
export {
  getSessionControllerEntryForOperation,
  hasSessionControllerIdentity,
  isCurrentSessionControllerOperation,
} from "./session-controller.identity.js";
/** Drops an entry that holds no custody so historical session keys are not retained. */
export function pruneSessionControllerEntry(entry: SessionControllerEntry): void {
  if (
    !entry.active &&
    !entry.attachment &&
    !entry.sourceTurnId &&
    !entry.waiters.size &&
    !entry.followupBarrier &&
    !entry.successorBarrier &&
    !entry.observations.size &&
    !entry.mailbox &&
    !entry.lifecycle &&
    controllerStorage.sessionControllers.get(entry.id) === entry
  ) {
    unindexSessionControllerAliases(entry, entry.aliases);
    if (entry.target) {
      const entries = controllerStorage.sessionControllerEntriesByStore.get(
        entry.target.storeScope,
      );
      entries?.delete(entry);
      if (entries?.size === 0) {
        controllerStorage.sessionControllerEntriesByStore.delete(entry.target.storeScope);
      }
    }
    controllerStorage.sessionControllers.delete(entry.id);
  }
}

export function getSessionControllerOperation(
  key: string,
  target?: SessionTarget,
): ReplyOperation | undefined {
  const normalizedKey = normalizeOptionalString(key);
  if (!normalizedKey) {
    return undefined;
  }
  const operations = findSessionControllerEntries(normalizedKey, target).flatMap((entry) =>
    entry.active ? [entry.active] : [],
  );
  if (operations.length > 1) {
    throw new ReplyRunAlreadyActiveError(key);
  }
  return operations[0];
}
export function* activeSessionOperations(): IterableIterator<ReplyOperation> {
  for (const entry of controllerStorage.sessionControllers.values()) {
    if (entry.active) {
      yield entry.active;
    }
  }
}

export { assertSessionControllerOperation } from "./session-controller.identity.js";

export {
  resolveControllerNativeAttempt,
  attachControllerNativeAttempt,
  detachControllerNativeAttempt,
} from "./session-controller.native-attempt.js";

/** Observe owner departures only for the lifetime of one awaited admission attempt. */
export function observeReplyRunCompletions(sessionKey: string) {
  const entry = getSessionControllerEntry(sessionKey);
  const observation: ReplyRunCompletionObservation = { changed: false, sources: new Map() };
  entry.observations.add(observation);
  return {
    read: () => (observation.changed ? [...observation.sources.values()] : undefined),
    dispose: () => {
      entry.observations.delete(observation);
      observation.sources.clear();
      pruneSessionControllerEntry(entry);
    },
  };
}

export function resolveReplyOperationAgentId(sessionKey: string, agentId?: string) {
  const owner = normalizeOptionalString(agentId) ?? parseAgentSessionKey(sessionKey)?.agentId;
  return owner ? normalizeAgentId(owner) : undefined;
}

export function prepareReplyRunKeyUpdate(
  operation: ReplyOperation,
  nextSessionKey: string,
  agentId: string | undefined,
  stateCleared: boolean,
  mailboxClaim?: SessionControllerMailboxClaim,
): { sessionKey: string; agentId?: string } | undefined {
  const nextKey = normalizeOptionalString(nextSessionKey);
  if (!nextKey) {
    throw new Error("Reply operations require a canonical sessionKey");
  }
  const nextAgentId = resolveReplyOperationAgentId(nextKey, agentId) ?? operation.agentId;
  if (nextKey === operation.key && nextAgentId === operation.agentId) {
    return undefined;
  }
  // Running and settled operations have already published their abort/steer/wait identity.
  const operationState = readSessionControllerOperationState(operation);
  if (operation.result || stateCleared || operationState?.phase !== "queued") {
    throw new Error(`Cannot rekey reply operation ${operation.key} in phase ${operation.phase}`);
  }
  const entry = getSessionControllerEntryForOperation(operation);
  const destination = mailboxClaim?.mailbox.owner.target;
  if (
    operation.agentId &&
    nextAgentId &&
    normalizeAgentId(operation.agentId) !== normalizeAgentId(nextAgentId) &&
    (!destination?.agentId ||
      normalizeAgentId(destination.agentId) !== normalizeAgentId(nextAgentId))
  ) {
    throw new Error("Changing agent owner requires matching destination admission");
  }
  const target = entry.target
    ? { ...entry.target, sessionKey: nextKey, aliases: [nextKey], agentId: nextAgentId }
    : undefined;
  const targetOwner = getSessionControllerOperation(nextKey, target);
  if (targetOwner !== operation) {
    const owner = mailboxClaim?.mailbox.owner ?? findSessionControllerEntry(nextKey, target);
    if (owner) {
      assertTurnAdmission(owner, {
        kind: operationState.turnKind,
        sessionKey: nextKey,
        registeredEntry: controllerStorage.sessionControllers.get(owner.id),
        claim: mailboxClaim,
      });
    }
  }
  return { sessionKey: nextKey, agentId: nextAgentId };
}

export function notifyReplyRunEnded(entry: SessionControllerEntry): void {
  for (const observation of entry.observations) {
    observation.changed = true;
  }
  if (!entry.active) {
    const waiters = entry.waiters;
    entry.waiters = new Set();
    for (const waiter of waiters) {
      waiter.finish(true);
    }
  }
  entry.mailbox?.wake();
  pruneSessionControllerEntry(entry);
}

export { resolveReplyRunForCurrentSessionId } from "./session-controller.identity.js";

export function isReplyRunCompacting(operation: ReplyOperation): boolean {
  const phase = readSessionControllerOperationState(operation)?.phase;
  if (phase === "preflight_compacting" || phase === "memory_flushing") {
    return true;
  }
  const backend = phase === "running" ? getAttachedBackend(operation) : undefined;
  return backend ? isEmbeddedRunHandleCompacting(operation.sessionId, backend) === true : false;
}

export function isReplyOperationPreBackendPhase(phase: ReplyOperationPhase): boolean {
  return (
    phase === "queued" ||
    phase === "waiting_for_deferred_maintenance" ||
    phase === "waiting_for_global_lane"
  );
}

export function markReplyOperationExecutionStarted(operation: ReplyOperation): void {
  controllerStorage.executionStartedOperations.add(operation);
  notifyGatewayWorkMetricsChanged();
}
export function hasReplyOperationExecutionStarted(operation: ReplyOperation): boolean {
  return controllerStorage.executionStartedOperations.has(operation);
}
/** Backend run IDs stay the operation's identity after detach, until the operation settles. */
export function recordOperationBackendRunId(operation: ReplyOperation, runId: string | undefined) {
  if (!runId) {
    return;
  }
  const runIds = controllerStorage.backendRunIdsByOperation.get(operation) ?? new Set<string>();
  runIds.add(runId);
  controllerStorage.backendRunIdsByOperation.set(operation, runIds);
}

export function hasOperationBackendRunId(operation: ReplyOperation, runId: string): boolean {
  return controllerStorage.backendRunIdsByOperation.get(operation)?.has(runId) === true;
}

export function getAttachedBackendAttachment(operation: ReplyOperation) {
  const entry = controllerStorage.controllerEntryByOperation.get(operation);
  return entry?.active === operation && entry.attachment?.operation === operation
    ? entry.attachment.backend
    : undefined;
}

export function getAttachedBackend(operation: ReplyOperation): ReplyBackendHandle | undefined {
  return getAttachedBackendAttachment(operation)?.handle;
}

// Committed output belongs to the bounded finalization owner. Stale recovery
// must not cancel delivery after the backend has already produced its answer.
export function hasCommittedReplyOperationOutcome(operation: ReplyOperation): boolean {
  return !operation.result && operation.abortFrozen;
}

export function isReplyOperationAbortable(operation: ReplyOperation): boolean {
  if (operation.result || operation.abortFrozen) {
    return false;
  }
  const backend = getAttachedBackend(operation);
  if (!backend?.isAbortable) {
    return true;
  }
  try {
    return backend.isAbortable();
  } catch {
    return false;
  }
}

/** Only the operation's own unforgeable signal can borrow its turn for preflight. */
export function resolveSessionControllerOperationForSignal(
  signal: AbortSignal | undefined,
): ReplyOperation | undefined {
  const operation = signal && controllerStorage.operationsByUpstreamAbortSignal.get(signal);
  return operation &&
    signal === operation.abortSignal &&
    isCurrentSessionControllerOperation(operation) &&
    !operation.result &&
    !signal.aborted
    ? operation
    : undefined;
}

export function runAfterReplyOperationClear(
  operation: ReplyOperation,
  afterClear: (sessionId: string) => void,
): void {
  const afterClearState = controllerStorage.afterClearByOperation.get(operation);
  if (!afterClearState?.barrier && !isCurrentSessionControllerOperation(operation)) {
    const barrier = getSessionControllerEntryForOperation(operation).followupBarrier;
    const source = barrier?.sources.get(
      controllerStorage.lifecycleAdmissionByOperation.get(operation)?.databaseIdentity,
    );
    if (barrier && source) {
      void barrier.settled.then(() => afterClear(source.sessionId));
      return;
    }
    afterClear(operation.sessionId);
    return;
  }
  const state = afterClearState ?? { callbacks: new Set<(sessionId: string) => void>() };
  state.callbacks.add(afterClear);
  controllerStorage.afterClearByOperation.set(operation, state);
}

export function isReplyOperationAbortedForRestart(operation: ReplyOperation): boolean {
  return operation.result?.kind === "aborted" && operation.result.code === "aborted_for_restart";
}

export function mergeReplyRunAdmissionSource<T extends ReplyRunAdmissionSource>(
  source: T,
  previous?: ReplyRunAdmissionSource,
): T {
  // Only a connected, non-restarted lineage in one store merges, in place so retained
  // clear callbacks keep a stable source reference.
  if (
    previous &&
    !isReplyOperationAbortedForRestart(previous.operation) &&
    previous.databaseIdentity === source.databaseIdentity &&
    source.sessionIds.has(previous.sessionId)
  ) {
    for (const id of source.sessionIds) {
      previous.sessionIds.add(id);
    }
    return Object.assign(previous, source, { sessionIds: previous.sessionIds });
  }
  return source;
}

/** Carries the exact operation lineage and physical database into an admission fence. */
export function resolveReplyRunAdmissionSource(
  operation: ReplyOperation,
  sessionId: string,
  previous?: ReplyRunAdmissionSource,
): ReplyRunAdmissionSource {
  return mergeReplyRunAdmissionSource(
    {
      sessionId,
      sessionIds: operation.captureOwnedSessionIds(),
      operation,
      databaseIdentity:
        controllerStorage.lifecycleAdmissionByOperation.get(operation)?.databaseIdentity,
    },
    previous,
  );
}

export function clearReplyRunState(params: {
  sessionKey: string;
  sessionId: string;
  operation: ReplyOperation;
}): void {
  const entry = getSessionControllerEntryForOperation(params.operation);
  if (!isCurrentSessionControllerOperation(params.operation)) {
    return;
  }
  for (const observation of entry.observations) {
    if (
      !params.operation.result ||
      params.operation.key !== params.sessionKey ||
      isReplyOperationAbortedForRestart(params.operation)
    ) {
      observation.sources.clear();
      continue;
    }
    const source = resolveReplyRunAdmissionSource(params.operation, params.sessionId);
    observation.sources.set(
      source.databaseIdentity,
      mergeReplyRunAdmissionSource(source, observation.sources.get(source.databaseIdentity)),
    );
  }
  entry.active = undefined;
  if (entry.attachment?.operation === params.operation) {
    entry.attachment = undefined;
  }
  entry.sourceTurnId = undefined;
  logSessionStateChange({
    sessionKey: params.sessionKey,
    sessionId: params.sessionId,
    state: "idle",
    reason: "reply_operation_ended",
    consumeQueuedTurn: false,
  });
  notifyGatewayWorkMetricsChanged();
  notifyReplyRunEnded(entry);
}

/** Repair only the projection; missing execution never releases retained writer or input custody. */
export function reconcileSessionControllerDiagnosticState(
  params: SessionRef & { stateGeneration?: number; expectedState?: SessionStateValue },
): "idle" | "waiting" | undefined {
  if (
    params.stateGeneration === undefined ||
    !isDiagnosticSessionStateCurrent({
      ...params,
      generation: params.stateGeneration,
      state: params.expectedState,
    })
  ) {
    return undefined;
  }
  const entries = [
    ...new Set(
      [params.sessionKey, params.sessionId].flatMap((key) =>
        key ? findSessionControllerEntries(key) : [],
      ),
    ),
  ];
  if (entries.some((entry) => entry.active)) {
    return undefined;
  }
  const observed = peekDiagnosticSessionState(params);
  if (!observed) {
    return undefined;
  }
  const state =
    observed.queueDepth > 0 ||
    entries.some(
      (entry) =>
        entry.attachment ||
        entry.followupBarrier ||
        entry.successorBarrier ||
        entry.mailbox?.entries.length ||
        entry.mailbox?.claim ||
        entry.lifecycle,
    )
      ? "waiting"
      : "idle";
  logSessionStateChange({
    ...params,
    state,
    reason: state === "waiting" ? "session_work_pending" : "stale_session_state_reconciled",
    consumeQueuedTurn: false,
  });
  // Publish first: waking the mailbox may synchronously start a successor.
  for (const entry of entries) {
    entry.mailbox?.wake();
  }
  return state;
}

/** Incoming sources consult the same owner policy as the autonomous timer. */
export function isReplyRunEvidenceStale(operation: ReplyOperation): boolean {
  const action = operation.watchdog.decide().action;
  return action === "stop" || action === "expire_cleanup" || action === "blocked";
}

export function expireVisibleStaleOperation(operation: ReplyOperation | undefined): boolean {
  if (!operation) {
    return false;
  }
  void operation.watchdog.tick();
  return !isCurrentSessionControllerOperation(operation);
}

export function resolveVisibleActiveWaitMs(operation: ReplyOperation | undefined): number {
  const deadline = operation?.watchdog.decide().deadlineAtMs;
  return deadline === undefined
    ? REPLY_RUN_IDLE_SETTLE_TIMEOUT_MS
    : Math.min(REPLY_RUN_IDLE_SETTLE_TIMEOUT_MS, Math.max(1, deadline - Date.now()));
}

export {
  getReplyOperationSessionReader,
  getReplyOperationSessionTarget,
  acquireReplyOperationSessionActor,
  captureReplyOperationSessionReader,
  acknowledgeReplySessionTransition,
} from "./session-controller.session-reader.js";

/** Await this exact owner's current backend generation, including recovery startup. */
export async function waitForReplyOperationBackend(
  operation: ReplyOperation,
  signal?: AbortSignal,
): Promise<boolean> {
  const entry = getSessionControllerEntryForOperation(operation);
  const key = operation.key;
  const current = () =>
    operation.key === key &&
    entry.active === operation &&
    !operation.result &&
    !operation.abortSignal.aborted;
  signal?.throwIfAborted();
  if (!current()) {
    return false;
  }
  const ready = controllerStorage.backendReadyByOperation.get(operation);
  if (ready) {
    await racePromiseWithAbortSignal(ready, signal);
  }
  return (
    controllerStorage.backendReadyByOperation.get(operation) === ready &&
    current() &&
    readSessionControllerOperationState(operation)?.phase === "running" &&
    entry.attachment?.backend !== undefined
  );
}
