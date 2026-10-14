import { t } from "../../lib/reactive/i18n.ts";
import type { SessionOwnerOption } from "../session-owner-chip.ts";
import { Icon } from "./icon.tsx";
import type { MenuEntry, MenuItem } from "./menu.tsx";
import { renderSessionOwnerAvatar, renderSessionOwnerChip } from "./session-presentation.tsx";

export function SidebarMenuRadioItem(params: {
  value: string;
  checked: boolean;
  label: string;
  owner?: SessionOwnerOption;
}): MenuItem {
  return {
    id: params.value,
    label: params.label,
    type: "radio",
    checked: params.checked,
    class: "sidebar-session-sort-menu__item",
    content: (
      <span class="row session-menu__label">
        {params.owner ? renderSessionOwnerChip(params.owner, "row", "owned") : undefined}
        <span class="session-menu__text">{params.label}</span>
      </span>
    ),
  };
}

export function SidebarOwnerOptions(params: {
  owners: readonly SessionOwnerOption[];
  ownerFilterId: string | null;
  selfOwnerId: string | null;
}): MenuItem[] {
  return params.owners.map((owner) =>
    SidebarMenuRadioItem({
      value: `owner:${owner.id}`,
      checked: params.ownerFilterId === owner.id,
      label:
        owner.id === params.selfOwnerId
          ? t("sessionsView.ownerYou", { name: owner.label ?? owner.id })
          : (owner.label ?? owner.id),
      owner,
    }),
  );
}

export function SidebarOwnerFilter(params: {
  owners: readonly SessionOwnerOption[];
  ownerFilterId: string | null;
  involvingMe: boolean;
  selfOwnerId: string | null;
  compact: boolean;
}): MenuEntry[] {
  if (!params.owners.length && params.ownerFilterId === null && !params.involvingMe) {
    return [];
  }
  const selectedOwner = params.owners.find((owner) => owner.id === params.ownerFilterId);
  const selectedName = selectedOwner?.label ?? selectedOwner?.id;
  const label = selectedName
    ? t("sessionsView.specificOwnerSelected", { name: selectedName })
    : t("sessionsView.specificOwnerAvailable", { count: String(params.owners.length) });
  return [
    {
      kind: "content",
      id: "owner-heading",
      content: (
        <>
          <div class="session-menu__separator" role="separator" />
          <div class="sidebar-session-sort-menu__title">{t("sessionsView.owners")}</div>
        </>
      ),
    },
    SidebarMenuRadioItem({
      value: "owner:",
      checked: params.ownerFilterId === null && !params.involvingMe,
      label: t("sessionsView.allOwners"),
    }),
    SidebarMenuRadioItem({
      value: "involving-me",
      checked: params.involvingMe,
      label: t("sessionsView.involvingMe"),
    }),
    ...(params.owners.length
      ? [
          {
            id: params.compact ? "compact:open-specific-owner" : "specific-owner",
            label,
            class:
              "sidebar-session-sort-menu__item sidebar-session-owner-submenu sidebar-session-choice-submenu",
            closeOnSelect: false,
            children: params.compact ? undefined : SidebarOwnerOptions(params),
            [params.compact ? "content" : "trigger"]: (
              <>
                <span class="session-menu__text">{t("sessionsView.specificOwner")}</span>
                <span
                  class="session-menu__shortcut sidebar-session-owner-selection"
                  aria-hidden="true"
                >
                  {selectedOwner ? (
                    <>
                      {renderSessionOwnerAvatar(selectedOwner)}
                      <span class="sidebar-session-owner-selection__name">{selectedName}</span>
                    </>
                  ) : (
                    <span class="sidebar-session-owner-count">{params.owners.length}</span>
                  )}
                </span>
                {params.compact ? <Icon name="chevronRight" /> : undefined}
              </>
            ),
          },
        ]
      : []),
  ];
}
