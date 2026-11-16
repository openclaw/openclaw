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
 *   (the "hollow wait" failure mode) does not count. The run must also owe
 *   its requester a completion (`expectsCompletionMessage`), and must not
 *   already be owned by detached lifecycle typing (`startSubagentTyping`).
 * - Cron/automation wake: `GatewayCronServiceContract.list()` (src/cron/
 *   service-contract.ts), filtered to jobs that are running now or whose
 *   `state.nextRunAtMs` is imminent, resolved to session keys via
 *   `resolveCronJobSessionBindings` (src/cron/job-session-bindings.ts).
 */
import { resolveAgentConfig } from "../agents/agent-scope-config.js";
import { subagentRuns } from "../agents/subagents/registry/subagent-registry-memory.js";
import { resolveSubagentLifecycleTypingOwner } from "../agents/subagents/registry/subagent-registry-typing-owner.js";
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

/** How far ahead a scheduled fire counts as "about to happen". A daily or
 * weekly job is idle between fires, not working; only the last stretch
 * before a fire (a few indicator polls) is worth signalling. */
const CRON_WAKE_IMMINENT_WINDOW_MS = 60_000;

/** Session (requester) keys with a live subagent run their parent is genuinely awaiting. */
export function listArmedSubagentWaitSessionKeys(): string[] {
  const keys = new Set<string>();
  for (const entry of subagentRuns.values()) {
    const requesterSessionKey = entry.requesterSessionKey?.trim();
    if (
      requesterSessionKey &&
      // A run that owes its requester nothing (e.g. a plugin child registered
      // without a requester) is not something that session is waiting on.
      entry.expectsCompletionMessage === true &&
      isSubagentRunLive(entry) &&
      // Detached lifecycle typing already owns this run's signal, with its own
      // requester/route currency checks. Never run a second keepalive beside it.
      !resolveSubagentLifecycleTypingOwner(entry)
    ) {
      keys.add(requesterSessionKey);
    }
  }
  return [...keys];
}

function hasArmedCronWake(job: Pick<CronJob, "state">, now: number): boolean {
  if (typeof job.state.runningAtMs === "number") {
    return true;
  }
  const nextRunAtMs = job.state.nextRunAtMs;
  return (
    typeof nextRunAtMs === "number" &&
    nextRunAtMs >= now - CRON_WAKE_PAST_DUE_GRACE_MS &&
    nextRunAtMs <= now + CRON_WAKE_IMMINENT_WINDOW_MS
  );
}

/** Session keys bound to an enabled automation/cron job that is running or about to fire. */
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
