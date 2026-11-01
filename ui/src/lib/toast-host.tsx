import { Errored, lazy, Loading, onSettled, Show } from "solid-js";
import { t } from "./reactive/i18n.ts";
import { defineSolidBridge, type SolidBridgeElement } from "./solid-bridge.ts";
import { toastOwnerFor, type ToastProperties, type ToastMethods } from "./toast.ts";

const ToastView = lazy(() => import("./toast-view.tsx"), { export: "ToastView" });

// Rendering modules also load in Node tests.
if (typeof customElements !== "undefined") {
  defineSolidBridge<ToastProperties, ToastMethods>(
    "openclaw-toast-host",
    (props, host) => {
      const owner = toastOwnerFor(host);
      return (
        <Show when={Boolean(props.toast)}>
          {(_shown) => {
            onSettled(() => () => {
              owner.body = undefined;
              owner.hover(false);
            });
            return (
              <Errored
                fallback={(_error, reset) => (
                  <div
                    class="app-toast app-toast--error"
                    data-active={props.active ? "true" : "false"}
                    role="alert"
                    onPointerEnter={() => owner.hover(true)}
                    onPointerLeave={() => owner.hover(false)}
                    onFocusIn={() => owner.syncDismissTimer(true)}
                    onFocusOut={(event) =>
                      owner.syncDismissTimer(
                        event.relatedTarget instanceof Node && host.contains(event.relatedTarget),
                      )
                    }
                  >
                    <span class="app-toast__message">{t("lazyView.errorTitle")}</span>
                    <button class="app-toast__action" type="button" onClick={() => reset()}>
                      {t("common.retry")}
                    </button>
                    <button
                      class="app-toast__dismiss"
                      type="button"
                      aria-label={t("common.dismiss")}
                      onClick={() => owner.dismiss("dismiss")}
                    >
                      ×
                    </button>
                  </div>
                )}
              >
                <Loading>
                  <ToastView
                    toast={props.toast}
                    active={props.active}
                    host={host}
                    bodyRef={(element) => (owner.body = element)}
                    ready={() => owner.syncDismissTimer()}
                    hover={(hovered) => owner.hover(hovered)}
                    focus={(focused) => owner.syncDismissTimer(focused)}
                    dismiss={(reason) => owner.dismiss(reason)}
                    transitionEnd={() => owner.transitionEnd()}
                  />
                </Loading>
              </Errored>
            );
          }}
        </Show>
      );
    },
    {
      properties: {
        toast: { default: null, attribute: false },
        active: { default: false, attribute: false },
      },
      connected: (host) => toastOwnerFor(host).connect(),
      disconnected: (host) => toastOwnerFor(host).disconnect(),
      propertyChanged: (host) => toastOwnerFor(host).afterPropertyChange(),
      methods: { show: (host, options) => toastOwnerFor(host).show(options) },
    },
  );
}

declare global {
  interface HTMLElementTagNameMap {
    "openclaw-toast-host": SolidBridgeElement<ToastProperties, ToastMethods>;
  }
}
