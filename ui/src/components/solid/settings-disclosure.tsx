import type { JSX } from "@solidjs/web";
import { Show } from "solid-js";
import { Icon } from "./icon.tsx";

/**
 * One disclosure for settings: a row that opens to more rows in the same group.
 * `quiet` is for details inside a surrounding group: a muted row with indented subrows.
 * `sections` opens whole settings sections below the row, since a group can't hold other groups.
 */
export function SettingsDisclosure(props: {
  id?: string;
  class?: string;
  title: JSX.Element;
  description?: JSX.Element;
  open?: boolean;
  quiet?: boolean;
  sections?: boolean;
  onToggle?: JSX.EventHandler<HTMLDetailsElement, Event>;
  children?: JSX.Element;
}) {
  return (
    <details
      id={props.id}
      class={[
        "settings-disclosure",
        { "settings-group": !props.quiet && !props.sections },
        props.class,
      ]}
      open={props.open}
      onToggle={(event) => props.onToggle?.(event)}
    >
      <summary
        class={[
          "settings-row settings-row--nav settings-disclosure__summary",
          { "settings-group": props.sections },
        ]}
      >
        <div class="settings-row__text">
          <span class={props.quiet ? "settings-row__desc" : "settings-row__title"}>
            {props.title}
          </span>
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
      {props.sections ? (
        <div class="settings-stack settings-disclosure__sections">{props.children}</div>
      ) : props.quiet ? (
        <div class="settings-subrows">{props.children}</div>
      ) : (
        props.children
      )}
    </details>
  );
}
