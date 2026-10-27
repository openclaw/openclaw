import type { JSX } from "@solidjs/web";
import { Icon, type IconName } from "../../../components/solid/icon.tsx";
import type { MenuEntry, MenuItem } from "../../../components/solid/menu.tsx";
import "../../../styles/settings-native-controls.css";

export function menuDivider(id: string): Extract<MenuEntry, { kind: "content" }> {
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
): Extract<MenuEntry, { kind: "content" }> {
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
export function menuSection(id: string, title: string, action?: JSX.Element): MenuEntry {
  return {
    kind: "content",
    id,
    content: (
      <div class="agent-chat__capability-menu-section">
        <span>{title}</span>
        {action}
      </div>
    ),
  };
}
export function skillIcon(emoji?: string): JSX.Element {
  return emoji ? (
    <span class="agent-chat__capability-menu-emoji" aria-hidden="true">
      {emoji}
    </span>
  ) : (
    <Icon name="wandSparkles" />
  );
}
export function menuChevron(): JSX.Element {
  return (
    <span class="agent-chat__capability-menu-chevron" aria-hidden="true">
      <Icon name="chevronRight" />
    </span>
  );
}
export function renderBackRow(title: string, details?: JSX.Element): MenuItem {
  return {
    id: "back",
    label: title,
    class: "agent-chat__capability-menu-item agent-chat__capability-menu-header",
    icon: <Icon name="chevronLeft" />,
    details,
    closeOnSelect: false,
  };
}
export function MenuSwitch(props: { checked: boolean }): JSX.Element {
  return (
    <span
      class={[
        "agent-chat__capability-menu-switch",
        "settings-toggle",
        { "agent-chat__capability-menu-switch--active": props.checked },
      ]}
      aria-hidden="true"
    >
      <span class="settings-toggle__control" />
    </span>
  );
}

export function renderCapabilityToggleRow(options: {
  value: string;
  label: string;
  checked: boolean;
  disabled: boolean;
  title?: string | null;
  icon?: IconName;
  emoji?: string;
  skill?: boolean;
}): MenuItem {
  return {
    id: options.value,
    label: options.label,
    type: "checkbox",
    checked: options.checked,
    disabled: options.disabled,
    class:
      "agent-chat__capability-menu-item agent-chat__capability-menu-toggle agent-chat__capability-menu-toggle--switch",
    attributes: { title: options.title ?? "" },
    icon: options.skill ? (
      skillIcon(options.emoji)
    ) : options.icon ? (
      <Icon name={options.icon} />
    ) : (
      <span />
    ),
    details: <MenuSwitch checked={options.checked} />,
    closeOnSelect: false,
  };
}
