import type { ApplicationGateway } from "../../app/gateway.ts";
import { withPromiseModalHost } from "../../components/promise-modal-host.ts";
import { DialogHeader } from "../../components/solid/dialog-header.tsx";
import { t } from "../../lib/reactive/i18n.ts";
import { PersonalEnrollment } from "./personal-enrollment.tsx";

export function devicePersonalEnrollmentAction(
  context: { gateway: ApplicationGateway; basePath: string },
  refresh: () => unknown,
  source: { read: () => { devicesError: string | null }; publish: () => void },
) {
  return (device: { id: string; name: string }) => {
    void showPersonalEnrollment({
      gateway: context.gateway,
      basePath: context.basePath,
      deviceId: device.id,
      name: device.name,
    })
      .then(() => refresh())
      .catch((error: unknown) => {
        source.read().devicesError = String(error);
        source.publish();
      });
  };
}

function showPersonalEnrollment(options: {
  gateway: ApplicationGateway;
  basePath: string;
  deviceId: string;
  name: string;
  signal?: AbortSignal;
}) {
  return withPromiseModalHost<void>({ signal: options.signal, value: undefined }, (modal) => {
    modal.render(() => (
      <openclaw-modal-dialog
        label={t("profilePage.enrollment.device")}
        onModal-cancel={() => modal.finish()}
      >
        <section class="oc-dialog">
          <DialogHeader title={options.name} onClose={() => modal.finish()} />
          <div class="oc-dialog__body">
            <PersonalEnrollment
              initialGateway={options.gateway}
              basePath={options.basePath}
              initialDeviceId={options.deviceId}
            />
          </div>
          <openclaw-modal-actions class="oc-dialog__footer">
            <button class="btn" onClick={() => modal.finish()}>
              {t("common.close")}
            </button>
          </openclaw-modal-actions>
        </section>
      </openclaw-modal-dialog>
    ));
  });
}
