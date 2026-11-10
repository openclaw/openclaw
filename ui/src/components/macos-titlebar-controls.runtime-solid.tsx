import type { JSX } from "@solidjs/web";
import { Show } from "solid-js";
import { beginNativeWindowDrag } from "../app/native-window-drag.ts";
import { t } from "../lib/reactive/i18n.ts";
import { defineSolidBridge } from "../lib/solid-bridge.ts";
import { Icon, type IconName } from "./solid/icon.tsx";
import "./tooltip.ts";

type Props = {
  historyOnly: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  macNavigation: boolean;
  navigationExpanded: boolean;
  onToggleSidebar: (() => void) | undefined;
  newSessionAction: (() => JSX.Element) | undefined;
};

function TitlebarButton(props: {
  label: string;
  icon: IconName;
  disabled?: boolean;
  expanded?: boolean;
  onClick?: () => void;
  class: string;
}) {
  return (
    <openclaw-tooltip prop:content={props.label}>
      <button
        type="button"
        class={["topbar-icon-btn macos-titlebar-controls__button", props.class]}
        aria-label={props.label}
        aria-expanded={props.expanded === undefined ? undefined : props.expanded ? "true" : "false"}
        disabled={props.disabled || !props.onClick}
        onClick={() => props.onClick?.()}
      >
        <Icon name={props.icon} />
      </button>
    </openclaw-tooltip>
  );
}

export const MacosTitlebarControls = defineSolidBridge<Props>(
  "openclaw-macos-titlebar-controls",
  (props, host) => {
    host.style.display = "contents";
    return (
      <nav
        class={[
          "macos-titlebar-controls",
          {
            "macos-titlebar-controls--history-only": props.historyOnly,
            "macos-titlebar-controls--navigation": props.macNavigation,
          },
        ]}
        onMouseDown={beginNativeWindowDrag}
      >
        <TitlebarButton
          label={t("nav.back")}
          icon={props.macNavigation ? "arrowLeft" : "chevronLeft"}
          disabled={!props.canGoBack}
          onClick={() => globalThis.history.back()}
          class="macos-titlebar-controls__back"
        />
        <TitlebarButton
          label={t("nav.forward")}
          icon={props.macNavigation ? "arrowRight" : "chevronRight"}
          disabled={!props.canGoForward}
          onClick={() => globalThis.history.forward()}
          class="macos-titlebar-controls__forward"
        />
        <Show when={props.macNavigation && !props.historyOnly}>
          <TitlebarButton
            label={t(props.navigationExpanded ? "nav.collapse" : "nav.expand")}
            icon={props.navigationExpanded ? "panelLeftClose" : "sessionSidebarOpen"}
            expanded={props.navigationExpanded}
            onClick={() => props.onToggleSidebar?.()}
            class="macos-titlebar-controls__sidebar"
          />
          <Show when={!props.navigationExpanded}>{props.newSessionAction?.()}</Show>
        </Show>
      </nav>
    );
  },
  {
    properties: {
      historyOnly: { default: false, attribute: false },
      canGoBack: { default: false, attribute: false },
      canGoForward: { default: false, attribute: false },
      macNavigation: { default: false, attribute: false },
      navigationExpanded: { default: false, attribute: false },
      onToggleSidebar: { default: undefined, attribute: false },
      newSessionAction: { default: undefined, attribute: false },
    },
  },
);
