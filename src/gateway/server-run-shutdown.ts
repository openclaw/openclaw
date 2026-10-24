import { raceWithTimeout } from "../../packages/retry/src/index.js";
import {
  createAgentRunRestartAbortError,
  isAgentRunRestartAbortReason,
} from "../agents/run-termination.js";
import { isAgentEventLifecycleGenerationCurrent } from "../infra/agent-events.js";
import { formatGatewayDrainCounts, waitForGatewayDrain } from "../infra/gateway-drain.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { hasGatewayContextOwner } from "../plugins/runtime/gateway-request-scope.js";
import { captureGatewaySessionWorkAdmissionInterruption } from "../sessions/session-controller.lifecycle-work.js";
import { captureGatewaySessionControllerWork } from "../sessions/session-controller.lifecycle.js";
import { sessionControllerMailboxes } from "../sessions/session-controller.mailbox.js";
import {
  getRpcSourceIdentity,
  getRpcSourceLifecycleGeneration,
  getRpcSourceProjectSessionActive,
  isRpcSourceQueued,
  isRpcSourceRegistered,
  listRpcSourceEntries,
  type RpcSourceRef,
} from "../sessions/session-controller.rpc-sources.js";
import { activeSessionOperations } from "../sessions/session-controller.state.js";
import { captureSessionControllerStop, stopSession } from "../sessions/session-controller.stop.js";
import {
  abortChatRunById,
  captureChatRunAbortPresentation,
  type RestartRecoveryCandidate,
} from "./chat-abort.js";
import { measureGatewayCloseStep } from "./restart-trace.js";
import type { ChatRunEntry, ChatRunState } from "./server-chat-state.js";
import type { GatewayContextResolver } from "./server-methods/types.js";
import { recordGatewayShutdownWarning } from "./server-shutdown.js";

const shutdownLog = createSubsystemLogger("gateway/shutdown");
const RESTART_REPLY_DRAIN_POLL_MS = 100;
const RESTART_TERMINAL_PERSISTENCE_WAIT_TIMEOUT_MS = 1_000;
const RESTART_MARKER_SLOW_WARNING_MS = 1_000;

function inspectRestartReplyDrain(params: {
  getPendingReplyCount: () => number;
  resolveGatewayContext: GatewayContextResolver;
}) {
  const pendingReplyCount = params.getPendingReplyCount();
  const entries = listGatewayRpcSourceEntries(params.resolveGatewayContext);
  const chatRuns = listRestartDrainRuns(entries).length;
  const queuedTurns = entries.filter(([, entry]) => isRpcSourceQueued(entry)).length;
  const counts = {
    pendingReplies:
      Number.isFinite(pendingReplyCount) && pendingReplyCount > 0
        ? Math.floor(pendingReplyCount)
        : 0,
    chatRuns,
    queuedTurns,
  };
  return { counts, idle: Object.values(counts).every((count) => count === 0) };
}

function listGatewayRpcSourceEntries(
  resolveGatewayContext: GatewayContextResolver,
): Array<[string, RpcSourceRef]> {
  return listRpcSourceEntries().filter(([, entry]) =>
    hasGatewayContextOwner(entry.input, resolveGatewayContext),
  );
}

function listUnabortedRuns(
  entries: Iterable<readonly [string, RpcSourceRef]>,
): Array<[string, RpcSourceRef]> {
  return [...entries].filter(
    (entry): entry is [string, RpcSourceRef] => !entry[1].input.abortSignal.aborted,
  );
}

function listRestartDrainRuns(
  entries: Iterable<readonly [string, RpcSourceRef]>,
): Array<[string, RpcSourceRef]> {
  return listUnabortedRuns(entries).filter(
    ([, entry]) => entry.input.phase !== "consumed" && !isRpcSourceQueued(entry),
  );
}

function isRestartRecoveryRun(entry: RpcSourceRef): boolean {
  // The close prelude may cancel connection work before its restart marker commits.
  return (
    (!entry.input.abortSignal.aborted ||
      entry.adapter.abortStopReason === "restart" ||
      isAgentRunRestartAbortReason(entry.input.abortSignal.reason)) &&
    entry.adapter.controlUiVisible !== false &&
    ((entry.input.claim && !entry.input.claim.released) ||
      entry.adapter.projectSessionTerminalPersisted !== true)
  );
}

export type GatewayRunShutdownParams = {
  resolveGatewayContext: GatewayContextResolver;
  restartRecoveryCandidates?: Map<string, RestartRecoveryCandidate>;
  chatRunState: ChatRunState;
  removeChatRun: (
    sessionId: string,
    clientRunId: string,
    sessionKey?: string,
  ) => ChatRunEntry | undefined;
  agentRunSeq: Map<string, number>;
  broadcast: (event: string, payload: unknown, opts?: { dropIfSlow?: boolean }) => void;
  nodeSendToSession: (sessionKey: string, event: string, payload: unknown) => void;
  markMainSessionsAbortedForRestart?: (params: {
    resolveGatewayContext: GatewayContextResolver;
    activeRuns: RestartRecoveryCandidate[];
    activeAdmissions: ReturnType<typeof captureGatewaySessionControllerWork>;
    reason: string;
    isActiveRun: (run: RestartRecoveryCandidate) => boolean;
  }) => Promise<void> | void;
  /** Cancel received execution and retire its principals only after recovery is recorded. */
  cancelReceivedWork?: (reason?: Error) => void;
};

type CapturedRestartRun = {
  run: RestartRecoveryCandidate;
  source?: RpcSourceRef;
  recoveryCandidate?: RestartRecoveryCandidate;
};

function collectActiveRestartSessionRefs(
  params: Pick<GatewayRunShutdownParams, "restartRecoveryCandidates"> & {
    entries: Iterable<readonly [string, RpcSourceRef]>;
  },
): CapturedRestartRun[] {
  const activeRuns: CapturedRestartRun[] = [];
  const observedAt = Date.now();
  const addRun = (
    run: RestartRecoveryCandidate,
    source?: RpcSourceRef,
    recoveryCandidate?: RestartRecoveryCandidate,
  ) => {
    activeRuns.push({
      run: {
        ...run,
        observedAt: run.observedAt ?? observedAt,
      },
      ...(source ? { source } : {}),
      ...(recoveryCandidate ? { recoveryCandidate } : {}),
    });
  };
  for (const [runId, entry] of [...params.entries].filter(([, source]) =>
    isRestartRecoveryRun(source),
  )) {
    const { sessionKey, sessionId, agentId } = getRpcSourceIdentity(entry);
    const target = entry.input.target ?? entry.input.mailbox.owner.target;
    const lifecycleGeneration = getRpcSourceLifecycleGeneration(entry);
    if (runId && lifecycleGeneration && sessionKey && sessionId && target) {
      addRun(
        {
          storePath: target.storeScope,
          agentId: agentId ?? target.agentId,
          runId,
          lifecycleGeneration,
          sessionKey,
          sessionId,
          observedAt: entry.adapter.projectSessionTerminalObservedAt,
        },
        entry,
      );
    }
  }
  for (const candidate of params.restartRecoveryCandidates?.values() ?? []) {
    const alreadyCaptured = activeRuns.find(
      ({ run }) =>
        run.runId === candidate.runId &&
        run.lifecycleGeneration === candidate.lifecycleGeneration &&
        run.storePath === candidate.storePath &&
        run.agentId === candidate.agentId &&
        run.sessionKey === candidate.sessionKey &&
        run.sessionId === candidate.sessionId,
    );
    if (alreadyCaptured) {
      alreadyCaptured.recoveryCandidate = candidate;
    } else {
      addRun(candidate, undefined, candidate);
    }
  }
  return activeRuns;
}

async function settleTerminalSessionPersistenceForRestart(
  entries: Iterable<readonly [string, RpcSourceRef]>,
): Promise<void> {
  const pending = listUnabortedRuns(entries).flatMap(([, entry]) => {
    const persistence = entry.adapter.projectSessionTerminalPersistence;
    if (getRpcSourceProjectSessionActive(entry) !== false || !persistence) {
      return [];
    }
    return [persistence];
  });
  if (pending.length === 0) {
    return;
  }
  const results = await raceWithTimeout(
    () => Promise.allSettled(pending),
    RESTART_TERMINAL_PERSISTENCE_WAIT_TIMEOUT_MS,
    () => null,
    { ref: false },
  );
  if (!results) {
    shutdownLog.warn(
      `terminal session persistence did not settle within ${RESTART_TERMINAL_PERSISTENCE_WAIT_TIMEOUT_MS}ms; preserving restart recovery`,
    );
  }
}

async function prepareActiveRunsForRestartRecovery(
  params: GatewayRunShutdownParams & {
    reason: string;
    warnings: string[];
    capturedSources: ReadonlyArray<readonly [string, RpcSourceRef]>;
    activeAdmissions: ReturnType<typeof captureGatewaySessionControllerWork>;
    capturedRecoveryCandidates: Map<string, RestartRecoveryCandidate>;
  },
): Promise<void> {
  if (!params.markMainSessionsAbortedForRestart) {
    return;
  }
  const recoveryCandidates = params.capturedRecoveryCandidates;
  const capturedRuns = collectActiveRestartSessionRefs({
    entries: params.capturedSources,
    restartRecoveryCandidates: recoveryCandidates,
  });
  const activeRuns = capturedRuns.map(({ run }) => run);
  const capturedByRun = new Map(capturedRuns.map((captured) => [captured.run, captured]));
  await settleTerminalSessionPersistenceForRestart(params.capturedSources);
  try {
    let markerOutcome!: Promise<void>;
    const timedOut = await raceWithTimeout(
      () => {
        markerOutcome = Promise.resolve(
          params.markMainSessionsAbortedForRestart!({
            resolveGatewayContext: params.resolveGatewayContext,
            activeRuns,
            activeAdmissions: params.activeAdmissions,
            reason: params.reason,
            isActiveRun: (run) => {
              const captured = capturedByRun.get(run);
              if (!captured) {
                return false;
              }
              const entry = captured.source;
              const replaced = listGatewayRpcSourceEntries(params.resolveGatewayContext).some(
                ([, current]) => {
                  const identity = getRpcSourceIdentity(current);
                  const target = current.input.target ?? current.input.mailbox.owner.target;
                  return (
                    current !== entry &&
                    target?.storeScope === run.storePath &&
                    (identity.agentId ?? target?.agentId) === run.agentId &&
                    identity.sessionKey === run.sessionKey &&
                    identity.sessionId === run.sessionId
                  );
                },
              );
              const sourceActive =
                entry !== undefined &&
                (isRpcSourceRegistered(entry) || !replaced) &&
                isRestartRecoveryRun(entry) &&
                ((entry.input.claim && !entry.input.claim.released) ||
                  entry.adapter.projectSessionTerminalPersisted !== true) &&
                getRpcSourceLifecycleGeneration(entry) === run.lifecycleGeneration;
              const candidate = captured.recoveryCandidate;
              const recoveryCandidateActive =
                candidate !== undefined &&
                // A retained terminal receipt cannot override a newer live source.
                !replaced &&
                candidate === params.restartRecoveryCandidates?.get(run.runId) &&
                candidate === recoveryCandidates.get(run.runId) &&
                candidate.lifecycleGeneration === run.lifecycleGeneration;
              return sourceActive || recoveryCandidateActive;
            },
          }),
        );
        return markerOutcome.then(() => false);
      },
      RESTART_MARKER_SLOW_WARNING_MS,
      () => true,
      { ref: false },
    );
    if (timedOut) {
      shutdownLog.warn(
        `restart session marker did not settle within ${RESTART_MARKER_SLOW_WARNING_MS}ms; waiting before shutdown`,
      );
      recordGatewayShutdownWarning(params.warnings, "restart-main-session-marker");
      await markerOutcome!;
    }
    for (const captured of capturedRuns) {
      if (
        captured.recoveryCandidate &&
        params.restartRecoveryCandidates?.get(captured.run.runId) === captured.recoveryCandidate &&
        captured.recoveryCandidate === recoveryCandidates.get(captured.run.runId)
      ) {
        params.restartRecoveryCandidates?.delete(captured.run.runId);
      }
    }
  } catch (err) {
    shutdownLog.warn(`failed to mark active main session(s) for restart recovery: ${String(err)}`);
    recordGatewayShutdownWarning(params.warnings, "restart-main-session-marker");
  }
}

/** Completes grace and requests cancellation before execution joining begins. */
export async function prepareGatewayRunShutdown(
  params: {
    getPendingReplyCount: () => number;
    timeoutMs: number;
    warnings: string[];
  } & GatewayRunShutdownParams,
): Promise<{ released: Promise<void> }> {
  let drainResult:
    | Awaited<ReturnType<typeof waitForGatewayDrain<ReturnType<typeof inspectRestartReplyDrain>>>>
    | undefined;
  {
    const initialSnapshot = inspectRestartReplyDrain(params);
    if (!initialSnapshot.idle) {
      drainResult = await waitForGatewayDrain(
        () => inspectRestartReplyDrain(params),
        params.timeoutMs,
        { pollMs: RESTART_REPLY_DRAIN_POLL_MS, ref: false },
      );
      if (!drainResult.drained) {
        shutdownLog.warn(
          `restart reply drain timed out after ${drainResult.elapsedMs}ms with ${formatGatewayDrainCounts(drainResult.snapshot)} still active; continuing shutdown`,
        );
        recordGatewayShutdownWarning(params.warnings, "restart-reply-drain");
      }
    }
  }
  // Preparation accepted during grace belongs to this cancellation boundary.
  const capturedSources = listGatewayRpcSourceEntries(params.resolveGatewayContext);
  // Recovery may retain these owners, but must not adopt a successor admitted while marking.
  const activeAdmissions = captureGatewaySessionControllerWork(params.resolveGatewayContext);
  const capturedRecoveryCandidates = new Map(params.restartRecoveryCandidates);
  const sourceByInput = new Map(
    capturedSources.map(([runId, entry]) => [
      entry.input,
      { runId, entry, presentation: captureChatRunAbortPresentation(params, runId) },
    ]),
  );
  const capture = captureSessionControllerStop({
    inputs: [
      ...sourceByInput.keys(),
      ...[...sessionControllerMailboxes()].flatMap((mailbox) =>
        mailbox.entries.filter((input) =>
          hasGatewayContextOwner(input, params.resolveGatewayContext),
        ),
      ),
    ],
    operations: [...activeSessionOperations()].filter((operation) =>
      hasGatewayContextOwner(operation, params.resolveGatewayContext),
    ),
  });
  const capturedEffects = captureGatewaySessionWorkAdmissionInterruption(
    params.resolveGatewayContext,
  );
  const pendingInputs = new Set(capture.inputs);
  const pendingOperations = new Set([
    ...capture.operations,
    ...capture.inputs.flatMap((input) => (input.claim?.operation ? [input.claim.operation] : [])),
  ]);
  for (const input of pendingInputs) {
    const released = () => pendingInputs.delete(input);
    void input.settlement.promise.then(released, released);
  }
  for (const operation of pendingOperations) {
    const released = () => pendingOperations.delete(operation);
    void operation.ownerSettlement.then(released, released);
  }
  const cancelCaptured = (selection = capture) =>
    stopSession({
      capture: selection,
      source: "restart",
      onError: (_target, error) => {
        shutdownLog.warn(`failed to cancel captured source during shutdown: ${String(error)}`);
        recordGatewayShutdownWarning(params.warnings, "restart-reply-abort");
        return "continue";
      },
      cancelInput: (input, cancel) => {
        const target = sourceByInput.get(input);
        if (!target) {
          return hasGatewayContextOwner(input, params.resolveGatewayContext) ? cancel() : false;
        }
        const lifecycleGeneration = getRpcSourceLifecycleGeneration(target.entry);
        if (
          !isRpcSourceRegistered(target.entry) ||
          (lifecycleGeneration && !isAgentEventLifecycleGenerationCurrent(lifecycleGeneration))
        ) {
          return false;
        }
        return abortChatRunById(params, {
          runId: target.runId,
          sessionKey: getRpcSourceIdentity(target.entry).sessionKey,
          expectedEntry: target.entry,
          presentation: target.presentation,
          preserveTerminal: getRpcSourceProjectSessionActive(target.entry) === false,
          cancel,
          stopReason: "restart",
        }).aborted;
      },
      cancelOperation: (operation, cancel) =>
        operation.lifecycleGeneration !== undefined &&
        isAgentEventLifecycleGenerationCurrent(operation.lifecycleGeneration) &&
        hasGatewayContextOwner(operation, params.resolveGatewayContext)
          ? cancel()
          : false,
    });
  // Freeze both subsets before queue abort listeners or recovery writes can change claims.
  const queuedCapture = captureSessionControllerStop({ inputs: capture.queuedInputs });
  const activeCapture = captureSessionControllerStop({
    inputs: capture.activeInputs,
    operations: capture.operations,
  });
  await prepareActiveRunsForRestartRecovery({
    ...params,
    capturedSources,
    activeAdmissions,
    capturedRecoveryCandidates,
    reason: "gateway restart shutdown",
  });
  const abortedQueuedTurns = cancelCaptured(queuedCapture).queuedCancelled;
  if (drainResult?.drained === false && abortedQueuedTurns > 0) {
    shutdownLog.warn(`aborted ${abortedQueuedTurns} queued turn(s) during restart shutdown`);
  }
  const abortedRuns = cancelCaptured(activeCapture).activeCancelled;
  if (drainResult?.drained) {
    shutdownLog.info(`restart reply drain completed after ${drainResult.elapsedMs}ms`);
  } else if (drainResult && abortedRuns > 0) {
    shutdownLog.warn(`aborted ${abortedRuns} active run(s) during restart shutdown`);
  }
  params.cancelReceivedWork?.(createAgentRunRestartAbortError());
  const effects = capturedEffects.interrupt(createAgentRunRestartAbortError());
  return {
    released: Promise.all([
      measureGatewayCloseStep(
        "restart.close.session-sources",
        () => capture.settled,
        () => {
          const custody = {
            sources: pendingInputs.size,
            operations: pendingOperations.size,
            sourceWork: 0,
          };
          for (const input of pendingInputs) {
            custody.sourceWork += input.custody.work?.size ?? 0;
          }
          return custody;
        },
      ),
      measureGatewayCloseStep(
        "restart.close.session-effects",
        () => effects.released,
        effects.inspectPending,
      ),
    ]).then(() => undefined),
  };
}
