import {
  createAgentRunDirectAbortError,
  createAgentRunRestartAbortError,
  createAgentRunSupersededAbortError,
} from "../agents/run-termination.js";
import type { SessionEntry } from "../config/sessions/types.js";
import { createInternalHookEvent, triggerInternalHook } from "../hooks/internal-hooks.js";
import { getAgentRunContext } from "../infra/agent-run-registry.js";
import {
  type ReplyOperation,
  type CapturedSessionControllerEffect,
  SESSION_CONTROLLER_DRAIN_TIMEOUT_MS,
  type SessionWorkRun,
  type SessionControllerInput,
  type SessionStopChildrenResult,
} from "./session-controller.contracts.js";
import { waitForSessionControllerSettlement } from "./session-controller.lifecycle-observation.js";
import {
  abortSessionControllerInput,
  captureSessionControllerSourceSettlement,
} from "./session-controller.mailbox-source.js";
import {
  getAttachedBackend,
  isReplyOperationAbortable,
  isCurrentSessionControllerOperation,
} from "./session-controller.state.js";
import {
  captureSessionControllerStop,
  captureSessionControllerStopCandidates,
  type SessionControllerStopCapture,
  type SessionControllerStopEffect,
  type SessionControllerStopRunEffect,
} from "./session-controller.stop-capture.js";
import { rpcSourcesByRunId } from "./session-controller.storage.js";

export {
  captureSessionControllerStop,
  captureSessionControllerStopCandidates,
  type SessionControllerStopCapture,
};

export type SessionControllerStopResult = {
  queuedCancelled: number;
  activeCancelled: number;
  abortedInputs: SessionControllerInput[];
  abortedOperations: ReplyOperation[];
  abortedEffects: SessionControllerStopEffect[];
  settled: Promise<void>;
  failures: Array<{
    target: SessionControllerInput | ReplyOperation | CapturedSessionControllerEffect;
    error: unknown;
  }>;
  finalizing: number;
  localModelMayStillBeFinishing?: true;
};

export type SessionStopSource =
  | "channel-user"
  | "client-session"
  | "client-run"
  | "talk"
  | "mutation"
  | "interrupt"
  | "restart"
  | "watchdog"
  | "operator-revocation"
  | "supersede";

type SessionStopPolicy = Readonly<{
  cancelQueued: boolean;
  stopChildren: boolean;
  recordMessageCutoff: boolean;
  fireCommandHook: boolean;
}>;

const commandStop = {
  cancelQueued: true,
  stopChildren: true,
  recordMessageCutoff: false,
  fireCommandHook: true,
} as const;
const ownerStop = {
  cancelQueued: false,
  stopChildren: false,
  recordMessageCutoff: false,
  fireCommandHook: false,
} as const;
const SESSION_STOP_POLICY = {
  "channel-user": { ...commandStop, recordMessageCutoff: true },
  "client-session": commandStop,
  "client-run": commandStop,
  talk: { ...commandStop, cancelQueued: false },
  mutation: ownerStop,
  interrupt: { ...ownerStop, cancelQueued: true },
  restart: { ...ownerStop, cancelQueued: true },
  watchdog: ownerStop,
  "operator-revocation": { ...ownerStop, cancelQueued: true },
  supersede: ownerStop,
} as const satisfies Record<SessionStopSource, SessionStopPolicy>;

export type SessionStopHookContext = Readonly<{
  sessionKey: string;
  sessionEntry?: SessionEntry;
  sessionId?: string;
  commandSource?: string;
  senderId?: string;
}>;

type SessionStopTargetStatus = "aborted" | "finalizing" | "unchanged";

/** An active parent owned outside the controller, stopped after its captured controller owners. */
type SessionStopExternalParent = Readonly<{
  stop: () => SessionStopTargetStatus | Promise<SessionStopTargetStatus>;
  settled?: Promise<unknown>;
}>;

type SessionStopOutcome = Readonly<{
  aborted: boolean;
  alreadyFinalizing: boolean;
  localModelMayStillBeFinishing?: true;
  queuedCancelled: number;
  activeCancelled: number;
  childrenStopped: number;
  childFailures: number;
  settled: Promise<void>;
  failures: SessionControllerStopResult["failures"];
}>;

export type SessionStopExecution = SessionStopOutcome & {
  /** Joins cutoff persistence, the command hook, and captured child cancellation. */
  completed: Promise<SessionStopOutcome>;
};

type SessionStopRequestBase = {
  source: SessionStopSource;
  /** Captured synchronously by ingress; a resolver may select among captured candidates later. */
  capture: SessionControllerStopCapture | (() => SessionControllerStopCapture);
  assertCurrent?: () => void;
  reason?: unknown;
  messageIdentity?: unknown;
  recordAbortTarget?: (options: { recordCutoff: boolean }) => Promise<void>;
  hookContext?: SessionStopHookContext;
  stopChildren?: (applyParentStop: () => Promise<boolean>) => Promise<SessionStopChildrenResult>;
  externalParent?: SessionStopExternalParent;
  /** Authorize and reserve presentation or partial custody before invoking cancel exactly once. */
  cancelInput?: (input: SessionControllerInput, cancel: () => boolean, queued: boolean) => boolean;
  cancelOperation?: (operation: ReplyOperation, cancel: () => boolean) => boolean;
  /** Authorized effects owned by another runtime, sequenced after queued withdrawal. */
  afterQueued?: () => void;
  /** Publication effects that require the captured parent cancellation result. */
  afterParent?: (result: SessionControllerStopResult) => void;
  /** Exact external parents may decline the child cancellation they provisionally captured. */
  continueChildStop?: () => boolean;
  onCancelled?: (target: SessionControllerInput | ReplyOperation) => void;
  /** Publishes only a matched run receipt; runless cancellation remains an owner fact. */
  onEffectCancelled?: (effect: SessionControllerStopRunEffect) => void;
  onError?: (
    target: SessionControllerInput | ReplyOperation | CapturedSessionControllerEffect,
    error: unknown,
  ) => "continue" | void;
};

export type SessionStopRequest = SessionStopRequestBase &
  (
    | {
        source: "mutation";
        mutation: Readonly<{ cancelQueued: boolean; stopChildren: boolean }>;
      }
    | {
        source: Exclude<SessionStopSource, "mutation">;
        mutation?: never;
      }
  );

function isOperationWaitingForLocalModel(operation: ReplyOperation): boolean {
  const runId = getAttachedBackend(operation)?.runId;
  return Boolean(runId && getAgentRunContext(runId)?.localModelWait);
}

/** Observes only the backend attached to this exact current controller source. */
export function isSessionControllerInputWaitingForLocalModel(
  input: SessionControllerInput,
): boolean {
  const operation = input.claim?.operation;
  if (operation) {
    return isOperationWaitingForLocalModel(operation);
  }
  const runId = input.protocolRunId;
  return Boolean(
    runId &&
    [...(rpcSourcesByRunId.get(runId) ?? [])].some((source) => source.input === input) &&
    getAgentRunContext(runId)?.localModelWait,
  );
}

/** One sequencer for captured Stop. Publication adapters wrap, but never replace, its primitive. */
function applySessionControllerStop(
  capture: SessionControllerStopCapture,
  params: Pick<
    SessionStopRequestBase,
    | "source"
    | "assertCurrent"
    | "reason"
    | "cancelInput"
    | "cancelOperation"
    | "afterQueued"
    | "onCancelled"
    | "onEffectCancelled"
    | "onError"
  > & { phase?: "all" | "queued" | "active"; pendingInputs?: readonly SessionControllerInput[] },
): SessionControllerStopResult {
  const result: SessionControllerStopResult = {
    queuedCancelled: 0,
    activeCancelled: 0,
    abortedInputs: [],
    abortedOperations: [],
    abortedEffects: [],
    settled: capture.settled,
    failures: [],
    finalizing: 0,
  };
  const assertCurrent = params.assertCurrent ?? (() => {});
  // Any cancellation signal can clear the provider's live observation synchronously.
  const waitingTargets = new Set<
    SessionControllerInput | ReplyOperation | CapturedSessionControllerEffect
  >([
    ...capture.activeInputs.filter(isSessionControllerInputWaitingForLocalModel),
    ...capture.operations.filter(isOperationWaitingForLocalModel),
    ...capture.effects.filter(
      (captured) => captured.run && getAgentRunContext(captured.run.runId)?.localModelWait,
    ),
  ]);
  const recordLocalWait = (
    target: SessionControllerInput | ReplyOperation | CapturedSessionControllerEffect,
  ) => {
    if (waitingTargets.has(target)) {
      result.localModelMayStillBeFinishing = true;
    }
  };
  const reason =
    params.reason ??
    (params.source === "restart"
      ? createAgentRunRestartAbortError()
      : params.source === "supersede"
        ? createAgentRunSupersededAbortError()
        : params.source === "channel-user"
          ? createAgentRunDirectAbortError()
          : undefined);
  const once = (
    effect: () => boolean,
    committedAfterFailure: () => boolean,
    record: () => void,
  ) => {
    let called = false;
    let accepted = false;
    return () => {
      if (called) {
        return accepted;
      }
      assertCurrent();
      called = true;
      try {
        accepted = effect();
      } catch (error) {
        // Exact owner records distinguish a failed observer from an uncommitted refusal.
        accepted = committedAfterFailure();
        if (accepted) {
          record();
        }
        throw error;
      }
      if (accepted) {
        record();
      }
      return accepted;
    };
  };
  const countFinalizing = (aborted: boolean, operation: ReplyOperation | undefined) => {
    if (
      !aborted &&
      operation &&
      isCurrentSessionControllerOperation(operation) &&
      !operation.result &&
      (operation.abortFrozen || !isReplyOperationAbortable(operation))
    ) {
      result.finalizing++;
    }
  };
  const cancelSource = (input: SessionControllerInput, queued: boolean) => {
    // Adapters may reserve custody first; this primitive revalidates authority at the side effect.
    assertCurrent();
    const operation = input.claim?.operation;
    const hadResult = Boolean(operation?.result);
    const wasRetiring = input.retirementRequested;
    const wasAborted = input.abortSignal.aborted;
    const cancel = once(
      () => abortSessionControllerInput(input, reason, assertCurrent),
      () =>
        (!hadResult && operation?.result?.kind === "aborted") ||
        (!wasRetiring &&
          input.retirementRequested === true &&
          !wasAborted &&
          input.abortSignal.aborted),
      () => {
        result.abortedInputs.push(input);
        if (queued) {
          result.queuedCancelled++;
        } else {
          result.activeCancelled++;
          recordLocalWait(input);
        }
        params.onCancelled?.(input);
      },
    );
    if (params.cancelInput) {
      params.cancelInput(input, cancel, queued);
    } else {
      cancel();
    }
    if (!queued) {
      countFinalizing(input.abortSignal.aborted, operation);
    }
  };
  const effect = (
    target: SessionControllerInput | ReplyOperation | CapturedSessionControllerEffect,
    run: () => void,
  ) => {
    try {
      run();
    } catch (error) {
      result.failures.push({ target, error });
      const committed =
        result.abortedInputs.some((input) => input === target) ||
        result.abortedOperations.some((operation) => operation === target) ||
        result.abortedEffects.some((captured) => captured === target);
      if (params.onError?.(target, error) !== "continue" && !committed) {
        throw error;
      }
    }
  };
  if (params.phase !== "active") {
    const pendingInputs = params.pendingInputs ?? capture.queuedInputs;
    const mailboxes = new Map(
      pendingInputs.map((input) => [input.mailbox, input.mailbox.clearing]),
    );
    // Cancelling the first input must not promote another selected pending input
    // before its own cancellation. Reentrant arrivals remain outside this batch.
    for (const mailbox of mailboxes.keys()) {
      mailbox.clearing = true;
    }
    try {
      for (const input of pendingInputs) {
        effect(input, () => cancelSource(input, true));
      }
      if (params.afterQueued) {
        assertCurrent();
        params.afterQueued();
      }
    } finally {
      for (const [mailbox, clearing] of mailboxes) {
        mailbox.clearing = clearing;
        if (!clearing) {
          mailbox.wake();
        }
      }
    }
  }
  if (params.phase === "queued") {
    return result;
  }
  for (const input of capture.activeInputs) {
    effect(input, () => cancelSource(input, false));
  }
  for (const operation of capture.operations) {
    effect(operation, () => {
      assertCurrent();
      const hadResult = Boolean(operation.result);
      let recorded = false;
      const record = () => {
        if (recorded) {
          return;
        }
        recorded = true;
        result.abortedOperations.push(operation);
        result.activeCancelled++;
        recordLocalWait(operation);
        params.onCancelled?.(operation);
      };
      const cancel = once(
        () => {
          if (!isCurrentSessionControllerOperation(operation)) {
            return false;
          }
          return params.source === "watchdog" ? operation.abortForStall() : operation.abort(reason);
        },
        () =>
          !hadResult &&
          (operation.result?.kind === "aborted" ||
            (params.source === "watchdog" &&
              operation.result?.kind === "failed" &&
              operation.result.code === "run_stalled")),
        record,
      );
      if (params.cancelOperation) {
        if (params.cancelOperation(operation, cancel)) {
          record();
        }
      } else {
        cancel();
      }
      countFinalizing(operation.abortSignal.aborted, operation);
    });
  }
  for (const captured of capture.effects) {
    effect(captured, () => {
      const wasInterrupted = Boolean(captured.effect.interrupted);
      let matchedRun: SessionWorkRun | undefined;
      const cancel = once(
        () => {
          const receipt = captured.interrupt(
            reason instanceof Error ? reason : createAgentRunDirectAbortError(),
          );
          matchedRun = receipt?.run;
          return Boolean(receipt);
        },
        () => !wasInterrupted && captured.effect.cancel.signal.aborted,
        () => {
          result.abortedEffects.push(captured);
          result.activeCancelled++;
          if (captured.run && matchedRun === captured.run) {
            recordLocalWait(captured);
            params.onEffectCancelled?.(captured);
          }
        },
      );
      cancel();
    });
  }
  return result;
}

/** Exact source teardown cancels its captured input without adopting session-wide Stop policy. */
export function cancelCapturedSessionControllerSource(
  capture: SessionControllerStopCapture,
  params: Omit<Parameters<typeof applySessionControllerStop>[1], "source" | "phase"> = {},
): SessionControllerStopResult {
  return applySessionControllerStop(capture, {
    ...params,
    source: "operator-revocation",
    phase: "all",
  });
}

function resolveStopOutcome(
  result: SessionControllerStopResult,
  external: SessionStopTargetStatus,
  children: SessionStopChildrenResult,
): SessionStopOutcome {
  const externalActiveCancelled = external === "aborted" ? 1 : 0;
  return Object.freeze({
    aborted: result.activeCancelled + externalActiveCancelled > 0,
    alreadyFinalizing: result.finalizing > 0 || external === "finalizing",
    ...(result.localModelMayStillBeFinishing
      ? { localModelMayStillBeFinishing: true as const }
      : {}),
    queuedCancelled: result.queuedCancelled,
    activeCancelled: result.activeCancelled + externalActiveCancelled,
    childrenStopped: children.stopped,
    childFailures: children.failed,
    settled: result.settled,
    failures: result.failures,
  });
}

/** Applies the source policy to one captured, caller-authorized stop request. */
export function stopSession(request: SessionStopRequest): SessionStopExecution {
  const sourcePolicy = SESSION_STOP_POLICY[request.source];
  const policy =
    request.source === "mutation"
      ? {
          ...sourcePolicy,
          cancelQueued: request.mutation.cancelQueued,
          stopChildren: request.mutation.stopChildren,
        }
      : sourcePolicy;
  let externalStatus: SessionStopTargetStatus = "unchanged";
  let parentResult: SessionControllerStopResult | undefined;
  let parentFailure: { error: unknown } | undefined;
  const unhandledFailures: unknown[] = [];
  let runPostParent: (() => Promise<void>) | undefined;
  let resolveParentResult!: (result: SessionControllerStopResult) => void;
  let rejectParentResult!: (error: unknown) => void;
  const parentResultReady = new Promise<SessionControllerStopResult>((resolve, reject) => {
    resolveParentResult = resolve;
    rejectParentResult = reject;
  });
  void parentResultReady.catch(() => {});
  const applyParentStopPhase = async (): Promise<boolean> => {
    if (parentResult) {
      return true;
    }
    const capture = typeof request.capture === "function" ? request.capture() : request.capture;
    request.assertCurrent?.();
    // Select pending work once after preparation; active cancellation stays bound
    // to ingress instances, and reentrant arrivals belong to a later Stop.
    const pendingInputs = policy.cancelQueued ? capture.selectPendingInputs() : [];
    const applied = applySessionControllerStop(capture, {
      ...request,
      phase: policy.cancelQueued ? "all" : "active",
      pendingInputs,
      onError: (target, error) => {
        const decision = request.onError?.(target, error);
        if (decision !== "continue") {
          unhandledFailures.push(error);
        }
        return decision;
      },
    });
    const newlyCancelled = applied.abortedInputs.filter((input) => !capture.inputs.includes(input));
    if (newlyCancelled.length) {
      applied.settled = Promise.all([
        applied.settled,
        ...newlyCancelled.map(captureSessionControllerSourceSettlement),
      ]).then(() => undefined);
      void applied.settled.catch(() => {});
    }
    parentResult = applied;
    // The external parent stops after controller owners, and Stop settles only after it does.
    const external = request.externalParent;
    let externalStop: Promise<void> | undefined;
    if (external) {
      request.assertCurrent?.();
      externalStop = Promise.resolve(external.stop()).then((status) => {
        externalStatus = status;
      });
    }
    const externalSettlement = external?.settled;
    if (externalSettlement) {
      applied.settled = Promise.all([applied.settled, externalSettlement]).then(() => undefined);
      void applied.settled.catch(() => {});
    }
    resolveParentResult(applied);
    request.assertCurrent?.();
    request.afterParent?.(applied);
    runPostParent = async () => {
      await externalStop;
      const outcome = resolveStopOutcome(applied, externalStatus, { stopped: 0, failed: 0 });
      if (
        (!outcome.alreadyFinalizing || outcome.activeCancelled > 0) &&
        request.recordAbortTarget
      ) {
        request.assertCurrent?.();
        await request.recordAbortTarget({
          recordCutoff: policy.recordMessageCutoff && request.messageIdentity !== undefined,
        });
      }
      if (policy.fireCommandHook) {
        const hookContext = request.hookContext;
        if (!hookContext) {
          throw new Error(`Stop source ${request.source} requires command hook context`);
        }
        request.assertCurrent?.();
        await triggerInternalHook(
          createInternalHookEvent("command", "stop", hookContext.sessionKey, {
            sessionEntry: hookContext.sessionEntry,
            sessionId: hookContext.sessionId,
            commandSource: hookContext.commandSource,
            senderId: hookContext.senderId,
          }),
        );
      }
    };
    // Let synchronous cancellation observers publish replacement identity before descendants run.
    await Promise.resolve();
    request.assertCurrent?.();
    return request.continueChildStop?.() ?? true;
  };

  const applyParentStop = async (): Promise<boolean> => {
    try {
      return await applyParentStopPhase();
    } catch (error) {
      parentFailure = { error };
      throw error;
    }
  };

  let children: Promise<SessionStopChildrenResult>;
  try {
    children = policy.stopChildren
      ? (request.stopChildren?.(applyParentStop) ??
        applyParentStop().then(() => ({ stopped: 0, failed: 0 })))
      : applyParentStop().then(() => ({ stopped: 0, failed: 0 }));
  } catch (error) {
    rejectParentResult(error);
    throw error;
  }
  const pendingSettlement = parentResultReady.then((result) => result.settled);
  void pendingSettlement.catch(() => {});
  const initial = parentResult
    ? resolveStopOutcome(parentResult, externalStatus, { stopped: 0, failed: 0 })
    : resolveStopOutcome(
        {
          queuedCancelled: 0,
          activeCancelled: 0,
          abortedInputs: [],
          abortedOperations: [],
          abortedEffects: [],
          settled: pendingSettlement,
          failures: [],
          finalizing: 0,
        },
        "unchanged",
        { stopped: 0, failed: 0 },
      );
  const completed = children.then(
    async (childResult) => {
      if (parentFailure) {
        throw parentFailure.error;
      }
      const postParent = runPostParent;
      const currentParentResult = parentResult;
      if (!postParent || !currentParentResult) {
        throw new Error("Parent Stop result is unavailable");
      }
      await postParent();
      // Committed failures never strand later owners but still fail default callers afterward.
      if (unhandledFailures.length === 1) {
        throw unhandledFailures[0];
      }
      if (unhandledFailures.length > 1) {
        throw new AggregateError(unhandledFailures, "Session cancellation failed");
      }
      return resolveStopOutcome(currentParentResult, externalStatus, childResult);
    },
    async (error: unknown) => {
      if (parentFailure) {
        throw error === parentFailure.error
          ? error
          : new AggregateError([parentFailure.error, error], "Session cancellation failed");
      }
      await runPostParent?.();
      throw error;
    },
  );
  void completed.catch(rejectParentResult);
  void completed.catch(() => {});
  return Object.freeze({ ...initial, completed });
}

async function drainSessionControllerOwnersForTest(): Promise<void> {
  const candidates = captureSessionControllerStopCandidates();
  const capture = captureSessionControllerStop({
    inputs: candidates.flatMap((candidate) => candidate.capture.inputs),
    operations: candidates.flatMap((candidate) => candidate.capture.operations),
    effects: candidates.flatMap((candidate) => candidate.capture.effects),
  });
  if (
    capture.inputs.length === 0 &&
    capture.operations.length === 0 &&
    capture.effects.length === 0
  ) {
    return;
  }

  // Teardown must use the same Stop owner as production and retain committed failures.
  const failures: unknown[] = [];
  const execution = stopSession({
    source: "restart",
    capture,
    onError: () => "continue",
  });
  const completion = execution.completed.then(
    async (outcome) => {
      failures.push(...outcome.failures.map(({ error }) => error));
      await outcome.settled;
    },
    (error: unknown) => {
      failures.push(error);
    },
  );
  const settlement = Promise.all([capture.settled, completion])
    .then(() => undefined)
    .catch((error: unknown) => {
      failures.push(error);
    });
  if (
    !(await waitForSessionControllerSettlement(settlement, SESSION_CONTROLLER_DRAIN_TIMEOUT_MS))
  ) {
    failures.push(
      new Error(
        `Session-controller cleanup remains pending after ${SESSION_CONTROLLER_DRAIN_TIMEOUT_MS}ms`,
      ),
    );
  }
  if (failures.length > 0) {
    throw new AggregateError(failures, "Session-controller cleanup failed");
  }
}

type SessionControllerTestApi = {
  drainSessionControllerOwnersForTest?: () => Promise<void>;
};

if (process.env.VITEST || process.env.NODE_ENV === "test") {
  // SAFETY: globalThis hosts the symbol-keyed internal test API publications.
  const publications = globalThis as Record<PropertyKey, unknown>;
  const registryKey = Symbol.for("openclaw.sessionControllerTestApi");
  // SAFETY: Storage publishes this mutable registry API before Stop can load.
  const api = publications[registryKey] as SessionControllerTestApi | undefined;
  if (api) {
    api.drainSessionControllerOwnersForTest = drainSessionControllerOwnersForTest;
  }
}
