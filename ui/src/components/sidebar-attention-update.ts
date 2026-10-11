import type { UpdateRunRecord } from "../../../src/infra/update-run-record.ts";
import type { ApplicationContext } from "../app/context.ts";
import { isUpdateActionable } from "../app/update-schedule-projection.ts";
import { canCallGatewayMethod } from "../lib/gateway-methods.ts";
import {
  isUpdateAttentionForced,
  resolveUpdateAttentionDismissal,
} from "./sidebar-attention-dismissals.ts";
import type { SidebarInboxEntry } from "./sidebar-attention-entries.ts";

export function isUpdateRunAttentionVisible(
  run: UpdateRunRecord | null,
  acknowledged: boolean,
  nowMs = Date.now(),
): boolean {
  return Boolean(
    run &&
    (run.status === "running" ||
      (!acknowledged &&
        run.finishedAtMs !== null &&
        nowMs - run.finishedAtMs < 24 * 60 * 60 * 1000)),
  );
}

export function resolveSidebarUpdateAttention(
  context: Pick<ApplicationContext, "gateway" | "overlays">,
): Extract<SidebarInboxEntry, { type: "update" }> | null {
  const snapshot = context.overlays.snapshot;
  const campaign = snapshot.updateSchedule?.campaign;
  const run = snapshot.updateRun;
  const runVisible = isUpdateRunAttentionVisible(run, snapshot.updateRunAcknowledged);
  const statusBanner = run ? null : snapshot.updateStatusBanner;
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
  const actionable = isUpdateActionable(snapshot.updateAvailable, snapshot.updateSchedule, busy);
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
  const dismissal =
    runVisible && run?.status !== "running"
      ? { kind: "updateAvailable" as const, signature: JSON.stringify(["run", run?.runId]) }
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
    requiresAction: forced || (canUpdate && actionable),
    severity: snapshot.updateStatusBanner?.tone === "danger" ? "error" : "warning",
  };
}
