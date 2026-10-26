import type { JSX } from "@solidjs/web";
import { createMemo, Errored, For, Loading } from "solid-js";
import { pathForRoute } from "../../../app-route-paths.ts";
import { Icon } from "../../../components/solid/icon.tsx";
import type { MenuEntry, MenuItem } from "../../../components/solid/menu.tsx";
import { t } from "../../../lib/reactive/i18n.ts";
import { resolveComposerSkills } from "../composer-capability-catalog.ts";
import { composerLibraryMenuItems } from "./chat-composer-library-menu.tsx";
import {
  menuDivider,
  menuSection,
  renderCapabilityMenuState,
  renderCapabilityToggleRow,
} from "./chat-composer-menu-rows.tsx";
import type {
  ChatComposerMenuSkill,
  ChatComposerPlusMenuContentProps,
} from "./chat-composer-plus-menu.types.ts";

function libraryRows(menu: ChatComposerPlusMenuContentProps, query: string): MenuEntry[] {
  const items = composerLibraryMenuItems(menu.library).filter(
    (entry) => entry.kind === "content" || entry.label.toLocaleLowerCase().includes(query),
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

function skillRows(
  rows: readonly ChatComposerMenuSkill[] | null,
  menu: ChatComposerPlusMenuContentProps,
  query: string,
  hasLibrary: boolean,
): MenuEntry[] {
  const matches = (text: string) => text.toLocaleLowerCase().includes(query);
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

function SkillCatalog(props: {
  menu: ChatComposerPlusMenuContentProps;
  query: string;
  hasLibrary: boolean;
  renderItems: (items: () => readonly MenuEntry[]) => JSX.Element;
}) {
  const skills = createMemo(() => props.menu.skillsRead ?? props.menu.skills);
  return (
    <Errored
      fallback={() => (
        <>
          {props.renderItems(() => (props.hasLibrary ? [menuDivider("agent-divider")] : []))}
          <div class="agent-chat__capability-menu-state" role="alert">
            {t("chat.composer.menu.skillsLoadFailed")}
          </div>
        </>
      )}
    >
      <Loading
        fallback={
          <>
            {props.renderItems(() => (props.hasLibrary ? [menuDivider("agent-divider")] : []))}
            <div class="agent-chat__capability-menu-section">
              {t("chat.composer.menu.agentWorkspace")}
            </div>
            <div
              class="agent-chat__capability-menu-skeleton"
              role="status"
              aria-label={t("chat.composer.menu.loadingSkills")}
            >
              <span />
              <span />
              <span />
            </div>
          </>
        }
      >
        {props.renderItems(() =>
          skillRows(
            props.menu.skillsRead
              ? resolveComposerSkills(skills(), props.menu.toolOverrides)
              : props.menu.skills,
            props.menu,
            props.query,
            props.hasLibrary,
          ),
        )}
      </Loading>
    </Errored>
  );
}

export function createComposerSkillsMenuItems(
  readMenu: () => ChatComposerPlusMenuContentProps,
  readQuery: () => string,
): (header: MenuItem) => MenuEntry[] {
  const libraryItems = createMemo(() => libraryRows(readMenu(), readQuery()));
  const skillsOwner = createMemo(() => ({ read: readMenu().skillsRead }), {
    equals: (a, b) => a.read === b.read,
  });
  return (header) => {
    const menu = readMenu();
    return [
      header,
      menuDivider("skills-header-divider"),
      {
        kind: "group",
        id: "skills-list",
        class: "agent-chat__capability-menu-scroll",
        items: [
          ...libraryItems(),
          ...skillRows(menu.skills, menu, readQuery(), libraryItems().length > 0),
        ],
        render: (renderItems) => (
          <div class="agent-chat__capability-menu-scroll">
            {renderItems(libraryItems)}
            <For each={[skillsOwner()]}>
              {() => (
                <SkillCatalog
                  menu={readMenu()}
                  query={readQuery()}
                  hasLibrary={libraryItems().length > 0}
                  renderItems={renderItems}
                />
              )}
            </For>
          </div>
        ),
      },
      {
        kind: "group",
        id: "skills-footer",
        items: [
          menuDivider("skills-manage-divider"),
          {
            id: "manage-skills",
            label: t("chat.composer.menu.manageSkills"),
            href: pathForRoute("skills", menu.basePath),
            class: "agent-chat__capability-menu-item",
            icon: <Icon name="settings" />,
          },
        ],
      },
    ];
  };
}
