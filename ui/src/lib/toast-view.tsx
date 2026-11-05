import { createMemo, createSignal, For, onSettled, Show } from "solid-js";
import { ErrorDetails } from "../components/config-error.tsx";
import { Icon, type IconName } from "../components/solid/icon.tsx";
import { AgentIdentityAvatar } from "../components/solid/identity-avatar.tsx";
import { formatUiExternalText } from "./format-error.ts";
import { shouldHandleNavigationClick } from "./navigation-click.ts";
import { t } from "./reactive/i18n.ts";
import {
  resolveToastAnchorRect,
  TOAST_LANES,
  TOAST_VISIBLE_LIMIT,
  type toastOwnerFor,
  type ToastEntry,
  type ToastLane,
  type ToastPlacement,
  type ToastSeverity,
} from "./toast.ts";
import toastStyles from "../styles/toast.css?inline";

type ToastController = ReturnType<typeof toastOwnerFor>;

const SEVERITY_ICONS = {
  success: "circleCheck",
  info: "info",
  warning: "alertTriangle",
  error: "circleAlert",
  progress: "loaderCircle",
} as const satisfies Record<ToastSeverity, IconName>;

export function ToastView(props: {
  toasts: readonly ToastEntry[];
  open: readonly ToastPlacement[];
  owner: ToastController;
}) {
  const anchored = createMemo(() => props.toasts.filter((entry) => entry.lane === "anchored"));
  return (
    <>
      <style>{toastStyles}</style>
      <div class="app-toast-lanes">
        <For each={TOAST_LANES}>
          {(lane) => (
            <ToastStack
              lane={lane}
              entries={props.toasts.filter((entry) => entry.lane === lane)}
              open={props.open.includes(lane)}
              owner={props.owner}
            />
          )}
        </For>
      </div>
      <div
        ref={(element) => props.owner.laneElement("anchored", element)}
        class="app-toast-anchored"
      >
        <For each={anchored()} keyed={(entry) => entry.id}>
          {(entry) => <ToastCard entry={entry()} open={false} owner={props.owner} />}
        </For>
      </div>
    </>
  );
}

/** Newest in front; the next two peek behind it. Hover, focus or a tap opens the
 * stack into a list, and leaving closes it. */
function ToastStack(props: {
  lane: ToastPlacement;
  entries: readonly ToastEntry[];
  open: boolean;
  owner: ToastController;
}) {
  return (
    <div
      ref={(element) => props.owner.laneElement(props.lane, element)}
      class={["app-toast-lane", `app-toast-lane--${props.lane}`]}
      data-open={props.open ? "" : undefined}
      onPointerEnter={(event) => {
        if (event.pointerType !== "touch") {
          props.owner.hover(props.lane, true);
        }
      }}
      onPointerLeave={(event) => {
        if (event.pointerType !== "touch") {
          props.owner.hover(props.lane, false);
        }
      }}
      onPointerDown={(event) => {
        if (event.pointerType === "touch") {
          props.owner.touch(props.lane);
        }
      }}
      onFocusIn={() => props.owner.focus(props.lane, true)}
      onFocusOut={(event) =>
        props.owner.focus(
          props.lane,
          event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget),
        )
      }
    >
      <For each={props.entries} keyed={(entry) => entry.id}>
        {(entry) => <ToastCard entry={entry()} open={props.open} owner={props.owner} />}
      </For>
    </div>
  );
}

function ToastCard(props: { entry: ToastEntry; open: boolean; owner: ToastController }) {
  const toast = () => props.entry.options;
  const anchor = createMemo(() =>
    props.entry.lane === "anchored" ? resolveToastAnchorRect(toast().anchor) : null,
  );
  const lane = (): ToastLane => props.entry.lane;
  const dismiss = (reason: "action" | "dismiss") => props.owner.dismiss(props.entry.id, reason);
  const content = createMemo(() => toast().message);
  const hasAction = () => Boolean(toast().actionLabel && toast().onAction);
  const [singleRow, setSingleRow] = createSignal(false);
  let contentElement!: HTMLDivElement;
  let bodyElement!: HTMLDivElement;
  let messageElement!: HTMLSpanElement;
  let actionElement: HTMLAnchorElement | HTMLButtonElement | undefined;
  onSettled(() => {
    const measure = () => {
      const action = hasAction() ? actionElement : undefined;
      const titleHeight = messageElement.offsetHeight;
      // Measure the contents, not the card: padding must not feed back into the
      // decision, and collapsed stack cards borrow the newest card's height.
      setSingleRow(
        titleHeight > 0 &&
          titleHeight <= Number.parseFloat(getComputedStyle(messageElement).lineHeight) + 1 &&
          (!action || action.offsetTop < bodyElement.offsetTop + bodyElement.offsetHeight),
      );
    };
    const observer = new ResizeObserver(measure);
    observer.observe(contentElement);
    observer.observe(messageElement);
    measure();
    return () => observer.disconnect();
  });
  // Two-sentence copy reads as a title and a muted description, without rewording.
  const copy = createMemo(() => {
    const value = content();
    const text = typeof value === "string" ? formatUiExternalText(value) : "";
    const split = toast().description ? null : /^(.+?[.!?])\s+(?=\p{Lu})(.+)$/su.exec(text);
    return split
      ? { title: split[1]!, description: split[2]! }
      : { title: text, description: toast().description };
  });
  const message = createMemo(() => {
    const value = content();
    if (typeof value === "string") {
      return copy().title;
    }
    // Snapshot only on message changes: inserting a fragment consumes its children.
    return value instanceof DocumentFragment ? Array.from(value.childNodes) : value;
  });
  return (
    <div
      class={[
        "app-toast",
        {
          "app-toast--anchored": Boolean(anchor()),
          "app-toast--success": toast().severity === "success",
          "app-toast--info": toast().severity === "info",
          "app-toast--warning": toast().severity === "warning",
          "app-toast--error": toast().severity === "error",
          "app-toast--progress": toast().severity === "progress",
          "app-toast--avatar": Boolean(toast().avatar),
          "app-toast--action": hasAction(),
          "app-toast--single-row": !copy().description && toast().detail == null && singleRow(),
        },
      ]}
      data-active={props.entry.active ? "true" : "false"}
      data-depth={props.entry.depth}
      inert={!props.open && (props.entry.depth ?? 0) >= TOAST_VISIBLE_LIMIT}
      tabindex="-1"
      style={
        anchor()
          ? {
              "--app-toast-anchor-center": `${anchor()!.left + anchor()!.width / 2}px`,
              "--app-toast-anchor-top": `${anchor()!.top}px`,
              "--app-toast-anchor-width": `${anchor()!.width}px`,
            }
          : {}
      }
      role={toast().severity === "error" ? "alert" : "status"}
      aria-live={toast().severity === "error" ? "assertive" : "polite"}
      aria-atomic="true"
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.stopPropagation();
          dismiss("dismiss");
        }
      }}
      onPointerEnter={() => {
        if (lane() === "anchored") {
          props.owner.hover("anchored", true);
        }
      }}
      onPointerLeave={() => {
        if (lane() === "anchored") {
          props.owner.hover("anchored", false);
        }
      }}
      onFocusIn={() => {
        if (lane() === "anchored") {
          props.owner.focus("anchored", true);
        }
      }}
      onFocusOut={(event) => {
        if (lane() === "anchored") {
          props.owner.focus(
            "anchored",
            event.relatedTarget instanceof Node &&
              event.currentTarget.contains(event.relatedTarget),
          );
        }
      }}
      onTransitionEnd={(event) => {
        if (
          lane() === "anchored" &&
          event.target === event.currentTarget &&
          event.propertyName === "opacity"
        ) {
          props.owner.transitionEnd(props.entry.id);
        }
      }}
    >
      {toast().avatar ? (
        <span class="app-toast__avatar" aria-hidden="true">
          <AgentIdentityAvatar agent={toast().avatar!} />
        </span>
      ) : toast().severity ? (
        <span class="app-toast__icon" aria-hidden="true">
          <Icon name={SEVERITY_ICONS[toast().severity!]} />
        </span>
      ) : undefined}
      <div class="app-toast__content" ref={(element) => (contentElement = element)}>
        <div class="app-toast__body" ref={(element) => (bodyElement = element)}>
          <span class="app-toast__message" ref={(element) => (messageElement = element)}>
            {message()}
          </span>
          {copy().description ? " " : undefined}
          {copy().description ? (
            <span class="app-toast__description">{formatUiExternalText(copy().description)}</span>
          ) : undefined}
          <Show when={toast()} keyed>
            {(options) => <ErrorDetails error={options.detail} />}
          </Show>
        </div>
        {hasAction() ? (
          toast().actionHref ? (
            <a
              ref={(element) => (actionElement = element)}
              class={["app-toast__action", { "app-toast__action--primary": toast().actionPrimary }]}
              href={toast().actionHref}
              onClick={(event) => {
                const action = toast().onAction;
                if (shouldHandleNavigationClick(event)) {
                  dismiss("action");
                }
                action?.(event);
              }}
              onAuxClick={(event) => toast().onAction?.(event)}
              onContextMenu={(event) => toast().onAction?.(event)}
            >
              {toast().actionLabel}
            </a>
          ) : (
            <button
              ref={(element) => (actionElement = element)}
              type="button"
              class={["app-toast__action", { "app-toast__action--primary": toast().actionPrimary }]}
              onClick={() => {
                const action = toast().onAction;
                dismiss("action");
                action?.();
              }}
            >
              {toast().actionLabel}
            </button>
          )
        ) : undefined}
      </div>
      <button
        type="button"
        class="app-toast__dismiss"
        aria-label={t("common.dismiss")}
        onClick={() => dismiss("dismiss")}
      >
        <Icon name="x" />
      </button>
    </div>
  );
}
