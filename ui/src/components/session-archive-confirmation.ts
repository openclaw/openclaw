import type { CronCompactJob, CronJobsListResult, GatewaySessionRow } from "../api/types.ts";
import type { ApplicationGatewaySnapshot } from "../app/gateway.ts";
import { t } from "../i18n/index.ts";
import { assertCanonicalCronJobsCursor, readCanonicalCronJobsPage } from "../lib/cron/jobs.ts";
import { formatUiError } from "../lib/format-error.ts";
import { formatCronSchedule } from "../lib/presenter.ts";
import { readSessionMethodScopeAccess } from "../lib/session-method-access.ts";
import type { SessionRequestClient } from "../lib/sessions/session-capability.ts";
import { showConfirmDialog } from "./confirm-dialog.ts";

type ArchiveTarget = Pick<GatewaySessionRow, "key" | "hasAutomation"> & { agentId?: string };
let confirmationPending = false;

/** One archive preview for the sidebar, chat header, Sessions page, and batch menu. */
export async function confirmSessionArchive(options: {
  client: SessionRequestClient;
  snapshot: Pick<ApplicationGatewaySnapshot, "hello">;
  targets: readonly ArchiveTarget[];
  signal?: AbortSignal;
  isCurrent: () => boolean;
}): Promise<boolean> {
  const targets = options.targets;
  if (targets.length === 0) {
    return options.isCurrent();
  }
  if (confirmationPending) {
    return false;
  }
  confirmationPending = true;
  const isCurrent = () => !options.signal?.aborted && options.isCurrent();
  try {
    const jobs = new Map<string, CronCompactJob>();
    const canRead = readSessionMethodScopeAccess(options.snapshot.hello?.auth, {
      method: "cron.list",
      requiredScope: "operator.read",
    }).allowed;
    let inventoryFailure: { message: string } | undefined;
    try {
      // A session-only writer can archive without gaining access to the automation inventory.
      for (const target of canRead ? targets : []) {
        let offset = 0;
        let revision: string | undefined;
        for (;;) {
          if (!isCurrent()) {
            return false;
          }
          const page = readCanonicalCronJobsPage(
            await options.client.request<CronJobsListResult<CronCompactJob>>("cron.list", {
              sessionKey: target.key,
              sessionAgentId: target.agentId,
              includeDisabled: true,
              compact: true,
              limit: 200,
              offset,
              sortBy: "name",
              sortDir: "asc",
            }),
            200,
          );
          if (!isCurrent()) {
            return false;
          }
          assertCanonicalCronJobsCursor(page, offset);
          if (revision !== undefined && page.snapshotRevision !== revision) {
            throw new Error(t("sessionsView.archiveAutomationsChanged"));
          }
          revision = page.snapshotRevision;
          for (const job of page.jobs) {
            jobs.set(job.id, job);
          }
          if (!page.hasMore) {
            break;
          }
          offset = page.nextOffset!;
        }
      }
    } catch (error) {
      inventoryFailure = { message: formatUiError(error) };
    }
    if (!isCurrent()) {
      return false;
    }
    const canPause = readSessionMethodScopeAccess(options.snapshot.hello?.auth, {
      method: "cron.update",
      requiredScope: "operator.admin",
    }).allowed;
    const enabled = [...jobs.values()].filter((job) => job.enabled).length;
    if (
      !inventoryFailure &&
      jobs.size === 0 &&
      (canPause || (canRead && !targets.some((target) => target.hasAutomation)))
    ) {
      return isCurrent();
    }
    const confirmed = await showConfirmDialog({
      title:
        options.targets.length === 1
          ? t("sessionsView.archiveAutomationsTitle")
          : t("sessionsView.archiveAutomationsBatchTitle", {
              count: String(options.targets.length),
            }),
      message: inventoryFailure
        ? `${t("sessionsView.archiveAutomationsLoadFailed")}\n\n${canPause ? t("sessionsView.archiveAutomationsUnknownPause") : t("sessionsView.archiveAutomationsNoPermission")}`
        : !canRead
          ? `${t("sessionsView.archiveAutomationsDetailsUnavailable")}\n\n${t("sessionsView.archiveAutomationsNoPermission")}`
          : !canPause
            ? t("sessionsView.archiveAutomationsNoPermission")
            : enabled > 0
              ? t("sessionsView.archiveAutomationsDescription")
              : t("sessionsView.archiveAutomationsAlreadyPaused"),
      details: inventoryFailure?.message,
      items: inventoryFailure
        ? undefined
        : [...jobs.values()].map((job) => ({
            title: job.displayName ?? job.name,
            description: job.schedule
              ? formatCronSchedule({ schedule: job.schedule })
              : t(
                  job.scheduleKind === "stream"
                    ? "sessionsView.automationStreamSchedule"
                    : "sessionsView.automationExitSchedule",
                ),
            status: t(
              !job.enabled
                ? "sessionsView.automationAlreadyPaused"
                : canPause
                  ? "sessionsView.automationWillPause"
                  : "sessionsView.automationStaysEnabled",
            ),
          })),
      confirmLabel: t(
        inventoryFailure
          ? "sessionsView.archiveAnyway"
          : canPause && enabled > 0
            ? "sessionsView.archiveAndPause"
            : "sessionsView.archiveSession",
      ),
      signal: options.signal,
    });
    return confirmed && isCurrent();
  } finally {
    confirmationPending = false;
  }
}
