import type { JSX } from "@solidjs/web";
import { Icon, type IconName } from "../../../components/solid/icon.tsx";
import type { MenuEntry, MenuItem } from "../../../components/solid/menu.tsx";
import { registerChatComposerEnglish } from "../../../i18n/locales/en-chat-composer.ts";
import { registerEnglishCatalog, t } from "../../../lib/reactive/i18n.ts";

registerEnglishCatalog(registerChatComposerEnglish);

export function menuDivider(id: string): MenuEntry {
  return {
    kind: "content",
    id,
    content: <div class="agent-chat__capability-menu-divider" role="separator" />,
  };
}

export function renderCapabilityMenuState(
  id: string,
  message: JSX.Element,
  role?: "status" | "alert",
): MenuEntry {
  return {
    kind: "content",
    id,
    content: (
      <div class="agent-chat__capability-menu-state" role={role}>
        {message}
      </div>
    ),
  };
}

export function renderBackRow(): MenuItem {
  return {
    id: "back",
    label: t("chat.composer.menu.back"),
    class: "agent-chat__capability-menu-item",
    icon: <Icon name="arrowLeft" />,
    closeOnSelect: false,
  };
}

export function renderCapabilityToggleRow(options: {
  value: string;
  label: string;
  checked: boolean;
  disabled: boolean;
  title?: string | null;
  icon?: IconName;
  note?: string | null;
  sessionNote?: string;
  checkbox?: boolean;
}): MenuItem {
  return {
    id: options.value,
    label: [options.label, options.note, options.sessionNote].filter(Boolean).join(" "),
    type: "checkbox",
    checked: options.checked,
    disabled: options.disabled,
    class: [
      "agent-chat__capability-menu-item agent-chat__capability-menu-toggle",
      {
        "agent-chat__capability-menu-toggle--switch": !options.checkbox,
      },
    ],
    attributes: { title: options.title ?? "" },
    icon: options.icon ? <Icon name={options.icon} /> : undefined,
    content: (
      <span class="agent-chat__capability-menu-label">
        <span>{options.label}</span>
        {options.note ? (
          <span class="agent-chat__capability-menu-note">
            {options.note}
            {options.sessionNote ? (
              <span class="agent-chat__capability-menu-session-tag">{options.sessionNote}</span>
            ) : null}
          </span>
        ) : null}
      </span>
    ),
    details: options.checkbox ? undefined : (
      <span
        class={[
          "agent-chat__capability-menu-switch chat-controls__speed-toggle",
          {
            "chat-controls__speed-toggle--active": options.checked,
          },
        ]}
        aria-hidden="true"
      >
        <span class="chat-controls__speed-toggle-thumb" />
      </span>
    ),
    closeOnSelect: false,
  };
}
