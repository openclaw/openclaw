import { createComponent, createEffect, lazy, Loading, Show } from "solid-js";
import { defineSolidBridge, type SolidBridgeElement } from "./solid-bridge.ts";
import { toastControllerFor, type ToastProperties, type ToastMethods } from "./toast.ts";

const ToastView = lazy(() => import("./toast-view.tsx"), { export: "ToastView" });

// Rendering modules also load in Node tests.
if (typeof customElements !== "undefined") {
  defineSolidBridge<ToastProperties, ToastMethods>(
    "openclaw-toast-host",
    (props, host) => {
      const controller = toastControllerFor(host);
      // Focus after the DOM commit determines whether the existing toast deadline pauses.
      createEffect(
        () => [props.toast, props.active],
        () => controller.updated(),
      );
      return createComponent(Show, {
        get when() {
          return Boolean(props.toast);
        },
        children: (_shown) => {
          return createComponent(Loading, {
            get children() {
              return createComponent(ToastView, {
                get toast() {
                  return props.toast;
                },
                get active() {
                  return props.active;
                },
                host,
                hover: (hovered) => controller.hover(hovered),
                focus: (focused) => controller.syncDismissTimer(focused),
                dismiss: (reason) => controller.dismiss(reason),
                transitionEnd: () => controller.transitionEnd(),
              });
            },
          });
        },
      });
    },
    {
      properties: {
        toast: { default: null, attribute: false },
        active: { default: false, attribute: false },
      },
      connected: (host) => toastControllerFor(host).connect(),
      disconnected: (host) => toastControllerFor(host).disconnect(),
      methods: { show: (host, options) => toastControllerFor(host).show(options) },
    },
  );
}

declare global {
  interface HTMLElementTagNameMap {
    "openclaw-toast-host": SolidBridgeElement<ToastProperties, ToastMethods>;
  }
}
