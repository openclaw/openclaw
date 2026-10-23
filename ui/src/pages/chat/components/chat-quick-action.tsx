import { createMemo, mapArray, merge, Show, type Accessor } from "solid-js";
import { Icon, type IconName } from "../../../components/solid/icon.tsx";
import { KeyboardShortcut } from "../../../components/solid/kbd.tsx";
import type { MenuEntry } from "../../../components/solid/menu.tsx";
import type { KeyboardShortcutCombo } from "../../../lib/keyboard-shortcut-contract.ts";

export type HeaderMenuSessionAction = {
  id: string;
  label: string;
  icon: IconName;
  description?: string;
  variant?: "danger";
  disabled?: boolean;
  onActivate: () => void | Promise<void>;
};

export type HeaderMenuQuickAction =
  | (HeaderMenuSessionAction & { kind?: "action"; active?: boolean })
  | { kind: "status"; id: string; label: string; icon: IconName; description?: string };

export type ChatQuickAction = HeaderMenuQuickAction & {
  className?: string;
  shortcut?: KeyboardShortcutCombo;
};

export function useChatQuickActionEntries(
  actions: Accessor<readonly ChatQuickAction[]>,
  layout = false,
  prefix = "",
): Accessor<readonly MenuEntry[]> {
  const entries = createMemo(
    () =>
      mapArray(
        actions,
        (current) => {
          const action = merge(current);
          const label = (
            <span class="session-menu__text">
              {action.label}
              <Show when={action.description}>
                <span class="session-menu__description">{action.description}</span>
              </Show>
            </span>
          );
          const icon = (
            <span class="session-menu__icon" aria-hidden="true">
              <Icon name={action.icon} />
            </span>
          );
          const shortcut = (
            <Show when={action.shortcut}>
              {(combo) => (
                <KeyboardShortcut combo={combo()} class="side-panel-type-option__shortcut" />
              )}
            </Show>
          );
          const status = createMemo(
            () => (
              <div class="session-menu__status" data-menu-status={action.id} role="note">
                <span class="session-menu__check" aria-hidden="true">
                  <Icon name={action.icon} />
                </span>
                {label}
              </div>
            ),
            { lazy: true },
          );
          return createMemo((): MenuEntry => {
            const id = `${prefix}${action.id}`;
            if (action.kind === "status") {
              return { kind: "content", id, content: status() };
            }
            return {
              id,
              label: action.label,
              class: ["session-menu__item", layout && action.className],
              type: action.active === undefined ? undefined : "checkbox",
              checked: action.active,
              disabled: action.disabled,
              variant: layout ? undefined : action.variant,
              icon,
              content: label,
              details: layout && action.shortcut ? shortcut : undefined,
            };
          });
        },
        { keyed: (action) => action.id },
      ),
    { lazy: true },
  );
  return createMemo(() => entries()().map((entry) => entry()), { lazy: true });
}
