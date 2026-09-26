import type { ApplicationContext } from "../../app/context.ts";
import { hasOperatorAdminAccess } from "../../app/operator-access.ts";
import {
  confirmAndStartUpdate,
  createUpdateProgressWatcher,
} from "../../app/update-confirmation.ts";
import { canReportUpdateFailure } from "../../app/update-failure-report-controller.ts";
import { CONTROL_UI_BUILD_INFO } from "../../build-info.ts";
import { canCallGatewayMethod } from "../../lib/gateway-methods.ts";
import { renderUpdates } from "./updates.ts";

export function renderUpdatesPage({
  context,
  configObject,
  configBusy,
  updateBusy,
}: {
  context: ApplicationContext;
  configObject: Record<string, unknown>;
  configBusy: boolean;
  updateBusy: boolean;
}) {
  const runtimeConfig = context.runtimeConfig;
  const gatewaySnapshot = context.gateway.snapshot;
  const overlaySnapshot = context.overlays.snapshot;
  const canAdmin = hasOperatorAdminAccess(gatewaySnapshot.hello?.auth ?? null);
  return renderUpdates({
    update: overlaySnapshot,
    nativeDeviceSettings: context.nativeDeviceSettings,
    configObject,
    gatewayVersion:
      context.config.current.serverVersion ?? gatewaySnapshot.hello?.server?.version ?? null,
    controlUiCommit: CONTROL_UI_BUILD_INFO.commit,
    controlUiCommitAt: CONTROL_UI_BUILD_INFO.commitAt,
    controlUiBuiltAt: CONTROL_UI_BUILD_INFO.builtAt,
    connected: gatewaySnapshot.phase === "connected",
    configBusy,
    canAdmin,
    canUpdate: canCallGatewayMethod(gatewaySnapshot, "update.run", "operator.admin"),
    canCheckStatus: canCallGatewayMethod(gatewaySnapshot, "update.status", "operator.admin"),
    canHoldUpdate: canCallGatewayMethod(gatewaySnapshot, "update.hold", "operator.admin"),
    canReport: canReportUpdateFailure(gatewaySnapshot),
    canDiagnose: canCallGatewayMethod(gatewaySnapshot, "openclaw.chat", "operator.admin"),
    updateBusy,
    onChannelChange: (channel) => runtimeConfig.patchForm(["update", "channel"], channel),
    onUpdateChecksChange: (enabled) => runtimeConfig.patchForm(["update", "checkOnStart"], enabled),
    onAutomaticUpdatesChange: (enabled) =>
      runtimeConfig.patchForm(["update", "auto", "enabled"], enabled),
    onUpdateNow: () =>
      void confirmAndStartUpdate({
        startGatewayUpdate: () => void context.overlays.runUpdate(),
        // The dialog outlives this page, so read live snapshots after each change.
        watchUpdateProgress: createUpdateProgressWatcher(context),
        onCheckStatus: () => context.overlays.refreshUpdateStatus(),
        onAcknowledge: () => context.overlays.acknowledgeUpdateRun(),
        updateAvailable: overlaySnapshot.updateAvailable,
        updateSchedule: overlaySnapshot.updateSchedule,
        // This row has no native-decline listener, so a handoff the Mac app
        // refuses would end in silence. Keep it on the Gateway route.
        viaNativeApp: false,
      }),
    onHoldUpdate: () => context.overlays.holdUpdate(),
    onCheckStatus: () => context.overlays.refreshUpdateStatus(),
    onReportFailure: (attemptId) => context.overlays.reportUpdateFailure(attemptId),
    onDiagnoseFailure: (attemptId) => context.overlays.diagnoseUpdateFailure(attemptId),
  });
}
