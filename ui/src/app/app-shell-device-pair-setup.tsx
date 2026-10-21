import type { JSX as SolidJSX } from "@solidjs/web";
import { children, Errored, isPending, lazy, Loading, Show } from "solid-js";
import { t } from "../lib/reactive/i18n.ts";

type DevicePairSetupModule = typeof import("../pages/devices/view-pairing.tsx");
type DevicePairSetupProps = Parameters<DevicePairSetupModule["DevicePairSetup"]>[0];
const PairingDialog = lazy(() => import("../pages/devices/view-pairing.tsx"), {
  export: "DevicePairSetup",
});

// Keep the pairing runtime lazy so opening the shell never fetches this chunk.
export function DevicePairSetup(props: { props: DevicePairSetupProps }): SolidJSX.Element {
  return (
    <Show when={props.props.open}>
      {(_open) => {
        // Observe the lazy content while Errored retains its fallback during a retry.
        const content = children(() => <PairingDialog {...props.props} />);
        return (
          <Errored
            fallback={(_error, reset) => (
              <PairingDialogFallback
                failed={!isPending(() => content())}
                retry={reset}
                onClose={() => props.props.onClose()}
              />
            )}
          >
            <Loading
              fallback={
                <PairingDialogFallback failed={false} onClose={() => props.props.onClose()} />
              }
            >
              {content()}
            </Loading>
          </Errored>
        );
      }}
    </Show>
  );
}

function PairingDialogFallback(props: {
  failed: boolean;
  retry?: () => void;
  onClose: () => void;
}): SolidJSX.Element {
  return (
    <openclaw-modal-dialog
      label={t("devices.pairing.title")}
      description={t(props.failed ? "devices.pairing.loadFailed" : "common.loading")}
      onModal-cancel={() => props.onClose()}
    >
      <section class="device-pair-setup" aria-busy={props.failed ? undefined : "true"}>
        <header class="device-pair-setup__header">
          <div>
            <h2>{t("devices.pairing.title")}</h2>
            <p role={props.failed ? undefined : "status"}>
              {t(props.failed ? "devices.pairing.loadFailed" : "common.loading")}
            </p>
          </div>
        </header>
        <openclaw-modal-actions class="device-pair-setup__footer">
          <Show when={props.failed}>
            <button class="btn btn--primary" type="button" onClick={() => props.retry?.()}>
              {t("common.retry")}
            </button>
          </Show>
          <button class="btn btn--ghost" type="button" onClick={() => props.onClose()}>
            {t("common.close")}
          </button>
        </openclaw-modal-actions>
      </section>
    </openclaw-modal-dialog>
  );
}
