import type { JSX } from "@solidjs/web";
import { Show } from "solid-js";
import { t } from "../lib/reactive/i18n.ts";
import { RelativeTime } from "./relative-time.tsx";
import { sidebarAttentionFocusRef } from "./sidebar-attention-focus.ts";
import { Icon } from "./solid/icon.tsx";

export function SidebarDismissButton(props: {
  itemLabel: string;
  onDismiss?: () => void;
  dismissing?: boolean;
  disabled?: boolean;
}) {
  const label = () => t("attention.dismissItem", { item: props.itemLabel });
  return (
    <Show when={props.onDismiss}>
      <button
        ref={sidebarAttentionFocusRef()}
        type="button"
        class="sidebar-issues-panel__dismiss"
        aria-label={label()}
        aria-busy={props.dismissing ? "true" : undefined}
        title={props.dismissing ? t("attention.mentions.dismissing") : label()}
        disabled={props.disabled || props.dismissing}
        onClick={(event: Event) => {
          event.preventDefault();
          event.stopPropagation();
          props.onDismiss?.();
        }}
      >
        <Icon name="x" />
      </button>
    </Show>
  );
}

/** Title on the left, arrival on the right; the dismiss control takes the time's place on hover. */
export function SidebarRowHeading(props: { title: string; timestampMs?: number | null }) {
  return (
    <span class="sidebar-issues-panel__heading-row">
      <span class="sidebar-issues-panel__entity" title={props.title}>
        {props.title}
      </span>
      {props.timestampMs == null ? null : (
        <RelativeTime class="sidebar-issues-panel__age" timestampMs={props.timestampMs} />
      )}
    </span>
  );
}

export function SidebarNotificationCard(props: {
  title: string;
  detail: string;
  timestampMs?: number | null;
  icon: JSX.Element;
  severity?: "error" | "warning";
  dismissing?: boolean;
  dismissDisabled?: boolean;
  onDismiss?: () => void;
  onToggle?: (open: boolean) => void;
  body: JSX.Element;
  bodyClass?: string;
}) {
  return (
    <details
      class={[
        "sidebar-issues-panel__details",
        props.severity && `sidebar-issues-panel__details--${props.severity}`,
      ]}
      onToggle={(event) => props.onToggle?.(event.currentTarget.open)}
    >
      <summary
        ref={sidebarAttentionFocusRef("row")}
        class="sidebar-issues-panel__summary"
        data-issue-row-focus
      >
        <span class="sidebar-issues-panel__icon" aria-hidden="true">
          {props.icon}
        </span>
        <span class="sidebar-issues-panel__content">
          <SidebarRowHeading title={props.title} timestampMs={props.timestampMs} />
          <span class="sidebar-issues-panel__state" title={props.detail}>
            {props.detail}
          </span>
        </span>
        <SidebarDismissButton
          itemLabel={props.title}
          onDismiss={props.onDismiss}
          dismissing={props.dismissing}
          disabled={props.dismissDisabled}
        />
      </summary>
      <div class={["sidebar-issues-panel__body", props.bodyClass]}>{props.body}</div>
    </details>
  );
}
