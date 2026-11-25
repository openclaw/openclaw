import {
  projectUpdateRunHistory,
  type UpdateRunServingIdentity,
} from "../../../src/infra/update-run-history-projection.ts";
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
import type { SidebarAttentionItem, SidebarInboxEntry } from "./sidebar-attention-entries.ts";

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
  serving?: UpdateRunServingIdentity,
): boolean {
  return Boolean(
    run &&
    !projectUpdateRunHistory(run, serving) &&
    (run.status === "running" ||
      (!acknowledged &&
        run.finishedAtMs !== null &&
        Date.now() - run.finishedAtMs < 24 * 60 * 60 * 1000)),
  );
}

function runDismissal(run: UpdateRunRecord): SidebarAttentionDismissal {
  return { kind: "updateAvailable", signature: JSON.stringify(["run", run.runId]) };
}

export function resolveSidebarHistoricalUpdateAttention(
  context: Pick<ApplicationContext, "gateway" | "overlays">,
): SidebarAttentionItem | null {
  const { updateRun: run, updateRunAcknowledged } = context.overlays.snapshot;
  const gateway = context.gateway.snapshot;
  if (
    !run ||
    gateway.phase !== "connected" ||
    !isUpdateRunAttentionVisible(run, updateRunAcknowledged)
  ) {
    return null;
  }
  const headline = projectUpdateRunHistory(run, gateway.hello?.server);
  if (!headline) {
    return null;
  }
  const dismissal = runDismissal(run);
  return {
    type: "attention",
    kind: "updateAvailable",
    category: "system",
    severity: "warning",
    requiresAction: false,
    icon: "alertTriangle",
    label: headline,
    detail: "",
    arrivedAtMs: run.finishedAtMs ?? undefined,
    signature: dismissal.signature,
    dismissal: canCallGatewayMethod(gateway, "update.run", "operator.admin") ? dismissal : null,
    action: { kind: "navigate", routeId: "updates" },
  };
}

/** Stored dismissals an Inbox entry keeps, including one its update row shows without offering. */
export function retainedDismissals(entry: SidebarInboxEntry): SidebarAttentionDismissal[] {
  return [entry.dismissal, entry.type === "update" ? entry.retainedDismissal : null].flatMap(
    (dismissal) => (dismissal ? [dismissal] : []),
  );
}

export function resolveSidebarUpdateAttention(
  context: Pick<ApplicationContext, "gateway" | "overlays">,
): Extract<SidebarInboxEntry, { type: "update" }> | null {
  const snapshot = context.overlays.snapshot;
  const campaign = snapshot.updateSchedule?.campaign;
  const run = snapshot.updateRun;
  const runVisible = isUpdateRunAttentionVisible(
    run,
    snapshot.updateRunAcknowledged,
    context.gateway.snapshot.phase === "connected"
      ? context.gateway.snapshot.hello?.server
      : undefined,
  );
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
  const actionable =
    busy || isReleaseUpdateAvailable(snapshot.updateAvailable, snapshot.updateSchedule);
  if (
    !(
      runVisible ||
      snapshot.updateReconciliationPending ||
      statusBanner ||
      (campaignPendingHydration ? snapshot.updateRunning : actionable)
    )
  ) {
    return null;
  }
  const outcomeDismissal = runVisible && run && run.status !== "running" ? runDismissal(run) : null;
  // A finishing restart leads the row it shares with the run that owes it, so dismissing the
  // run's outcome cannot also hide the restart. A stored dismissal of that outcome applies
  // again once the restart is gone.
  const finishing = isFinishingUpdateCampaign(snapshot.updateSchedule);
  const dismissal =
    outcomeDismissal && !finishing
      ? outcomeDismissal
      : resolveUpdateAttentionDismissal({
          gatewayBootId: context.gateway.snapshot.hello?.server?.bootId,
          updateAvailable: snapshot.updateAvailable,
          updateSchedule: snapshot.updateSchedule,
        });
  const forced = busy || isUpdateAttentionForced(statusBanner?.tone);
  return {
    type: "update",
    category: "system",
    dismissal: canUpdate && !forced ? dismissal : null,
    retainedDismissal: finishing ? outcomeDismissal : null,
    requiresAction: forced || (canUpdate && actionable),
    severity: snapshot.updateStatusBanner?.tone === "danger" ? "error" : "warning",
  };
}
