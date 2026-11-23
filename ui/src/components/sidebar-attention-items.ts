import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { cronFailureTimestamp } from "../../../packages/gateway-protocol/src/schema/cron-failure-dismissals.ts";
import type { CronCompactJob, CronJob, ModelAuthStatusResult } from "../api/types.ts";
import { t } from "../i18n/index.ts";
import { registerSidebarAttentionEnglish } from "../i18n/locales/en-sidebar-attention.ts";
import { isCronJobActiveFailure, isCronJobRunning } from "../lib/cron-status.ts";
import { clampText, formatTimeAgo } from "../lib/format.ts";
import {
  hasRoutineOAuthExpiry,
  isMonitoredAuthProvider,
  listEffectiveModelAuthProviders,
} from "../lib/model-auth.ts";
import type { SidebarAttentionItem } from "./sidebar-attention-entries.ts";

registerSidebarAttentionEnglish();

const CRON_OVERDUE_GRACE_MS = 300_000;
const ALERT_QUESTION_MAX_LENGTH = 1_000;

export type CronAttentionJob = Pick<
  CronJob,
  "id" | "name" | "agentId" | "enabled" | "updatedAtMs"
> & {
  state: Pick<
    CronJob["state"],
    "lastRunStatus" | "lastStatus" | "lastRunAtMs" | "nextRunAtMs" | "runningAtMs" | "autoDisabled"
  >;
};

function isCronAttentionJob(job: unknown): job is CronAttentionJob {
  if (
    !isRecord(job) ||
    typeof job.id !== "string" ||
    !job.id ||
    typeof job.name !== "string" ||
    typeof job.enabled !== "boolean" ||
    typeof job.updatedAtMs !== "number" ||
    (job.agentId !== undefined && typeof job.agentId !== "string") ||
    !isRecord(job.state)
  ) {
    return false;
  }
  const state = job.state;
  const disabled = state.autoDisabled;
  return (
    [job.updatedAtMs, state.nextRunAtMs, state.lastRunAtMs, state.runningAtMs].every(
      (value) =>
        value === undefined || (typeof value === "number" && Number.isFinite(value) && value >= 0),
    ) &&
    [state.lastRunStatus, state.lastStatus].every(
      (value) => value === undefined || value === "ok" || value === "error" || value === "skipped",
    ) &&
    (disabled === undefined ||
      (isRecord(disabled) &&
        (disabled.reason === "consecutive-failures" || disabled.reason === "schedule-errors") &&
        typeof disabled.atMs === "number" &&
        Number.isFinite(disabled.atMs) &&
        disabled.atMs >= 0 &&
        typeof disabled.consecutiveErrors === "number" &&
        Number.isSafeInteger(disabled.consecutiveErrors) &&
        disabled.consecutiveErrors > 0))
  );
}

export function applyCronAttentionEvent(jobs: CronAttentionJob[], payload: unknown): boolean {
  if (
    !isRecord(payload) ||
    typeof payload.action !== "string" ||
    !["removed", "started", "finished", "scheduled"].includes(payload.action) ||
    !isCronAttentionJob(payload.job) ||
    payload.jobId !== payload.job.id
  ) {
    return false;
  }
  const job = payload.job;
  const index = jobs.findIndex((entry) => entry.id === job.id);
  // Events do not establish list membership: even All agents can be access-
  // filtered, and completion can carry a removed job's historical snapshot.
  if (index < 0) {
    return false;
  }
  if (payload.action === "removed") {
    jobs.splice(index, 1);
  } else {
    const { id, name, agentId, enabled, updatedAtMs } = job;
    const { nextRunAtMs, lastRunAtMs, lastRunStatus, lastStatus, runningAtMs, autoDisabled } =
      job.state;
    // Retain attention facts only; event jobs also contain full task payloads.
    const attention = {
      id,
      name,
      agentId,
      enabled,
      updatedAtMs,
      state: { nextRunAtMs, lastRunAtMs, lastRunStatus, lastStatus, runningAtMs, autoDisabled },
    };
    jobs[index] = attention;
  }
  return true;
}

export function compactCronAttentionJob(job: CronCompactJob): CronAttentionJob {
  return {
    id: job.id,
    name: job.name,
    agentId: job.agentId,
    enabled: job.enabled,
    updatedAtMs: job.updatedAtMs,
    state: {
      nextRunAtMs: job.nextRunAtMs ?? undefined,
      lastRunAtMs: job.lastRunAtMs ?? undefined,
      lastRunStatus: job.lastRunStatus ?? undefined,
      runningAtMs: job.runningAtMs,
      autoDisabled: job.autoDisabled,
    },
  };
}

export function cronOverdueAt(job: CronAttentionJob, schedulerEnabled: boolean | null): number {
  return schedulerEnabled !== false &&
    job.enabled &&
    !isCronJobRunning(job) &&
    job.state?.nextRunAtMs != null
    ? job.state.nextRunAtMs + CRON_OVERDUE_GRACE_MS
    : Infinity;
}

export function buildSidebarAttentionEntries(params: {
  cronJobs: readonly CronAttentionJob[];
  cronSchedulerEnabled: boolean | null;
  cronOwnerByJobId?: ReadonlyMap<string, string>;
  modelAuthStatus: ModelAuthStatusResult | null;
  modelAuthAgentId?: string | null;
  now: number;
}): SidebarAttentionItem[] {
  const entries: SidebarAttentionItem[] = [];
  const attentionEntry = (
    item: Omit<SidebarAttentionItem, "category" | "dismissal" | "requiresAction" | "type">,
    category: SidebarAttentionItem["category"],
    failedAtMs?: number,
  ): SidebarAttentionItem => ({
    ...item,
    type: "attention",
    category,
    dismissal: {
      kind: item.kind,
      signature: item.signature,
      ...(failedAtMs !== undefined ? { failedAtMs } : {}),
    },
    requiresAction: true,
  });

  const monitored = listEffectiveModelAuthProviders(params.modelAuthStatus?.providers ?? []).filter(
    isMonitoredAuthProvider,
  );
  const expired = monitored.filter(
    (provider) =>
      provider.status === "missing" ||
      (provider.status === "expired" && !hasRoutineOAuthExpiry("expired", provider.profiles)),
  );
  for (const provider of expired) {
    // Auth is agent-scoped; one agent's dismissal must not hide another's warning.
    const signature = params.modelAuthAgentId
      ? `agent:${params.modelAuthAgentId}\n${provider.provider}`
      : provider.provider;
    const fact = `${provider.displayName}: ${provider.status}`;
    const profiles = provider.profiles.filter((profile) => profile.reasonCode !== "setup_inactive");
    const failed = profiles.find(
      (candidate) => candidate.status === "expired" || candidate.status === "missing",
    );
    // Inventory includes excluded credentials; mixed types cannot identify the failing auth method.
    const profile =
      failed && profiles.every((candidate) => candidate.type === failed.type) ? failed : undefined;
    const scope = profile?.profileId ?? params.modelAuthAgentId?.trim();
    const status = t(
      profile?.type === "oauth"
        ? "attention.signInRequired"
        : profile?.type === "api_key"
          ? "attention.apiKeyRequired"
          : "attention.authExpired",
    );
    // Status snapshots refresh, so a known expiry keeps the row's arrival stable.
    const expiredAt = provider.expiry?.at;
    const arrivedAtMs =
      expiredAt !== undefined && expiredAt <= params.now
        ? expiredAt
        : (params.modelAuthStatus?.ts ?? params.now);
    const time = formatTimeAgo(Math.max(0, params.now - arrivedAtMs), { suffix: false });
    const detail = scope
      ? t("attention.modelAuthExpiredWithScope", { scope, status, time })
      : t("attention.modelAuthExpiredState", { status, time });
    const alertTitle = t("attention.modelAuthExpired", { providers: provider.displayName });
    entries.push(
      attentionEntry(
        {
          kind: "modelAuthExpired",
          severity: "error",
          icon: "plug",
          label: provider.displayName,
          detail,
          meta: {
            ...(scope ? { context: scope } : {}),
            status,
          },
          arrivedAtMs,
          inlineAction: {
            label: t(
              profile?.type === "oauth"
                ? "attention.signIn"
                : profile?.type === "api_key"
                  ? "attention.updateApiKey"
                  : "attention.reconnect",
            ),
            routeId: "model-providers",
          },
          signature,
          action: {
            kind: "askCustodian",
            alert: {
              id: `modelAuthExpired:${signature}`,
              title: alertTitle,
              facts: [fact],
              question: clampText(
                t("attention.alerts.modelAuthExpiredQuestion", { facts: fact }),
                ALERT_QUESTION_MAX_LENGTH,
              ),
              action: {
                label: t("routeTitles.modelProviders"),
                target: { kind: "navigate", routeId: "model-providers" },
              },
            },
          },
        },
        "system",
      ),
    );
  }
  for (const kind of ["cronFailed", "cronOverdue"] as const) {
    const failed = kind === "cronFailed";
    const timestamp = (job: CronAttentionJob) =>
      (failed ? job.state?.lastRunAtMs : job.state?.nextRunAtMs) ?? job.updatedAtMs;
    const jobs = params.cronJobs
      .filter((job) =>
        failed
          ? isCronJobActiveFailure(job)
          : params.now > cronOverdueAt(job, params.cronSchedulerEnabled),
      )
      .toSorted((left, right) => timestamp(right) - timestamp(left));
    for (const job of jobs) {
      const time = formatTimeAgo(Math.max(0, params.now - timestamp(job)));
      const context = params.cronOwnerByJobId?.get(job.id);
      entries.push(
        attentionEntry(
          {
            kind,
            severity: failed ? "error" : "warning",
            icon: "clock",
            label: job.name?.trim() || job.id,
            detail: t(failed ? "attention.automationFailed" : "attention.automationOverdue", {
              time,
            }),
            meta: {
              ...(context ? { context } : {}),
              status: t(failed ? "attention.failed" : "attention.overdue"),
            },
            arrivedAtMs: timestamp(job),
            action: { kind: "navigate", routeId: "cron" },
            // A later overdue episode must resurface after its planned run changes.
            signature: failed ? job.id : `${job.id}@${job.state?.nextRunAtMs}`,
          },
          "automations",
          failed ? cronFailureTimestamp(job) : undefined,
        ),
      );
    }
  }

  return entries;
}
