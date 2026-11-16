import { createMemo, Errored, For, Loading, onSettled, Show } from "solid-js";
import { pathForRoute } from "../../../app-route-paths.ts";
import { HeaderSearchField, HeaderSearchToggle } from "../../../components/solid/header-search.tsx";
import { Icon } from "../../../components/solid/icon.tsx";
import type { MenuEntry, MenuItem } from "../../../components/solid/menu.tsx";
import { registerMcpEnglish } from "../../../i18n/locales/en-mcp.ts";
import { registerEnglishCatalog, t } from "../../../lib/reactive/i18n.ts";
import {
  nextBooleanToolOverrides,
  nextMcpToolsDenyOverrides,
  readOwnEntry,
  resolveToolOverrideState,
} from "../../../lib/sessions/tool-overrides.ts";
import { resolveComposerSkills } from "../composer-capability-catalog.ts";
import type { ChatComposerMenuSkill } from "../composer-capability-types.ts";
import {
  handleComposerLibrarySelection,
  composerLibraryMenuItems,
  composerLibraryAddItems,
} from "./chat-composer-library-menu.tsx";
import { toolsForServer, isToolDenied, menuRenderInputs } from "./chat-composer-menu-inputs.ts";
import {
  renderCapabilityMenuState,
  renderCapabilityToggleRow,
  menuDivider,
  menuSection,
} from "./chat-composer-menu-rows.tsx";
import { connectorItems } from "./chat-composer-plugins-menu.tsx";
import { ChatComposerPlusMenuFrame } from "./chat-composer-plus-menu-frame.tsx";
import type {
  ChatComposerPlusMenuContentProps,
  ChatComposerPlusMenuSubviewProps,
} from "./chat-composer-plus-menu.types.ts";

registerEnglishCatalog(registerMcpEnglish);

function libraryRows(menu: ChatComposerPlusMenuContentProps, query: string): MenuEntry[] {
  const items = composerLibraryMenuItems(menu.library).filter(
    (item) => item.kind === "content" || item.label.toLowerCase().normalize("NFC").includes(query),
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
  const matches = (text: string) => text.toLowerCase().normalize("NFC").includes(query);
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

function handleSubviewSelection(
  { id: value }: MenuItem,
  event: CustomEvent<MenuItem>,
  ownerProps: ChatComposerPlusMenuSubviewProps,
) {
  const props = ownerProps.menu;
  const toggleCapability = (
    group: "skills" | "mcpServers",
    name: string,
    enabled: boolean,
    baseEnabled: boolean,
  ) =>
    props.onPatchToolOverrides(
      nextBooleanToolOverrides(props.toolOverrides, group, name, !enabled, baseEnabled),
    );
  if (value === "back") {
    event.preventDefault();
    if (ownerProps.closeSearch()) {
      return;
    }
    ownerProps.changeView(
      props.view === "libraries" || props.view.startsWith("library:") ? "skills" : "root",
    );
    return;
  }
  if (handleComposerLibrarySelection(value, props.library, ownerProps.changeView)) {
    event.preventDefault();
    return;
  }
  if (value.startsWith("skill:")) {
    event.preventDefault();
    const skill = props.skills?.find((entry) => entry.key === value.slice("skill:".length));
    if (skill && !skill.missingDeps && !skill.blocked && !props.mutationBlockedReason) {
      toggleCapability("skills", skill.key, skill.enabled, skill.baseEnabled);
    }
    return;
  }
  if (value.startsWith("server:")) {
    event.preventDefault();
    const name = value.slice("server:".length);
    const server = props.mcpServers.find((entry) => entry.name === name);
    if (server && !props.onOpenToolAccess) {
      if (!props.mutationBlockedReason) {
        toggleCapability(
          "mcpServers",
          name,
          resolveToolOverrideState(
            server.enabled,
            readOwnEntry(props.toolOverrides?.mcpServers, name),
          ),
          server.enabled,
        );
      }
    } else if (server) {
      const expanding = ownerProps.expanded !== name;
      ownerProps.onExpandedChange(expanding ? name : null);
      if (expanding) {
        props.onOpenToolAccess?.(name);
      }
    }
    return;
  }
  if (ownerProps.expanded && (value.startsWith("mcp-tool:") || value === "tools-all")) {
    event.preventDefault();
    if (props.toolAccessMutationBlockedReason) {
      return;
    }
    const tools = toolsForServer(props.toolsEffectiveResult, ownerProps.expanded);
    if (value === "tools-all") {
      const deny = tools.every((tool) => !isToolDenied(props, tool));
      let next = props.toolOverrides;
      for (const tool of tools) {
        next = nextMcpToolsDenyOverrides(next, ownerProps.expanded, tool.mcpToolName, deny);
      }
      props.onPatchToolOverrides(next ?? null);
    } else {
      const tool = tools.find((entry) => entry.mcpToolName === value.slice("mcp-tool:".length));
      if (tool) {
        props.onPatchToolOverrides(
          nextMcpToolsDenyOverrides(
            props.toolOverrides,
            ownerProps.expanded,
            tool.mcpToolName,
            !isToolDenied(props, tool),
          ),
        );
      }
    }
    return;
  }
  if (value === "add-server") {
    props.onAddServer?.();
  }
}

export function ChatComposerPlusMenuSubview(props: ChatComposerPlusMenuSubviewProps) {
  let body!: HTMLDivElement;
  let searchInput: HTMLInputElement | undefined;
  const inputs = createMemo(
    () => {
      const view = props.view;
      const menu = props.menu;
      return { view, menu, values: menuRenderInputs(menu, view) };
    },
    {
      lazy: true,
      equals: (previous, next) =>
        previous.view === next.view &&
        previous.values.length === next.values.length &&
        previous.values.every((value, index) => Object.is(value, next.values[index])),
    },
  );
  const skillsQuery = () => props.query.trim().toLowerCase().normalize("NFC");
  const libraryItems = createMemo(() => libraryRows(inputs().menu, skillsQuery()));
  const skillsOwner = createMemo(() => ({ read: inputs().menu.skillsRead }), {
    equals: (a, b) => a.read === b.read,
  });
  const openSearch = () => {
    props.onSearchHeightChange(body.offsetHeight);
    props.onSearchingChange(true);
    onSettled(() => searchInput?.focus());
  };
  const headerTitle = createMemo(() => {
    if (props.view === "connectors") {
      return t("chat.composer.menu.connectors");
    }
    if (props.view === "libraries") {
      return t("chat.composer.menu.addFromLibraries");
    }
    if (props.view.startsWith("library:")) {
      return (
        props.menu.library?.result?.session?.selections.find(
          (pin) => pin.skillId === props.view.slice("library:".length),
        )?.slug ?? t("chat.composer.menu.skills")
      );
    }
    return t("chat.composer.menu.skills");
  });
  const header: MenuItem = {
    id: "back",
    get label() {
      return headerTitle();
    },
    closeOnSelect: false,
    render: (attributes) => (
      <div
        {...attributes}
        class="oc-menu-item agent-chat__capability-menu-item agent-chat__capability-menu-header"
      >
        <span class="oc-menu-item__icon">
          <Icon name="chevronLeft" />
        </span>
        <span class="oc-menu-item__label">
          <Show when={props.view === "skills" && props.searching} fallback={headerTitle()}>
            <HeaderSearchField
              label={t("chat.composer.menu.searchSkills")}
              query={props.query}
              controlRef={() => props.controls.ref()}
              inputProps={{ "data-search": "" }}
              inputRef={(element) => {
                searchInput = element;
              }}
              onQueryChange={props.onQueryChange}
              onClose={() => props.closeSearch()}
            />
          </Show>
        </span>
        <span class="oc-menu-item__details">
          <Show when={props.view === "skills"}>
            <HeaderSearchToggle
              open={props.searching}
              label={t("chat.composer.menu.searchSkills")}
              closeLabel={t("chat.composer.menu.clearSearch")}
              controlRef={() => props.controls.ref()}
              onToggle={() => {
                if (props.searching) {
                  props.closeSearch();
                } else {
                  openSearch();
                }
              }}
            />
          </Show>
        </span>
      </div>
    ),
  };
  const withHeader = (rows: MenuEntry[], scroll = false): MenuEntry[] =>
    scroll
      ? [
          header,
          rows[1]!,
          {
            kind: "group",
            id: "library-list",
            class: "agent-chat__capability-menu-scroll",
            items: rows.slice(2),
          },
        ]
      : [header, ...rows.slice(1)];
  const lockedHeight = () => (props.view === "skills" ? props.searchHeight : undefined);
  const items = createMemo(
    (): MenuEntry[] => {
      const { view, menu } = inputs();
      if (view === "skills") {
        return [
          header,
          menuDivider("skills-header-divider"),
          {
            kind: "group",
            id: "skills-list",
            class: "agent-chat__capability-menu-scroll",
            items: [
              ...libraryItems(),
              ...skillRows(menu.skills, menu, skillsQuery(), libraryItems().length > 0),
            ],
            render: (renderItems) => (
              <div class="agent-chat__capability-menu-scroll">
                {renderItems(libraryItems)}
                <For each={[skillsOwner()]}>
                  {() => {
                    const skills = createMemo(
                      () => inputs().menu.skillsRead ?? inputs().menu.skills,
                    );
                    return (
                      <Errored
                        fallback={() => (
                          <>
                            {renderItems(() =>
                              libraryItems().length > 0 ? [menuDivider("agent-divider")] : [],
                            )}
                            <div class="agent-chat__capability-menu-state" role="alert">
                              {t("chat.composer.menu.skillsLoadFailed")}
                            </div>
                          </>
                        )}
                      >
                        <Loading
                          fallback={
                            <>
                              {renderItems(() =>
                                libraryItems().length > 0 ? [menuDivider("agent-divider")] : [],
                              )}
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
                          {renderItems(() =>
                            skillRows(
                              inputs().menu.skillsRead
                                ? resolveComposerSkills(skills(), inputs().menu.toolOverrides)
                                : inputs().menu.skills,
                              inputs().menu,
                              skillsQuery(),
                              libraryItems().length > 0,
                            ),
                          )}
                        </Loading>
                      </Errored>
                    );
                  }}
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
      }
      if (view === "connectors") {
        return withHeader(
          connectorItems(
            menu,
            props.expanded,
            props.controls,
            () => props.menu,
            () => props.expanded,
          ),
        );
      }
      if (view === "libraries") {
        return withHeader(composerLibraryAddItems(menu.library), true);
      }
      if (view.startsWith("library:")) {
        return withHeader(
          composerLibraryMenuItems(menu.library, view.slice("library:".length)),
          true,
        );
      }
      return [];
    },
    { lazy: true },
  );
  return (
    <ChatComposerPlusMenuFrame
      {...props}
      items={items}
      height={lockedHeight()}
      select={(item, event) => handleSubviewSelection(item, event, props)}
      onBody={(element) => {
        body = element;
      }}
    />
  );
}
