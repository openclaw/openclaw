import type { JSX } from "@solidjs/web";
import { t } from "../../lib/reactive/i18n.ts";
import { Icon } from "./icon.tsx";
import "../../styles/session-menu-compact.css";

export function renderCompactSessionMenuNavigationItem(params: {
  value: string;
  label: string;
  icon: JSX.Element;
  details?: JSX.Element;
  accessibleLabel?: string;
  disabled?: boolean;
  title?: string;
}) {
  return (
    <wa-dropdown-item
      class={[
        "session-menu__item",
        { "session-menu__item--compact-details": Boolean(params.details) },
      ]}
      value={params.value}
      aria-label={params.accessibleLabel}
      disabled={params.disabled ?? false}
      title={params.title}
    >
      <span slot="icon" class="session-menu__icon" aria-hidden="true">
        {params.icon}
      </span>
      <span class="session-menu__text">{params.label}</span>
      {params.details ? (
        <span class="session-menu__compact-details" aria-hidden="true">
          {params.details}
        </span>
      ) : undefined}
      <span slot="details" class="session-menu__icon session-menu__chevron" aria-hidden="true">
        <Icon name="chevronRight" />
      </span>
    </wa-dropdown-item>
  );
}

export function renderCompactSessionMenuFrame(
  body: JSX.Element,
  parent: "root" | "settings" = "root",
) {
  return (
    <>
      <wa-dropdown-item
        class="session-menu__item session-menu__back"
        value={parent === "settings" ? "compact:back-settings" : "compact:back"}
      >
        <span slot="icon" class="session-menu__icon" aria-hidden="true">
          <Icon name="arrowLeft" />
        </span>
        <span class="session-menu__text">{t("common.back")}</span>
      </wa-dropdown-item>
      <div class="session-menu__separator" role="separator" />
      {body}
    </>
  );
}
