import type { JSX } from "@solidjs/web";
import { Show } from "solid-js";
import { Icon } from "./icon.tsx";

/**
 * One disclosure for settings: a row that opens to more rows in the same group.
 * `nested` puts that row inside a surrounding group.
 */
export function SettingsDisclosure(props: {
  id?: string;
  class?: string;
  summaryClass?: string;
  title: JSX.Element;
  description?: JSX.Element;
  control?: JSX.Element;
  open?: boolean;
  nested?: boolean;
  onToggle?: JSX.EventHandler<HTMLDetailsElement, Event>;
  children?: JSX.Element;
}) {
  return (
    <details
      id={props.id}
      class={["settings-disclosure", { "settings-group": !props.nested }, props.class]}
      open={props.open}
      onToggle={(event) => props.onToggle?.(event)}
    >
      <summary
        class={["settings-row settings-row--nav settings-disclosure__summary", props.summaryClass]}
      >
        <div class="settings-row__text">
          <span class="settings-row__title">{props.title}</span>
          <Show when={props.description}>
            <span class="settings-row__desc">{props.description}</span>
          </Show>
        </div>
        <div class="settings-row__control">
          {props.control}
          <span class="settings-row__chevron settings-disclosure__chevron">
            <Icon name="chevronRight" />
          </span>
        </div>
      </summary>
      {props.nested ? <div class="settings-subrows">{props.children}</div> : props.children}
    </details>
  );
}
