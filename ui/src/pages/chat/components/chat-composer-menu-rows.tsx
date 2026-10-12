import type { JSX } from "@solidjs/web";
import { icons } from "../../../components/icons.ts";
import { t } from "../../../lib/reactive/i18n.ts";
import { LitContent } from "./chat-composer-interop.tsx";

export function menuDivider(): JSX.Element {
  return <div class="agent-chat__capability-menu-divider" role="separator"></div>;
}

export function renderCapabilityMenuState(message: string, role?: "status" | "alert") {
  return (
    <div class="agent-chat__capability-menu-state" role={role}>
      {message}
    </div>
  );
}

export function renderBackRow() {
  return (
    <>
      <wa-dropdown-item class="agent-chat__capability-menu-item" value="back">
        <span slot="icon" aria-hidden="true">
          <LitContent value={icons.arrowLeft} />
        </span>
        <span>{t("chat.composer.menu.back")}</span>
      </wa-dropdown-item>
      {menuDivider()}
    </>
  );
}

export function renderCapabilityToggleRow(options: {
  value: string;
  label: string;
  checked: boolean;
  disabled: boolean;
  title?: string | null;
  icon?: unknown;
  note?: JSX.Element | null;
  checkbox?: boolean;
}) {
  return (
    <wa-dropdown-item
      class="agent-chat__capability-menu-item agent-chat__capability-menu-toggle"
      value={options.value}
      type="checkbox"
      prop:checked={options.checked}
      disabled={options.disabled}
      title={options.title ?? ""}
    >
      {options.icon ? (
        <span slot="icon" aria-hidden="true">
          <LitContent value={options.icon} />
        </span>
      ) : null}
      <span class="agent-chat__capability-menu-label">
        <span>{options.label}</span>
        {options.note ?? null}
      </span>
      {options.checkbox ? null : (
        <wa-switch
          slot="details"
          class="agent-chat__capability-menu-switch"
          size="s"
          tabindex="-1"
          inert
          aria-hidden="true"
          prop:checked={options.checked}
          disabled={options.disabled}
        ></wa-switch>
      )}
    </wa-dropdown-item>
  );
}
