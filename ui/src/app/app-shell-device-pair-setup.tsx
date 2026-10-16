import type { JSX as SolidJSX } from "@solidjs/web";
import { createEffect, Show } from "solid-js";
import { t } from "../lib/reactive/i18n.ts";
import type { LazyRenderer } from "./lazy-renderer.ts";

type DevicePairSetupModule = typeof import("../pages/devices/view-pairing.tsx");
type DevicePairSetupProps = Parameters<DevicePairSetupModule["DevicePairSetup"]>[0];
export type DevicePairSetupLoader = LazyRenderer<DevicePairSetupModule["DevicePairSetup"]>;

// Keep the pairing runtime lazy so opening the shell never fetches this chunk.
export function DevicePairSetup(props: {
  loader: DevicePairSetupLoader;
  props: DevicePairSetupProps;
}): SolidJSX.Element {
  createEffect(
    () => props.props.open && !props.loader.renderer() && !props.loader.failed(),
    (shouldLoad) => {
      if (shouldLoad) {
        props.loader.load();
      }
    },
  );
  return (
    <Show when={props.props.open}>
      <Show
        when={props.loader.renderer()}
        keyed
        fallback={
          <openclaw-modal-dialog
            label={t("devices.pairing.title")}
            description={t(props.loader.failed() ? "devices.pairing.loadFailed" : "common.loading")}
            onModal-cancel={() => props.props.onClose()}
          >
            <section
              class="device-pair-setup"
              aria-busy={props.loader.failed() ? undefined : "true"}
            >
              <header class="device-pair-setup__header">
                <div>
                  <h2>{t("devices.pairing.title")}</h2>
                  <p role={props.loader.failed() ? undefined : "status"}>
                    {t(props.loader.failed() ? "devices.pairing.loadFailed" : "common.loading")}
                  </p>
                </div>
              </header>
              <openclaw-modal-actions class="device-pair-setup__footer">
                <Show when={props.loader.failed()}>
                  <button
                    class="btn btn--primary"
                    type="button"
                    onClick={() => props.loader.retry()}
                  >
                    {t("common.retry")}
                  </button>
                </Show>
                <button class="btn btn--ghost" type="button" onClick={() => props.props.onClose()}>
                  {t("common.close")}
                </button>
              </openclaw-modal-actions>
            </section>
          </openclaw-modal-dialog>
        }
      >
        {(View) => <View {...props.props} />}
      </Show>
    </Show>
  );
}
