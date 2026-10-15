import { readLatestAssistantReply, waitForAgentRunsToDrain } from "../../agents/run-wait.js";
import { resolveSubagentCompletionResultText } from "../../agents/subagents/completion/subagent-completion-result.js";
import type { SubagentRunRecord } from "../../agents/subagents/registry/subagent-registry.types.js";
import { isRetainedUnendedSubagentRun } from "../../agents/subagents/registry/subagent-run-liveness.js";
import { bindAgentToolGatewayRequest } from "../../agents/tools/in-process-gateway.js";
import { selectDeliverableSessionsReply } from "../../agents/tools/sessions-send-tokens.js";
import { isSilentReplyPayloadText, SILENT_REPLY_TOKEN } from "../../auto-reply/tokens.js";
import { sleepWithAbort } from "../../infra/backoff.js";
import { isFastTestRuntimeEnv } from "../../infra/env.js";
import { hasUnsettledCronDescendants } from "./delivery-subagent-registry.runtime.js";
import { listDescendantRunsForRequester } from "./run-subagent-registry.runtime.js";
import { isLikelyInterimCronMessage } from "./subagent-followup-hints.js";

export async function readDescendantSubagentFallbackReply(params: {
  sessionKey: string;
  runStartedAt: number;
}): Promise<string | undefined> {
  const descendants = (await listDescendantRunsForRequester(params.sessionKey)).filter(
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
  return replies.length ? replies.join("\n\n") : undefined;
}

/**
 * Settles a spawn-only handoff on its descendants' own results. Nothing resumes a cron
 * parent that only handed off (#135318), so there is no parent synthesis to wait for.
 * Undefined when descendants did not settle in time; explicit child silence settles as
 * SILENT_REPLY_TOKEN.
 */
export async function waitForDescendantSubagentResult(params: {
  sessionKey: string;
  runStartedAt: number;
  timeoutMs: number;
  abortSignal?: AbortSignal;
}): Promise<{ reply?: string } | undefined> {
  await waitForDescendantSubagentSummary({
    ...params,
    observedActiveDescendants: true,
    awaitParentSynthesis: false,
  });
  if (params.abortSignal?.aborted || (await hasUnsettledCronDescendants(params.sessionKey))) {
    return undefined;
  }
  const reply = await readDescendantSubagentFallbackReply(params);
  if (reply) {
    return { reply };
  }
  const ended = (await listDescendantRunsForRequester(params.sessionKey)).filter(
    (entry) =>
      typeof entry.execution.endedAt === "number" && entry.execution.endedAt >= params.runStartedAt,
  );
  const silent =
    ended.length > 0 &&
    ended.every(
      (entry) =>
        entry.execution.outcome?.status === "ok" &&
        entry.completion?.terminalReply?.disposition === "silent",
    );
  return { reply: silent ? SILENT_REPLY_TOKEN : undefined };
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
  /** False when nothing will resume the parent, so settlement is final. */
  awaitParentSynthesis?: boolean;
  abortSignal?: AbortSignal;
}): Promise<string | undefined> {
  const fastTestMode = isFastTestRuntimeEnv();
  const timings = {
    waitMinMs: fastTestMode ? 10 : 30_000,
    finalReplyGraceMs: fastTestMode ? 50 : 5_000,
    gracePollMs: fastTestMode ? 8 : 200,
  };
  const requestGateway = bindAgentToolGatewayRequest({ hostedOnly: true });
  const initialReply = params.initialReply?.trim();
  const deadline = Date.now() + Math.max(timings.waitMinMs, Math.floor(params.timeoutMs));

  const callGateway: typeof requestGateway = (request) =>
    requestGateway({
      ...request,
      signal: params.abortSignal,
      timeoutMs: Math.min(request.timeoutMs ?? Infinity, Math.max(1, deadline - Date.now())),
    });

  const getActiveRuns = async () => {
    if (params.abortSignal?.aborted) {
      return [];
    }
    const runs = await listDescendantRunsForRequester(params.sessionKey);
    return params.abortSignal?.aborted
      ? []
      : runs.filter((entry) => isRetainedUnendedSubagentRun(entry));
  };
  let initialActiveRuns: SubagentRunRecord[];
  let sawPendingDescendants: boolean;
  try {
    initialActiveRuns = await getActiveRuns();
    if (params.abortSignal?.aborted) {
      return undefined;
    }
    sawPendingDescendants =
      params.observedActiveDescendants === true ||
      initialActiveRuns.length > 0 ||
      (await hasUnsettledCronDescendants(params.sessionKey));
  } catch (error) {
    if (params.abortSignal?.aborted) {
      return undefined;
    }
    throw error;
  }

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
        getPendingRunIds: async () => (await getActiveRuns()).map((entry) => entry.runId),
      });
      if (!(await hasUnsettledCronDescendants(params.sessionKey))) {
        break;
      }
      // A yielded task still owns completion while no execution can be waited
      // on. Observe the registry's handoff without waking a competing parent.
      await sleepWithAbort(
        Math.min(timings.gracePollMs, Math.max(0, deadline - Date.now())),
        params.abortSignal,
      );
      pendingRunIds = (await getActiveRuns()).map((entry) => entry.runId);
    }
    if (
      params.abortSignal?.aborted ||
      (await hasUnsettledCronDescendants(params.sessionKey)) ||
      params.awaitParentSynthesis === false
    ) {
      return undefined;
    }

    // Give the parent a bounded window to synthesize the settled descendants.
    const gracePeriodDeadline = Math.min(Date.now() + timings.finalReplyGraceMs, deadline);

    const resolveUsableLatestReply = async () => {
      const latest = (
        await readLatestAssistantReply({ sessionKey: params.sessionKey, callGateway })
      )?.trim();
      if (
        latest &&
        !isSilentReplyPayloadText(latest) &&
        (latest !== initialParentReply || !isLikelyInterimCronMessage(latest))
      ) {
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

    return await resolveUsableLatestReply();
  } catch (error) {
    if (params.abortSignal?.aborted || Date.now() >= deadline) {
      return undefined;
    }
    throw error;
  }
}
