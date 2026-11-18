import type { JSX } from "@solidjs/web";
import { createMemo, onSettled } from "solid-js";
import { isPhoneLayout, PHONE_LAYOUT_QUERY } from "../../lib/phone-layout.ts";
import { createMediaQuery } from "../../lib/reactive/platform.ts";
import { createScrollPosition } from "../../lib/reactive/scroll-state.ts";
import { reclaimHubTabFocus, rememberHubTabFocus } from "../hub-tabs-focus.ts";
import { useScrollState } from "./scroll-state.ts";
import { Tabs } from "./tabs.tsx";
import "../../styles/hub-tabs.css";
import hubStyles from "../../styles/hub-tabs.css?inline";

export type HubTabsProps<T extends string> = {
  id: string;
  active: T | null;
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
  class?: string;
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
      className: ["hub-tab", { "oc-segmented-item": props.carapace }],
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
  let strip!: HTMLElement;
  let tabElement!: (value: string) => HTMLElement | undefined;
  onSettled(() => {
    if (props.active !== null) {
      reclaimHubTabFocus(props.id, props.active, tabElement(props.active));
    }
  });
  const scrollState = useScrollState(true);
  const phone = createMediaQuery(PHONE_LAYOUT_QUERY, isPhoneLayout());
  // Keyed to a value, so re-rendered tab props can't cancel a reveal that is waiting for its frame.
  // Count badges arrive after mount and can push the active tab back out of view.
  const revealKey = createMemo(() =>
    phone() && props.active !== null
      ? `${props.active}|${props.tabs.map((tab) => tab.count).join(",")}`
      : null,
  );
  // Only the strip scrolls, so the page never moves.
  createScrollPosition(
    () => {
      const key = revealKey();
      return {
        reveal:
          key === null
            ? undefined
            : {
                identity: [key],
                target: () => (props.active !== null ? tabElement(props.active) : undefined),
              },
      };
    },
    { region: () => strip, revealTiming: "animation-frame", revealAxis: "inline" },
  );
  return (
    <Tabs
      ref={(element, findTab) => {
        strip = element;
        tabElement = findTab;
        scrollState(element);
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
        props.class,
      ]}
      onActivate={(value, element, event) => {
        const tab = props.tabs.find((entry) => entry.value === value);
        if (!tab || tab.value === props.active) {
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
