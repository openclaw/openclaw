import { Show } from "solid-js";
import { NAV_DRAWER_TOGGLE_REGISTRATION } from "../../app/navigation-surface.ts";
import { createRouteElementRef } from "../../app/route-element-ref.ts";
import { t } from "../../lib/reactive/i18n.ts";
import {
  SHELL_NAV_DRAWER_TOGGLE_EVENT,
  type ShellNavDrawerToggleDetail,
} from "../command-palette-contract.ts";
import type { GatewayStatusProps } from "../gateway-status.ts";
import { Icon } from "./icon.tsx";

/**
 * The narrow-layout drawer button. The shell topbar and both mobile chat
 * headers render this one control, so moving between routes or out of
 * session creation never swaps its appearance.
 */
export function MobileNavToggle(props: {
  class: string;
  open: boolean;
  /** Badges the button where the header has no other connection indicator. */
  status?: GatewayStatusProps["kind"];
  /** The shell topbar toggles directly; page headers ask the shell through its event. */
  onToggle?: (trigger: HTMLElement) => void;
}) {
  const ref = createRouteElementRef(NAV_DRAWER_TOGGLE_REGISTRATION);
  return (
    <button
      ref={ref}
      type="button"
      class={["mobile-nav-toggle", props.class]}
      aria-label={props.open ? t("nav.collapse") : t("nav.expand")}
      aria-expanded={props.open ? "true" : "false"}
      data-connection-status={props.status ?? undefined}
      onClick={(event) => {
        const trigger = event.currentTarget;
        if (props.onToggle) {
          props.onToggle(trigger);
          return;
        }
        window.dispatchEvent(
          new CustomEvent<ShellNavDrawerToggleDetail>(SHELL_NAV_DRAWER_TOGGLE_EVENT, {
            detail: { trigger },
          }),
        );
      }}
    >
      <Icon name="sessionMenu" />
      <Show when={props.status}>
        <span class="gateway-status-dot" aria-hidden="true" />
      </Show>
    </button>
  );
}
