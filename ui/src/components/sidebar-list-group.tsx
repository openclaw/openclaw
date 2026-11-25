import type { JSX } from "@solidjs/web";
import { Show } from "solid-js";
import { Icon } from "./solid/icon.tsx";

/** A collapsible group of a section sidebar's rows, under the Sessions sidebar's group heading. */
export function SidebarListGroup(props: {
  label: string;
  open: boolean;
  onToggle: () => void;
  children: JSX.Element;
}): JSX.Element {
  return (
    <div class="sidebar-list-group" role="group" aria-label={props.label}>
      <div class="sidebar-recent-sessions__head">
        <button
          type="button"
          class="sidebar-session-group-toggle"
          aria-expanded={props.open ? "true" : "false"}
          onClick={() => props.onToggle()}
        >
          <span class="sidebar-session-group-toggle__lead" aria-hidden="true">
            <span class="sidebar-session-group-toggle__icon">
              <Icon name={props.open ? "chevronDown" : "chevronRight"} />
            </span>
          </span>
          <span class="sidebar-recent-sessions__label-text">{props.label}</span>
        </button>
      </div>
      <Show when={props.open}>{props.children}</Show>
    </div>
  );
}
