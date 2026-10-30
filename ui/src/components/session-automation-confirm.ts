import type { CronCompactJob, CronJobsListResult } from "../api/types.ts";
import type { ApplicationGatewaySnapshot } from "../app/gateway.ts";
import { t } from "../i18n/index.ts";
import { registerSessionOrganizationEnglish } from "../i18n/locales/en-session-organization.ts";
import { canCallGatewayMethod } from "../lib/gateway-methods.ts";
import { resolveUiConversationIdentity } from "../lib/sessions/session-key.ts";
import type { ConfirmDialogOptions } from "./confirm-dialog.ts";

registerSessionOrganizationEnglish();

const LISTED_AUTOMATION_LIMIT = 10;

/** A conversation the operator is about to archive or delete. */
type SessionAutomationTarget = {
  key: string;
  agentId?: string;
  label?: string;
  hasAutomation?: boolean;
};

/** Confirmation copy for enabled automations that an archive or delete pauses. */
export type BoundAutomationNotice = {
  action: "archive" | "delete";
  message: string;
  details?: string;
  automationCount: number;
};

function hasBoundAutomation(sessions: readonly SessionAutomationTarget[]): boolean {
  return sessions.some((session) => session.hasAutomation === true);
}

/** Identifies the archive or delete targets and the connection used to name their automations. */
export type BoundAutomationRequest = {
  action: "archive" | "delete";
  sessions: readonly SessionAutomationTarget[];
  gateway: { snapshot: ApplicationGatewaySnapshot };
  selectedAgentId?: string;
  signal?: AbortSignal;
};

/**
 * Runs an archive or delete confirmation with the pause warning when any
 * target row reports an enabled bound automation. Without one, `present`
 * receives null synchronously, so existing confirmations keep their timing.
 * Shown, confirmed and cancelled warnings are recorded for visibility.
 */
export function confirmWithBoundAutomations<T>(
  request: BoundAutomationRequest,
  present: (notice: BoundAutomationNotice | null) => Promise<T>,
  confirmed: (result: T) => boolean,
): Promise<T> {
  if (!hasBoundAutomation(request.sessions)) {
    return present(null);
  }
  return readBoundAutomationNotice(request).then(async (notice) => {
    logBoundAutomationConfirm(notice, "shown");
    const result = await present(notice);
    logBoundAutomationConfirm(notice, confirmed(result) ? "confirmed" : "cancelled");
    return result;
  });
}

// Names come from the existing session-filtered cron.list read; a failed or
// unavailable read still warns, just without names.
async function readBoundAutomationNotice(
  params: BoundAutomationRequest,
): Promise<BoundAutomationNotice> {
  const targets = params.sessions.filter((session) => session.hasAutomation === true);
  const { jobs, total } = await listBoundAutomations(params.gateway.snapshot, targets, params);
  const single = params.sessions.length === 1 ? params.sessions[0] : undefined;
  const message = t(
    params.action === "archive"
      ? single
        ? "sessionsView.automationPauseArchiveOne"
        : "sessionsView.automationPauseArchiveOther"
      : single
        ? "sessionsView.automationPauseDeleteOne"
        : "sessionsView.automationPauseDeleteOther",
    { session: single?.label ?? single?.key ?? "", count: String(targets.length) },
  );
  if (jobs.length === 0) {
    return {
      action: params.action,
      message: message + "\n\n" + t("sessionsView.automationPauseUnlisted"),
      automationCount: targets.length,
    };
  }
  const lines = jobs.slice(0, LISTED_AUTOMATION_LIMIT).map((job) => job.name + " (" + job.id + ")");
  if (total > lines.length) {
    lines.push(t("sessionsView.automationPauseMore", { count: String(total - lines.length) }));
  }
  return { action: params.action, message, details: lines.join("\n"), automationCount: total };
}

// Reads each flagged conversation's enabled bound jobs, deduplicated by job ID.
// Failures leave names out; the row flag alone still justifies the warning.
// Jobs beyond a page's limit are counted, not named, and may repeat across pages.
async function listBoundAutomations(
  snapshot: ApplicationGatewaySnapshot,
  targets: readonly SessionAutomationTarget[],
  params: { selectedAgentId?: string; signal?: AbortSignal },
): Promise<{ jobs: CronCompactJob[]; total: number }> {
  const client = snapshot.client;
  if (
    !client ||
    !canCallGatewayMethod(snapshot, "cron.list", "operator.read", { requireAdvertisement: false })
  ) {
    return { jobs: [], total: 0 };
  }
  const pages = await Promise.all(
    targets.map(async (target) => {
      const identity = resolveUiConversationIdentity(
        snapshot,
        target.key,
        target.agentId ?? params.selectedAgentId,
      );
      try {
        return await client.request<CronJobsListResult<CronCompactJob>>(
          "cron.list",
          {
            sessionKey: identity.sessionKey,
            ...(identity.agentId ? { sessionAgentId: identity.agentId } : {}),
            enabled: "enabled",
            compact: true,
            includeDeliveryPreviews: false,
            sortBy: "name",
            limit: LISTED_AUTOMATION_LIMIT,
          },
          { signal: params.signal },
        );
      } catch {
        return null;
      }
    }),
  );
  const jobs = new Map<string, CronCompactJob>();
  let unlisted = 0;
  for (const page of pages) {
    // A response without a job list names nothing; the row flag still warns.
    const listed = Array.isArray(page?.jobs) ? page.jobs : [];
    for (const job of listed) {
      jobs.set(job.id, job);
    }
    unlisted += Math.max(0, (page?.total ?? 0) - listed.length);
  }
  return { jobs: [...jobs.values()], total: jobs.size + unlisted };
}

/**
 * Adds the pause warning to an archive or delete confirmation. The warning is
 * never skippable, so an opted-out delete confirmation still appears for it.
 */
export function withBoundAutomationNotice<T extends ConfirmDialogOptions>(
  options: T,
  notice: BoundAutomationNotice,
): T {
  return {
    ...options,
    skipPreference: undefined,
    title: options.title ?? t("sessionsView.automationPauseTitle"),
    message: options.message ? options.message + "\n\n" + notice.message : notice.message,
    ...(notice.details ? { details: notice.details } : {}),
    confirmLabel: t(
      notice.action === "archive" ? "sessionsView.archiveAnyway" : "sessionsView.deleteAnyway",
    ),
  };
}

// Counts only; job names and session labels stay out of the console record.
function logBoundAutomationConfirm(
  notice: BoundAutomationNotice,
  outcome: "shown" | "confirmed" | "cancelled",
) {
  console.info("[session-automation-confirm] " + notice.action + " " + outcome, {
    automations: notice.automationCount,
  });
}
