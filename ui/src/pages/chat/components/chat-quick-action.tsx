import { Show } from "solid-js";
import { KeyboardShortcut } from "../../../components/solid/kbd.tsx";
import type { KeyboardShortcutCombo } from "../../../lib/keyboard-shortcut-contract.ts";
import { LitContent, type LegacyTemplateResult } from "../../../lit/solid-content.tsx";

export type HeaderMenuSessionAction = {
  id: string;
  label: string;
  icon: LegacyTemplateResult;
  description?: string;
  variant?: "danger";
  disabled?: boolean;
  onActivate: () => void;
};

export type HeaderMenuQuickAction =
  | (HeaderMenuSessionAction & { kind?: "action"; active?: boolean })
  | { kind: "status"; id: string; label: string; icon: LegacyTemplateResult; description?: string };

export type ChatQuickAction = HeaderMenuQuickAction & {
  className?: string;
  shortcut?: KeyboardShortcutCombo;
};

export function ChatQuickActionItem(props: {
  action: ChatQuickAction;
  value: string;
  slot?: string;
  layout?: boolean;
}) {
  const command = () => (props.action.kind === "status" ? null : props.action);
  const label = () => (
    <span class="session-menu__text">
      {props.action.label}
      <Show when={props.action.description}>
        <span class="session-menu__description">{props.action.description}</span>
      </Show>
    </span>
  );
  return (
    <Show
      when={command()}
      fallback={
        <div
          slot={props.slot}
          class="session-menu__status"
          data-menu-status={props.action.id}
          role="note"
        >
          <span class="session-menu__check" aria-hidden="true">
            <LitContent value={props.action.icon} />
          </span>
          {label()}
        </div>
      }
    >
      {(action) => (
        <wa-dropdown-item
          slot={props.slot}
          class={["session-menu__item", props.layout ? action().className : undefined]}
          value={props.value}
          aria-label={props.layout ? action().label : undefined}
          type={action().active === undefined ? undefined : "checkbox"}
          prop:checked={action().active ?? false}
          prop:disabled={action().disabled}
          variant={props.layout ? undefined : action().variant}
        >
          <span slot="icon" class="session-menu__icon" aria-hidden="true">
            <LitContent value={action().icon} />
          </span>
          {label()}
          <Show when={props.layout ? action().shortcut : undefined}>
            {(shortcut) => (
              <KeyboardShortcut
                combo={shortcut()}
                slot="details"
                class="side-panel-type-option__shortcut"
              />
            )}
          </Show>
        </wa-dropdown-item>
      )}
    </Show>
  );
}
