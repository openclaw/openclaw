import fs from "node:fs/promises";

export type OagChannelHealthSummary = {
  schemaVersion?: number;
  congested: boolean;
  backloggedAfterRecovery?: boolean;
  affectedChannels: string[];
  affectedTargets?: Array<{
    channel: string;
    accountId?: string;
    sessionKeys: string[];
    pendingDeliveries?: number;
    recentFailures?: number;
  }>;
  pendingDeliveries: number;
  recentFailureCount: number;
  backlogAgeMinutes?: number;
  escalationRecommended?: boolean;
  recommendedAction?: string;
  verifyAttempts?: number;
  lastAction?: string;
  lastActionAt?: string;
  lastActionDetail?: string;
  lastVerifyAt?: string;
  lastRestartAt?: string;
  lastFailureAt?: string;
  lastRecoveredAt?: string;
  updatedAt?: string;
  sessionWatch?: {
    active: boolean;
    affectedChannels: string[];
    stateCounts?: Record<string, number>;
    escalationRecommended?: boolean;
    recommendedAction?: string;
    affectedSessions?: Array<{
      agentId?: string;
      sessionKey: string;
      sessionId?: string;
      channel?: string;
      accountId?: string;
      state?: string;
      reason?: string;
      silentMinutes?: number;
      blockedRetryCount?: number;
      escalationRecommended?: boolean;
      recommendedAction?: string;
    }>;
    lastAction?: string;
    lastActionAt?: string;
    lastActionDetail?: string;
    lastNudgeAt?: string;
    updatedAt?: string;
  };
  taskWatch?: {
    active: boolean;
    counts?: Record<string, number>;
    escalationRecommended?: boolean;
    recommendedAction?: string;
    affectedTasks?: Array<{
      taskId: string;
      followupType?: string;
      priority?: string;
      escalationCount?: number;
      currentStep?: number;
      totalSteps?: number;
      stepTitle?: string;
      progressAgeSeconds?: number;
      terminalStepStuck?: boolean;
      deferredBy?: string;
      notBefore?: string;
      message?: string;
    }>;
    updatedAt?: string;
  };
};

function getOagChannelHealthPath(): string | undefined {
  const home = process.env.HOME?.trim();
  return home ? `${home}/.openclaw/sentinel/channel-health-state.json` : undefined;
}

function readOptionalString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed || undefined;
}

type SentinelSchemaVersion = 1 | 2;

function detectSchemaVersion(parsed: Record<string, unknown>): SentinelSchemaVersion {
  if (typeof parsed.schema_version === "number" && parsed.schema_version >= 2) {
    return 2;
  }
  // Default to v1 for backward compatibility with existing sentinel producers
  return 1;
}

function parseAffectedTargetsV2(raw: unknown[]): OagChannelHealthSummary["affectedTargets"] {
  return raw
    .filter((item): item is Record<string, unknown> => Boolean(item && typeof item === "object"))
    .map((item) => ({
      channel: readOptionalString(item.channel) ?? "",
      accountId: readOptionalString(item.account_id),
      sessionKeys: (() => {
        const keys = item.session_keys;
        if (!Array.isArray(keys)) {
          return [];
        }
        return (keys as unknown[])
          .map((entry) => readOptionalString(entry))
          .filter((entry): entry is string => typeof entry === "string" && entry.length > 0);
      })(),
      pendingDeliveries:
        typeof item.pending_deliveries === "number" ? item.pending_deliveries : undefined,
      recentFailures: typeof item.recent_failures === "number" ? item.recent_failures : undefined,
    }))
    .filter((item) => item.channel.length > 0);
}

export async function readOagChannelHealthSummary(): Promise<OagChannelHealthSummary | undefined> {
  const statePath = getOagChannelHealthPath();
  if (!statePath) {
    return undefined;
  }
  try {
    const raw = await fs.readFile(statePath, "utf8");
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const schemaVersion = detectSchemaVersion(parsed);
    const affectedChannels = Array.isArray(parsed.affected_channels)
      ? parsed.affected_channels
          .map((item) => String(item).trim())
          .filter((item) => item.length > 0)
      : [];
    const affectedTargets = Array.isArray(parsed.affected_targets)
      ? schemaVersion >= 2
        ? parseAffectedTargetsV2(parsed.affected_targets)
        : // v1: dual-naming fallback for backward compatibility with existing sentinel producers
          parsed.affected_targets
            .filter((item): item is Record<string, unknown> =>
              Boolean(item && typeof item === "object"),
            )
            .map((item) => ({
              channel: readOptionalString(item.channel) ?? "",
              accountId: readOptionalString(item.account_id) ?? readOptionalString(item.accountId),
              sessionKeys: (() => {
                const raw = item.session_keys ?? item.sessionKeys;
                if (!Array.isArray(raw)) {
                  return [];
                }
                return (raw as unknown[])
                  .map((entry) => readOptionalString(entry))
                  .filter(
                    (entry): entry is string => typeof entry === "string" && entry.length > 0,
                  );
              })(),
              pendingDeliveries:
                typeof (item.pending_deliveries ?? item.pendingDeliveries) === "number"
                  ? Number(item.pending_deliveries ?? item.pendingDeliveries)
                  : undefined,
              recentFailures:
                typeof (item.recent_failures ?? item.recentFailures) === "number"
                  ? Number(item.recent_failures ?? item.recentFailures)
                  : undefined,
            }))
            .filter((item) => item.channel.length > 0)
      : [];
    const sessionWatchRaw =
      parsed.session_watch && typeof parsed.session_watch === "object"
        ? (parsed.session_watch as Record<string, unknown>)
        : undefined;
    const taskWatchRaw =
      parsed.task_watch && typeof parsed.task_watch === "object"
        ? (parsed.task_watch as Record<string, unknown>)
        : undefined;
    return {
      schemaVersion,
      congested: parsed.congested === true,
      backloggedAfterRecovery: parsed.backlogged_after_recovery === true,
      affectedChannels,
      affectedTargets,
      pendingDeliveries:
        typeof parsed.pending_deliveries === "number" ? parsed.pending_deliveries : 0,
      recentFailureCount:
        typeof parsed.recent_failure_count === "number" ? parsed.recent_failure_count : 0,
      backlogAgeMinutes:
        typeof parsed.backlog_age_minutes === "number" ? parsed.backlog_age_minutes : undefined,
      escalationRecommended: parsed.escalation_recommended === true,
      recommendedAction:
        typeof parsed.recommended_action === "string" && parsed.recommended_action.trim()
          ? parsed.recommended_action
          : undefined,
      verifyAttempts:
        typeof parsed.verify_attempts === "number" ? parsed.verify_attempts : undefined,
      lastAction:
        typeof parsed.last_action === "string" && parsed.last_action.trim()
          ? parsed.last_action
          : undefined,
      lastActionAt:
        typeof parsed.last_action_at === "string" && parsed.last_action_at.trim()
          ? parsed.last_action_at
          : undefined,
      lastActionDetail:
        typeof parsed.last_action_detail === "string" && parsed.last_action_detail.trim()
          ? parsed.last_action_detail
          : undefined,
      lastVerifyAt:
        typeof parsed.last_verify_at === "string" && parsed.last_verify_at.trim()
          ? parsed.last_verify_at
          : undefined,
      lastRestartAt:
        typeof parsed.last_restart_at === "string" && parsed.last_restart_at.trim()
          ? parsed.last_restart_at
          : undefined,
      lastFailureAt:
        typeof parsed.last_failure_at === "string" && parsed.last_failure_at.trim()
          ? parsed.last_failure_at
          : undefined,
      lastRecoveredAt:
        typeof parsed.last_recovered_at === "string" && parsed.last_recovered_at.trim()
          ? parsed.last_recovered_at
          : undefined,
      updatedAt:
        typeof parsed.updated_at === "string" && parsed.updated_at.trim()
          ? parsed.updated_at
          : undefined,
      sessionWatch: sessionWatchRaw
        ? {
            active: sessionWatchRaw.active === true,
            affectedChannels: Array.isArray(sessionWatchRaw.affected_channels)
              ? sessionWatchRaw.affected_channels
                  .map((item) => String(item).trim())
                  .filter((item) => item.length > 0)
              : [],
            stateCounts:
              sessionWatchRaw.state_counts &&
              typeof sessionWatchRaw.state_counts === "object" &&
              !Array.isArray(sessionWatchRaw.state_counts)
                ? Object.fromEntries(
                    Object.entries(sessionWatchRaw.state_counts).map(([key, value]) => [
                      key,
                      typeof value === "number" ? value : 0,
                    ]),
                  )
                : undefined,
            affectedSessions: Array.isArray(sessionWatchRaw.affected_sessions)
              ? sessionWatchRaw.affected_sessions
                  .filter((item): item is Record<string, unknown> =>
                    Boolean(item && typeof item === "object"),
                  )
                  .map((item) => ({
                    agentId: readOptionalString(item.agent_id),
                    sessionKey: readOptionalString(item.session_key) ?? "",
                    sessionId: readOptionalString(item.session_id),
                    channel: readOptionalString(item.channel),
                    accountId: readOptionalString(item.account_id),
                    state: readOptionalString(item.state),
                    reason: readOptionalString(item.reason),
                    silentMinutes:
                      typeof item.silent_minutes === "number" ? item.silent_minutes : undefined,
                    blockedRetryCount:
                      typeof item.blocked_retry_count === "number"
                        ? item.blocked_retry_count
                        : undefined,
                    escalationRecommended: item.escalation_recommended === true,
                    recommendedAction:
                      typeof item.recommended_action === "string" && item.recommended_action.trim()
                        ? item.recommended_action
                        : undefined,
                  }))
                  .filter((item) => item.sessionKey.length > 0)
              : [],
            escalationRecommended: sessionWatchRaw.escalation_recommended === true,
            recommendedAction:
              typeof sessionWatchRaw.recommended_action === "string" &&
              sessionWatchRaw.recommended_action.trim()
                ? sessionWatchRaw.recommended_action
                : undefined,
            lastAction:
              typeof sessionWatchRaw.last_action === "string" && sessionWatchRaw.last_action.trim()
                ? sessionWatchRaw.last_action
                : undefined,
            lastActionAt:
              typeof sessionWatchRaw.last_action_at === "string" &&
              sessionWatchRaw.last_action_at.trim()
                ? sessionWatchRaw.last_action_at
                : undefined,
            lastActionDetail:
              typeof sessionWatchRaw.last_action_detail === "string" &&
              sessionWatchRaw.last_action_detail.trim()
                ? sessionWatchRaw.last_action_detail
                : undefined,
            lastNudgeAt:
              typeof sessionWatchRaw.last_nudge_at === "string" &&
              sessionWatchRaw.last_nudge_at.trim()
                ? sessionWatchRaw.last_nudge_at
                : undefined,
            updatedAt:
              typeof sessionWatchRaw.updated_at === "string" && sessionWatchRaw.updated_at.trim()
                ? sessionWatchRaw.updated_at
                : undefined,
          }
        : undefined,
      taskWatch: taskWatchRaw
        ? {
            active: taskWatchRaw.active === true,
            counts:
              taskWatchRaw.counts &&
              typeof taskWatchRaw.counts === "object" &&
              !Array.isArray(taskWatchRaw.counts)
                ? Object.fromEntries(
                    Object.entries(taskWatchRaw.counts).map(([key, value]) => [
                      key,
                      typeof value === "number" ? value : 0,
                    ]),
                  )
                : undefined,
            escalationRecommended: taskWatchRaw.escalation_recommended === true,
            recommendedAction:
              typeof taskWatchRaw.recommended_action === "string" &&
              taskWatchRaw.recommended_action.trim()
                ? taskWatchRaw.recommended_action
                : undefined,
            affectedTasks: Array.isArray(taskWatchRaw.affected_tasks)
              ? taskWatchRaw.affected_tasks
                  .filter((item): item is Record<string, unknown> =>
                    Boolean(item && typeof item === "object"),
                  )
                  .map((item) => ({
                    taskId: readOptionalString(item.task_id) ?? "",
                    followupType: readOptionalString(item.followup_type),
                    priority: readOptionalString(item.priority),
                    escalationCount:
                      typeof item.escalation_count === "number" ? item.escalation_count : undefined,
                    currentStep:
                      typeof item.current_step === "number" ? item.current_step : undefined,
                    totalSteps: typeof item.total_steps === "number" ? item.total_steps : undefined,
                    stepTitle: readOptionalString(item.step_title),
                    progressAgeSeconds:
                      typeof item.progress_age_seconds === "number"
                        ? item.progress_age_seconds
                        : undefined,
                    terminalStepStuck: item.terminal_step_stuck === true,
                    deferredBy: readOptionalString(item.deferred_by),
                    notBefore: readOptionalString(item.not_before),
                    message: readOptionalString(item.message),
                  }))
                  .filter((item) => item.taskId.length > 0)
              : [],
            updatedAt:
              typeof taskWatchRaw.updated_at === "string" && taskWatchRaw.updated_at.trim()
                ? taskWatchRaw.updated_at
                : undefined,
          }
        : undefined,
    };
  } catch {
    return undefined;
  }
}

export function formatOagChannelHealthLine(summary?: OagChannelHealthSummary): string {
  if (!summary) {
    return "unavailable";
  }
  const channels =
    summary.affectedChannels.length > 0 ? summary.affectedChannels.join(", ") : "all";
  const recentAction = (() => {
    if (summary.lastAction === "gateway_restart_triggered") {
      return "auto-restarted gateway";
    }
    if (summary.lastAction === "gateway_restart_failed") {
      return "gateway restart failed";
    }
    if (summary.lastAction === "gateway_restart_deferred") {
      return "restart deferred";
    }
    if (summary.lastAction === "recovery_verify") {
      return `verified x${summary.verifyAttempts ?? 0}`;
    }
    return "";
  })();
  const suffix = recentAction ? ` · OAG ${recentAction}` : "";
  const detailSuffix = summary.lastActionDetail ? ` · last=${summary.lastActionDetail}` : "";
  if (summary.congested) {
    return `congested · ${summary.pendingDeliveries} pending · ${summary.recentFailureCount} failures · OAG containing pressure on ${channels}${suffix}${detailSuffix}`;
  }
  if (summary.escalationRecommended) {
    return `backlog prolonged · ${summary.pendingDeliveries} pending · ${summary.backlogAgeMinutes ?? 0}m · OAG recommends gateway restart${suffix}${detailSuffix}`;
  }
  if (summary.backloggedAfterRecovery) {
    return `recovering backlog · ${summary.pendingDeliveries} pending · ${summary.backlogAgeMinutes ?? 0}m · OAG verifying ${channels}${suffix}${detailSuffix}`;
  }
  return `clear · ${summary.pendingDeliveries} pending${suffix}${detailSuffix}`;
}

export function formatOagChannelHealthAdvice(
  summary?: OagChannelHealthSummary,
): string | undefined {
  if (!summary) {
    return undefined;
  }
  if (summary.congested) {
    return "OAG is deferring extra follow-ups until channel delivery stabilizes.";
  }
  if (summary.escalationRecommended) {
    return "Backlog has persisted after recovery; if it does not clear, restart the gateway.";
  }
  if (summary.backloggedAfterRecovery) {
    return "Channel connectivity recovered, but queued deliveries are still draining.";
  }
  return undefined;
}

export function formatOagSessionWatchLine(summary?: OagChannelHealthSummary): string {
  const watch = summary?.sessionWatch;
  if (!watch) {
    return "unavailable";
  }
  const channels = watch.affectedChannels.length > 0 ? watch.affectedChannels.join(", ") : "all";
  const counts = watch.stateCounts
    ? Object.entries(watch.stateCounts)
        .map(([key, value]) => `${key}:${value}`)
        .join(", ")
    : "";
  const suffix = watch.lastActionDetail ? ` · last=${watch.lastActionDetail}` : "";
  if (watch.escalationRecommended) {
    return `blocked by model/runtime errors · watching ${watch.affectedSessions?.length ?? 0} sessions · OAG recommends ${watch.recommendedAction ?? "escalation"}${suffix}`;
  }
  if (watch.active) {
    return `watching ${watch.affectedSessions?.length ?? 0} sessions · ${counts || "active"} · ${channels}${suffix}`;
  }
  if (watch.lastAction === "session_watchdog_cleared") {
    return `clear · recent recovery completed${suffix}`;
  }
  return `clear${suffix}`;
}

export function formatOagSessionWatchAdvice(summary?: OagChannelHealthSummary): string | undefined {
  const watch = summary?.sessionWatch;
  if (!watch) {
    return undefined;
  }
  if (watch.escalationRecommended) {
    return "A session recovery is being blocked by repeated model/runtime errors; consider gateway restart or model failover.";
  }
  if (watch.active) {
    return "OAG is checking stalled sessions and nudging the mainline back into the active task.";
  }
  return undefined;
}

export function formatOagTaskWatchLine(summary?: OagChannelHealthSummary): string {
  const watch = summary?.taskWatch;
  if (!watch) {
    return "unavailable";
  }
  if (!watch.active || !watch.affectedTasks || watch.affectedTasks.length === 0) {
    return "clear";
  }
  const primary = watch.affectedTasks[0];
  if (!primary) {
    return "clear";
  }
  const stepLabel =
    typeof primary.currentStep === "number" && typeof primary.totalSteps === "number"
      ? `step ${primary.currentStep}/${primary.totalSteps}`
      : "unknown step";
  const ageMinutes =
    typeof primary.progressAgeSeconds === "number"
      ? Math.max(0, Math.floor(primary.progressAgeSeconds / 60))
      : 0;
  const escalationLabel =
    typeof primary.escalationCount === "number" && primary.escalationCount > 0
      ? ` · escalation x${primary.escalationCount}`
      : "";
  if (primary.terminalStepStuck) {
    return `terminal step still running · ${stepLabel} · ${ageMinutes}m${escalationLabel}`;
  }
  return `${primary.followupType ?? "task follow-up"} · ${stepLabel} · ${ageMinutes}m${escalationLabel}`;
}

export function formatOagTaskWatchAdvice(summary?: OagChannelHealthSummary): string | undefined {
  const watch = summary?.taskWatch;
  if (!watch || !watch.active || !watch.affectedTasks || watch.affectedTasks.length === 0) {
    return undefined;
  }
  const primary = watch.affectedTasks[0];
  if (!primary) {
    return undefined;
  }
  if (primary.terminalStepStuck) {
    return "Task looks complete but is still running; OAG is forcing mainline resolution or next-node expansion.";
  }
  if (watch.escalationRecommended) {
    return (
      watch.recommendedAction ??
      "OAG recommends following up on the highest-escalation running task now."
    );
  }
  return undefined;
}
