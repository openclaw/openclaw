import { lazy, Loading, onSettled, Show } from "solid-js";
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
