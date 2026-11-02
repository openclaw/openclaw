import type { JSX } from "@solidjs/web";
import { Show } from "solid-js";
import { Icon } from "./icon.tsx";

/** One disclosure for settings: a row that opens to more rows in the same group. */
export function SettingsDisclosure(props: {
  id?: string;
  class?: string;
  title: JSX.Element;
  description?: JSX.Element;
  open?: boolean;
  onToggle?: JSX.EventHandler<HTMLDetailsElement, Event>;
  children?: JSX.Element;
}) {
  return (
    <details
      id={props.id}
      class={["settings-group settings-disclosure", props.class]}
      open={props.open}
      onToggle={(event) => props.onToggle?.(event)}
    >
      <summary class="settings-row settings-row--nav settings-disclosure__summary">
        <div class="settings-row__text">
          <span class="settings-row__title">{props.title}</span>
          <Show when={props.description}>
            <span class="settings-row__desc">{props.description}</span>
          </Show>
        </div>
        <div class="settings-row__control">
          <span class="settings-row__chevron settings-disclosure__chevron">
            <Icon name="chevronRight" />
          </span>
        </div>
      </summary>
      {props.children}
    </details>
  );
}
