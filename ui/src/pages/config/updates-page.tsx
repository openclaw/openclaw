import { createMemo } from "@solidjs/signals";
import type { ApplicationContext } from "../../app/context.ts";
import { hasOperatorAdminAccess } from "../../app/operator-access.ts";
import {
  confirmAndStartUpdate,
  createUpdateProgressWatcher,
} from "../../app/update-confirmation.ts";
import { canReportUpdateFailure } from "../../app/update-failure-report-controller.ts";
import { CONTROL_UI_BUILD_INFO } from "../../build-info.ts";
import { canCallGatewayMethod } from "../../lib/gateway-methods.ts";
import {
  projectApplicationConfig,
  projectGateway,
  projectOverlays,
} from "../../lib/reactive/application.ts";
import { Updates } from "./updates.tsx";

export type UpdatesPageProps = {
  context: ApplicationContext;
  configObject: Record<string, unknown>;
  configBusy: boolean;
  updateBusy: boolean;
  nowMs?: number;
};

export function UpdatesPage(props: UpdatesPageProps) {
  const gateway = createMemo(() => projectGateway(props.context.gateway));
  const overlays = createMemo(() => projectOverlays(props.context.overlays));
  const config = createMemo(() => projectApplicationConfig(props.context.config));
  const snapshot = () => gateway().read().snapshot;
  return (
    <Updates
      update={overlays().read()}
      nativeDeviceSettings={props.context.nativeDeviceSettings}
      configObject={props.configObject}
      gatewayVersion={config().read().serverVersion ?? snapshot().hello?.server?.version ?? null}
      controlUiCommit={CONTROL_UI_BUILD_INFO.commit}
      controlUiCommitAt={CONTROL_UI_BUILD_INFO.commitAt}
      controlUiBuiltAt={CONTROL_UI_BUILD_INFO.builtAt}
      connected={snapshot().phase === "connected"}
      configBusy={props.configBusy}
      canAdmin={hasOperatorAdminAccess(snapshot().hello?.auth ?? null)}
      canUpdate={canCallGatewayMethod(snapshot(), "update.run", "operator.admin")}
      canCheckStatus={canCallGatewayMethod(snapshot(), "update.status", "operator.admin")}
      canHoldUpdate={canCallGatewayMethod(snapshot(), "update.hold", "operator.admin")}
      canReport={canReportUpdateFailure(snapshot())}
      canDiagnose={canCallGatewayMethod(snapshot(), "openclaw.chat", "operator.admin")}
      updateBusy={props.updateBusy}
      nowMs={props.nowMs}
      onChannelChange={(channel) =>
        props.context.runtimeConfig.patchForm(["update", "channel"], channel)
      }
      onUpdateChecksChange={(enabled) =>
        props.context.runtimeConfig.patchForm(["update", "checkOnStart"], enabled)
      }
      onAutomaticUpdatesChange={(enabled) =>
        props.context.runtimeConfig.patchForm(["update", "auto", "enabled"], enabled)
      }
      onUpdateNow={() => {
        const update = overlays().read();
        void confirmAndStartUpdate({
          startGatewayUpdate: () => void props.context.overlays.runUpdate(),
          // The dialog outlives this page, so read live snapshots after each change.
          watchUpdateProgress: createUpdateProgressWatcher(props.context),
          onCheckStatus: () => props.context.overlays.refreshUpdateStatus(),
          onAcknowledge: () => props.context.overlays.acknowledgeUpdateRun(),
          updateAvailable: update.updateAvailable,
          updateSchedule: update.updateSchedule,
          // Keep Gateway routing: this row has no native-decline listener.
          viaNativeApp: false,
        });
      }}
      onHoldUpdate={() => props.context.overlays.holdUpdate()}
      onCheckStatus={() => props.context.overlays.refreshUpdateStatus()}
      onReportFailure={(attemptId) => props.context.overlays.reportUpdateFailure(attemptId)}
      onDiagnoseFailure={(attemptId) => props.context.overlays.diagnoseUpdateFailure(attemptId)}
    />
  );
}

export function renderUpdatesPage(props: UpdatesPageProps) {
  return <UpdatesPage {...props} />;
}
