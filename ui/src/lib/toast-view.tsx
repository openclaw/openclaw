import { createMemo } from "solid-js";
import { Icon } from "../components/solid/icon.tsx";
import { LitContent } from "../lit/solid-content.tsx";
import { formatUiExternalText } from "./format-error.ts";
import { t } from "./reactive/i18n.ts";
import { resolveToastAnchorRect, type ToastOptions, type ToastDismissReason } from "./toast.ts";

/** Unported callers may still supply a Lit template; this span is its only renderer. */
function ToastContent(props: {
  class: string;
  content: ToastOptions["message"];
  hidden?: boolean;
}) {
  return (
    <span class={props.class} aria-hidden={props.hidden ? "true" : undefined}>
      {typeof props.content === "string" ? (
        formatUiExternalText(props.content)
      ) : (
        <LitContent value={props.content} />
      )}
    </span>
  );
}

export function ToastView(props: {
  toast: ToastOptions | null;
  active: boolean;
  host: HTMLElement;
  hover(value: boolean): void;
  focus(value: boolean): void;
  dismiss(reason: ToastDismissReason): void;
  transitionEnd(): void;
}) {
  const anchor = createMemo(() => resolveToastAnchorRect(props.toast?.anchor));
  return (
    <>
      {props.toast ? (
        <div
          class={[
            "app-toast",
            {
              "app-toast--anchored": Boolean(anchor()),
              "app-toast--bottom": !anchor() && props.toast.placement === "bottom",
            },
          ]}
          data-active={props.active ? "true" : "false"}
          style={
            anchor()
              ? {
                  "--app-toast-anchor-center": `${anchor()!.left + anchor()!.width / 2}px`,
                  "--app-toast-anchor-top": `${anchor()!.top}px`,
                  "--app-toast-anchor-width": `${anchor()!.width}px`,
                }
              : {}
          }
          role="status"
          aria-live="polite"
          aria-atomic="true"
          onPointerEnter={() => props.hover(true)}
          onPointerLeave={() => props.hover(false)}
          onFocusIn={() => props.focus(true)}
          onFocusOut={(event) =>
            props.focus(
              event.relatedTarget instanceof Node && props.host.contains(event.relatedTarget),
            )
          }
          onTransitionEnd={(event) => {
            if (event.target === event.currentTarget && event.propertyName === "opacity") {
              props.transitionEnd();
            }
          }}
        >
          {props.toast.icon ? (
            <ToastContent class="app-toast__icon" content={props.toast.icon} hidden />
          ) : undefined}
          <ToastContent class="app-toast__message" content={props.toast.message} />
          {props.toast.actionLabel && props.toast.onAction ? (
            <button
              type="button"
              class="app-toast__action"
              onClick={() => {
                const action = props.toast?.onAction;
                props.dismiss("action");
                action?.();
              }}
            >
              {props.toast.actionLabel}
            </button>
          ) : undefined}
          <button
            type="button"
            class="app-toast__dismiss"
            aria-label={t("common.dismiss")}
            onClick={() => props.dismiss("dismiss")}
          >
            <Icon name="x" />
          </button>
        </div>
      ) : undefined}
    </>
  );
}
