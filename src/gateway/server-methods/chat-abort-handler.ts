import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import {
  ErrorCodes,
  errorShape,
  validateChatAbortParams,
} from "../../../packages/gateway-protocol/src/index.js";
import { captureExecRequestCancellation } from "../../agents/bash-process-control.js";
import { createAgentRunDirectAbortError } from "../../agents/run-termination.js";
import { discardSessionPendingInput } from "../../config/sessions/session-pending-input-withdrawal.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { isIncognitoSessionKey, normalizeAgentId } from "../../routing/session-key.js";
import { getSessionControllerSourceIdentity } from "../../sessions/session-controller.identity.js";
import { holdSessionControllerSourceWithdrawal } from "../../sessions/session-controller.mailbox.js";
import {
  listRpcSourceEntries,
  getRpcSourceForGateway,
  getRpcSourceIdentity,
  getReservedRpcSourceInput,
  isRpcSourceQueued,
  isRpcSourceRegistered,
} from "../../sessions/session-controller.rpc-sources.js";
import {
  cancelCapturedSessionControllerSource,
  captureSessionControllerStop,
  stopSession,
  type SessionStopHookContext,
} from "../../sessions/session-controller.stop.js";
import { parseAgentSessionKey } from "../../sessions/session-key-utils.js";
import { resolveStateContentionPresentation } from "../../sessions/session-run-error-presentation.js";
import {
  waitForChatAbortAcknowledgment,
  waitForChatAbortTerminalPersistence,
} from "../chat-abort-lifecycle-internal.js";
import { captureWorkerInferenceForSession, createChatAbortOps } from "../chat-abort-ops.js";
import { formatStopRequest } from "../control-plane-audit.js";
import {
  resolveRequestedSessionAgentId,
  tryResolveSessionCompatibilityOwnerAgentId,
} from "../session-request-agent.js";
import {
  captureGatewayScopeMatcher,
  captureRpcSourceScopeMatcher,
} from "../session-runtime-scope.js";
import { resolveSessionStoreKey } from "../session-utils.js";
import { getWorkerInferenceSessionControl } from "../worker-environments/inference-control-internal.js";
import {
  canRequesterAbortChatRun,
  resolveChatAbortTargetRejection,
  resolveChatAbortRequester,
} from "./chat-abort-authorization.js";
import * as exactRun from "./chat-abort-exact-run.js";
import {
  abortChatRunsForSessionKeyWithPartials,
  abortControlledSubagents,
  descendantAbortError,
} from "./chat-abort-runtime.js";
import {
  abortedPartialPersistenceError,
  captureAbortedPartial,
  deferAbortedPartialPersistence,
  prepareChatAbortSessionSnapshot,
  withAbortedPartialPersistenceWarning,
  type AbortedPartialSnapshot,
} from "./chat-aborted-partial.js";
import { persistAbortedPartials } from "./chat-transcript-persistence.js";
import { respondError } from "./response.js";
import { emitSessionsChanged } from "./session-change-event.js";
import { readGatewayRequestMutationAuthority } from "./session-mutation-guards.js";
import type { GatewayRequestHandlerOptions } from "./types.js";
import { assertValidParams } from "./validation.js";

type ChatAbortLifecycle = {
  /** Internal composition may advance only after this exact run was cancelled. */
  onExactRunAborted?: (runId: string) => void;
  onDescendantsCancelled?: (
    result: NonNullable<Awaited<ReturnType<typeof abortControlledSubagents>>>,
  ) => void;
  cascadeDescendants?: true;
  hookContext?: SessionStopHookContext;
};

export async function handleChatAbortRequestWithLifecycle(
  options: GatewayRequestHandlerOptions,
  lifecycle: ChatAbortLifecycle = {},
): Promise<void> {
  const { params, respond, context, client, sessionMutationAuthorization } = options;
  const authority = readGatewayRequestMutationAuthority(options);
  const requester = resolveChatAbortRequester(client, sessionMutationAuthorization);
  const assertCurrent = () => {
    authority.assertCurrent();
    sessionMutationAuthorization?.assertCurrent();
    requester.sessionAuthority?.assertCurrent();
  };
  if (!assertValidParams(params, validateChatAbortParams, "chat.abort", respond)) {
    return;
  }
  const { sessionKey: rawSessionKey, runId, preserveSideRuns, discardPendingInput } = params;
  if (discardPendingInput && !runId) {
    respondError(
      respond,
      ErrorCodes.INVALID_REQUEST,
      "discardPendingInput requires an exact runId",
    );
    return;
  }
  const agentIdOverride = normalizeOptionalString(params.agentId);
  const abortCfg = context.getRuntimeConfig();
  const parsedAbortSessionKey = parseAgentSessionKey(rawSessionKey);
  const compatibilityDefaultAgentId = tryResolveSessionCompatibilityOwnerAgentId(
    abortCfg,
    rawSessionKey,
  );
  const bareSessionAgentResolution = !parsedAbortSessionKey
    ? resolveRequestedSessionAgentId(abortCfg, rawSessionKey, agentIdOverride)
    : undefined;
  if (bareSessionAgentResolution && !bareSessionAgentResolution.ok) {
    respond(false, undefined, bareSessionAgentResolution.error);
    return;
  }
  const abortAgentId = parsedAbortSessionKey
    ? (agentIdOverride ?? normalizeAgentId(parsedAbortSessionKey.agentId))
    : bareSessionAgentResolution?.agentId;
  if (!abortAgentId) {
    respondError(
      respond,
      ErrorCodes.INVALID_REQUEST,
      rawSessionKey.trim().toLowerCase() === "global"
        ? "agentId is required for global chat.abort when no compatibility owner exists"
        : "agentId is required for unscoped chat.abort when no compatibility owner exists",
    );
    return;
  }
  if (
    agentIdOverride &&
    parsedAbortSessionKey &&
    normalizeAgentId(parsedAbortSessionKey.agentId) !== normalizeAgentId(agentIdOverride)
  ) {
    respondError(
      respond,
      ErrorCodes.INVALID_REQUEST,
      `agentId "${agentIdOverride}" does not match session key "${rawSessionKey}"`,
    );
    return;
  }
  const canonicalAbortSessionKey = resolveSessionStoreKey({
    cfg: abortCfg,
    sessionKey: rawSessionKey,
    storeAgentId: abortAgentId,
  });
  if (discardPendingInput && isIncognitoSessionKey(canonicalAbortSessionKey)) {
    respondError(
      respond,
      ErrorCodes.INVALID_REQUEST,
      "Removing accepted queued input is unavailable in incognito sessions. Use Stop to cancel it.",
    );
    return;
  }
  const narrow =
    authority.sessionScope === "operator.sessions.write" ||
    requester.sessionAuthority !== undefined;
  const admittedTarget = sessionMutationAuthorization?.admittedTarget;
  if (
    narrow &&
    (!admittedTarget?.sessionId.trim() ||
      admittedTarget.sessionKey !== canonicalAbortSessionKey ||
      admittedTarget.agentId !== normalizeAgentId(abortAgentId))
  ) {
    respondError(respond, ErrorCodes.INVALID_REQUEST, "session target is unavailable");
    return;
  }
  const requiredSessionId = narrow ? admittedTarget?.sessionId : undefined;
  const ops = createChatAbortOps(context);

  const prepareAbortSession = (key = canonicalAbortSessionKey, agentId = abortAgentId) =>
    prepareChatAbortSessionSnapshot({
      excludeInternalEffects: true,
      cfg: abortCfg,
      key,
      agentId,
    });
  const stopHookContext = lifecycle.hookContext ?? {
    sessionKey: canonicalAbortSessionKey,
    sessionId: requiredSessionId,
    commandSource: "gateway:chat.abort",
    senderId: requester.deviceId ?? requester.connId,
  };
  if (!runId) {
    const res = await abortChatRunsForSessionKeyWithPartials(
      {
        context,
        ops,
        sessionKey: canonicalAbortSessionKey,
        sessionKeyAliases: canonicalAbortSessionKey === rawSessionKey ? undefined : [rawSessionKey],
        agentId: abortAgentId,
        sessionId: requiredSessionId,
        requiredSessionId,
        defaultAgentId: compatibilityDefaultAgentId,
        abortOrigin: "rpc",
        stopReason: "rpc",
        stopSource: "client-session",
        hookContext: stopHookContext,
        requester,
        assertCurrent,
        preserveSideRuns,
        cascadeDescendants: lifecycle.cascadeDescendants,
      },
      prepareAbortSession,
    );
    if (res.unauthorized) {
      respondError(respond, ErrorCodes.INVALID_REQUEST, "unauthorized");
      return;
    }
    if (res.descendants?.killed || res.descendants?.continuationRetired) {
      lifecycle.onDescendantsCancelled?.(res.descendants);
    }
    const error = res.error ?? descendantAbortError(res.descendants, "Session");
    if (error) {
      respond(false, undefined, withAbortedPartialPersistenceWarning(error, res.warning));
      return;
    }
    respond(true, {
      ok: true,
      aborted: res.aborted,
      runIds: res.runIds,
      ...(res.warning ? { warning: res.warning } : {}),
    });
    return;
  }
  // Hold the exact request-time source across fallible metadata preparation.
  const resolveGatewayContext = context.resolveGatewayContext;
  const matchesGateway = captureGatewayScopeMatcher(resolveGatewayContext);
  const capturedSources = listRpcSourceEntries().filter(
    ([id, entry]) => id === runId && matchesGateway(entry.input),
  );
  const reservedCandidate = getReservedRpcSourceInput(runId, { resolveGatewayContext });
  if (
    !discardPendingInput &&
    reservedCandidate &&
    !reservedCandidate.target &&
    reservedCandidate.sourceAdapter?.preparation
  ) {
    const adapter = reservedCandidate.sourceAdapter;
    const knownAgentId = adapter.preparation?.agentId;
    const rejection = narrow
      ? "runId does not match session incarnation"
      : knownAgentId && normalizeAgentId(knownAgentId) !== normalizeAgentId(abortAgentId)
        ? "runId does not match agentId"
        : !canRequesterAbortChatRun({ requester: adapter.requester }, requester, {
              requireOwnerMatch: true,
            })
          ? "unauthorized"
          : undefined;
    if (rejection) {
      respondError(respond, ErrorCodes.INVALID_REQUEST, rejection);
      return;
    }
    // Routing has no physical session yet. Cancel only this captured source, never
    // descendants, workers, or command hooks selected by the caller's placeholder key.
    const stopped = cancelCapturedSessionControllerSource(
      captureSessionControllerStop({ inputs: [reservedCandidate] }),
      { assertCurrent, reason: createAgentRunDirectAbortError() },
    );
    const failure = stopped.failures[0];
    if (failure) {
      throw failure.error;
    }
    const aborted = stopped.abortedInputs.includes(reservedCandidate);
    respond(true, { ok: true, aborted, runIds: aborted ? [runId] : [] });
    return;
  }
  const commands = captureExecRequestCancellation({
    runId,
    sessionKey: canonicalAbortSessionKey,
    sessionId: requiredSessionId,
    agentId: abortAgentId,
  });
  const abortSession = await prepareAbortSession();
  const abortSessionEntry = abortSession.ok ? abortSession.value.entry : undefined;
  const capturedStores = new Set(
    [...capturedSources.map(([, entry]) => entry.input), reservedCandidate].flatMap((input) =>
      input?.target ? [input.target.storeScope] : [],
    ),
  );
  // Fallible transcript metadata cannot discard one exact captured physical owner.
  const storePath = abortSession.ok
    ? abortSession.value.storePath
    : capturedStores.size === 1
      ? capturedStores.values().next().value
      : undefined;
  const matchesScope = storePath
    ? captureRpcSourceScopeMatcher({
        storePath,
        resolveGatewayContext,
      })
    : () => false;
  // Runs the command Stop sequence when no exact run source was captured.
  const stopWithoutCapturedRun = (reason?: string, afterParent?: () => void) =>
    stopSession({
      source: "client-run",
      capture: captureSessionControllerStop({}),
      assertCurrent,
      reason,
      hookContext: stopHookContext,
      afterParent,
    }).completed;
  const authorizeRunTarget = (
    target: Parameters<typeof resolveChatAbortTargetRejection>[0]["target"],
  ): boolean => {
    const rejection = resolveChatAbortTargetRejection({
      target,
      requester,
      requestedSessionKey: rawSessionKey,
      canonicalSessionKey: canonicalAbortSessionKey,
      requestedAgentId: normalizeAgentId(abortAgentId),
      defaultAgentId: compatibilityDefaultAgentId,
      requiredSessionId,
      discardPendingInput,
      narrow,
    });
    if (rejection) {
      respondError(respond, ErrorCodes.INVALID_REQUEST, rejection);
    }
    return rejection === undefined;
  };

  // Capture the exact input once; an await must never select a successor by run ID.
  const targetMatches = capturedSources.flatMap(([, entry]) =>
    matchesScope(entry) ? [entry] : [],
  );
  const active = targetMatches.length === 1 ? targetMatches[0] : undefined;
  const reserved =
    !active && reservedCandidate && storePath && reservedCandidate.target?.storeScope === storePath
      ? reservedCandidate
      : undefined;
  const activeIdentity = active
    ? getRpcSourceIdentity(active)
    : reserved
      ? getSessionControllerSourceIdentity(reserved)
      : undefined;
  const workerTarget = getWorkerInferenceSessionControl(
    context.workerEnvironmentService,
  )?.resolveSessionTargetForRunId(runId);

  const workerCancellation = captureWorkerInferenceForSession({
    context,
    sessionId: activeIdentity?.sessionId ?? workerTarget?.sessionId ?? abortSessionEntry?.sessionId,
    runId,
  });
  let inputWithdrawn = false;
  if (discardPendingInput) {
    if (
      active &&
      !authorizeRunTarget({ ...getRpcSourceIdentity(active), requester: active.adapter.requester })
    ) {
      return;
    }
    if (
      !active ||
      !isRpcSourceQueued(active) ||
      active.input.phase === "injecting" ||
      active.input.claim ||
      active.input.retirementRequested
    ) {
      respond(true, { ok: true, aborted: false, runIds: [] });
      return;
    }
    const withdrawalScope = getRpcSourceIdentity(active);
    const withdrawalTarget = active.input.target;
    const captured = {
      ...withdrawalScope,
      agentId: withdrawalScope.agentId ?? abortAgentId,
    };
    const hold = holdSessionControllerSourceWithdrawal(active.input);
    try {
      if (!abortSession.ok) {
        throw abortSession.error;
      }
      inputWithdrawn = await discardSessionPendingInput(
        { ...captured, storePath: abortSession.value.storePath },
        runId,
        () => {
          assertCurrent();
          const currentIdentity = getRpcSourceIdentity(active);
          // The write retains this source and physical owner across each awaited phase.
          if (
            !isRpcSourceRegistered(active) ||
            !isRpcSourceQueued(active) ||
            !withdrawalTarget ||
            active.input.target !== withdrawalTarget ||
            currentIdentity.sessionKey !== withdrawalScope.sessionKey ||
            currentIdentity.sessionId !== withdrawalScope.sessionId ||
            currentIdentity.agentId !== withdrawalScope.agentId
          ) {
            throw new Error("Run changed before input removal; refresh and retry.");
          }
        },
      );
      if (inputWithdrawn) {
        active.adapter.abortStopReason = "rpc";
        inputWithdrawn = hold.commit("rpc");
        if (inputWithdrawn) {
          emitSessionsChanged(
            context,
            { ...captured, reason: "agent.input.settled" },
            { accessChanged: false },
          );
        }
      }
    } finally {
      hold();
    }
    respond(true, { ok: true, aborted: inputWithdrawn, runIds: inputWithdrawn ? [runId] : [] });
    return;
  }
  const workerRunIds = new Set<string>();
  let workerSettlement: Promise<string[]> | undefined;
  const cancelWorker = () => {
    if (!requester.isAdmin || !workerCancellation?.runIds.length) {
      return;
    }
    assertCurrent();
    const settlement = workerCancellation.cancel({
      assertCurrent,
      onCancelled: (id) => {
        workerRunIds.add(id);
        lifecycle.onExactRunAborted?.(id);
      },
    });
    workerSettlement = settlement;
    void settlement.catch(() => undefined);
  };
  const respondWithWorkerRuns = async (
    localRunIds: string[],
    warning?: string,
    commandAborted = false,
  ): Promise<void> => {
    await workerSettlement;
    const runIds = new Set([...localRunIds, ...workerRunIds]);
    if (!abortSession.ok) {
      throw abortSession.error;
    }
    respond(true, {
      ok: true,
      aborted: runIds.size > 0 || commandAborted,
      runIds: [...runIds],
      ...(warning ? { warning } : {}),
    });
  };
  if (!active) {
    if (reserved && activeIdentity) {
      if (
        !authorizeRunTarget({
          ...activeIdentity,
          requester: reserved.sourceAdapter?.requester,
        })
      ) {
        return;
      }
      const assertReserved = exactRun.captureSourceAssertion(reserved, assertCurrent);
      const selectedSession =
        activeIdentity.sessionKey === rawSessionKey ||
        activeIdentity.sessionKey === canonicalAbortSessionKey
          ? abortSession
          : await prepareAbortSession(
              activeIdentity.sessionKey,
              activeIdentity.agentId ?? abortAgentId,
            );
      const selectedEntry = selectedSession.ok ? selectedSession.value.entry : undefined;
      let aborted = false;
      let descendants: Awaited<ReturnType<typeof abortControlledSubagents>> | undefined;
      const stopped = stopSession({
        source: "client-run",
        capture: captureSessionControllerStop({ inputs: [reserved] }),
        assertCurrent: assertReserved,
        reason: createAgentRunDirectAbortError(),
        hookContext: {
          ...stopHookContext,
          sessionKey: activeIdentity.sessionKey,
          sessionId: activeIdentity.sessionId,
        },
        afterParent: cancelWorker,
        onCancelled: (target) => {
          if (target === reserved) {
            aborted = true;
          }
        },
        stopChildren: async (applyParentStop) => {
          // The settle producer can still own the registry operation needed for
          // descendant cleanup. Cancel its captured source before entering that owner.
          await applyParentStop();
          descendants = await abortControlledSubagents({
            cfg: abortCfg,
            sessionKey: activeIdentity.sessionKey,
            agentId: activeIdentity.agentId,
            requesterTurnRunId: runId,
            sessionId: activeIdentity.sessionId,
            lifecycleRevision:
              selectedEntry?.sessionId === activeIdentity.sessionId
                ? selectedEntry.lifecycleRevision
                : undefined,
            assertCurrent: assertReserved,
          });
          return {
            stopped: descendants?.killed ?? 0,
            failed: descendants?.status === "error" ? descendants.failed : 0,
          };
        },
      });
      await stopped.completed;
      const descendantError = descendantAbortError(descendants, "Parent run");
      if (descendantError) {
        respond(false, undefined, descendantError);
        return;
      }
      await respondWithWorkerRuns(aborted ? [runId] : []);
      return;
    }
    if (commands.owners.length > 0) {
      for (const owner of commands.owners) {
        const { identity } = owner;
        const target = {
          ...identity,
          requester: {
            connectionId: identity.ownerConnId,
            deviceId: identity.ownerDeviceId,
          },
        };
        if (
          !identity.sessionKey ||
          !identity.sessionId ||
          !canRequesterAbortChatRun(target, requester, { requireOwnerMatch: true })
        ) {
          respondError(respond, ErrorCodes.INVALID_REQUEST, "unauthorized");
          return;
        }
        if (!authorizeRunTarget(target)) {
          return;
        }
      }
      const descendants = await abortControlledSubagents({
        cfg: abortCfg,
        sessionKey: canonicalAbortSessionKey,
        agentId: abortAgentId,
        sessionId: abortSessionEntry?.sessionId,
        requesterTurnRunId: runId,
        lifecycleRevision: abortSessionEntry?.lifecycleRevision,
        execCancellation: commands,
        assertCurrent,
        beforeKill: async () => {
          assertCurrent();
          if (getRpcSourceForGateway(runId, resolveGatewayContext)) {
            throw new Error("Run changed before cancellation; retry Stop.");
          }
          await stopWithoutCapturedRun("rpc", cancelWorker);
          return true;
        },
      });
      const error = descendantAbortError(descendants, "Parent run");
      if (error) {
        respond(false, undefined, error);
        return;
      }
      await respondWithWorkerRuns([], undefined, descendants?.execAborted);
      return;
    }
    if (!workerCancellation?.runIds.length) {
      if (!abortSession.ok) {
        throw abortSession.error;
      }
      await stopWithoutCapturedRun();
      respond(true, { ok: true, aborted: false, runIds: [] });
      return;
    }
    if (!requester.isAdmin) {
      respondError(respond, ErrorCodes.INVALID_REQUEST, "unauthorized");
      return;
    }
    cancelWorker();
    await stopWithoutCapturedRun("rpc");
    await respondWithWorkerRuns([]);
    return;
  }
  if (
    !authorizeRunTarget({ ...getRpcSourceIdentity(active), requester: active.adapter.requester })
  ) {
    return;
  }
  const { sessionKey, sessionId, agentId } = getRpcSourceIdentity(active);
  assertCurrent();
  const assertActive = exactRun.captureSourceAssertion(active.input, assertCurrent);
  const selectedSession =
    sessionKey === rawSessionKey || sessionKey === canonicalAbortSessionKey
      ? abortSession
      : await prepareAbortSession(sessionKey, agentId ?? abortAgentId);
  let snapshot: AbortedPartialSnapshot | undefined;
  const { aborted, descendants, failure } = await exactRun.stopExactClientRun({
    ops,
    cfg: abortCfg,
    runId,
    active,
    lifecycleRevision:
      selectedSession.ok && selectedSession.value.entry?.sessionId === sessionId
        ? selectedSession.value.entry.lifecycleRevision
        : undefined,
    assertCurrent: assertActive,
    hookContext: stopHookContext,
    afterParent: cancelWorker,
    onAborted: () => lifecycle.onExactRunAborted?.(runId),
    onAbortPrepared: () => {
      const text = context.chatRunState.resolveBuffer(runId, { final: true }).text;
      if (active.adapter.controlUiVisible === false || !text?.trim()) {
        return undefined;
      }
      snapshot = captureAbortedPartial({
        runId,
        sessionKey,
        sessionId,
        agentId: agentId ?? abortAgentId,
        text,
        abortOrigin: "rpc",
        resolveTerminalProducer: active.adapter.resolveTerminalProducer,
        session: selectedSession,
      });
      return deferAbortedPartialPersistence(snapshot, context);
    },
  });
  const descendantError = descendantAbortError(descendants, "Parent run");
  let warning: string | undefined;
  const errors: unknown[] = failure ? [failure.error] : [];
  // A later child fence can reject after the parent consumed its buffer. The
  // transcript owner must still settle that already-committed cancellation.
  if (aborted) {
    try {
      const partialPersistence = snapshot
        ? persistAbortedPartials({ context, snapshots: [snapshot] }).then((value) => {
            warning = value;
            return value;
          })
        : undefined;
      await waitForChatAbortAcknowledgment(
        Promise.all(
          [partialPersistence, waitForChatAbortTerminalPersistence(active)].map((work) =>
            Promise.resolve(work).catch((error: unknown) => errors.push(error)),
          ),
        ),
      );
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length) {
    if (descendantError) {
      // A pending producer retains custody, but must not hide an already-known child failure.
      respond(
        false,
        undefined,
        withAbortedPartialPersistenceWarning(
          {
            ...descendantError,
            message: [descendantError.message, ...errors.map(formatErrorMessage)].join(" "),
          },
          warning,
        ),
      );
      return;
    }
    throw abortedPartialPersistenceError(
      errors.length === 1
        ? errors[0]
        : new AggregateError(errors, "Chat cancellation and persistence failed"),
      warning,
    );
  }
  if (!abortSession.ok) {
    throw abortedPartialPersistenceError(abortSession.error, warning);
  }
  if (descendantError) {
    respond(false, undefined, withAbortedPartialPersistenceWarning(descendantError, warning));
    return;
  }
  try {
    await respondWithWorkerRuns(aborted ? [runId] : [], warning);
  } catch (error) {
    throw abortedPartialPersistenceError(error, warning);
  }
}

export async function handleChatAbortRequest(options: GatewayRequestHandlerOptions): Promise<void> {
  if (validateChatAbortParams(options.params)) {
    options.context.logGateway.info(
      formatStopRequest("chat.abort", options.client, options.params),
    );
  }
  try {
    await handleChatAbortRequestWithLifecycle(options);
  } catch (error) {
    const contention = resolveStateContentionPresentation(error);
    if (!contention) {
      throw error;
    }
    // A session read can fail even though cancellation takes effect. Do not
    // replay Stop or claim it had no effect; preserve uncertainty at the RPC boundary.
    options.respond(
      false,
      undefined,
      errorShape(
        ErrorCodes.UNAVAILABLE,
        "The server is busy. Check this turn's status before trying Stop again.\n\n" +
          "SQLite transaction admission remained busy. Stopping may already have taken effect.",
        { details: { errorKind: contention.errorKind } },
      ),
    );
  }
}
