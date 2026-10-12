import type { JSX } from "@solidjs/web";
import { Show } from "solid-js";
import { t } from "../lib/reactive/i18n.ts";
import { RelativeTime } from "./relative-time.tsx";
import { Icon } from "./solid/icon.tsx";

export function SidebarDismissButton(props: {
  itemLabel: string;
  onDismiss?: () => void;
  dismissing?: boolean;
}) {
  const label = () => t("attention.dismissItem", { item: props.itemLabel });
  return (
    <Show when={props.onDismiss}>
      <button
        type="button"
        class="sidebar-issues-panel__dismiss"
        aria-label={label()}
        aria-busy={props.dismissing ? "true" : undefined}
        title={props.dismissing ? t("attention.mentions.dismissing") : label()}
        disabled={props.dismissing}
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

export function SidebarNotificationCard(props: {
  title: string;
  detail: string;
  timestampMs?: number | null;
  icon: JSX.Element;
  severity?: "error" | "warning";
  critical?: boolean;
  dismissing?: boolean;
  onDismiss?: () => void;
  body: JSX.Element;
  bodyClass?: string;
}) {
  return (
    <details
      class={[
        "sidebar-issues-panel__details",
        props.severity && `sidebar-issues-panel__details--${props.severity}`,
      ]}
    >
      <summary class="sidebar-issues-panel__summary" data-issue-row-focus>
        <span
          class={[
            "sidebar-issues-panel__icon",
            { "sidebar-issues-panel__icon--critical": props.critical },
          ]}
          aria-hidden="true"
        >
          {props.icon}
        </span>
        <span class="sidebar-issues-panel__content">
          <span class="sidebar-issues-panel__entity" title={props.title}>
            {props.title}
          </span>
          <span class="sidebar-issues-panel__state-row sidebar-issues-panel__notification-meta">
            <span class="sidebar-issues-panel__state" title={props.detail}>
              {props.detail}
            </span>
            {props.timestampMs == null ? null : (
              <>
                <span aria-hidden="true">·</span>
                <RelativeTime class="sidebar-issues-panel__age" timestampMs={props.timestampMs} />
              </>
            )}
          </span>
        </span>
        <SidebarDismissButton
          itemLabel={props.title}
          onDismiss={props.onDismiss}
          dismissing={props.dismissing}
        />
        <span class="sidebar-issues-panel__chevron" aria-hidden="true">
          <Icon name="chevronRight" />
        </span>
      </summary>
      <div class={["sidebar-issues-panel__body", props.bodyClass]}>{props.body}</div>
    </details>
  );
}
