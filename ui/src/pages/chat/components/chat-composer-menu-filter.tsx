import type { MenuEntry } from "../../../components/solid/menu.tsx";
import { t } from "../../../lib/reactive/i18n.ts";
import type { ChatComposerMenuSkill } from "../composer-capability-types.ts";
import { composerLibraryMenuItems } from "./chat-composer-library-menu.tsx";
import {
  menuDivider,
  menuSection,
  renderCapabilityMenuState,
  renderCapabilityToggleRow,
} from "./chat-composer-menu-rows.tsx";
import type { ChatComposerPlusMenuContentProps } from "./chat-composer-plus-menu.types.ts";

// Canonical NFC so NFD skill labels still match NFC queries (macOS paste).
export const matchMenuText = (value: string) => value.toLocaleLowerCase().normalize("NFC");

export function libraryRows(menu: ChatComposerPlusMenuContentProps, query: string): MenuEntry[] {
  const items = composerLibraryMenuItems(menu.library).filter(
    (entry) => entry.kind === "content" || matchMenuText(entry.label).includes(query),
  );
  return items.length
    ? [
        {
          kind: "group",
          id: "library-skills",
          items: [menuSection("library-heading", t("chat.composer.menu.fromLibraries")), ...items],
        },
      ]
    : [];
}

export function skillRows(
  rows: readonly ChatComposerMenuSkill[] | null,
  menu: ChatComposerPlusMenuContentProps,
  query: string,
  hasLibrary: boolean,
): MenuEntry[] {
  const matches = (text: string) => matchMenuText(text).includes(query);
  const entries: MenuEntry[] = [];
  const filtered = rows?.filter((skill) => matches(skill.name)) ?? [];
  for (const unavailable of [false, true]) {
    const group = filtered.filter(
      (skill) => Boolean(skill.missingDeps || skill.blocked) === unavailable,
    );
    if (!group.length) {
      continue;
    }
    const id = unavailable ? "unavailable" : "agent";
    const groupRows: MenuEntry[] = [
      ...(entries.length || hasLibrary ? [menuDivider(`${id}-divider`)] : []),
      menuSection(
        `${id}-heading`,
        t(unavailable ? "chat.composer.menu.unavailable" : "chat.composer.menu.agentWorkspace"),
      ),
    ];
    for (const skill of group) {
      groupRows.push({
        ...renderCapabilityToggleRow({
          value: `skill:${skill.key}`,
          label: skill.name,
          emoji: skill.emoji,
          skill: true,
          checked: skill.enabled,
          disabled: unavailable || menu.mutationBlockedReason !== null,
          title: skill.missingDeps
            ? t("chat.composer.menu.depsMissing")
            : skill.blocked
              ? t("chat.composer.menu.skillBlocked")
              : menu.mutationBlockedReason,
        }),
        ...(unavailable ? { type: undefined, checked: undefined, details: undefined } : {}),
      });
    }
    entries.push({ kind: "group", id: `${id}-skills`, items: groupRows });
  }

  return entries.length || hasLibrary
    ? entries
    : [
        renderCapabilityMenuState(
          "skills-empty",
          t(query ? "chat.composer.menu.noMatches" : "chat.composer.menu.noSkills"),
        ),
      ];
}
