import type { JSX } from "@solidjs/web";
import { createMemo, For, Show } from "solid-js";
import { t } from "../../lib/reactive/i18n.ts";
import type { SessionOwnerOption } from "../session-owner-chip.ts";
import { syncDropdownItemRadio } from "../web-awesome.ts";
import { Icon } from "./icon.tsx";
import { renderCompactSessionMenuNavigationItem as CompactSessionMenuNavigationItem } from "./session-menu-compact.tsx";
import { renderSessionOwnerAvatar, renderSessionOwnerChip } from "./session-presentation.tsx";

export function SidebarMenuRadioItem(params: {
  value: string;
  checked: boolean;
  label: string;
  owner?: SessionOwnerOption;
  submenu?: boolean;
}): JSX.Element {
  return (
    <wa-dropdown-item
      slot={params.submenu ? "submenu" : undefined}
      class="sidebar-session-sort-menu__item"
      value={params.value}
      role="menuitemradio"
      aria-label={params.label}
      aria-checked={params.checked ? "true" : "false"}
      ref={(element) => syncDropdownItemRadio(element, params.checked)}
    >
      <span slot="details" class="session-menu__check" aria-hidden="true">
        {params.checked ? <Icon name="check" /> : undefined}
      </span>
      <span class="row session-menu__label">
        {params.owner ? renderSessionOwnerChip(params.owner, "row", "owned") : undefined}
        <span class="session-menu__text">{params.label}</span>
      </span>
    </wa-dropdown-item>
  );
}

export function SidebarOwnerOptions(params: {
  owners: readonly SessionOwnerOption[];
  ownerFilterId: string | null;
  selfOwnerId: string | null;
  submenu: boolean;
}): JSX.Element {
  return (
    <For each={params.owners}>
      {(owner) => (
        <SidebarMenuRadioItem
          value={`owner:${owner.id}`}
          checked={params.ownerFilterId === owner.id}
          label={
            owner.id === params.selfOwnerId
              ? t("sessionsView.ownerYou", { name: owner.label ?? owner.id })
              : (owner.label ?? owner.id)
          }
          owner={owner}
          submenu={params.submenu}
        />
      )}
    </For>
  );
}

export function SidebarOwnerFilter(params: {
  owners: readonly SessionOwnerOption[];
  ownerFilterId: string | null;
  involvingMe: boolean;
  selfOwnerId: string | null;
  compact: boolean;
}): JSX.Element {
  const owners = () => params.owners;
  const ownerFilterId = () => params.ownerFilterId;
  const involvingMe = () => params.involvingMe;
  const selectedOwner = createMemo(() => owners().find((owner) => owner.id === ownerFilterId()));
  const selectedName = createMemo(() => selectedOwner()?.label ?? selectedOwner()?.id);
  const accessibleLabel = createMemo(() => {
    const name = selectedName();
    return name
      ? t("sessionsView.specificOwnerSelected", { name })
      : t("sessionsView.specificOwnerAvailable", { count: String(owners().length) });
  });
  const details = createMemo(() =>
    selectedOwner() ? (
      <>
        {renderSessionOwnerAvatar(selectedOwner()!)}
        <span class="sidebar-session-owner-selection__name">{selectedName()}</span>
      </>
    ) : (
      <span class="sidebar-session-owner-count">{owners().length}</span>
    ),
  );
  return (
    <Show when={owners().length > 0 || ownerFilterId() !== null || involvingMe()}>
      <div class="session-menu__separator" role="separator" />
      <div class="sidebar-session-sort-menu__title">{t("sessionsView.owners")}</div>
      <SidebarMenuRadioItem
        value="owner:"
        checked={ownerFilterId() === null && !involvingMe()}
        label={t("sessionsView.allOwners")}
      />
      <SidebarMenuRadioItem
        value="involving-me"
        checked={involvingMe()}
        label={t("sessionsView.involvingMe")}
      />
      {owners().length > 0 ? (
        params.compact ? (
          <CompactSessionMenuNavigationItem
            value="compact:open-specific-owner"
            label={t("sessionsView.specificOwner")}
            icon={<Icon name="users" />}
            details={
              <span class="session-menu__shortcut sidebar-session-owner-selection">
                {details()}
              </span>
            }
            accessibleLabel={accessibleLabel()}
          />
        ) : (
          <wa-dropdown-item
            class="sidebar-session-sort-menu__item sidebar-session-owner-submenu sidebar-session-choice-submenu"
            aria-label={accessibleLabel()}
          >
            <span class="session-menu__text">{t("sessionsView.specificOwner")}</span>
            <span
              slot="details"
              class="session-menu__shortcut sidebar-session-owner-selection"
              aria-hidden="true"
            >
              {details()}
            </span>
            <SidebarOwnerOptions {...params} submenu />
          </wa-dropdown-item>
        )
      ) : undefined}
    </Show>
  );
}
