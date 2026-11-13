import type { JSX } from "@solidjs/web";
import { omit, Show } from "solid-js";
import { t } from "../../lib/reactive/i18n.ts";
import { Icon } from "./icon.tsx";

export type InlineAlertTone = "danger" | "warning" | "info" | "success";

const TONE_CLASS: Record<InlineAlertTone, string> = {
  danger: "danger",
  warning: "warn",
  info: "info",
  success: "success",
};

/**
 * Shared inline alert for errors, warnings, notes and confirmations that sit in
 * the page flow. Tone is the only signal: no icon and no tinted border.
 * Placement stays with the caller: a section failure above its group, a page
 * failure inside the page content so navigation remains, a field error under
 * its field. Toasts and plain muted notes are separate surfaces.
 */
export function InlineAlert(
  props: Omit<JSX.HTMLAttributes<HTMLDivElement>, "title" | "role"> & {
    tone: InlineAlertTone;
    title?: JSX.Element;
    /** Trailing control, usually a small button such as Retry. */
    action?: JSX.Element;
    onDismiss?: () => void;
    dismissLabel?: string;
    /** Denser form for popovers and menus. */
    compact?: boolean;
    /** Defaults to `alert` for danger and `status` otherwise; `none` drops the live role. */
    role?: "alert" | "status" | "note" | "none";
  },
) {
  const attributes = omit(
    props,
    "tone",
    "title",
    "action",
    "onDismiss",
    "dismissLabel",
    "compact",
    "role",
    "class",
    "children",
  );
  const liveRole = () => {
    const role = props.role ?? (props.tone === "danger" ? "alert" : "status");
    return role === "none" ? undefined : role;
  };
  const hasAction = () => props.action != null;
  return (
    <div
      {...attributes}
      class={[
        "callout",
        TONE_CLASS[props.tone],
        {
          "callout--action": hasAction(),
          "callout--dismissible": Boolean(props.onDismiss),
          "callout--compact": props.compact,
        },
        props.class,
      ]}
      role={liveRole()}
    >
      <Show when={hasAction() || props.onDismiss || props.title != null} fallback={props.children}>
        <div class="callout__body">
          <div class="callout__content">
            <Show when={props.title != null}>
              <strong class="callout__title">{props.title}</strong>
            </Show>
            {props.children}
          </div>
          <Show when={hasAction()}>
            <div class="callout__action">{props.action}</div>
          </Show>
        </div>
        <Show when={props.onDismiss}>
          {(onDismiss) => (
            <button
              type="button"
              class="callout__dismiss"
              aria-label={props.dismissLabel ?? t("common.dismiss")}
              onClick={() => onDismiss()()}
            >
              <Icon name="x" />
            </button>
          )}
        </Show>
      </Show>
    </div>
  );
}
