import type { OpenClawConfig } from "../../config/config.js";
import type { SessionEntry } from "../../config/sessions.js";
import {
  bindSessionControllerSourceTurnId,
  type ReplyOperation,
} from "../../sessions/session-controller.js";
import {
  acquireReplyOperationSessionActor,
  getReplyOperationSessionTarget,
  lifecycleAdmissionByOperation,
} from "../../sessions/session-controller.state.js";
import {
  resolveReplyRunDeliveryContext,
  resolveSourceReplyPolicy,
  type RunReplyAgentParams,
} from "./agent-runner-core.js";
import { buildThreadingToolContext } from "./agent-runner-utils.js";
import { createReplyRestartRecoveryClaimController } from "./restart-recovery-claim.js";
import { resolveReplyAdmissionRunId, resolveReplySourceTurnId } from "./source-turn-id.js";

export function createReplyAgentRestartRecoveryController(
  context: Pick<
    RunReplyAgentParams,
    "followupRun" | "opts" | "runtimePolicySessionKey" | "sessionCtx" | "sessionKey" | "storePath"
  > & {
    activeSessionStore: Record<string, SessionEntry> | undefined;
    cfg: OpenClawConfig;
    getActiveSessionEntry: () => SessionEntry | undefined;
    replyOperation: ReplyOperation;
    restartRecoverySourceTurnId: string | undefined;
    setActiveSessionEntry: (entry: SessionEntry) => void;
  },
) {
  const {
    activeSessionStore,
    cfg,
    followupRun,
    getActiveSessionEntry,
    opts,
    replyOperation,
    restartRecoverySourceTurnId,
    runtimePolicySessionKey,
    sessionCtx,
    sessionKey,
    setActiveSessionEntry,
    storePath,
  } = context;

  const restartRecoverySameChannelThreadRequired = restartRecoverySourceTurnId
    ? buildThreadingToolContext({
        sessionCtx,
        config: cfg,
        hasRepliedRef: undefined,
      }).sameChannelThreadRequired
    : undefined;
  const admissionRunId = resolveReplyAdmissionRunId(sessionCtx);
  const recovery = createReplyRestartRecoveryClaimController({
    agentId: followupRun.run.agentId,
    operationAdmission: lifecycleAdmissionByOperation.get(replyOperation),
    acquireSessionActor: async () => {
      const actor = await acquireReplyOperationSessionActor(replyOperation);
      if (!actor) {
        return undefined;
      }
      const target = getReplyOperationSessionTarget(replyOperation);
      if (!target) {
        throw new Error("Reply operation has no session actor target");
      }
      return { actor, target };
    },
    operatorAuthority: followupRun.operatorAuthority,
    requesterOrigin: followupRun.run.requesterOrigin,
    inputProvenance: followupRun.run.inputProvenance,
    lifecycleGeneration: replyOperation.lifecycleGeneration,
    admissionRunId,
    executionRunId: opts?.runId,
    getEntry: () =>
      sessionKey
        ? (activeSessionStore?.[sessionKey] ?? getActiveSessionEntry())
        : getActiveSessionEntry(),
    getSessionId: () => replyOperation.sessionId,
    isRestartAbort: () =>
      replyOperation.result?.kind === "aborted" &&
      replyOperation.result.code === "aborted_for_restart",
    resolveDeliveryContext: (entry) =>
      sessionKey
        ? resolveReplyRunDeliveryContext({
            cfg,
            sessionCtx,
            sessionEntry: entry,
            sessionKey,
            runtimePolicySessionKey,
            opts,
          })
        : undefined,
    requesterAccountId:
      followupRun.originatingAccountId ?? sessionCtx.AccountId ?? followupRun.run.agentAccountId,
    requesterSenderId: sessionCtx.SenderId,
    resolveUserTurnTarget: ({
      entry,
      sessionId,
      sessionKey: targetSessionKey,
      storePath: targetStorePath,
    }) => {
      const target = getReplyOperationSessionTarget(replyOperation);
      // Persistence shares the actor's physical spelling; scheduling keeps its logical store scope.
      const persistenceStorePath =
        target?.agentId === followupRun.run.agentId &&
        target.target.canonicalKey === targetSessionKey
          ? (target.readSource?.path ?? target.storePath)
          : targetStorePath;
      return {
        sessionId,
        sessionKey: targetSessionKey,
        sessionEntry: entry,
        ...(activeSessionStore ? { sessionStore: activeSessionStore } : {}),
        storePath: persistenceStorePath,
        agentId: followupRun.run.agentId,
        cwd: followupRun.run.workspaceDir,
        config: cfg,
      };
    },
    ...(sessionKey ? { sessionKey } : {}),
    setEntry: (entry) => {
      setActiveSessionEntry(entry);
      if (activeSessionStore && sessionKey) {
        activeSessionStore[sessionKey] = entry;
      }
    },
    sameChannelThreadRequired: restartRecoverySameChannelThreadRequired,
    sourceTurnId: restartRecoverySourceTurnId,
    strandedReplyRetry: followupRun.strandedReplyRetry,
    sourceReplyDeliveryMode: sessionKey
      ? resolveSourceReplyPolicy({
          cfg,
          sessionCtx,
          sessionEntry: getActiveSessionEntry(),
          sessionKey,
          runtimePolicySessionKey,
          opts,
        }).sourceReplyDeliveryMode
      : opts?.sourceReplyDeliveryMode,
    ...(storePath ? { storePath } : {}),
  });
  return {
    ...recovery,
    admitUserTurn: async (...args: Parameters<typeof recovery.admitUserTurn>) => {
      const result = await recovery.admitUserTurn(...args);
      if (result === "admitted") {
        const sourceTurnId = resolveReplySourceTurnId({
          sourceTurnId: restartRecoverySourceTurnId,
          admissionRunId,
          ingressProvider: sessionCtx.Provider ?? sessionCtx.Surface,
          entry: getActiveSessionEntry(),
        });
        if (sourceTurnId) {
          bindSessionControllerSourceTurnId(replyOperation, sourceTurnId);
        }
      }
      return result;
    },
  };
}
