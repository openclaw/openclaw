import { resolveUpdateRunServingChange } from "../../../src/infra/update-run-history-projection.ts";
import type { UpdateRunRecord } from "../../../src/infra/update-run-record.ts";
import type { UpdateAvailable, UpdateScheduleState } from "../api/types.ts";
import type { ApplicationContext } from "../app/context.ts";
import {
  isFinishingUpdateCampaign,
  isUpdateActionable,
} from "../app/update-schedule-projection.ts";
import { canCallGatewayMethod } from "../lib/gateway-methods.ts";
import {
  isUpdateAttentionForced,
  resolveUpdateAttentionDismissal,
  type SidebarAttentionDismissal,
} from "./sidebar-attention-dismissals.ts";
import type { SidebarInboxEntry, SidebarUpdateEntry } from "./sidebar-attention-entries.ts";

/** The selected channel owns notification eligibility, not stale target metadata. */
export function isReleaseUpdateAvailable(
  updateAvailable: UpdateAvailable | null | undefined,
  updateSchedule: UpdateScheduleState | null | undefined,
): boolean {
  const channel = updateSchedule?.channel ?? updateAvailable?.channel;
  return (
    (channel === "stable" || channel === "beta") &&
    isUpdateActionable(updateAvailable, updateSchedule, false)
  );
}

export function isUpdateRunAttentionVisible(
  run: UpdateRunRecord | null,
  acknowledged: boolean,
): boolean {
  return Boolean(
    run &&
    (run.status === "running" ||
      (!acknowledged &&
        run.finishedAtMs !== null &&
        Date.now() - run.finishedAtMs < 24 * 60 * 60 * 1000)),
  );
}

/** Stored dismissals an Inbox entry keeps, including one its update row shows without offering. */
export function retainedDismissals(entry: SidebarInboxEntry): SidebarAttentionDismissal[] {
  return [entry.dismissal, entry.type === "update" ? entry.retainedDismissal : null].flatMap(
    (dismissal) => (dismissal ? [dismissal] : []),
  );
}

export function resolveSidebarUpdateAttention(
  context: Pick<ApplicationContext, "gateway" | "overlays">,
): SidebarUpdateEntry[] {
  const snapshot = context.overlays.snapshot;
  const campaign = snapshot.updateSchedule?.campaign;
  const run = snapshot.updateRun;
  const runVisible = isUpdateRunAttentionVisible(run, snapshot.updateRunAcknowledged);
  const statusBanner =
    snapshot.updateStatusCheckBanner ?? (run ? null : snapshot.updateStatusBanner);
  const busy =
    snapshot.updateRunning ||
    snapshot.updateReconciliationPending ||
    campaign?.state === "applying";
  const canUpdate = canCallGatewayMethod(context.gateway.snapshot, "update.run", "operator.admin");
  const canHydrateCampaign = canCallGatewayMethod(
    context.gateway.snapshot,
    "update.status",
    "operator.admin",
  );
  const campaignPendingHydration =
    campaign && !snapshot.updateCampaignStatusHydrated && canHydrateCampaign;
  const release = isReleaseUpdateAvailable(snapshot.updateAvailable, snapshot.updateSchedule);
  const actionable = busy || release;
  const currentVisible =
    snapshot.updateReconciliationPending ||
    statusBanner ||
    (campaignPendingHydration ? snapshot.updateRunning : actionable);
  if (!runVisible && !currentVisible) {
    return [];
  }
  const runDismissal =
    runVisible && run?.status !== "running"
      ? { kind: "updateAvailable" as const, signature: JSON.stringify(["run", run?.runId]) }
      : null;
  // A finishing restart leads the row it shares with the run that owes it, so dismissing the
  // run's outcome cannot also hide the restart. A stored dismissal of that outcome applies
  // again once the restart is gone.
  const finishing = isFinishingUpdateCampaign(snapshot.updateSchedule);
  const historical =
    run &&
    context.gateway.snapshot.phase === "connected" &&
    resolveUpdateRunServingChange(run, context.gateway.snapshot.hello?.server);
  // A new release is a different action, not a retry of the recorded run. Give each
  // its own row so a dismissal (or a busy campaign) applies only to its owner.
  const separateHistory = historical && (!finishing || campaignPendingHydration);
  const history: SidebarUpdateEntry[] =
    separateHistory && runDismissal
      ? [
          {
            type: "update",
            category: "system",
            surface: "history",
            dismissal: canUpdate ? runDismissal : null,
            requiresAction: false,
            severity: "warning",
          },
        ]
      : [];
  if (separateHistory && !currentVisible) {
    return history;
  }
  const dismissal =
    runDismissal && !finishing && !separateHistory
      ? runDismissal
      : resolveUpdateAttentionDismissal({
          gatewayBootId: context.gateway.snapshot.hello?.server?.bootId,
          updateAvailable: snapshot.updateAvailable,
          updateSchedule: snapshot.updateSchedule,
        });
  const forced = busy || isUpdateAttentionForced(statusBanner?.tone);
  return [
    {
      type: "update",
      category: "system",
      surface: separateHistory ? "release" : undefined,
      dismissal: canUpdate && !forced ? dismissal : null,
      retainedDismissal: finishing ? runDismissal : null,
      requiresAction: forced || (canUpdate && actionable),
      severity:
        statusBanner?.tone === "danger" ||
        (!historical && snapshot.updateStatusBanner?.tone === "danger")
          ? "error"
          : "warning",
    },
    ...history,
  ];
}
