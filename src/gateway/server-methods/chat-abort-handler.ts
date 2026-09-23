import type { Result } from "@openclaw/normalization-core/result";
// RPC adapter for chat.abort; cancellation policy lives in the sibling modules.
import {
  ErrorCodes,
  errorShape,
  validateChatAbortParams,
} from "../../../packages/gateway-protocol/src/index.js";
import { normalizeAgentId } from "../../routing/session-key.js";
import { parseAgentSessionKey } from "../../sessions/session-key-utils.js";
import { createChatAbortOps } from "../chat-abort-ops.js";
import { abortChatRunById, type ChatAbortControllerEntry } from "../chat-abort.js";
import { abortQueuedChatTurnById, type QueuedChatTurnEntry } from "../chat-queued-turns.js";
import { chatRunBelongsToAgent } from "../chat-run-owner.js";
import { pendingChatSendDedupeKey } from "../server-shared.js";
import {
  resolveRequestedSessionAgentId,
  tryResolveSessionCompatibilityOwnerAgentId,
} from "../session-request-agent.js";
import { loadSessionEntry, resolveSessionStoreKey } from "../session-utils.js";
import {
  canRequesterAbortChatRun,
  canRequesterAbortPreRegisteredRun,
  readPreRegisteredAgentDedupePayloadForSession,
  resolveChatAbortRequester,
  writePreRegisteredAgentAbort,
  writePreRegisteredChatAbort,
} from "./chat-abort-authorization.js";
import {
  abortChatRunsForSessionKeyWithPartials,
  captureWorkerInferenceForSession,
  abortControlledSubagents,
  descendantAbortError,
} from "./chat-abort-runtime.js";
import {
  abortedPartialPersistenceError,
  captureAbortedPartial,
  withAbortedPartialPersistenceWarning,
} from "./chat-aborted-partial.js";
import {
  normalizeOptionalChatText as normalizeOptionalText,
  normalizeUnknownChatText as normalizeUnknownText,
} from "./chat-text-normalization.js";
import { persistAbortedPartials } from "./chat-transcript-persistence.js";
import { readGatewayRequestMutationAuthority } from "./session-mutation-guards.js";
import type { GatewayRequestContext, GatewayRequestHandlerOptions } from "./types.js";
import { assertValidParams } from "./validation.js";

type ChatAbortLifecycle = {
  onAuthorizedAfterQueuedAbort?: () => boolean;
  onDescendantsCancelled?: () => void;
  excludeRunIds?: ReadonlySet<string>;
  cascadeDescendants?: true;
};

type ChatAbortTarget = Pick<
  ChatAbortControllerEntry | QueuedChatTurnEntry,
  "sessionKey" | "sessionId" | "agentId" | "ownerConnId" | "ownerDeviceId"
>;

export async function handleChatAbortRequestWithLifecycle(
  options: GatewayRequestHandlerOptions,
  lifecycle: ChatAbortLifecycle = {},
): Promise<void> {
  const { params, respond, context, client, sessionMutationAuthorization } = options;
  const authority = readGatewayRequestMutationAuthority(options);
  const assertCurrent = () => {
    authority.assertCurrent();
    sessionMutationAuthorization?.assertCurrent();
  };
  if (!assertValidParams(params, validateChatAbortParams, "chat.abort", respond)) {
    return;
  }
  const {
    sessionKey: rawSessionKey,
    runId,
    preserveSideRuns,
  } = params as {
    sessionKey: string;
    agentId?: string;
    runId?: string;
    preserveSideRuns?: boolean;
  };
  const agentIdOverride = normalizeOptionalText((params as { agentId?: string }).agentId);
  const abortCfg = context.getRuntimeConfig();
  const parsedAbortSessionKey = parseAgentSessionKey(rawSessionKey);
  const compatibilityDefaultAgentId = tryResolveSessionCompatibilityOwnerAgentId(
    abortCfg,
    rawSessionKey,
  );
  const inferredSessionAgentId =
    !agentIdOverride && parsedAbortSessionKey
      ? normalizeAgentId(parsedAbortSessionKey.agentId)
      : undefined;
  const bareSessionAgentResolution = !parsedAbortSessionKey
    ? resolveRequestedSessionAgentId(abortCfg, rawSessionKey, agentIdOverride)
    : undefined;
  if (bareSessionAgentResolution && !bareSessionAgentResolution.ok) {
    respond(false, undefined, bareSessionAgentResolution.error);
    return;
  }
  const abortAgentId = parsedAbortSessionKey
    ? (agentIdOverride ?? inferredSessionAgentId)
    : bareSessionAgentResolution?.agentId;
  if (!abortAgentId) {
    respond(
      false,
      undefined,
      errorShape(
        ErrorCodes.INVALID_REQUEST,
        rawSessionKey.trim().toLowerCase() === "global"
          ? "agentId is required for global chat.abort when no compatibility owner exists"
          : "agentId is required for unscoped chat.abort when no compatibility owner exists",
      ),
    );
    return;
  }
  if (
    agentIdOverride &&
    parsedAbortSessionKey &&
    normalizeAgentId(parsedAbortSessionKey.agentId) !== normalizeAgentId(agentIdOverride)
  ) {
    respond(
      false,
      undefined,
      errorShape(
        ErrorCodes.INVALID_REQUEST,
        `agentId "${agentIdOverride}" does not match session key "${rawSessionKey}"`,
      ),
    );
    return;
  }
  const canonicalAbortSessionKey = resolveSessionStoreKey({
    cfg: abortCfg,
    sessionKey: rawSessionKey,
    storeAgentId: abortAgentId,
  });
  const narrow = authority.sessionScope === "operator.sessions.write";
  const admittedTarget = sessionMutationAuthorization?.admittedTarget;
  if (
    narrow &&
    (!admittedTarget?.sessionId.trim() ||
      admittedTarget.sessionKey !== canonicalAbortSessionKey ||
      admittedTarget.agentId !== normalizeAgentId(abortAgentId))
  ) {
    respond(
      false,
      undefined,
      errorShape(ErrorCodes.INVALID_REQUEST, "session target is unavailable"),
    );
    return;
  }
  const requiredSessionId = narrow ? admittedTarget?.sessionId : undefined;
  const ops = createChatAbortOps(context);
  const requester = resolveChatAbortRequester(client);

  const sessionLoadOptions = { agentId: abortAgentId };
  const abortSession: Result<ReturnType<typeof loadSessionEntry>, unknown> = (() => {
    try {
      return { ok: true, value: loadSessionEntry(canonicalAbortSessionKey, sessionLoadOptions) };
    } catch (error) {
      return { ok: false, error };
    }
  })();
  const abortSessionEntry = abortSession.ok ? abortSession.value.entry : undefined;
  if (!runId) {
    const res = await abortChatRunsForSessionKeyWithPartials({
      context,
      ops,
      sessionKey: canonicalAbortSessionKey,
      sessionKeyAliases: canonicalAbortSessionKey === rawSessionKey ? undefined : [rawSessionKey],
      agentId: abortAgentId,
      sessionId: abortSessionEntry?.sessionId,
      requiredSessionId,
      session: abortSession,
      defaultAgentId: compatibilityDefaultAgentId,
      abortOrigin: "rpc",
      stopReason: "rpc",
      requester,
      assertCurrent,
      preserveSideRuns,
      excludeRunIds: lifecycle.excludeRunIds,
      onAuthorizedAfterQueuedAbort: lifecycle.onAuthorizedAfterQueuedAbort,
      cascadeDescendants: lifecycle.cascadeDescendants,
    });
    if (res.unauthorized) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "unauthorized"));
      return;
    }
    if (res.descendants?.killed) {
      lifecycle.onDescendantsCancelled?.();
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
  const normalizedAgentIdOverride = normalizeAgentId(abortAgentId);
  const authorizeRunTarget = (target: ChatAbortTarget): boolean => {
    if (narrow && target.sessionId !== requiredSessionId) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "runId does not match session incarnation"),
      );
      return false;
    }
    if (
      target.sessionKey !== rawSessionKey &&
      target.sessionKey !== canonicalAbortSessionKey &&
      (narrow || !canRequesterAbortChatRun(target, requester, { requireOwnerMatch: true }))
    ) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "runId does not match sessionKey"),
      );
      return false;
    }
    if (
      !chatRunBelongsToAgent(
        {
          agentId: target.agentId,
          sessionKey: target.sessionKey,
          defaultAgentId: compatibilityDefaultAgentId,
        },
        normalizedAgentIdOverride,
      )
    ) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "runId does not match agentId"),
      );
      return false;
    }
    if (!canRequesterAbortChatRun(target, requester)) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "unauthorized"));
      return false;
    }
    return true;
  };

  const active = context.chatAbortControllers.get(runId);
  // Broad same-device Stop can name an active run on another session. Capture
  // that original producer's SID before descendant or transcript work yields.
  const workerCancellation = captureWorkerInferenceForSession({
    context,
    sessionId: active?.sessionId ?? abortSessionEntry?.sessionId,
    runId,
  });
  const respondWithWorkerRuns = (localRunIds: string[], warning?: string): void => {
    const runIds = new Set(localRunIds);
    if (requester.isAdmin) {
      assertCurrent();
      workerCancellation?.cancel({ assertCurrent, onCancelled: (id) => runIds.add(id) });
    }
    if (!abortSession.ok) {
      throw abortSession.error;
    }
    respond(true, {
      ok: true,
      aborted: runIds.size > 0,
      runIds: [...runIds],
      ...(warning ? { warning } : {}),
    });
  };
  if (!active) {
    const readPendingRunForAbort = (
      entry: GatewayRequestContext["dedupe"] extends Map<string, infer T> ? T | undefined : never,
    ) => {
      for (const sessionKey of new Set([canonicalAbortSessionKey, rawSessionKey])) {
        const payload = readPreRegisteredAgentDedupePayloadForSession({
          entry,
          runId,
          sessionKey,
          agentId: abortAgentId,
          defaultAgentId: compatibilityDefaultAgentId,
          includeHidden: true,
          requiredSessionId,
        });
        if (payload) {
          return {
            sessionKey: normalizeUnknownText(payload.sessionKey) ? sessionKey : undefined,
            payload,
          };
        }
      }
      return undefined;
    };
    const pendingChatMatch = readPendingRunForAbort(
      context.dedupe.get(pendingChatSendDedupeKey(runId)),
    );
    if (pendingChatMatch) {
      if (!canRequesterAbortPreRegisteredRun(pendingChatMatch.payload, requester)) {
        respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "unauthorized"));
        return;
      }
      assertCurrent();
      const aborted = writePreRegisteredChatAbort({
        context,
        runId,
        stopReason: "rpc",
        attemptId: normalizeUnknownText(pendingChatMatch.payload.attemptId),
        expectedPayload: pendingChatMatch.payload,
      });
      respondWithWorkerRuns(aborted ? [runId] : []);
      return;
    }
    const pendingAgentEntry = context.dedupe.get(`agent:${runId}`);
    const pendingAgentMatch = readPendingRunForAbort(pendingAgentEntry);
    if (pendingAgentMatch) {
      const pendingAgentPayload = pendingAgentMatch.payload;
      if (!canRequesterAbortPreRegisteredRun(pendingAgentPayload, requester)) {
        respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "unauthorized"));
        return;
      }
      let aborted = false;
      const descendants = await abortControlledSubagents({
        cfg: abortCfg,
        sessionKey: pendingAgentMatch.sessionKey ?? canonicalAbortSessionKey,
        agentId: abortAgentId,
        requesterTurnRunId: runId,
        assertCurrent,
        beforeKill: () => {
          assertCurrent();
          return (aborted = writePreRegisteredAgentAbort({
            context,
            runId,
            sessionKey: pendingAgentMatch.sessionKey,
            payload: pendingAgentPayload,
            expectedPayload: pendingAgentPayload,
            stopReason: "rpc",
          }));
        },
      });
      const error = descendantAbortError(descendants, "Parent run");
      if (error) {
        respond(false, undefined, error);
        return;
      }
      respondWithWorkerRuns(aborted ? [runId] : []);
      return;
    }
    // Queued followup/collect turns keep a cancel identity after chat.send
    // terminalizes; abort them here so Esc cannot report done while they run.
    const chatQueuedTurns = context.chatQueuedTurns;
    const queued = chatQueuedTurns.get(runId);
    if (queued) {
      if (!authorizeRunTarget(queued)) {
        return;
      }
      const { sessionKey, sessionId, agentId } = queued;
      assertCurrent();
      if (
        chatQueuedTurns.get(runId) !== queued ||
        queued.sessionKey !== sessionKey ||
        queued.sessionId !== sessionId ||
        queued.agentId !== agentId
      ) {
        throw new Error("Run changed before cancellation; retry Stop.");
      }
      const queuedRes = abortQueuedChatTurnById(chatQueuedTurns, {
        runId,
        sessionKey: queued.sessionKey,
        stopReason: "rpc",
        allowSessionMismatch: true,
      });
      respondWithWorkerRuns(queuedRes.aborted ? [runId] : []);
      return;
    }
    if (!workerCancellation?.runIds.length) {
      if (!abortSession.ok) {
        throw abortSession.error;
      }
      respond(true, { ok: true, aborted: false, runIds: [] });
      return;
    }
    if (!requester.isAdmin) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "unauthorized"));
      return;
    }
    respondWithWorkerRuns([]);
    return;
  }
  if (!authorizeRunTarget(active)) {
    return;
  }
  let aborted = false;
  const { sessionKey, sessionId, agentId, controlUiVisible } = active;
  const partialText = context.chatRunState.resolveBuffer(runId, { final: true }).text;
  const snapshot =
    controlUiVisible !== false && partialText?.trim()
      ? captureAbortedPartial({
          runId,
          sessionKey,
          sessionId,
          agentId: agentId ?? abortAgentId,
          text: partialText,
          abortOrigin: "rpc",
          ...(sessionKey === rawSessionKey || sessionKey === canonicalAbortSessionKey
            ? { session: abortSession }
            : {}),
        })
      : undefined;
  let descendants: Awaited<ReturnType<typeof abortControlledSubagents>>;
  let failure: { error: unknown } | undefined;
  let warning: string | undefined;
  try {
    descendants = await abortControlledSubagents({
      cfg: abortCfg,
      sessionKey,
      agentId,
      requesterTurnRunId: runId,
      assertCurrent,
      beforeKill: () => {
        // The descendant owner can await a reservation even when no child survives.
        assertCurrent();
        if (
          context.chatAbortControllers.get(runId) !== active ||
          active.sessionKey !== sessionKey ||
          active.sessionId !== sessionId ||
          active.agentId !== agentId
        ) {
          throw new Error("Run changed before cancellation; retry Stop.");
        }
        return (aborted = abortChatRunById(ops, { runId, sessionKey, stopReason: "rpc" }).aborted);
      },
    });
  } catch (error) {
    failure = { error };
  } finally {
    // A later child fence can reject after the parent consumed its buffer. The
    // transcript owner must still settle that already-committed cancellation.
    if (aborted && snapshot) {
      warning = await persistAbortedPartials({ context, snapshots: [snapshot] });
    }
  }
  if (failure) {
    throw abortedPartialPersistenceError(failure.error, warning);
  }
  if (!abortSession.ok) {
    throw abortedPartialPersistenceError(abortSession.error, warning);
  }
  const descendantError = descendantAbortError(descendants, "Parent run");
  if (descendantError) {
    respond(false, undefined, withAbortedPartialPersistenceWarning(descendantError, warning));
    return;
  }
  try {
    respondWithWorkerRuns(aborted ? [runId] : [], warning);
  } catch (error) {
    throw abortedPartialPersistenceError(error, warning);
  }
}

export async function handleChatAbortRequest(options: GatewayRequestHandlerOptions): Promise<void> {
  await handleChatAbortRequestWithLifecycle(options);
}
