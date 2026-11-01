import { currentThemeBranding } from "../app/theme-branding.ts";
import { buildExternalLinkRel, EXTERNAL_LINK_TARGET } from "../lib/external-link.ts";
import { openExternalUrlSafe } from "../lib/open-external-url.ts";
import { COMMUNITY_DISCORD_URL, OFFICIAL_SUPPORT_URL } from "../lib/product-links.ts";
import { t } from "../lib/reactive/i18n.ts";
import { renderSidebarMenuAction } from "./app-sidebar-dropdown.tsx";
import type { IconName } from "./icon-data.ts";
import { Icon } from "./solid/icon.tsx";
import type { MenuItem } from "./solid/menu.tsx";

// External rows of the footer identity menu. Docs-first: public docs pages over
// raw GitHub, matching the ClawSweeper docs-link policy for user-facing copy.
const IDENTITY_MENU_LINKS: ReadonlyArray<{
  href: string;
  icon: IconName;
  label: () => string;
}> = [
  { href: "https://docs.openclaw.ai", icon: "book", label: () => t("common.docs") },
  {
    href: OFFICIAL_SUPPORT_URL,
    icon: "messageSquare",
    label: () => t("agentChip.getHelp"),
  },
  { href: COMMUNITY_DISCORD_URL, icon: "users", label: () => t("agentChip.discord") },
  {
    href: "https://docs.openclaw.ai/releases",
    icon: "scrollText",
    label: () => t("agentChip.viewChangelog"),
  },
];

export const COMMAND_VALUE_PREFIX = "command:";
const LINK_VALUE_PREFIX = "link:";

export function renderSidebarHelpMenu(): MenuItem | undefined {
  if (!currentThemeBranding().communityLinks) {
    return undefined;
  }
  return {
    ...renderSidebarMenuAction("command:help", t("agentChip.help"), "circleQuestionMark", {
      className: "sidebar-identity-menu__help",
    }),
    trigger: (
      <>
        <span class="nav-item__icon" aria-hidden="true">
          <Icon name="circleQuestionMark" />
        </span>
        <span class="sidebar-customize-menu__text">{t("agentChip.help")}</span>
      </>
    ),
    content: undefined,
    children: IDENTITY_MENU_LINKS.map((link) => ({
      id: `${LINK_VALUE_PREFIX}${encodeURIComponent(link.href)}`,
      label: link.label(),
      href: link.href,
      class: "sidebar-customize-menu__item",
      attributes: {
        "data-new-tab-action": "",
        target: EXTERNAL_LINK_TARGET,
        rel: buildExternalLinkRel(),
      },
      icon: (
        <span class="nav-item__icon" aria-hidden="true">
          <Icon name={link.icon} />
        </span>
      ),
      content: <span class="sidebar-customize-menu__text">{link.label()}</span>,
    })),
  };
}

export function selectSidebarHelpLink(value: string): boolean {
  if (!value.startsWith(LINK_VALUE_PREFIX)) {
    return false;
  }
  openExternalUrlSafe(decodeURIComponent(value.slice(LINK_VALUE_PREFIX.length)));
  return true;
}
