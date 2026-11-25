import { resolveDefaultAgentId } from "../agents/agent-scope-config.js";
import { isAgentRunRestartAbortReason } from "../agents/run-termination.js";
import { subagentRegistryLog } from "../agents/subagents/registry/subagent-registry-lifecycle-log.js";
import {
  listLiveSubagentSessions,
  listYieldWaitingSessions,
  resolveRootSubagentRequester,
  restartSessionOwnerKey,
} from "../agents/subagents/registry/subagent-registry-read.js";
import { restartResumeSkipReason } from "../config/sessions/session-run-lifecycle-projection.js";
import { preparePhysicalSessionStorePath } from "../config/sessions/session-store-path.js";
import type { InternalSessionEntry } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  getAgentRunContext,
  hasAgentRunContextExecutionOwner,
  listLiveAgentRunIds,
} from "../infra/agent-run-registry.js";
import { parseAgentSessionKey } from "../routing/session-key.js";
import type { ReplyOperation } from "../sessions/session-controller.contracts.js";
import { getSessionControllerEntryForOperation } from "../sessions/session-controller.identity.js";
import { findSessionControllerOperationByRunId } from "../sessions/session-controller.queries.js";
import { getRpcSourceForSignal } from "../sessions/session-controller.rpc-sources.js";
import {
  activeSessionOperations,
  getOperationBackendRunIds,
  hasCommittedReplyOperationOutcome,
} from "../sessions/session-controller.state.js";
import { resolveExplicitIncognitoAgentSqliteTarget } from "../state/openclaw-agent-db.paths.js";
import type { QueuedOperatorRecoverySource } from "./operator-run-recovery-source.codec.js";
import { captureQueuedOperatorRecoverySource } from "./operator-run-recovery-source.js";
import type { createRestartResumeSummary } from "./session-restart-resume-log.js";

/** Capture the interrupted execution's source, never a later steering participant. */
function captureSessionRestartOperatorSource(
  operation: ReplyOperation,
): QueuedOperatorRecoverySource | undefined {
  try {
    const requester = operation.personalToolParticipants?.resolve(undefined, {
      allowTurnOwner: () => true,
    });
    if (requester) {
      return captureQueuedOperatorRecoverySource(requester.operatorAuthority);
    }
    const claim = getSessionControllerEntryForOperation(operation).mailbox?.claim;
    const sources =
      claim?.operation === operation && !claim.released && !claim.releaseRequested
        ? claim.sources
        : [];
    return sources.length > 1
      ? { kind: "unavailable" }
      : captureQueuedOperatorRecoverySource(sources[0]?.operatorAuthority);
  } catch {
    // A failed known source cannot fall back to the session principal.
    return { kind: "unavailable" };
  }
}

export type SessionIdentity = {
  agentId: string;
  sessionKey: string;
  storePath: string;
  sessionId?: string;
  needsResume: boolean;
  scheduledAutomation?: boolean;
  parked?: boolean;
  directChat?: boolean;
  operatorSource?: NonNullable<InternalSessionEntry["resumeAfterRestart"]>["operatorSource"];
};

/** Select live work by its execution owner before shutdown aborts those owners. */
export async function selectLiveRestartResumeSessions(
  cfg: OpenClawConfig,
  summary: ReturnType<typeof createRestartResumeSummary>,
): Promise<Map<string, SessionIdentity>> {
  const sessions = new Map<string, SessionIdentity>();
  const chatRoots = new Set<string>();
  const inputs: Array<Partial<SessionIdentity> & { sessionKey: string }> = [];
  const add = (input: (typeof inputs)[number]) => inputs.push(input);
  const select = async (input: (typeof inputs)[number]) => {
    const inputAgentId =
      input.agentId ??
      parseAgentSessionKey(input.sessionKey)?.agentId ??
      resolveDefaultAgentId(cfg);
    const start = {
      agentId: inputAgentId,
      sessionKey: input.sessionKey,
      storePath: await preparePhysicalSessionStorePath(
        { agentId: inputAgentId, sessionKey: input.sessionKey, storePath: input.storePath },
        cfg,
      ),
    };
    const root =
      input.parked || input.directChat
        ? start
        : await resolveRootSubagentRequester(start, cfg, chatRoots);
    const { agentId, storePath } = root;
    const skip =
      (resolveExplicitIncognitoAgentSqliteTarget(storePath, { agentId })
        ? "incognito"
        : undefined) ?? restartResumeSkipReason(root.sessionKey);
    if (skip && !(skip === "subagent" && input.parked)) {
      summary.record(agentId, root.sessionKey, skip);
      return;
    }
    const key = restartSessionOwnerKey(root);
    if (input.directChat) {
      chatRoots.add(key);
    }
    const existing = sessions.get(key);
    if (!existing) {
      summary.record(agentId, root.sessionKey, "persistence-incomplete");
      sessions.set(key, {
        agentId,
        storePath,
        sessionKey: root.sessionKey,
        sessionId: root === start ? input.sessionId : undefined,
        needsResume: input.needsResume !== false,
        scheduledAutomation: root === start && input.scheduledAutomation,
        parked: input.parked,
        directChat: input.directChat,
        operatorSource: root === start ? input.operatorSource : undefined,
      });
    } else {
      existing.scheduledAutomation ||= root === start && input.scheduledAutomation;
      existing.needsResume =
        !existing.scheduledAutomation &&
        (existing.needsResume || (!input.parked && input.needsResume !== false));
      if (root === start) {
        existing.sessionId ??= input.sessionId;
        existing.operatorSource ??= input.operatorSource;
      }
    }
  };
  for (const operation of activeSessionOperations()) {
    const restartAborted = isAgentRunRestartAbortReason(operation.abortSignal.reason);
    if (operation.abortSignal.aborted && !restartAborted) {
      summary.record(
        operation.agentId ??
          parseAgentSessionKey(operation.key)?.agentId ??
          resolveDefaultAgentId(cfg),
        operation.key,
        "already-aborted",
      );
      continue;
    }
    const { target, mailbox } = getSessionControllerEntryForOperation(operation);
    const claim = mailbox?.claim?.operation === operation ? mailbox.claim : undefined;
    const input = claim?.inputs[0];
    const source = claim?.sources[0]?.run;
    const provenance = source?.inputProvenance;
    // A new chat input owns its turn, even if the dashboard was originally a child.
    // A steer into a delegated operation is not its originating input.
    const directChat =
      parseAgentSessionKey(operation.key)?.rest.startsWith("dashboard:") &&
      ((input?.protocolRunId &&
        getRpcSourceForSignal(input.protocolRunId, input.abortSignal)?.adapter.kind ===
          "chat-send" &&
        (!provenance || provenance.kind === "external_user")) ||
        (source?.internalEventExecution &&
          provenance?.kind === "internal_system" &&
          provenance.sourceTool === "restart"));
    // Cron owns interrupted occurrences, including those targeting an ordinary conversation.
    let scheduledAutomation = claim?.sources.some((item) => item.run.scheduledAutomation);
    if (scheduledAutomation) {
      for (const runId of getOperationBackendRunIds(operation) ?? []) {
        if (getAgentRunContext(runId)?.acceptedUserReply) {
          scheduledAutomation = false;
          break;
        }
      }
    }
    add({
      sessionKey: operation.key,
      agentId: operation.agentId,
      sessionId: operation.sessionId,
      storePath: target?.physicalStorePath ?? target?.storeScope,
      operatorSource: captureSessionRestartOperatorSource(operation),
      directChat: Boolean(directChat),
      scheduledAutomation,
      // Completed replies can retain execution custody only to settle workspace uploads.
      needsResume:
        !scheduledAutomation &&
        (!operation.result || restartAborted) &&
        !hasCommittedReplyOperationOutcome(operation),
    });
  }
  for (const runId of listLiveAgentRunIds()) {
    if (!hasAgentRunContextExecutionOwner(runId)) {
      continue;
    }
    const operation = findSessionControllerOperationByRunId(runId);
    if (operation) {
      continue;
    }
    const run = getAgentRunContext(runId);
    if (run?.sessionKey && (!run.cronRunsByJobId?.size || run.acceptedUserReply)) {
      add({ sessionKey: run.sessionKey, agentId: run.agentId, sessionId: run.sessionId });
    }
  }
  inputs.push(...listLiveSubagentSessions(), ...listYieldWaitingSessions());
  // Register independent owners with their original custody before resolving delegated edges.
  for (const input of inputs.toSorted(
    (a, b) => Number(Boolean(b.directChat)) - Number(Boolean(a.directChat)),
  )) {
    await select(input).catch((error: unknown) => {
      subagentRegistryLog.warn("failed to resolve live subagent restart ancestry", {
        sessionKey: input.sessionKey,
        error,
      });
    });
  }
  return sessions;
}
