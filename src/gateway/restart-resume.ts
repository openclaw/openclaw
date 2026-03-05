import type { CliDeps } from "../cli/deps.js";
import { agentCommandFromIngress } from "../commands/agent.js";
import type { OpenClawConfig } from "../config/config.js";
import { type RestartSentinel, readRestartSentinel } from "../infra/restart-sentinel.js";
import type { RuntimeEnv } from "../runtime.js";
import {
  ensureInflightAgentRunLifecycleCleanerStarted,
  listInflightAgentRuns,
  markInflightAgentRunResumed,
} from "./inflight-agent-runs.js";

const DEFAULT_RESUME_PROMPT =
  "Continue where you left off. The OpenClaw gateway restarted while you were running.";

export async function maybeResumeInflightAgentRunsAfterRestart(params: {
  cfg: OpenClawConfig;
  deps: CliDeps;
  runtime: RuntimeEnv;
  env?: NodeJS.ProcessEnv;
  /**
   * Optional pre-read sentinel snapshot.
   * This avoids races with other startup code that consumes the sentinel.
   */
  sentinel?: RestartSentinel | null;
  /**
   * If provided and returns >0, resumption will be skipped to reduce duplicate
   * work during in-process restarts where older runs may still be active.
   */
  getActiveRunCount?: () => number;
  runAgent?: typeof agentCommandFromIngress;
}): Promise<{ resumed: number; considered: number; skipped: boolean }> {
  const enabled = params.cfg.gateway?.restartRecovery?.resumeInflightAgentRuns === true;
  if (!enabled) {
    return { resumed: 0, considered: 0, skipped: true };
  }

  const env = params.env ?? process.env;
  const sentinel = params.sentinel ?? (await readRestartSentinel(env).catch(() => null));
  if (!sentinel || sentinel.payload?.kind !== "restart") {
    return { resumed: 0, considered: 0, skipped: true };
  }

  const active = params.getActiveRunCount?.() ?? 0;
  if (active > 0) {
    return { resumed: 0, considered: 0, skipped: true };
  }

  ensureInflightAgentRunLifecycleCleanerStarted(env);
  const inflight = await listInflightAgentRuns(env);
  const run = params.runAgent ?? agentCommandFromIngress;

  let resumed = 0;
  for (const entry of inflight) {
    const runId = entry.runId?.trim();
    if (!runId) {
      continue;
    }
    const baseOpts = entry.opts;
    // Force idempotency key stability and avoid re-playing the original prompt.
    // The resumed run uses the existing session transcript as context.
    const resumeOpts = {
      ...baseOpts,
      runId,
      message: DEFAULT_RESUME_PROMPT,
      senderIsOwner: baseOpts.senderIsOwner,
    };
    await markInflightAgentRunResumed(runId, env).catch(() => {});
    void run(resumeOpts, params.runtime, params.deps).catch(() => {});
    resumed += 1;
  }

  return { resumed, considered: inflight.length, skipped: false };
}
