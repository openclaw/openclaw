import type { JSX } from "@solidjs/web";
import { createMemo, onSettled, untrack } from "solid-js";
import { reclaimHubTabFocus, rememberHubTabFocus } from "../hub-tabs-focus.ts";
import { Tabs } from "./tabs.tsx";
import "../../styles/hub-tabs.css";
import hubStyles from "../../styles/hub-tabs.css?inline";

export type HubTabsProps<T extends string> = {
  id: string;
  active: T | null;
  requestedActive?: T;
  tabs: readonly {
    value: T;
    label: JSX.Element;
    badge?: JSX.Element;
    count?: number | null;
    disabled?: boolean;
    testId?: string;
  }[];
  ariaLabel: string;
  panelId: string;
  className?: string;
  carapace?: boolean;
  variant?: "primary" | "sub";
  onSelect: (value: T) => void;
  onActivate?: (element: HTMLElement) => void;
};

export function HubTabs<T extends string>(props: HubTabsProps<T>) {
  const items = createMemo(() =>
    props.tabs.map((tab) => ({
      value: tab.value,
      id: `${props.id}-tab-${tab.value}`,
      panelId: props.panelId,
      disabled: tab.disabled,
      testId: tab.testId,
      className: `hub-tab ${props.carapace ? "oc-segmented-item" : ""}`,
      label: (
        <>
          {tab.label}
          {tab.count == null ? null : (
            <span class="hub-tab__badge hub-tab__badge--count">{tab.count}</span>
          )}
          {tab.badge == null ? null : <span class="hub-tab__badge">{tab.badge}</span>}
        </>
      ),
    })),
  );
  let tablist: HTMLDivElement | undefined;
  onSettled(() => {
    const initial = untrack(() => ({ id: props.id, active: props.active }));
    const selected = [...(tablist?.querySelectorAll<HTMLElement>("[role=tab]") ?? [])].find(
      (tab) => tab.dataset.tabValue === initial.active,
    );
    if (initial.active !== null) {
      reclaimHubTabFocus(initial.id, initial.active, selected);
    }
  });
  return (
    <Tabs
      ref={(node) => {
        tablist = node;
      }}
      id={`${props.id}-tabs`}
      shadowStyles={[hubStyles]}
      items={items()}
      active={props.active}
      activation="manual"
      ariaLabel={props.ariaLabel}
      class={[
        "hub-tabs",
        `hub-tabs--${props.variant ?? "primary"}`,
        `${props.id}-hub-tabs`,
        { "oc-segmented": props.carapace },
        props.className,
      ]}
      onActivate={(value, element, event) => {
        const tab = props.tabs.find((entry) => entry.value === value);
        if (!tab || tab.value === (props.requestedActive ?? props.active)) {
          return false;
        }
        if (event instanceof KeyboardEvent) {
          rememberHubTabFocus(props.id, tab.value, element);
        }
        props.onSelect(tab.value);
        props.onActivate?.(element);
        return false;
      }}
    />
  );
}
