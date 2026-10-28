import { createMemo, createSignal, Errored, For, Loading, onSettled, Show } from "solid-js";
import { pathForRoute } from "../../../app-route-paths.ts";
import { Icon } from "../../../components/solid/icon.tsx";
import type { MenuEntry, MenuHandle, MenuItem } from "../../../components/solid/menu.tsx";
import { registerChatComposerMenuEnglish } from "../../../i18n/locales/en-chat-composer-menu.ts";
import { registerMcpEnglish } from "../../../i18n/locales/en-mcp.ts";
import { registerEnglishCatalog, t } from "../../../lib/reactive/i18n.ts";
import { createLayoutMeasurement } from "../../../lib/reactive/layout-measurement.ts";
import {
  countSessionToolOverrides,
  nextBooleanToolOverrides,
  nextMcpToolsDenyOverrides,
  nextWebSearchToolOverrides,
  readOwnEntry,
  resolveToolOverrideState,
  resolveWebSearchToolOverrideState,
} from "../../../lib/sessions/tool-overrides.ts";
import { uploadsEnabled } from "../../../lib/uploads.ts";
import { resolveComposerSkills } from "../composer-capability-catalog.ts";
import type {
  ChatComposerMenuSkill,
  ChatComposerPlusMenuView,
} from "../composer-capability-types.ts";
import "./chat-camera-capture.tsx";
import { filePickerLabel, useNativeAttachmentSourceMenu } from "./chat-attachment-picker-policy.ts";
import {
  handleComposerLibrarySelection,
  composerLibraryMenuItems,
  composerLibraryAddItems,
} from "./chat-composer-library-menu.tsx";
import { toolsForServer, isToolDenied, menuRenderInputs } from "./chat-composer-menu-inputs.ts";
import {
  menuChevron,
  renderCapabilityMenuState,
  renderCapabilityToggleRow,
  menuDivider,
  menuSection,
} from "./chat-composer-menu-rows.tsx";
import { connectorItems } from "./chat-composer-plugins-menu.tsx";
import type {
  ChatComposerPlusMenuContentProps,
  ChatComposerPlusMenuResolvedProps,
} from "./chat-composer-plus-menu.types.ts";

registerEnglishCatalog(registerChatComposerMenuEnglish);

registerEnglishCatalog(registerMcpEnglish);

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

function rootItems(menu: ChatComposerPlusMenuContentProps): MenuEntry[] {
  const entries: MenuEntry[] = [];
  const canUpload = uploadsEnabled(menu.attachments.uploadConfig);
  if (canUpload) {
    const sources: MenuEntry[] = [];
    const mediaOption = menu.attachments.imagesOnly
      ? (["photo", "image", t("chat.composer.attachPhoto")] as const)
      : (["media", "image", t("chat.composer.attachMedia")] as const);
    const nativeSourceMenu = useNativeAttachmentSourceMenu();
    for (const [id, icon, label] of nativeSourceMenu
      ? ([["file", "paperclip", t("chat.composer.attach")]] as const)
      : ([
          ["camera", "camera", t("chat.composer.cameraInput")],
          mediaOption,
          // Image-only composers keep the single picker's file input, filtered to images.
          ...(menu.attachments.imagesOnly
            ? []
            : ([["file", "paperclip", t(filePickerLabel())]] as const)),
        ] as const)) {
      sources.push({
        id,
        label,
        class: nativeSourceMenu
          ? "agent-chat__attach-menu-option agent-chat__capability-menu-item"
          : "agent-chat__attach-menu-option",
        icon: <Icon name={icon} />,
      });
    }
    entries.push({
      kind: "group",
      id: "attachment-sources",
      class: sources.length === 1 ? undefined : "agent-chat__attachment-sources",
      items: sources,
    });
  }
  if (menu.showCapabilities || menu.rootToggles?.length) {
    if (canUpload) {
      entries.push(menuDivider("attachment-divider"));
    }
    entries.push(...(menu.rootToggles ?? []).map(renderCapabilityToggleRow));
  }
  if (!menu.showCapabilities) {
    return entries;
  }
  for (const view of ["skills", "connectors"] as const) {
    entries.push({
      id: `open-${view}`,
      label: t(`chat.composer.menu.${view}`),
      class: "agent-chat__capability-menu-item",
      icon: <Icon name={view === "skills" ? "book" : "plug"} />,
      details: menuChevron(),
      closeOnSelect: false,
    });
  }
  const staleWebSearchEnable = !menu.webSearchBaseEnabled && menu.toolOverrides?.webSearch === true;
  entries.push(
    renderCapabilityToggleRow({
      value: "toggle-web-search",
      label: t("chat.composer.menu.webSearch"),
      checked: resolveWebSearchToolOverrideState(
        menu.webSearchBaseEnabled,
        menu.toolOverrides?.webSearch,
      ),
      disabled:
        menu.mutationBlockedReason !== null ||
        (!menu.webSearchBaseEnabled && !staleWebSearchEnable),
      title:
        menu.mutationBlockedReason ??
        (staleWebSearchEnable
          ? t("chat.composer.menu.webSearchClearStaleEnable")
          : !menu.webSearchBaseEnabled
            ? t("chat.composer.menu.webSearchGloballyDisabled")
            : ""),
      icon: "globe",
    }),
  );
  if (menu.mutationBlockedReason === t("chat.composer.menu.offlineBlocked")) {
    entries.push(renderCapabilityMenuState("capability-blocked", menu.mutationBlockedReason));
  }
  const overrideCount = countSessionToolOverrides(menu.toolOverrides);
  if (overrideCount > 0) {
    entries.push(menuDivider("overrides-divider"), {
      id: "clear-overrides",
      label: t(
        overrideCount === 1
          ? "chat.composer.menu.sessionChange"
          : "chat.composer.menu.sessionChanges",
        { count: String(overrideCount) },
      ),
      class: "agent-chat__capability-menu-item agent-chat__capability-menu-overrides",
      disabled: menu.mutationBlockedReason !== null,
      attributes: { title: menu.mutationBlockedReason ?? "" },
      icon: <Icon name="rotateCcw" />,
      details: (
        <span class="agent-chat__capability-menu-clear-overrides" aria-hidden="true">
          {t("chat.composer.menu.reset")}
        </span>
      ),
      closeOnSelect: false,
    });
  }
  return entries;
}

function handleMenuSelection(
  { id: value }: MenuItem,
  event: CustomEvent<MenuItem>,
  menu: MenuHandle,
  ownerProps: { menu: ChatComposerPlusMenuContentProps; open: boolean },
  expanded: string | null,
  expand: (server: string | null) => void,
  closeSearch: () => boolean,
) {
  const props = ownerProps.menu;
  const overlay = menu.overlay;
  const { surface } = overlay;
  if (
    uploadsEnabled(props.attachments.uploadConfig) &&
    (value === "camera" || value === "photo" || value === "file" || value === "media")
  ) {
    props.inputHandle.open(value);
    return;
  }
  const rootToggle = props.rootToggles?.find((toggle) => toggle.value === value);
  if (rootToggle) {
    event.preventDefault();
    if (!rootToggle.disabled) {
      rootToggle.onChange(!rootToggle.checked);
    }
    return;
  }
  const changeView = (view: ChatComposerPlusMenuView) => {
    const focused = surface.ownerDocument.activeElement;
    closeSearch();
    props.onViewChange(view);
    onSettled(() => {
      const active = surface.ownerDocument.activeElement;
      // A controlled close can settle before Menu applies it; newer focus also wins.
      if (
        overlay.open &&
        ownerProps.open &&
        (active === focused || (active === surface.ownerDocument.body && !focused?.isConnected))
      ) {
        menu.focusFirst();
      }
    });
  };
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
    if (closeSearch()) {
      return;
    }
    changeView(props.view === "libraries" || props.view.startsWith("library:") ? "skills" : "root");
    return;
  }
  if (value === "open-skills" || value === "open-connectors") {
    event.preventDefault();
    changeView(value === "open-skills" ? "skills" : "connectors");
    return;
  }
  if (handleComposerLibrarySelection(value, props.library, changeView)) {
    event.preventDefault();
    return;
  }
  if (value === "toggle-web-search") {
    event.preventDefault();
    if (
      props.mutationBlockedReason ||
      (!props.webSearchBaseEnabled && props.toolOverrides?.webSearch !== true)
    ) {
      return;
    }
    props.onPatchToolOverrides(
      nextWebSearchToolOverrides(
        props.toolOverrides,
        props.webSearchBaseEnabled &&
          !resolveWebSearchToolOverrideState(
            props.webSearchBaseEnabled,
            props.toolOverrides?.webSearch,
          ),
        props.webSearchBaseEnabled,
      ),
    );
    return;
  }
  if (value === "clear-overrides") {
    event.preventDefault();
    if (!props.mutationBlockedReason) {
      props.onPatchToolOverrides(null);
    }
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
      expand(expanded === name ? null : name);
      if (expanded !== name) {
        props.onOpenToolAccess?.(name);
      }
    }
    return;
  }
  if (expanded && (value.startsWith("mcp-tool:") || value === "tools-all")) {
    event.preventDefault();
    if (props.toolAccessMutationBlockedReason) {
      return;
    }
    const tools = toolsForServer(props.toolsEffectiveResult, expanded);
    if (value === "tools-all") {
      const deny = tools.every((tool) => !isToolDenied(props, tool));
      let next = props.toolOverrides;
      for (const tool of tools) {
        next = nextMcpToolsDenyOverrides(next, expanded, tool.mcpToolName, deny);
      }
      props.onPatchToolOverrides(next ?? null);
    } else {
      const tool = tools.find((entry) => entry.mcpToolName === value.slice("mcp-tool:".length));
      if (tool) {
        props.onPatchToolOverrides(
          nextMcpToolsDenyOverrides(
            props.toolOverrides,
            expanded,
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

export function ChatComposerPlusMenuBody(props: ChatComposerPlusMenuResolvedProps) {
  let body!: HTMLDivElement;
  let searchInput: HTMLInputElement | undefined;
  const [searching, setSearching] = createSignal(false);
  const [query, setQuery] = createSignal("");
  const [searchHeight, setSearchHeight] = createSignal<number>();
  const [expanded, setExpanded] = createSignal<string | null>(null);
  const closeSearch = () => {
    if (!searching()) {
      return false;
    }
    setSearching(false);
    setQuery("");
    setSearchHeight(undefined);
    onSettled(() => {
      if (props.open) {
        props.readMenu().itemElement("back")?.focus({ preventScroll: true });
      }
    });
    return true;
  };
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
  const skillsQuery = () => query().trim().toLocaleLowerCase();
  const libraryItems = createMemo(() => libraryRows(inputs().menu, skillsQuery()));
  const skillsOwner = createMemo(() => ({ read: inputs().menu.skillsRead }), {
    equals: (a, b) => a.read === b.read,
  });
  const openSearch = (event: MouseEvent) => {
    event.stopPropagation();
    setSearchHeight(body.offsetHeight);
    setSearching(true);
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
          <Show when={props.view === "skills" && searching()} fallback={headerTitle()}>
            <input
              ref={[
                props.controls.ref(),
                (element) => {
                  searchInput = element;
                },
              ]}
              data-search
              aria-label={t("chat.composer.menu.searchSkills")}
              class="agent-chat__capability-menu-search"
              value={query()}
              onClick={(event) => event.stopPropagation()}
              onInput={(event) => setQuery(event.currentTarget.value)}
              onKeyDown={(event) => {
                if (event.key === "Escape") {
                  event.preventDefault();
                  event.stopPropagation();
                  closeSearch();
                }
              }}
            />
          </Show>
        </span>
        <span class="oc-menu-item__details">
          <Show when={props.view === "skills"}>
            <Show
              when={searching()}
              fallback={
                <button
                  ref={props.controls.ref()}
                  type="button"
                  class="agent-chat__capability-menu-icon-button"
                  aria-label={t("chat.composer.menu.searchSkills")}
                  onClick={openSearch}
                >
                  <Icon name="search" />
                </button>
              }
            >
              <Show when={query()}>
                <button
                  ref={props.controls.ref()}
                  type="button"
                  class="agent-chat__capability-menu-icon-button"
                  aria-label={t("chat.composer.menu.clearSearch")}
                  onClick={(event) => {
                    event.stopPropagation();
                    setQuery("");
                    onSettled(() => searchInput?.focus());
                  }}
                >
                  <Icon name="x" />
                </button>
              </Show>
            </Show>
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
  const lockedHeight = () => (props.view === "skills" ? searchHeight() : undefined);
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
          connectorItems(menu, expanded(), props.controls, () => props.menu, expanded),
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
      return rootItems(menu);
    },
    { lazy: true },
  );
  createLayoutMeasurement(
    () => ({ items: items(), height: lockedHeight() }),
    () => {
      if (!body) {
        return undefined;
      }
      const panel = props.readMenu().overlay.surface;
      const style = getComputedStyle(panel);
      // Measure content without the opening scale or the scroll viewport's current clamp.
      const contentHeight = [...body.children].reduce((total, child) => {
        if (!(child instanceof HTMLElement)) {
          return total;
        }
        const childStyle = getComputedStyle(child);
        return (
          total +
          Math.max(child.scrollHeight, Number.parseFloat(childStyle.height) || 0) +
          Number.parseFloat(childStyle.marginTop) +
          Number.parseFloat(childStyle.marginBottom)
        );
      }, 0);
      const staticHeight = Math.ceil(
        (lockedHeight() ?? contentHeight) +
          Number.parseFloat(style.paddingTop) +
          Number.parseFloat(style.paddingBottom) +
          Number.parseFloat(style.borderTopWidth) +
          Number.parseFloat(style.borderBottomWidth),
      );
      return () => {
        panel.style.height = `${staticHeight}px`;
      };
    },
    { targets: () => (body ? [body] : []), fonts: true },
  );
  onSettled(() => {
    if (props.readMenu().overlay.open) {
      props.menu.onLoadSkills();
    }
    props.onReady({
      items,
      select: (item, event) =>
        handleMenuSelection(
          item,
          event,
          props.readMenu(),
          props,
          expanded(),
          setExpanded,
          closeSearch,
        ),
      navigate: (value) => props.menu.onNavigate(value === "manage-skills" ? "skills" : "plugins"),
    });
    return () => props.onReady(undefined);
  });
  return (
    <div
      ref={(element) => {
        body = element;
      }}
      class="agent-chat__capability-menu-body"
      style={{ height: lockedHeight() === undefined ? undefined : `${searchHeight()}px` }}
    >
      {props.renderItems(items)}
    </div>
  );
}
