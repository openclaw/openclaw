import { createMemo, onSettled } from "solid-js";
import { Icon } from "../components/solid/icon.tsx";
import { AgentIdentityAvatar } from "../components/solid/identity-avatar.tsx";
import { formatUiExternalText } from "./format-error.ts";
import { t } from "./reactive/i18n.ts";
import { resolveToastAnchorRect, type ToastOptions, type ToastDismissReason } from "./toast.ts";

export function ToastView(props: {
  toast: ToastOptions | null;
  active: boolean;
  host: HTMLElement;
  bodyRef(element: HTMLElement): void;
  ready(): void;
  hover(value: boolean): void;
  focus(value: boolean): void;
  dismiss(reason: ToastDismissReason): void;
  transitionEnd(): void;
}) {
  onSettled(() => props.ready());
  const anchor = createMemo(() => resolveToastAnchorRect(props.toast?.anchor));
  const content = createMemo(() => props.toast?.message);
  const message = createMemo(() => {
    const value = content();
    if (typeof value === "string") {
      return formatUiExternalText(value);
    }
    // Snapshot only on message changes: inserting a fragment consumes its children.
    return value instanceof DocumentFragment ? Array.from(value.childNodes) : value;
  });
  return (
    <>
      {props.toast ? (
        <div
          ref={(element) => props.bodyRef(element)}
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
          {props.toast.avatar ? (
            <span class="app-toast__avatar" aria-hidden="true">
              <AgentIdentityAvatar agent={props.toast.avatar} />
            </span>
          ) : props.toast.icon ? (
            <span class="app-toast__icon" aria-hidden="true">
              <Icon name={props.toast.icon} />
            </span>
          ) : undefined}
          <span class="app-toast__message">{message()}</span>
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
