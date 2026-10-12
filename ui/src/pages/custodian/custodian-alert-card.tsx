import { createMemo, For, Show } from "solid-js";
import type { ApplicationContext } from "../../app/context.ts";
import { hasNativeUpdateBridge } from "../../app/native-link-routing.ts";
import {
  confirmAndStartUpdate,
  createUpdateProgressWatcher,
} from "../../app/update-confirmation.ts";
import type { CustodianAlert } from "../../components/custodian-alert-contract.ts";
import { Icon } from "../../components/solid/icon.tsx";
import { canCallGatewayMethod } from "../../lib/gateway-methods.ts";
import { projectGateway } from "../../lib/reactive/application.ts";
import { t } from "../../lib/reactive/i18n.ts";

export function CustodianAlertCard(props: {
  alert: CustodianAlert;
  context: ApplicationContext;
  onDismiss: () => void;
}) {
  const gateway = createMemo(() => projectGateway(props.context.gateway));
  const canUpdate = () =>
    canCallGatewayMethod(gateway().read().snapshot, "update.run", "operator.admin");
  const updateDisabled = () => props.alert.action?.target.kind === "update" && !canUpdate();
  return (
    <article class="custodian__nudge custodian__alert-card" role="status">
      <div class="custodian__alert-heading">
        <strong>{props.alert.title}</strong>
        <button
          class="custodian__nudge-dismiss"
          type="button"
          aria-label={t("common.dismiss")}
          onClick={() => props.onDismiss()}
        >
          <Icon name="x" />
        </button>
      </div>
      <ul class="custodian__alert-facts">
        <For each={props.alert.facts}>{(fact) => <li>{fact}</li>}</For>
      </ul>
      <Show when={props.alert.action}>
        {(action) => (
          <button
            class="btn btn--sm primary custodian__alert-action"
            type="button"
            title={updateDisabled() ? t("updates.adminRequired") : undefined}
            disabled={updateDisabled()}
            onClick={() => {
              const target = action().target;
              const context = props.context;
              if (target.kind === "navigate") {
                context.navigate(target.routeId);
              } else if (canUpdate()) {
                void confirmAndStartUpdate({
                  startGatewayUpdate: () => void context.overlays.runUpdate(),
                  watchUpdateProgress: createUpdateProgressWatcher(context),
                  onAcknowledge: () => context.overlays.acknowledgeUpdateRun(),
                  onCheckStatus: () => context.overlays.refreshUpdateStatus(),
                  onReviewUpdate: () => context.navigate("updates"),
                  updateAvailable: context.overlays.snapshot.updateAvailable,
                  updateSchedule: context.overlays.snapshot.updateSchedule,
                  viaNativeApp: hasNativeUpdateBridge(),
                });
              }
            }}
          >
            {action().label}
          </button>
        )}
      </Show>
    </article>
  );
}
