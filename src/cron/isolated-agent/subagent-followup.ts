/** Reads or waits for descendant subagent summaries after isolated cron orchestration. */
import { readLatestAssistantReply, waitForAgentRunsToDrain } from "../../agents/run-wait.js";
import { resolveSubagentCompletionResultText } from "../../agents/subagents/completion/subagent-completion-result.js";
import {
  hasDescendantRunAwaitingSettle,
  listDescendantRunsForRequester,
} from "../../agents/subagents/registry/subagent-registry-read.js";
import { isRetainedUnendedSubagentRun } from "../../agents/subagents/registry/subagent-run-liveness.js";
import { bindAgentToolGatewayRequest } from "../../agents/tools/in-process-gateway.js";
import { selectDeliverableSessionsReply } from "../../agents/tools/sessions-send-tokens.js";
import { stripHeartbeatToken } from "../../auto-reply/heartbeat.js";
import {
  HEARTBEAT_TOKEN,
  isSilentReplyPayloadText,
  SILENT_REPLY_TOKEN,
} from "../../auto-reply/tokens.js";
import { sleepWithAbort } from "../../infra/backoff.js";
import { isFastTestRuntimeEnv } from "../../infra/env.js";
import { isLikelyInterimCronMessage } from "./subagent-followup-hints.js";

function resolveCronSubagentTimings() {
  const fastTestMode = isFastTestRuntimeEnv();
  return {
    waitMinMs: fastTestMode ? 10 : 30_000,
    finalReplyGraceMs: fastTestMode ? 50 : 5_000,
    gracePollMs: fastTestMode ? 8 : 200,
  };
}

/** Reads completed descendant subagent replies when the orchestrator only emitted interim text. */
export async function readDescendantSubagentFallbackReply(params: {
  sessionKey: string;
  runStartedAt: number;
}): Promise<string | undefined> {
  const descendants = listDescendantRunsForRequester(params.sessionKey).filter(
    (entry) =>
      typeof entry.execution.endedAt === "number" &&
      entry.execution.endedAt >= params.runStartedAt &&
      entry.childSessionKey.trim().length > 0,
  );
  if (descendants.length === 0) {
    return undefined;
  }

  const callGateway = bindAgentToolGatewayRequest({ hostedOnly: true });
  const replies: string[] = [];
  // Limit fallback synthesis to the latest few children so a noisy run does not
  // flood the cron announce with stale descendant output.
  const latestRuns = descendants
    .toSorted((a, b) => (a.execution.endedAt ?? 0) - (b.execution.endedAt ?? 0))
    .slice(-4);
  for (const entry of latestRuns) {
    const completionReply = resolveSubagentCompletionResultText(entry);
    // Producer-owned terminal evidence and private resume transcripts must
    // never be replaced by an older visible child-session reply.
    const canReadTranscript =
      entry.completion?.terminalReply === undefined &&
      entry.execution.transcriptTarget === undefined;
    const reply = canReadTranscript
      ? selectDeliverableSessionsReply(
          await readLatestAssistantReply({ sessionKey: entry.childSessionKey, callGateway }),
          completionReply,
        )
      : completionReply;
    if (!reply || reply.toUpperCase() === SILENT_REPLY_TOKEN.toUpperCase()) {
      continue;
    }
    replies.push(reply);
  }
  if (replies.length === 0) {
    return undefined;
  }
  if (replies.length === 1) {
    return replies[0];
  }
  return replies.join("\n\n");
}

/**
 * Waits for descendant subagents to complete using a push-based approach:
 * running descendants use `agent.wait`; registry settlement spans yielded
 * tasks, successor admission, and completion delivery between executions.
 * Only after settlement does the synthesis grace period begin.
 */
export async function waitForDescendantSubagentSummary(params: {
  sessionKey: string;
  initialReply?: string;
  timeoutMs: number;
  observedActiveDescendants?: boolean;
  abortSignal?: AbortSignal;
}): Promise<string | undefined> {
  const timings = resolveCronSubagentTimings();
  const requestGateway = bindAgentToolGatewayRequest({ hostedOnly: true });
  const initialReply = params.initialReply?.trim();
  const deadline = Date.now() + Math.max(timings.waitMinMs, Math.floor(params.timeoutMs));

  const callGateway: typeof requestGateway = (request) =>
    requestGateway({
      ...request,
      signal: params.abortSignal,
      timeoutMs: Math.min(request.timeoutMs ?? Infinity, Math.max(1, deadline - Date.now())),
    });

  const getActiveRuns = () =>
    params.abortSignal?.aborted
      ? []
      : listDescendantRunsForRequester(params.sessionKey).filter((entry) =>
          isRetainedUnendedSubagentRun(entry),
        );
  const initialActiveRuns = getActiveRuns();
  const sawPendingDescendants =
    params.observedActiveDescendants === true ||
    initialActiveRuns.length > 0 ||
    hasDescendantRunAwaitingSettle(params.sessionKey);

  if (params.abortSignal?.aborted) {
    return undefined;
  }
  if (!sawPendingDescendants) {
    return initialReply;
  }

  try {
    // Delivery text has already lost MEDIA directives. Compare history against
    // its own text so the unchanged parent cannot masquerade as new synthesis.
    const initialParentReply = (
      await readLatestAssistantReply({ sessionKey: params.sessionKey, callGateway })
    )?.trim();
    let pendingRunIds = initialActiveRuns.map((entry) => entry.runId);
    while (Date.now() < deadline && !params.abortSignal?.aborted) {
      await waitForAgentRunsToDrain({
        deadlineAtMs: deadline,
        callGateway,
        initialPendingRunIds: pendingRunIds,
        getPendingRunIds: () => getActiveRuns().map((entry) => entry.runId),
      });
      if (!hasDescendantRunAwaitingSettle(params.sessionKey)) {
        break;
      }
      // A yielded task still owns completion while no execution can be waited
      // on. Observe the registry's handoff without waking a competing parent.
      await sleepWithAbort(
        Math.min(timings.gracePollMs, Math.max(0, deadline - Date.now())),
        params.abortSignal,
      );
      pendingRunIds = getActiveRuns().map((entry) => entry.runId);
    }
    if (params.abortSignal?.aborted || hasDescendantRunAwaitingSettle(params.sessionKey)) {
      return undefined;
    }

    // --- Grace period: wait for the cron agent's synthesis ---
    // After the subagent announces fire and the cron agent processes them, it
    // produces a new assistant message.  Poll briefly (bounded by
    // finalReplyGraceMs) to capture that synthesis.
    const gracePeriodDeadline = Math.min(Date.now() + timings.finalReplyGraceMs, deadline);

    const resolveUsableLatestReply = async () => {
      const latest = (
        await readLatestAssistantReply({ sessionKey: params.sessionKey, callGateway })
      )?.trim();
      if (
        latest &&
        latest.toUpperCase() !== SILENT_REPLY_TOKEN.toUpperCase() &&
        // Parent heartbeat acknowledgments remain in chat.history after the
        // child settles and must not masquerade as descendant output.
        !stripHeartbeatToken(latest, { mode: "heartbeat", maxAckChars: 0 }).shouldSkip &&
        !isSilentReplyPayloadText(latest, HEARTBEAT_TOKEN) &&
        (latest !== initialParentReply || !isLikelyInterimCronMessage(latest))
      ) {
        // Ignore the original interim acknowledgement; only a new synthesis or a
        // non-interim reply should replace descendant fallback text.
        return latest;
      }
      return undefined;
    };

    while (Date.now() < gracePeriodDeadline) {
      const latest = await resolveUsableLatestReply();
      if (latest) {
        return latest;
      }
      await sleepWithAbort(
        Math.min(timings.gracePollMs, gracePeriodDeadline - Date.now()),
        params.abortSignal,
      );
    }

    // Final read after grace period expires.
    const latest = await resolveUsableLatestReply();
    if (latest) {
      return latest;
    }

    return undefined;
  } catch (error) {
    if (params.abortSignal?.aborted || Date.now() >= deadline) {
      return undefined;
    }
    throw error;
  }
}
