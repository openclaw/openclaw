import { createMemo, Errored, For, lazy, Loading, Show } from "solid-js";
import { redactToolDetail } from "./browser-redact.ts";
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
        <Show when={props.toasts.length > 0}>
          {(_shown) => (
            <Errored
              fallback={(_error, reset) => (
                <div class="app-toast-lanes">
                  <div
                    class="app-toast-lane app-toast-lane--top-center"
                    onPointerEnter={() => owner.hover("top-center", true)}
                    onPointerLeave={() => owner.hover("top-center", false)}
                    onFocusIn={() => owner.focus("top-center", true)}
                    onFocusOut={(event) =>
                      owner.focus(
                        "top-center",
                        event.relatedTarget instanceof Node &&
                          event.currentTarget.contains(event.relatedTarget),
                      )
                    }
                  >
                    <div
                      class="app-toast app-toast--error app-toast--action"
                      data-depth="0"
                      data-active="true"
                      role="alert"
                    >
                      <div class="app-toast__content">
                        <div class="app-toast__body">
                          <span class="app-toast__message">{t("lazyView.errorTitle")}</span>
                          <For each={props.toasts} keyed={(entry) => entry.id}>
                            {(entry) => {
                              const content = createMemo(() => entry().options.message);
                              const message = createMemo(() => {
                                const value = content();
                                if (typeof value === "string") {
                                  return redactToolDetail(value.trim());
                                }
                                const copy = value.cloneNode(true);
                                return copy instanceof DocumentFragment
                                  ? Array.from(copy.childNodes)
                                  : copy;
                              });
                              return (
                                <Show when={entry().active}>
                                  <div>
                                    <span class="app-toast__message">{message()}</span>
                                    <Show when={entry().options.description}>
                                      {(description) => (
                                        <>
                                          {" "}
                                          <span class="app-toast__description">
                                            {redactToolDetail(description().trim())}
                                          </span>
                                        </>
                                      )}
                                    </Show>
                                  </div>
                                </Show>
                              );
                            }}
                          </For>
                        </div>
                        <button class="app-toast__action" type="button" onClick={() => reset()}>
                          {t("common.retry")}
                        </button>
                      </div>
                      <button
                        class="app-toast__dismiss"
                        type="button"
                        aria-label={t("common.dismiss")}
                        onClick={() => owner.dismissAll("dismiss")}
                      >
                        ×
                      </button>
                    </div>
                  </div>
                </div>
              )}
            >
              <Loading>
                <ToastView toasts={props.toasts} open={props.open} owner={owner} />
              </Loading>
            </Errored>
          )}
        </Show>
      );
    },
    {
      properties: {
        toasts: { default: [], attribute: false },
        open: { default: [], attribute: false },
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
