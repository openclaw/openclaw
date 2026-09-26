import type { CronJob, ModelAuthStatusResult } from "../api/types.ts";
import { t } from "../i18n/index.ts";
import { registerSidebarAttentionEnglish } from "../i18n/locales/en-sidebar-attention.ts";
import { isCronJobActiveFailure, isCronJobRunning } from "../lib/cron-status.ts";
import { clampText, formatTimeAgo } from "../lib/format.ts";
import { isMonitoredAuthProvider, listEffectiveModelAuthProviders } from "../lib/model-auth.ts";
import type { SidebarAttentionItem } from "./sidebar-attention-entries.ts";

registerSidebarAttentionEnglish();

// A cron job counts as overdue when its next planned run is this far in the
// past; mirrors the threshold the Overview attention list used.
const CRON_OVERDUE_GRACE_MS = 300_000;
const ALERT_QUESTION_MAX_LENGTH = 1_000;
const SIDEBAR_ATTENTION_PRIORITY: Record<SidebarAttentionItem["kind"], number> = {
  modelAuthExpired: 0,
  cronFailed: 1,
  cronOverdue: 2,
};

export type CronAttentionJob = Pick<
  CronJob,
  "id" | "name" | "agentId" | "enabled" | "updatedAtMs"
> & {
  state: Pick<
    CronJob["state"],
    "lastRunStatus" | "lastStatus" | "lastRunAtMs" | "nextRunAtMs" | "runningAtMs" | "autoDisabled"
  >;
};

export function cronOverdueAt(job: CronAttentionJob, schedulerEnabled: boolean | null): number {
  return schedulerEnabled !== false &&
    job.enabled &&
    !isCronJobRunning(job) &&
    job.state?.nextRunAtMs != null
    ? job.state.nextRunAtMs + CRON_OVERDUE_GRACE_MS
    : Infinity;
}

export function compareSidebarAttentionEntries(
  left: SidebarAttentionItem,
  right: SidebarAttentionItem,
): number {
  return SIDEBAR_ATTENTION_PRIORITY[left.kind] - SIDEBAR_ATTENTION_PRIORITY[right.kind];
}

type SidebarAttentionContent = Omit<
  SidebarAttentionItem,
  "category" | "dismissal" | "requiresAction" | "type"
>;

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
    item: SidebarAttentionContent,
    category: SidebarAttentionItem["category"],
  ): SidebarAttentionItem => ({
    ...item,
    type: "attention",
    category,
    dismissal: { kind: item.kind, signature: item.signature },
    requiresAction: true,
  });
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
              time,
            },
            action: { kind: "navigate", routeId: "cron" },
            // A later overdue episode must resurface after its planned run changes.
            signature: failed ? job.id : `${job.id}@${job.state?.nextRunAtMs}`,
          },
          "automations",
        ),
      );
    }
  }

  const monitored = listEffectiveModelAuthProviders(params.modelAuthStatus?.providers ?? []).filter(
    isMonitoredAuthProvider,
  );
  const expired = monitored.filter(
    (provider) => provider.status === "expired" || provider.status === "missing",
  );
  for (const provider of expired) {
    // Auth is agent-scoped; one agent's dismissal must not hide another's warning.
    const signature = params.modelAuthAgentId
      ? `agent:${params.modelAuthAgentId}\n${provider.provider}`
      : provider.provider;
    const fact = `${provider.displayName}: ${provider.status}`;
    const scope =
      provider.profiles.find(
        (profile) => profile.status === "expired" || profile.status === "missing",
      )?.profileId ?? params.modelAuthAgentId?.trim();
    const time = formatTimeAgo(
      Math.max(0, params.now - (params.modelAuthStatus?.ts ?? params.now)),
      { suffix: false },
    );
    const detail = scope
      ? t("attention.modelAuthExpiredWithScope", { scope, time })
      : t("attention.modelAuthExpiredState", { time });
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
            status: t("attention.authExpired"),
            time,
          },
          inlineAction: {
            label: t("attention.reconnect"),
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
  return entries;
}
