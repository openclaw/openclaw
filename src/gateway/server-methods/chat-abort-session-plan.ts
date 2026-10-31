import { captureExecRequestCancellation } from "../../agents/bash-process-control.js";
import type { SubagentRequestSessionOrigin } from "../../agents/subagents/registry/subagent-exec-request-ownership.js";
import { getAgentEventLifecycleGeneration } from "../../infra/agent-events.js";
import { isCurrentSessionControllerTurnInput } from "../../sessions/session-controller.context.js";
import type { ReplyOperation } from "../../sessions/session-controller.contracts.js";
import { getSessionControllerSourceIdentity } from "../../sessions/session-controller.identity.js";
import { inputMatchesSessionId } from "../../sessions/session-controller.lifecycle-projections.js";
import { captureSessionTarget } from "../../sessions/session-controller.lifecycle.js";
import type { SessionControllerInput } from "../../sessions/session-controller.mailbox.js";
import {
  getRpcSourceIdentity,
  isRpcSourceRegistered,
  listRpcSourceEntries,
  listRpcSourceEntriesForSession,
  type RpcSourceRef,
} from "../../sessions/session-controller.rpc-sources.js";
import {
  getAttachedBackend,
  getSessionControllerEntryForOperation,
} from "../../sessions/session-controller.state.js";
import {
  captureSessionControllerStop,
  stopSession,
  type SessionStopRequest,
  type SessionStopExecution,
} from "../../sessions/session-controller.stop.js";
import { stopSkillExperienceReview } from "../../skills/workshop/experience-review-default.js";
import {
  waitForChatAbortAcknowledgment,
  waitForChatAbortTerminalPersistence,
} from "../chat-abort-lifecycle-internal.js";
import { abortChatRunById, createChatAbortSignalReason } from "../chat-abort.js";
import {
  captureGatewayScopeMatcher,
  captureRpcSourceScopeMatcher,
} from "../session-runtime-scope.js";
import type { WorkerInferenceCancellation } from "../worker-environments/inference-control-internal.js";
import {
  canRequesterAbortChatRun,
  captureSessionAbortRequestOrigin,
  resolveAuthorizedRunsForSessionKeys,
  resolveAuthorizedQueuedTurnsForSession,
} from "./chat-abort-authorization.js";
import type { ChatSessionAbortParams, ChatSessionAbortResult } from "./chat-abort-runtime.types.js";
import {
  abortedPartialPersistenceError,
  captureAbortedPartial,
  deferAbortedPartialPersistence,
  type AbortedPartialSnapshot,
} from "./chat-aborted-partial.js";
import { persistAbortedPartials } from "./chat-transcript-persistence.js";
import { createSessionAbortPersistence } from "./session-abort-persistence.js";

/** Resolve once at the cancellation boundary; persist captured partials only after Stop. */
export function prepareChatSessionAbort(
  params: ChatSessionAbortParams,
  workerCancellation: WorkerInferenceCancellation | undefined,
  selectedRunId?: string,
) {
  const sessionKeys = [params.sessionKey, ...(params.sessionKeyAliases ?? [])];
  const session = params.session?.ok ? params.session.value : undefined;
  const resolveGatewayContext = params.context.resolveGatewayContext;
  const matchesGateway = captureGatewayScopeMatcher(resolveGatewayContext);
  const sourceStores = new Set(
    listRpcSourceEntriesForSession({
      sessionKeys,
      sessionIds: [params.sessionId],
      requiredSessionId: params.requiredSessionId,
      agentId: params.agentId,
      defaultAgentId: params.defaultAgentId,
    }).flatMap(({ entry }) =>
      matchesGateway(entry.input) && entry.input.target ? [entry.input.target.storeScope] : [],
    ),
  );
  // Metadata failure cannot erase one unambiguous captured cancellation owner.
  const storePath =
    params.controllerTargets?.[0]?.storeScope ??
    session?.storePath ??
    (sourceStores.size === 1 ? sourceStores.values().next().value : undefined);
  const matchesScope = storePath
    ? captureRpcSourceScopeMatcher({ storePath, resolveGatewayContext })
    : () => false;
  const acceptsRequest: SubagentRequestSessionOrigin["acceptsRequest"] = (identity) =>
    canRequesterAbortChatRun(
      {
        ...identity,
        requester: { connectionId: identity.ownerConnId, deviceId: identity.ownerDeviceId },
      },
      params.requester,
    ) &&
    (params.includeProtectedRuns === true ||
      (identity.controlUiVisible !== false &&
        !(params.preserveSideRuns && identity.turnKind === "btw")));
  const commands = captureExecRequestCancellation(
    {
      sessionKey: params.sessionKey,
      sessionId: params.requiredSessionId ?? params.sessionId,
      agentId: params.agentId,
    },
    acceptsRequest,
  );
  const sessionOrigin = captureSessionAbortRequestOrigin(params, acceptsRequest);
  // A lifecycle disposer must not join the source whose cleanup it is performing.
  const includesSource = (input: SessionControllerInput) =>
    params.stopSource !== "mutation" || !isCurrentSessionControllerTurnInput(input);
  const ownerScope = {
    sessionKeys,
    matchesScope: (entry: RpcSourceRef) => matchesScope(entry) && includesSource(entry.input),
    requiredSessionId: params.requiredSessionId,
    agentId: params.agentId,
    defaultAgentId: params.defaultAgentId,
    requester: params.requester,
    preserveSideRuns: params.preserveSideRuns,
    includeProtectedRuns: params.includeProtectedRuns,
  };
  const queuedPlan = resolveAuthorizedQueuedTurnsForSession({
    ...ownerScope,
    sessionId: params.sessionId,
  });
  const {
    authorizedRuns,
    matchedRunIds: matchedActiveRunIds,
    hasUnauthorizedRuns: hasUnauthorizedActiveRuns,
    hasUnauthorizedProtectedRuns: hasUnauthorizedProtectedActiveRuns,
    hasProtectedRuns: hasProtectedActiveRuns,
  } = resolveAuthorizedRunsForSessionKeys({
    ...ownerScope,
    sessionIds: [params.sessionId],
  });
  const hasAuthorizedGatewayRuns = authorizedRuns.length > 0 || queuedPlan.authorized.length > 0;
  const isLifecycleAbort = Boolean(params.cascadeDescendants);
  const hasWorkerRun = Boolean(
    (!hasAuthorizedGatewayRuns || isLifecycleAbort) && workerCancellation?.runIds.length,
  );
  // The worker manager admits at most one active inference per session, and a
  // worker-backed turn shares its controller's runId. One exact match therefore
  // represents the only worker owner instead of inventing a second owner.
  const hasControllerRepresentedWorkerRun =
    hasWorkerRun && matchedActiveRunIds.some((runId) => workerCancellation?.runIds.includes(runId));
  const hasUnauthorizedOwner =
    hasUnauthorizedActiveRuns ||
    queuedPlan.hasUnauthorizedRuns ||
    (hasWorkerRun && !hasControllerRepresentedWorkerRun && !params.requester.isAdmin);
  const hasProtectedLifecycleRuns = hasProtectedActiveRuns || queuedPlan.hasProtectedRuns;
  const hasUnauthorizedProtectedOwner =
    hasUnauthorizedProtectedActiveRuns || queuedPlan.hasUnauthorizedProtectedRuns;
  const hasUnauthorizedLifecycleOwner = isLifecycleAbort && hasUnauthorizedProtectedOwner;
  const canRunLifecycleCleanup = !hasUnauthorizedOwner && !hasProtectedLifecycleRuns;
  // Keep ordinary chat.abort's admin worker behavior; only the injected broad
  // lifecycle path must preserve hidden or explicitly preserved Gateway runs.
  const canCancelWorkerSession = !isLifecycleAbort || !hasProtectedLifecycleRuns;
  const snapshots: AbortedPartialSnapshot[] = [];
  const capturedTargets = [...queuedPlan.authorized, ...authorizedRuns];
  const targetByInput = new Map(capturedTargets.map((target) => [target.entry.input, target]));
  const targets =
    params.controllerTargets ??
    (storePath
      ? [
          captureSessionTarget({
            storeScope: storePath,
            sessionKey: params.sessionKey,
            aliases: params.sessionKeyAliases,
            agentId: params.agentId,
            // Only narrow admission limits a full-session Stop to one incarnation.
            incarnation: params.requiredSessionId,
          }),
        ]
      : []);
  const candidates = captureSessionControllerStop({ targets, resolveGatewayContext });
  const controllerStop = captureSessionControllerStop({
    pendingCaptures: [candidates],
    inputs: candidates.inputs.filter(
      (input) =>
        input.target?.storeScope === storePath && matchesGateway(input) && includesSource(input),
    ),
    operations: candidates.operations.filter(
      (operation) =>
        getSessionControllerEntryForOperation(operation).target?.storeScope === storePath &&
        matchesGateway(operation) &&
        (params.requiredSessionId === undefined || sessionKeys.includes(operation.key)),
    ),
    effects: canRunLifecycleCleanup
      ? candidates.effects.filter(
          (effect) =>
            effect.run !== undefined &&
            acceptsRequest(effect.run) &&
            (params.requiredSessionId === undefined ||
              (effect.run.sessionKey !== undefined && sessionKeys.includes(effect.run.sessionKey))),
        )
      : [],
  });
  const stopCapture = captureSessionControllerStop({
    pendingCaptures: canRunLifecycleCleanup ? [controllerStop] : [],
    inputs: [...targetByInput.keys(), ...(controllerStop?.inputs ?? [])],
    operations: controllerStop?.operations,
    effects: controllerStop.effects,
  });
  const terminalWrites: Promise<unknown>[] = [];
  const persistSessionAbort = createSessionAbortPersistence({
    sessionKey: params.sessionKey,
    agentId: params.agentId,
    lifecycleRevision: session?.entry?.lifecycleRevision,
    lifecycleGeneration: getAgentEventLifecycleGeneration(),
    startedAt: session?.entry?.startedAt,
    stopReason: params.stopReason,
    assertCurrent: params.assertCurrent,
  });
  const controllerRuns = new Map<
    SessionControllerInput | ReplyOperation,
    Parameters<typeof persistSessionAbort>[0]
  >();
  // Capture direct-host identity before cancellation detaches its native backend.
  // RPC sources retain their own terminal-persistence path.
  for (const target of [...stopCapture.activeInputs, ...stopCapture.operations]) {
    const operation = "instance" in target ? target.claim?.operation : target;
    if (
      !operation ||
      capturedTargets.some(({ entry }) => entry.input.claim?.operation === operation)
    ) {
      continue;
    }
    const runId = getAttachedBackend(operation)?.runId;
    if (runId) {
      controllerRuns.set(target, {
        runId,
        sessionId: operation.sessionId,
        startedAtMs: operation.startedAtMs,
      });
    }
  }

  // Preview the identities this prepared Stop can cancel so an explicit-stop bridge can
  // register suppression before the abort effect. The final result.runIds still records
  // only what actually committed; these are the same selected identities.
  const selectedRunIds = [
    ...new Set([
      ...capturedTargets.map(({ runId }) => runId),
      ...[...controllerRuns.values()].map(({ runId }) => runId),
      ...stopCapture.effects.flatMap((effect) => (effect.run?.runId ? [effect.run.runId] : [])),
      ...(params.requester.isAdmin && canCancelWorkerSession
        ? (workerCancellation?.runIds ?? [])
        : []),
    ]),
  ];

  let workerCancellationPersistence: Promise<string[]> | undefined;
  let stopExecution: SessionStopExecution | undefined;
  // Reentrant cancellation can revoke the next effect. Keep committed outcomes
  // available to the partial-persistence owner even when abort() then throws.
  const result: ChatSessionAbortResult = { aborted: false, runIds: [], unauthorized: false };
  const recordRun = (runId: string) => {
    result.aborted = true;
    if (!result.runIds.includes(runId)) {
      result.runIds.push(runId);
    }
  };
  const cancelWorker = () => {
    workerCancellationPersistence = workerCancellation?.cancel({
      assertCurrent: params.assertCurrent,
      onCancelled: recordRun,
    });
    // The synchronous abort owner must return before persistence settles. Observe
    // rejection now, but finish() still joins the original operation and its cause.
    void workerCancellationPersistence?.catch(() => undefined);
  };
  const abortAuthorizedRuns = () => {
    params.assertCurrent?.();
    const rpcSourceByInput = new Map(
      listRpcSourceEntries().map(([, entry]) => [entry.input, entry]),
    );
    params.onControllerTargets?.([...capturedTargets]);
    if (!hasAuthorizedGatewayRuns) {
      // A persisted session id must not bypass a matching connection or protected run owner.
      if (hasUnauthorizedOwner || hasUnauthorizedLifecycleOwner) {
        result.unauthorized = true;
        return result;
      }
    }
    const onCancelled: NonNullable<SessionStopRequest["onCancelled"]> = (target) => {
      const source = "instance" in target ? targetByInput.get(target) : undefined;
      const controllerRun = controllerRuns.get(target);
      if (source) {
        recordRun(source.runId);
      } else if (controllerRun) {
        recordRun(controllerRun.runId);
        const persistence = persistSessionAbort(controllerRun);
        terminalWrites.push(persistence);
        void persistence.catch(() => undefined);
      } else {
        result.aborted = true;
      }
    };
    const cancelInput: NonNullable<SessionStopRequest["cancelInput"]> = (input, cancel, queued) => {
      const target = targetByInput.get(input);
      if (!target) {
        if (!controllerStop.inputs.includes(input) && !(queued && canRunLifecycleCleanup)) {
          return false;
        }
        params.assertCurrent?.();
        if (
          !inputMatchesSessionId(input, params.requiredSessionId) ||
          (params.requiredSessionId !== undefined &&
            !sessionKeys.includes(getSessionControllerSourceIdentity(input).sessionKey))
        ) {
          return false;
        }
        const source = rpcSourceByInput.get(input);
        const adapter = source ? source.adapter : input.sourceAdapter;
        if (
          (source && !isRpcSourceRegistered(source)) ||
          (params.includeProtectedRuns !== true &&
            (adapter?.controlUiVisible === false ||
              (params.preserveSideRuns && adapter?.turnKind === "btw"))) ||
          !canRequesterAbortChatRun(
            {
              ...getSessionControllerSourceIdentity(input),
              requester: adapter?.requester,
              initiatingPersonalOperator: source?.adapter.initiatingPersonalOperator,
            },
            params.requester,
          )
        ) {
          return false;
        }
        return cancel();
      }
      const { runId, sessionKey, sessionId, agentId, entry } = target;
      const identity = getRpcSourceIdentity(entry);
      if (
        !isRpcSourceRegistered(entry) ||
        identity.sessionKey !== sessionKey ||
        identity.sessionId !== sessionId ||
        identity.agentId !== agentId
      ) {
        return false;
      }
      return abortChatRunById(params.ops, {
        runId,
        sessionKey,
        expectedEntry: entry,
        cancel,
        assertCurrent: params.assertCurrent,
        stopReason: params.stopReason,
        onAbortPrepared: () => {
          if (!authorizedRuns.some((candidate) => candidate.entry === entry)) {
            return undefined;
          }
          const text = params.context.chatRunState.resolveBuffer(runId, { final: true }).text;
          if (!text?.trim()) {
            return undefined;
          }
          const snapshot = captureAbortedPartial({
            runId,
            sessionKey: identity.sessionKey,
            sessionId: identity.sessionId,
            agentId: identity.agentId ?? params.agentId,
            text,
            abortOrigin: params.abortOrigin,
            resolveTerminalProducer: entry.adapter.resolveTerminalProducer,
            session: params.session,
          });
          snapshots.push(snapshot);
          return deferAbortedPartialPersistence(snapshot, params.context);
        },
        onAbortCommitted: () => recordRun(runId),
      }).aborted;
    };
    const afterParent = () => {
      if (!result.unauthorized && !result.error) {
        params.assertCurrent?.();
        if (
          params.requester.isAdmin &&
          canCancelWorkerSession &&
          workerCancellation?.runIds.length
        ) {
          cancelWorker();
        }
        if (commands.cancel()) {
          result.aborted = true;
        }
      }
    };
    const isCommandStop = ["channel-user", "client-session", "client-run"].includes(
      params.stopSource,
    );
    if (!params.hookContext && isCommandStop) {
      throw new Error(`Stop source ${params.stopSource} requires command hook context`);
    }
    // Accepted Stop with confirmed authority. Review cancellation never precedes this gate, so
    // a rejected Stop leaves the session's queued and in-flight review untouched.
    if (params.cancelExperienceReview === true) {
      stopSkillExperienceReview({
        sessions: [{ agentId: params.agentId, sessionKey: params.sessionKey }],
        runIds: selectedRunIds,
      });
    }
    const stopRequest = {
      capture: stopCapture,
      assertCurrent: params.assertCurrent,
      reason: createChatAbortSignalReason(params.stopReason),
      hookContext: params.hookContext,
      onCancelled,
      onEffectCancelled: (effect) => {
        recordRun(effect.run.runId);
        const persistence = persistSessionAbort(effect.run);
        terminalWrites.push(persistence);
        void persistence.catch(() => undefined);
      },
      cancelInput,
      cancelOperation: (operation, cancel) => {
        if (
          !canRunLifecycleCleanup ||
          (params.requiredSessionId !== undefined &&
            (operation.sessionId !== params.requiredSessionId ||
              !sessionKeys.includes(operation.key)))
        ) {
          return false;
        }
        params.assertCurrent?.();
        return cancel();
      },
      afterParent,
    } satisfies Omit<SessionStopRequest, "source" | "mutation">;
    stopExecution =
      params.stopSource === "mutation"
        ? stopSession({
            ...stopRequest,
            source: params.stopSource,
            mutation: { cancelQueued: true, stopChildren: false },
          })
        : stopSession({ ...stopRequest, source: params.stopSource });
    return result;
  };
  const hasOtherWork =
    matchedActiveRunIds.some((runId) => runId !== selectedRunId) ||
    queuedPlan.matchedRunIds.some((runId) => runId !== selectedRunId) ||
    stopCapture.effects.some((effect) => effect.run?.runId !== selectedRunId) ||
    (hasWorkerRun && (!selectedRunId || !workerCancellation?.runIds.includes(selectedRunId)));
  return {
    canCascade: canRunLifecycleCleanup && !hasUnauthorizedLifecycleOwner,
    hasOtherWork,
    acceptsRequest,
    commands,
    sessionOrigin,
    selectedRunIds,
    result,
    abort: abortAuthorizedRuns,
    async finish() {
      let stopFailure: unknown;
      try {
        await stopExecution?.completed;
      } catch (error) {
        // Cancellation can commit for an earlier exact target before authority
        // revocation blocks a later one. Preserve the committed target's output.
        stopFailure = error;
      }
      const abortedRunIds = new Set(result.runIds);
      const [worker, partial, terminal, exec] = await waitForChatAbortAcknowledgment(
        Promise.allSettled([
          workerCancellationPersistence,
          result.aborted && snapshots.length > 0
            ? persistAbortedPartials({
                context: params.context,
                snapshots: snapshots.filter((snapshot) => abortedRunIds.has(snapshot.runId)),
              })
            : undefined,
          Promise.all([
            ...terminalWrites,
            ...capturedTargets
              .filter(({ runId }) => abortedRunIds.has(runId))
              .map(({ entry }) => waitForChatAbortTerminalPersistence(entry)),
          ]),
          commands.settle(),
        ]),
      );

      // A captured session failure can also surface through partial persistence.
      const failures = new Set<unknown>();
      if (stopFailure !== undefined) {
        failures.add(stopFailure);
      }
      for (const settled of [worker, partial, terminal, exec]) {
        if (settled.status === "rejected") {
          failures.add(settled.reason);
        }
      }
      if (params.session && !params.session.ok) {
        failures.add(params.session.error);
      }
      const warning = partial.status === "fulfilled" ? partial.value : undefined;
      if (failures.size > 0) {
        const errors = [...failures];
        throw abortedPartialPersistenceError(
          errors.length === 1
            ? errors[0]
            : new AggregateError(errors, "Chat cancellation persistence failed"),
          warning,
        );
      }
      return warning;
    },
  };
}
