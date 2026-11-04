import { createMemo, onSettled } from "solid-js";
import { Icon, type IconName } from "../components/solid/icon.tsx";
import { AgentIdentityAvatar } from "../components/solid/identity-avatar.tsx";
import { formatUiExternalText } from "./format-error.ts";
import { shouldHandleNavigationClick } from "./navigation-click.ts";
import { t } from "./reactive/i18n.ts";
import {
  resolveToastAnchorRect,
  type ToastOptions,
  type ToastDismissReason,
  type ToastSeverity,
} from "./toast.ts";

const SEVERITY_ICONS = {
  success: "circleCheck",
  info: "info",
  warning: "alertTriangle",
  error: "circleAlert",
  progress: "loaderCircle",
} as const satisfies Record<ToastSeverity, IconName>;

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
              "app-toast--success": props.toast.severity === "success",
              "app-toast--info": props.toast.severity === "info",
              "app-toast--warning": props.toast.severity === "warning",
              "app-toast--error": props.toast.severity === "error",
              "app-toast--progress": props.toast.severity === "progress",
              "app-toast--avatar": Boolean(props.toast.avatar),
              "app-toast--action": Boolean(props.toast.actionLabel && props.toast.onAction),
              "app-toast--bottom": !anchor() && props.toast.placement === "bottom",
              "app-toast--top-center": !anchor() && props.toast.placement === "top-center",
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
          role={props.toast.severity === "error" ? "alert" : "status"}
          aria-live={props.toast.severity === "error" ? "assertive" : "polite"}
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
          ) : props.toast.severity ? (
            <span class="app-toast__icon" aria-hidden="true">
              <Icon name={SEVERITY_ICONS[props.toast.severity]} />
            </span>
          ) : undefined}
          <div class="app-toast__content">
            <div class="app-toast__body">
              <span class="app-toast__message">{message()}</span>
              {props.toast.description ? (
                <span class="app-toast__description">
                  {formatUiExternalText(props.toast.description)}
                </span>
              ) : undefined}
            </div>
            {props.toast.actionLabel && props.toast.onAction ? (
              props.toast.actionHref ? (
                <a
                  class={[
                    "app-toast__action",
                    { "app-toast__action--primary": props.toast.actionPrimary },
                  ]}
                  href={props.toast.actionHref}
                  onClick={(event) => {
                    const action = props.toast?.onAction;
                    if (shouldHandleNavigationClick(event)) {
                      props.dismiss("action");
                    }
                    action?.(event);
                  }}
                  onAuxClick={(event) => props.toast?.onAction?.(event)}
                  onContextMenu={(event) => props.toast?.onAction?.(event)}
                >
                  {props.toast.actionLabel}
                </a>
              ) : (
                <button
                  type="button"
                  class={[
                    "app-toast__action",
                    { "app-toast__action--primary": props.toast.actionPrimary },
                  ]}
                  onClick={() => {
                    const action = props.toast?.onAction;
                    props.dismiss("action");
                    action?.();
                  }}
                >
                  {props.toast.actionLabel}
                </button>
              )
            ) : undefined}
          </div>
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
