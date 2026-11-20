import { resolveDefaultAgentId } from "../agents/agent-scope-config.js";
import { isAgentRunRestartAbortReason } from "../agents/run-termination.js";
import { subagentRegistryLog } from "../agents/subagents/registry/subagent-registry-lifecycle-log.js";
import {
  listLiveSubagentRootSessions,
  listYieldWaitingSessions,
  resolveRootSubagentRequester,
} from "../agents/subagents/registry/subagent-registry-read.js";
import { resolveSessionStorePathCore } from "../config/sessions/paths.js";
import { restartResumeSkipReason } from "../config/sessions/session-run-lifecycle-projection.js";
import type { InternalSessionEntry } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  getAgentRunContext,
  hasAgentRunContextExecutionOwner,
  listLiveAgentRunIds,
} from "../infra/agent-run-registry.js";
import { parseAgentSessionKey } from "../routing/session-key.js";
import { getSessionControllerEntryForOperation } from "../sessions/session-controller.identity.js";
import { findSessionControllerOperationByRunId } from "../sessions/session-controller.queries.js";
import {
  activeSessionOperations,
  getOperationBackendRunIds,
  hasCommittedReplyOperationOutcome,
} from "../sessions/session-controller.state.js";
import { resolveExplicitIncognitoAgentSqliteTarget } from "../state/openclaw-agent-db.paths.js";
import type { createRestartResumeSummary } from "./session-restart-resume-log.js";
import { captureSessionRestartOperatorSource } from "./session-system-turn-authority.js";

export type SessionIdentity = {
  agentId: string;
  sessionKey: string;
  storePath: string;
  sessionId?: string;
  needsResume: boolean;
  scheduledAutomation?: boolean;
  parked?: boolean;
  operatorSource?: NonNullable<InternalSessionEntry["resumeAfterRestart"]>["operatorSource"];
};

/** Select live work by its execution owner before shutdown aborts those owners. */
export async function selectLiveRestartResumeSessions(
  cfg: OpenClawConfig,
  summary: ReturnType<typeof createRestartResumeSummary>,
): Promise<Map<string, SessionIdentity>> {
  const sessions = new Map<string, SessionIdentity>();
  const inputs: Array<Partial<SessionIdentity> & { sessionKey: string }> = [];
  const add = (input: (typeof inputs)[number]) => inputs.push(input);
  const select = async (input: (typeof inputs)[number]) => {
    const root = input.parked
      ? input
      : await resolveRootSubagentRequester(input.sessionKey, input.agentId).catch(
          (error: unknown) => {
            subagentRegistryLog.warn("failed to resolve live subagent restart ancestry", {
              sessionKey: input.sessionKey,
              error,
            });
            return undefined;
          },
        );
    if (!root) {
      return;
    }
    const agentId =
      root.agentId ?? parseAgentSessionKey(root.sessionKey)?.agentId ?? resolveDefaultAgentId(cfg);
    const storePath =
      root.storePath ??
      (root.sessionKey === input.sessionKey ? input.storePath : undefined) ??
      resolveSessionStorePathCore(cfg.session?.store, { agentId });
    const skip =
      (resolveExplicitIncognitoAgentSqliteTarget(storePath, { agentId })
        ? "incognito"
        : undefined) ?? restartResumeSkipReason(root.sessionKey);
    if (skip && !(skip === "subagent" && input.parked)) {
      summary.record(agentId, root.sessionKey, skip);
      return;
    }
    const key = JSON.stringify([agentId, root.sessionKey]);
    const existing = sessions.get(key);
    if (!existing) {
      summary.record(agentId, root.sessionKey, "persistence-incomplete");
      sessions.set(key, {
        agentId,
        storePath,
        sessionKey: root.sessionKey,
        sessionId: root.sessionKey === input.sessionKey ? input.sessionId : undefined,
        needsResume: input.needsResume !== false,
        scheduledAutomation: root.sessionKey === input.sessionKey && input.scheduledAutomation,
        parked: input.parked,
        operatorSource: root.sessionKey === input.sessionKey ? input.operatorSource : undefined,
      });
    } else {
      existing.scheduledAutomation ||=
        root.sessionKey === input.sessionKey && input.scheduledAutomation;
      existing.needsResume =
        !existing.scheduledAutomation &&
        (existing.needsResume || (!input.parked && input.needsResume !== false));
      if (root.sessionKey === input.sessionKey && input.operatorSource) {
        existing.operatorSource = input.operatorSource;
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
    // Cron owns interrupted occurrences, including those targeting an ordinary conversation.
    let scheduledAutomation =
      mailbox?.claim?.operation === operation &&
      mailbox.claim.sources.some((source) => source.run.scheduledAutomation);
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
  const roots = listLiveSubagentRootSessions();
  const waiting = [...listYieldWaitingSessions()];
  for (const root of await roots) {
    add(root);
  }
  for (const session of waiting) {
    add(session);
  }
  for (const input of inputs) {
    await select(input);
  }
  return sessions;
}
