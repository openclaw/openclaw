import type { CliDeps } from "../cli/deps.js";
import { agentCommandFromIngress } from "../commands/agent.js";
import type { OpenClawConfig } from "../config/config.js";
import { logVerbose } from "../globals.js";
import { type RestartSentinel, readRestartSentinel } from "../infra/restart-sentinel.js";
import type { RuntimeEnv } from "../runtime.js";
import {
  clearInflightAgentRuns,
  ensureInflightAgentRunLifecycleCleanerStarted,
  isInflightAgentRunRecoveryEnabled,
  listInflightAgentRuns,
  markInflightAgentRunsResumed,
} from "./inflight-agent-runs.js";

const DEFAULT_RESUME_PROMPT =
  "Continue where you left off. The OpenClaw gateway restarted while you were running.";
const MAX_RESUME_ATTEMPTS = 10;
// Skip records older than 10 minutes — stale runs are unlikely to produce
// useful continuations after such a long gap.
const MAX_AGE_MS = 10 * 60 * 1000;

function isRestartEligibleSentinel(sentinel: RestartSentinel | null | undefined): boolean {
  const payload = sentinel?.payload;
  if (!payload || payload.status !== "ok") {
    return false;
  }
  switch (payload.kind) {
    case "restart":
    case "config-apply":
    case "config-patch":
    case "update":
      return true;
    default:
      return false;
  }
}

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
  if (!isInflightAgentRunRecoveryEnabled(params.cfg)) {
    return { resumed: 0, considered: 0, skipped: true };
  }

  const env = params.env ?? process.env;
  const active = params.getActiveRunCount?.() ?? 0;
  if (active > 0) {
    return { resumed: 0, considered: 0, skipped: true };
  }

  const sentinel = params.sentinel ?? (await readRestartSentinel(env).catch(() => null));
  if (!isRestartEligibleSentinel(sentinel)) {
    // Best-effort: if the gateway started without a valid restart sentinel,
    // clear any leftover inflight records (e.g. after a hard crash) so they do
    // not get resumed on a future unrelated restart.
    await clearInflightAgentRuns(env).catch(() => {});
    return { resumed: 0, considered: 0, skipped: true };
  }

  ensureInflightAgentRunLifecycleCleanerStarted(env);
  const inflight = await listInflightAgentRuns(env);
  const run = params.runAgent ?? agentCommandFromIngress;
  const now = Date.now();

  const resumedIds: string[] = [];
  for (const entry of inflight) {
    const runId = entry.runId?.trim();
    if (!runId) {
      continue;
    }
    if ((entry.resumeCount ?? 0) >= MAX_RESUME_ATTEMPTS) {
      continue;
    }
    if (now - entry.acceptedAt > MAX_AGE_MS) {
      logVerbose(`restart recovery: skipping stale run ${runId} (age ${now - entry.acceptedAt}ms)`);
      continue;
    }
    const baseOpts = entry.opts;
    const resumeOpts = {
      ...baseOpts,
      runId,
      message: DEFAULT_RESUME_PROMPT,
    };
    void run(resumeOpts, params.runtime, params.deps).catch((err) => {
      logVerbose(`restart recovery: resumed run ${runId} failed: ${String(err)}`);
    });
    resumedIds.push(runId);
  }

  await markInflightAgentRunsResumed(resumedIds, env).catch(() => {});

  return { resumed: resumedIds.length, considered: inflight.length, skipped: false };
}
