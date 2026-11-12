/**
 * Production wiring for `createBackgroundActivityIndicator`'s two "armed
 * background work" sources, plus the channel-resolution target adapter.
 *
 * Each source maps directly onto a real, currently-tracked gateway state --
 * never a self-report -- so a session only lights up when there is a
 * genuine mechanism that will bring it back:
 *
 * - Subagent wait: `subagentRuns` (src/agents/subagents/registry/
 *   subagent-registry-memory.ts), filtered by `isSubagentRunLive` (src/
 *   agents/subagents/registry/subagent-run-liveness.ts), which requires
 *   both an open execution (`endedAt` unset) *and* a live, currently
 *   registered `agent-run-registry` context/owner/lease for that exact
 *   run's `lifecycleGeneration` -- so an orphaned or merely-claimed wait
 *   (the "hollow wait" failure mode) does not count.
 * - Cron/automation wake: `GatewayCronServiceContract.list()` (src/cron/
 *   service-contract.ts), filtered to jobs with a defined, not-too-stale
 *   `state.nextRunAtMs`, resolved to session keys via
 *   `resolveCronJobSessionBindings` (src/cron/job-session-bindings.ts).
 */
import { resolveAgentConfig } from "../agents/agent-scope-config.js";
import { subagentRuns } from "../agents/subagents/registry/subagent-registry-memory.js";
import { isSubagentRunLive } from "../agents/subagents/registry/subagent-run-liveness.js";
import { extractDeliveryInfo } from "../config/sessions/delivery-info.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveCronJobSessionBindings } from "../cron/job-session-bindings.js";
import type { CronJob } from "../cron/types.js";
import type { GatewayCronServiceContract } from "../gateway/server-cron-contract.js";
import { resolveSessionStoreIdentity } from "../gateway/session-store-key.js";

/** A job whose next fire slipped into the very recent past still counts as
 * "armed": the scheduler tick that advances `nextRunAtMs` past the fire it
 * just triggered can lag the fire itself by a few seconds. */
const CRON_WAKE_PAST_DUE_GRACE_MS = 30_000;

/** Session (requester) keys with a live subagent run their parent is genuinely awaiting. */
export function listArmedSubagentWaitSessionKeys(): string[] {
  const keys = new Set<string>();
  for (const entry of subagentRuns.values()) {
    const requesterSessionKey = entry.requesterSessionKey?.trim();
    if (requesterSessionKey && isSubagentRunLive(entry)) {
      keys.add(requesterSessionKey);
    }
  }
  return [...keys];
}

function hasArmedCronWake(job: Pick<CronJob, "state">, now: number): boolean {
  const nextRunAtMs = job.state.nextRunAtMs;
  return typeof nextRunAtMs === "number" && nextRunAtMs >= now - CRON_WAKE_PAST_DUE_GRACE_MS;
}

/** Session keys bound to an enabled automation/cron job with a pending scheduled fire. */
export async function listArmedCronWakeSessionKeys(params: {
  cron: Pick<GatewayCronServiceContract, "list" | "getDefaultAgentId">;
  cfg: OpenClawConfig;
  now?: number;
}): Promise<string[]> {
  // `list()` with no opts already restricts to enabled jobs (see isJobEnabled
  // in src/cron/service/jobs-scheduling.ts via src/cron/service/ops-read.ts).
  const jobs = await params.cron.list();
  const defaultAgentId = params.cron.getDefaultAgentId();
  const now = params.now ?? Date.now();
  const keys = new Set<string>();
  for (const job of jobs) {
    if (!hasArmedCronWake(job, now)) {
      continue;
    }
    for (const sessionKey of resolveCronJobSessionBindings(job, {
      cfg: params.cfg,
      defaultAgentId,
    }).keys()) {
      keys.add(sessionKey);
    }
  }
  return [...keys];
}

/** Resolves a session's current routable channel delivery target, if any. */
export async function resolveBackgroundActivitySessionDelivery(
  sessionKey: string,
  cfg: OpenClawConfig,
) {
  return (await extractDeliveryInfo(sessionKey, { cfg })).deliveryContext;
}

/** Honors the same per-agent/global `typingMode: "never"` opt-out the turn-bound
 * and lifecycle typing paths already respect. */
export function isBackgroundActivityTypingEnabled(
  sessionKey: string,
  cfg: OpenClawConfig,
): boolean {
  const { agentId } = resolveSessionStoreIdentity({ cfg, sessionKey });
  const typingMode =
    resolveAgentConfig(cfg, agentId)?.typingMode ?? cfg.agents?.defaults?.typingMode;
  return typingMode !== "never";
}

/** The configured typing keepalive cadence, when one is set. */
export function resolveBackgroundActivityTypingIntervalSeconds(
  cfg: OpenClawConfig,
): number | undefined {
  const configured = cfg.agents?.defaults?.typingIntervalSeconds;
  return typeof configured === "number" && configured > 0 ? configured : undefined;
}
