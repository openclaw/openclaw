import { createMemo, Show } from "solid-js";
import { KeyboardShortcut } from "../../../components/solid/kbd.tsx";
import type { MenuEntry } from "../../../components/solid/menu.tsx";
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
  const entry = createMemo(() =>
    chatQuickActionEntry(props.action, props.value, props.layout, props.slot),
  );
  const command = () => {
    const current = entry();
    return current.kind === "content" ? undefined : current;
  };
  const status = () => {
    const current = entry();
    return current.kind === "content" ? current.content : undefined;
  };
  return (
    <Show when={command()} fallback={status()}>
      {(item) => (
        <wa-dropdown-item
          slot={props.slot}
          class={item().class}
          value={item().id}
          aria-label={props.layout ? item().label : undefined}
          type={item().type === "checkbox" ? "checkbox" : undefined}
          prop:checked={item().checked ?? false}
          prop:disabled={item().disabled}
          variant={item().variant}
        >
          <span slot="icon">{item().icon}</span>
          {item().content}
          <Show when={item().details}>
            <span slot="details">{item().details}</span>
          </Show>
        </wa-dropdown-item>
      )}
    </Show>
  );
}

/** Native menu consumers share the same quick-action presentation as remaining legacy menus. */
export function chatQuickActionEntry(
  action: ChatQuickAction,
  id: string,
  layout = false,
  slot?: string,
): Exclude<MenuEntry, { kind: "group" }> {
  const label = (
    <span class="session-menu__text">
      {action.label}
      <Show when={action.description}>
        <span class="session-menu__description">{action.description}</span>
      </Show>
    </span>
  );
  if (action.kind === "status") {
    return {
      kind: "content",
      id,
      content: (
        <div slot={slot} class="session-menu__status" data-menu-status={action.id} role="note">
          <span class="session-menu__check" aria-hidden="true">
            <LitContent value={action.icon} />
          </span>
          {label}
        </div>
      ),
    };
  }
  return {
    id,
    label: action.label,
    class: `session-menu__item${layout && action.className ? ` ${action.className}` : ""}`,
    type: action.active === undefined ? undefined : "checkbox",
    checked: action.active,
    disabled: action.disabled,
    variant: layout ? undefined : action.variant,
    icon: (
      <span class="session-menu__icon" aria-hidden="true">
        <LitContent value={action.icon} />
      </span>
    ),
    content: label,
    details:
      layout && action.shortcut ? (
        <KeyboardShortcut combo={action.shortcut} class="side-panel-type-option__shortcut" />
      ) : undefined,
  };
}
