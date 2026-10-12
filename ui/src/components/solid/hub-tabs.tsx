import type { JSX } from "@solidjs/web";
import { createEffect, For, onSettled } from "solid-js";
import "../../styles/hub-tabs.css";
import { syncTabGroupLabel } from "../web-awesome-tabs.ts";

type HubTabOption<T extends string> = {
  value: T;
  label: JSX.Element;
  badge?: JSX.Element;
  count?: number | null;
  disabled?: boolean;
  testId?: string;
};
export type HubTabsProps<T extends string> = {
  id: string;
  active: T | null;
  requestedActive?: T;
  tabs: ReadonlyArray<HubTabOption<T>>;
  ariaLabel: string;
  panelId: string;
  className?: string;
  carapace?: boolean;
  variant?: "primary" | "sub";
  onSelect: (tab: T) => void;
  onActivate?: (element: HTMLElement) => void;
};

const PENDING_FOCUS_WINDOW_MS = 2000;
const NO_ACTIVE_TAB = "__openclaw-hub-tabs-no-active__";
let pendingFocus: { hubId: string; tab: string; at: number; source: Element } | null = null;

function HubTab<T extends string>(props: { hub: HubTabsProps<T>; tab: HubTabOption<T> }) {
  let element: HTMLElement | undefined;
  const selected = () => props.hub.active === props.tab.value;
  const fallbackFocus = () =>
    props.hub.active === null ? props.hub.tabs.find((tab) => !tab.disabled)?.value : null;
  const activate = (event: MouseEvent | KeyboardEvent, keyboard = false) => {
    const target = event.currentTarget;
    if (
      !(target instanceof HTMLElement) ||
      props.tab.disabled ||
      props.tab.value === (props.hub.requestedActive ?? props.hub.active)
    ) {
      return;
    }
    if (keyboard) {
      event.preventDefault();
      pendingFocus = { hubId: props.hub.id, tab: props.tab.value, at: Date.now(), source: target };
    }
    props.hub.onSelect(props.tab.value);
    props.hub.onActivate?.(target);
  };
  onSettled(() => {
    if (
      !selected() ||
      pendingFocus?.hubId !== props.hub.id ||
      pendingFocus.tab !== props.tab.value
    ) {
      return;
    }
    const pending = pendingFocus;
    pendingFocus = null;
    const focus = document.activeElement;
    if (
      element?.isConnected &&
      Date.now() - pending.at <= PENDING_FOCUS_WINDOW_MS &&
      (focus === pending.source || focus === document.body || focus === document.documentElement)
    ) {
      element.focus();
    }
  });
  return (
    <wa-tab
      ref={(node) => {
        element = node;
      }}
      id={`${props.hub.id}-tab-${props.tab.value}`}
      panel={props.tab.value}
      aria-controls={props.hub.panelId}
      class={["hub-tab", { "oc-segmented-item": props.hub.carapace }]}
      active={selected()}
      disabled={props.tab.disabled}
      prop:tabIndex={selected() || props.tab.value === fallbackFocus() ? 0 : -1}
      aria-selected={selected() ? "true" : "false"}
      data-test-id={props.tab.testId}
      onClick={(event: MouseEvent) => {
        if (event.detail > 0 || event.isTrusted) {
          activate(event);
        }
      }}
      onKeyDown={(event: KeyboardEvent) => {
        if (!event.repeat && (event.key === "Enter" || event.key === " ")) {
          activate(event, true);
        }
      }}
    >
      {props.tab.label}
      {props.tab.count == null ? null : (
        <span class="hub-tab__badge hub-tab__badge--count">{props.tab.count}</span>
      )}
      {props.tab.badge == null ? null : <span class="hub-tab__badge">{props.tab.badge}</span>}
    </wa-tab>
  );
}

export function HubTabs<T extends string>(props: HubTabsProps<T>) {
  let group: HTMLElement | undefined;
  createEffect(
    () => props.ariaLabel,
    (label) => syncTabGroupLabel(group, label),
  );
  return (
    <wa-tab-group
      ref={(node) => {
        group = node;
      }}
      class={[
        "hub-tabs",
        `hub-tabs--${props.variant ?? "primary"}`,
        `${props.id}-hub-tabs`,
        props.className,
        { "oc-segmented": props.carapace },
      ]}
      aria-label={props.ariaLabel}
      prop:active={props.active ?? NO_ACTIVE_TAB}
      activation="manual"
      without-scroll-controls
    >
      <For each={props.tabs} keyed={(tab) => tab.value}>
        {(tab) => <HubTab hub={props} tab={tab()} />}
      </For>
    </wa-tab-group>
  );
}
