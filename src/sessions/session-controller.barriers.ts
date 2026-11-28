/** Operation-owned delivery and successor fences share one barrier registration path. */
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { ReplyFollowupAdmissionBarrierTimeoutPolicy } from "../auto-reply/reply/reply-dispatcher.types.js";
import { createDeferredCore } from "../shared/deferred.js";
import {
  REPLY_RUN_IDLE_SETTLE_TIMEOUT_MS,
  type ReplyOperation,
  type ReplyRunAdmissionSource,
  type ReplyRunAdmissionBarrier,
  type ReplyOperationAfterClear,
  type ReplyOperationSuccessorBarrierGroup,
} from "./session-controller.contracts.js";
import { logSessionControllerPhase } from "./session-controller.diagnostics.js";
import {
  getSessionControllerEntryForOperation,
  isCurrentSessionControllerOperation,
} from "./session-controller.identity.js";
import { waitForReplyBarrierSettlement } from "./session-controller.settlement.js";
import {
  getSessionControllerEntry,
  getSessionControllerOperation,
  findSessionControllerEntry,
  mergeReplyRunAdmissionSource,
  pruneSessionControllerEntry,
  resolveReplyRunAdmissionSource,
} from "./session-controller.state.js";
import * as controllerStorage from "./session-controller.storage.js";

function registerReplyRunAdmissionBarrier(
  barrierKind: "followupBarrier" | "successorBarrier",
  sessionKey: string,
  initialSource: ReplyRunAdmissionSource,
  barrier: Promise<void>,
): ReplyRunAdmissionBarrier {
  const sourceOwner = getSessionControllerEntryForOperation(initialSource.operation);
  const owner =
    controllerStorage.sessionControllers.get(sourceOwner.id) === sourceOwner &&
    sourceOwner.aliases.has(sessionKey)
      ? sourceOwner
      : getSessionControllerEntry(
          sessionKey,
          sourceOwner.target
            ? { ...sourceOwner.target, sessionKey, aliases: [sessionKey] }
            : undefined,
        );
  const previous = owner[barrierKind];
  const source = mergeReplyRunAdmissionSource(
    initialSource,
    previous?.sources.get(initialSource.databaseIdentity),
  );
  // Retain only the latest source per physical store in this pending chain.
  // A foreign global barrier must not hide a same-store compaction successor.
  const sources = new Map(previous?.sources);
  sources.set(source.databaseIdentity, source);
  const settled = previous
    ? Promise.all([previous.settled, barrier]).then(() => undefined)
    : barrier;
  const entry = { settled, source, sources };
  owner[barrierKind] = entry;
  const diagnosticIdentity = {
    phase: barrierKind === "successorBarrier" ? "successor-barrier" : "followup-barrier",
    sessionKey,
    sessionId: source.sessionId,
  } as const;
  logSessionControllerPhase({ ...diagnosticIdentity, status: "waiting" });
  void settled.then(() => {
    logSessionControllerPhase({ ...diagnosticIdentity, status: "settled" });
    if (owner[barrierKind] === entry) {
      owner[barrierKind] = undefined;
      owner.mailbox?.wake();
      pruneSessionControllerEntry(owner);
    }
  });
  return entry;
}

/** Fence successor admission until owner handoff started at slot clear settles. */
export function registerReplyOperationSuccessorBarrier(params: {
  operation: ReplyOperation;
  sessionId: string;
  sessionKeys: readonly string[];
  start: () => PromiseLike<unknown>;
  /** Resource release fences start at clear; moving an active owner does not release it. */
  deferUntilClear?: boolean;
}): void {
  const settlement = createDeferredCore();
  const sources = new Map<string, ReplyRunAdmissionSource>();
  for (const sessionKey of new Set(params.sessionKeys.map(normalizeOptionalString))) {
    if (sessionKey) {
      sources.set(sessionKey, resolveReplyRunAdmissionSource(params.operation, params.sessionId));
    }
  }
  const publish = () => {
    for (const [sessionKey, source] of sources) {
      sources.set(
        sessionKey,
        registerReplyRunAdmissionBarrier("successorBarrier", sessionKey, source, settlement.promise)
          .source,
      );
    }
  };
  if (!params.deferUntilClear) {
    publish();
  }
  let started = false;
  // A failed handoff leaves the fence closed so callers never observe a partial release.
  const logHandoffFailed = () =>
    logSessionControllerPhase({
      phase: "successor-barrier",
      status: "failed",
      sessionKey: params.operation.key,
      sessionId: params.sessionId,
      reason: "handoff-failed-fence-retained",
    });
  const start = () => {
    if (started) {
      return;
    }
    started = true;
    try {
      if (params.deferUntilClear) {
        publish();
      }
      void Promise.resolve(params.start()).then(
        () => settlement.resolve(undefined),
        logHandoffFailed,
      );
    } catch {
      logHandoffFailed();
    }
  };
  if (!isCurrentSessionControllerOperation(params.operation)) {
    start();
    return;
  }
  const groups =
    controllerStorage.successorBarrierGroupsByOperation.get(params.operation) ??
    new Set<ReplyOperationSuccessorBarrierGroup>();
  groups.add({ registrationKey: params.operation.key, sources });
  controllerStorage.successorBarrierGroupsByOperation.set(params.operation, groups);
  const starts =
    controllerStorage.successorBarrierStartsByOperation.get(params.operation) ??
    new Set<() => void>();
  starts.add(start);
  controllerStorage.successorBarrierStartsByOperation.set(params.operation, starts);
}

/** Resolve only the live operation admitted with this exact upstream signal. */
export function resolveActiveReplyRunOwnerForSignal(signal: AbortSignal):
  | {
      sessionId: string;
      sessionKey: string;
      abort: () => boolean;
      handoff: (settle: (producerCompleted: Promise<unknown>) => Promise<void>) => boolean;
    }
  | undefined {
  const operation = controllerStorage.operationsByUpstreamAbortSignal.get(signal);
  if (!operation) {
    return undefined;
  }
  const { key: sessionKey, sessionId } = operation;
  const isCurrent = () =>
    !signal.aborted &&
    !operation.result &&
    operation.key === sessionKey &&
    operation.sessionId === sessionId &&
    isCurrentSessionControllerOperation(operation);
  if (!isCurrent()) {
    return undefined;
  }
  return {
    sessionId,
    sessionKey,
    // A retained selector must never cancel the operation that replaced this owner.
    abort: () => isCurrent() && operation.abortByUser(),
    handoff: (settle) => {
      const producerCompleted = controllerStorage.producerCompletionByOperation.get(operation);
      if (!isCurrent() || !producerCompleted) {
        return false;
      }
      const settlement = settle(producerCompleted);
      registerReplyOperationSuccessorBarrier({
        operation,
        sessionId,
        sessionKeys: [sessionKey],
        start: () => settlement,
      });
      return true;
    },
  };
}

export function startReplyOperationSuccessorBarriers(operation: ReplyOperation): void {
  const starts = controllerStorage.successorBarrierStartsByOperation.get(operation);
  // These maps are operation-owned lifecycle metadata, not identity indexes.
  // Clear drops both before handoff starts so adoption cannot retain stale groups.
  controllerStorage.successorBarrierStartsByOperation.delete(operation);
  controllerStorage.successorBarrierGroupsByOperation.delete(operation);
  if (!starts) {
    return;
  }
  for (const start of starts) {
    start();
  }
}

export function updateSuccessorAdmissionSessionId(
  operation: ReplyOperation,
  sessionId: string,
): void {
  for (const group of controllerStorage.successorBarrierGroupsByOperation.get(operation) ?? []) {
    if (group.registrationKey !== operation.key) {
      continue;
    }
    for (const source of group.sources.values()) {
      resolveReplyRunAdmissionSource(operation, sessionId, source);
    }
  }
}

export function isReplyRunSuccessorAdmissionBlocked(sessionKey: string): boolean {
  const normalizedSessionKey = normalizeOptionalString(sessionKey);
  return Boolean(
    normalizedSessionKey &&
    !getSessionControllerOperation(normalizedSessionKey) &&
    findSessionControllerEntry(normalizedSessionKey)?.successorBarrier,
  );
}

export function flushReplyOperationAfterClear(operation: ReplyOperation, sessionId: string): void {
  const state = controllerStorage.afterClearByOperation.get(operation);
  if (!state) {
    return;
  }
  controllerStorage.afterClearByOperation.delete(operation);
  for (const callback of state.callbacks) {
    callback(sessionId);
  }
}

export function registerFollowupAdmissionBarrier(
  operation: ReplyOperation,
  barrier: PromiseLike<unknown>,
  timeout: number | ReplyFollowupAdmissionBarrierTimeoutPolicy = REPLY_RUN_IDLE_SETTLE_TIMEOUT_MS,
): ReplyRunAdmissionBarrier {
  const entry = registerReplyRunAdmissionBarrier(
    "followupBarrier",
    operation.key,
    resolveReplyRunAdmissionSource(operation, operation.sessionId),
    waitForReplyBarrierSettlement(barrier, timeout),
  );
  // A later global barrier may belong to another store. Late callbacks still
  // wait for this operation's own delivery before releasing admission.
  const afterClear: ReplyOperationAfterClear = controllerStorage.afterClearByOperation.get(
    operation,
  ) ?? { callbacks: new Set() };
  afterClear.barrier = entry;
  controllerStorage.afterClearByOperation.set(operation, afterClear);
  return entry;
}

export function updateFollowupAdmissionSessionId(operation: ReplyOperation): void {
  const sources = getSessionControllerEntryForOperation(operation).followupBarrier?.sources;
  const databaseIdentity =
    controllerStorage.lifecycleAdmissionByOperation.get(operation)?.databaseIdentity;
  const source = sources?.get(databaseIdentity);
  if (sources && source) {
    sources.set(
      databaseIdentity,
      resolveReplyRunAdmissionSource(operation, operation.sessionId, source),
    );
  }
}
