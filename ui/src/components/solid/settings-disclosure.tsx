import type { JSX } from "@solidjs/web";
import { createSignal, Show } from "solid-js";
import { Icon } from "./icon.tsx";
import { IconButton } from "./icon-button.tsx";
import { SettingsRow } from "./settings-ui.tsx";

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

/**
 * A row whose details belong to it, such as an account and its connection facts. The chevron
 * sits after the row's action and opens indented rows under it, so the details need no row
 * of their own.
 */
export function SettingsDetailsRow(props: {
  title: JSX.Element;
  description?: JSX.Element;
  control?: JSX.Element;
  /** Names the chevron for assistive tech and its tooltip, for example "Connection details". */
  detailsLabel: string;
  /** False hides the chevron while there is nothing to show. */
  hasDetails?: boolean;
  children?: JSX.Element;
}) {
  const [open, setOpen] = createSignal(false, { ownedWrite: true });
  const available = () => props.hasDetails !== false;
  return (
    <>
      <SettingsRow
        title={props.title}
        description={props.description}
        control={
          <>
            {props.control}
            <Show when={available()}>
              <openclaw-tooltip prop:content={props.detailsLabel}>
                <IconButton
                  size={28}
                  glyph="row"
                  class="settings-details-toggle"
                  icon="chevronRight"
                  label={props.detailsLabel}
                  tooltip={false}
                  aria-expanded={open() ? "true" : "false"}
                  onClick={() => setOpen(!open())}
                />
              </openclaw-tooltip>
            </Show>
          </>
        }
      />
      <Show when={available() && open()}>
        <div class="settings-subrows">{props.children}</div>
      </Show>
    </>
  );
}
