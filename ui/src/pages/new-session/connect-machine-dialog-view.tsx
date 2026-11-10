import { Errored, lazy, Loading, Show } from "solid-js";
import "../../components/modal-dialog.tsx";
import { DialogHeader } from "../../components/solid/dialog-header.tsx";
import { LazyViewError } from "../../components/solid/lazy-view-error.tsx";
import { t } from "../../lib/reactive/i18n.ts";
import type { ConnectMachineSetupState } from "./connect-machine-dialog.ts";

const Content = lazy(() => import("./connect-machine-dialog-content.tsx"), {
  export: "ConnectMachineDialogContent",
});

export function ConnectMachineDialog(props: ReturnType<ConnectMachineSetupState["view"]>) {
  return (
    <Show when={props.open}>
      <openclaw-modal-dialog
        class="connect-machine-dialog"
        label={t("newSession.connectMachineTitle")}
        description={t("newSession.connectMachineDescription")}
        onModal-cancel={() => props.onClose()}
      >
        <section class="oc-dialog">
          <DialogHeader
            title={t("newSession.connectMachineTitle")}
            description={<p>{t("newSession.connectMachineDescription")}</p>}
            onClose={() => props.onClose()}
          />
          <Errored
            fallback={(error, reset) => (
              <div class="oc-dialog__body connect-machine-dialog__body">
                <LazyViewError error={error()} onRetry={() => reset()} inline />
              </div>
            )}
          >
            <Loading
              fallback={
                <div class="oc-dialog__body connect-machine-dialog__body">
                  <p class="connect-machine-dialog__status" role="status">
                    {t("newSession.connectMachineGenerating")}
                  </p>
                </div>
              }
            >
              <Content {...props} />
            </Loading>
          </Errored>
        </section>
      </openclaw-modal-dialog>
    </Show>
  );
}
