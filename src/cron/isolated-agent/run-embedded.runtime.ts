import { createCommandCompactionAccounting } from "../../agents/command/compaction-accounting.js";
import type { CompactionAccountingFact } from "../../agents/embedded-agent-runner/run/internal-params.js";
import { runEmbeddedAgent } from "../../agents/embedded-agent.js";
import { logWarn } from "../../logger.js";
import { captureReplyMessageJoinObservation } from "../../sessions/session-controller.message-join-observation.js";
import { resolveIsolatedCronPromptCacheKey } from "./prompt-cache-key.js";
import type { CronRunExecutionParams } from "./run-execution.types.js";

/** Keep cron execution observations on the runner's private writer, including failed candidates. */
export async function runCronEmbeddedAgent(
  params: Parameters<typeof runEmbeddedAgent>[0] & {
    sessionKey: string;
    provider: string;
    model: string;
  },
  context: Pick<CronRunExecutionParams, "job" | "agentId" | "agentSessionKey" | "cronSession">,
  observeContextSnapshot: (snapshot: CompactionAccountingFact["currentContextSnapshot"]) => void,
) {
  const sessionEntry = context.cronSession.sessionEntry;
  const accounting = createCommandCompactionAccounting({
    persistCounts: true,
    onDurableFact: () => {},
    refreshSessionEntry: () => {},
  });
  const candidate = accounting.beginCandidate(params.abortSignal);
  params.promptCacheKey = resolveIsolatedCronPromptCacheKey({
    job: context.job,
    agentId: context.agentId,
    agentSessionKey: context.agentSessionKey,
    provider: params.provider,
    model: params.model,
  });
  params.onCompactionAccounting = candidate.observe;
  params.joinObservation = captureReplyMessageJoinObservation({
    run: { ...params, sessionFile: params.sessionKey },
    sessionEntry,
  });
  try {
    return await runEmbeddedAgent(params);
  } finally {
    await candidate.finish(sessionEntry).catch((error: unknown) => {
      logWarn(`cron compaction accounting failed: ${String(error)}`);
    });
    observeContextSnapshot(accounting.fact?.currentContextSnapshot);
  }
}
