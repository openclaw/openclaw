import type { JSX as SolidJSX } from "@solidjs/web";
import { createEffect, createMemo, Show } from "solid-js";
import { t } from "../lib/reactive/i18n.ts";
import type { LazyRenderer } from "./lazy-renderer.ts";
import { LitRouteHost } from "./lit-route-host.tsx";

type DevicePairSetupModule = typeof import("../pages/devices/view-pairing.runtime.ts");
type DevicePairSetupProps = Parameters<DevicePairSetupModule["renderDevicePairSetup"]>[0];
export type DevicePairSetupLoader = LazyRenderer<DevicePairSetupModule["renderDevicePairSetup"]>;

// Keep the pairing runtime lazy so opening the shell never fetches this chunk.
export function DevicePairSetup(props: {
  loader: DevicePairSetupLoader;
  revision: number;
  props: DevicePairSetupProps;
}): SolidJSX.Element {
  const state = createMemo(() => {
    return {
      revision: props.revision,
      renderer: props.loader.renderer,
      failed: props.loader.failed,
    };
  });
  createEffect(
    () => props.props.open && !state().renderer && !state().failed,
    (shouldLoad) => {
      if (shouldLoad) {
        props.loader.load();
      }
    },
  );
  return (
    <Show when={props.props.open}>
      <Show
        when={state().renderer}
        fallback={
          <openclaw-modal-dialog
            label={t("devices.pairing.title")}
            description={t(state().failed ? "devices.pairing.loadFailed" : "common.loading")}
            onModal-cancel={() => props.props.onClose()}
          >
            <section class="device-pair-setup" aria-busy={state().failed ? undefined : "true"}>
              <header class="device-pair-setup__header">
                <div>
                  <h2>{t("devices.pairing.title")}</h2>
                  <p role={state().failed ? undefined : "status"}>
                    {t(state().failed ? "devices.pairing.loadFailed" : "common.loading")}
                  </p>
                </div>
              </header>
              <footer class="device-pair-setup__footer">
                <Show when={state().failed}>
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
              </footer>
            </section>
          </openclaw-modal-dialog>
        }
      >
        <LitRouteHost renderValue={() => state().renderer?.(props.props)} />
      </Show>
    </Show>
  );
}
