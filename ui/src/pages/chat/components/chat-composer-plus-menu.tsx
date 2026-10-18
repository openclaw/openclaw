import { createEffect, createMemo, createUniqueId, onSettled, Show, untrack } from "solid-js";
import { pathForRoute } from "../../../app-route-paths.ts";
import { Icon } from "../../../components/solid/icon.tsx";
import {
  Menu,
  type MenuEntry,
  type MenuHandle,
  type MenuItem,
} from "../../../components/solid/menu.tsx";
import { registerMcpEnglish } from "../../../i18n/locales/en-mcp.ts";
import { formatUiExternalText } from "../../../lib/format-error.ts";
import { registerEnglishCatalog, t } from "../../../lib/reactive/i18n.ts";
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
import { handleChatAttachmentMenuSelection } from "./chat-attachment-inputs.ts";
import { useSingleAttachmentPicker } from "./chat-attachment-picker-policy.ts";
import { ComposerContent } from "./chat-composer-content.tsx";
import {
  handleComposerLibrarySelection,
  composerLibraryMenuItems,
} from "./chat-composer-library-menu.tsx";
import {
  menuRenderInputs,
  toolsForServer,
  isToolDenied,
  MCP_DISCOVERY_NOTICE_IDS,
} from "./chat-composer-menu-inputs.ts";
import {
  renderBackRow,
  renderCapabilityMenuState,
  renderCapabilityToggleRow,
  menuDivider,
} from "./chat-composer-menu-rows.tsx";
import type {
  ChatComposerPlusMenuContentProps,
  ChatComposerPlusMenuProps,
  ChatComposerPlusMenuView,
} from "./chat-composer-plus-menu.types.ts";

registerEnglishCatalog(registerMcpEnglish);

function rootItems(menu: ChatComposerPlusMenuContentProps): MenuEntry[] {
  const entries: MenuEntry[] = [];
  const canUpload = uploadsEnabled(menu.attachments.uploadConfig);
  if (canUpload) {
    for (const [id, icon, label] of useSingleAttachmentPicker()
      ? ([["file", "paperclip", t("chat.composer.attach")]] as const)
      : ([
          ["camera", "camera", t("chat.composer.takePhoto")],
          ["photo", "image", t("chat.composer.attachPhoto")],
          ["file", "paperclip", t("chat.composer.attachFileOption")],
        ] as const)) {
      entries.push({
        id,
        label,
        class: "agent-chat__attach-menu-option",
        icon: <Icon name={icon} />,
      });
    }
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
  const counts = {
    skills:
      Object.keys(menu.toolOverrides?.skills ?? {}).length > 0
        ? t("chat.composer.menu.enabledCount", {
            count: String(menu.skills?.filter((skill) => skill.enabled).length ?? 0),
          })
        : null,
    connectors: menu.mcpServers.filter((server) =>
      resolveToolOverrideState(
        server.enabled,
        readOwnEntry(menu.toolOverrides?.mcpServers, server.name),
      ),
    ).length,
  };
  for (const view of ["skills", "connectors"] as const) {
    entries.push({
      id: `open-${view}`,
      label: t(`chat.composer.menu.${view}`),
      class: "agent-chat__capability-menu-item",
      icon: <Icon name={view === "skills" ? "book" : "plug"} />,
      details: (
        <span class="agent-chat__capability-menu-details">
          {counts[view] !== null ? (
            <span class="agent-chat__capability-menu-badge">{counts[view]}</span>
          ) : null}
          <span class="agent-chat__capability-menu-chevron" aria-hidden="true">
            <Icon name="chevronRight" />
          </span>
        </span>
      ),
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
      checkbox: true,
    }),
    menuDivider("manage-divider"),
    {
      id: "manage-plugins",
      label: t("chat.composer.menu.managePlugins"),
      href: pathForRoute("plugins", menu.basePath),
      class: "agent-chat__capability-menu-item",
      content: (
        <span class="agent-chat__capability-menu-link">
          {t("chat.composer.menu.managePlugins")}
        </span>
      ),
      icon: <Icon name="plug" />,
    },
  );
  const overrideCount = countSessionToolOverrides(menu.toolOverrides);
  if (overrideCount > 0) {
    entries.push({
      id: "clear-overrides",
      label: t(
        overrideCount === 1 ? "chat.composer.overrides.countOne" : "chat.composer.overrides.count",
        { count: String(overrideCount) },
      ),
      class: "agent-chat__capability-menu-item agent-chat__capability-menu-overrides",
      disabled: menu.mutationBlockedReason !== null,
      attributes: { title: menu.mutationBlockedReason ?? "" },
      icon: <Icon name="settings" />,
      details: (
        <span class="agent-chat__capability-menu-clear-overrides" aria-hidden="true">
          <Icon name="x" />
        </span>
      ),
      closeOnSelect: false,
    });
  }
  return entries;
}

function skillItems(menu: ChatComposerPlusMenuContentProps): MenuEntry[] {
  const header = [menuDivider("back-divider"), ...composerLibraryMenuItems(menu.library)];
  const notice = menu.skillsLoading
    ? (["chat.composer.menu.loadingSkills", "status"] as const)
    : menu.skillsError
      ? (["chat.composer.menu.skillsLoadFailed", "alert"] as const)
      : !menu.skills?.length
        ? (["chat.composer.menu.noSkills", undefined] as const)
        : null;
  if (notice) {
    header.push(renderCapabilityMenuState("skills-notice", t(notice[0]), notice[1]));
  }
  const skills: MenuEntry[] = [];
  for (const skill of menu.skills ?? []) {
    const title = skill.missingDeps
      ? t("chat.composer.menu.depsMissing")
      : skill.blocked
        ? t("chat.composer.menu.skillBlocked")
        : menu.mutationBlockedReason;
    skills.push(
      renderCapabilityToggleRow({
        value: `skill:${skill.key}`,
        label: skill.name,
        checked: skill.enabled,
        disabled: skill.missingDeps || skill.blocked || menu.mutationBlockedReason !== null,
        title,
        note: skill.missingDeps || skill.blocked ? title : null,
      }),
    );
  }
  const manage: MenuItem = {
    id: "manage-skills",
    label: t("chat.composer.menu.manageSkills"),
    href: pathForRoute("skills", menu.basePath),
    class: "agent-chat__capability-menu-item",
    content: (
      <span class="agent-chat__capability-menu-link">{t("chat.composer.menu.manageSkills")}</span>
    ),
  };
  return [
    renderBackRow(),
    { kind: "group", id: "skills-header", items: header },
    { kind: "group", id: "skills-list", items: skills },
    { kind: "group", id: "skills-footer", items: [menuDivider("skills-manage-divider"), manage] },
  ];
}

function connectorItems(menu: ChatComposerPlusMenuContentProps): MenuEntry[] {
  const entries: MenuEntry[] = [renderBackRow(), menuDivider("back-divider")];
  if (!menu.mcpServers.length) {
    entries.push(
      renderCapabilityMenuState("connectors-empty", t("chat.composer.menu.noConnectors")),
    );
  }
  for (const server of menu.mcpServers) {
    const override = readOwnEntry(menu.toolOverrides?.mcpServers, server.name);
    const enabled = resolveToolOverrideState(server.enabled, override);
    entries.push(
      renderCapabilityToggleRow({
        value: `connector:${server.name}`,
        label: server.name,
        checked: enabled,
        disabled: menu.mutationBlockedReason !== null,
        title: menu.mutationBlockedReason,
        note: enabled ? t("common.enabled") : t("common.disabled"),
        sessionNote: override !== undefined ? t("chat.composer.menu.sessionTag") : undefined,
      }),
    );
    if (menu.onOpenToolAccess) {
      entries.push({
        id: `tools:${server.name}`,
        label: t("chat.composer.menu.toolAccess.label"),
        class: "agent-chat__capability-menu-item agent-chat__capability-menu-subrow",
        icon: <Icon name="wrench" />,
        closeOnSelect: false,
      });
    }
  }
  entries.push(menuDivider("connectors-add-divider"));
  if (menu.onAddServer) {
    entries.push({
      id: "add-server",
      label: t("chat.composer.menu.addMcpServer"),
      class: "agent-chat__capability-menu-item",
      disabled: !menu.canAdmin,
      attributes: { title: !menu.canAdmin ? (menu.adminBlockedReason ?? "") : "" },
      icon: <Icon name="plus" />,
    });
  }
  return entries;
}

function toolItems(menu: ChatComposerPlusMenuContentProps, serverName: string): MenuEntry[] {
  const tools = toolsForServer(menu.toolsEffectiveResult, serverName);
  const notice = !tools.length
    ? menu.toolsEffectiveResult?.notices?.find(
        (entry) => MCP_DISCOVERY_NOTICE_IDS.has(entry.id) && entry.servers?.includes(serverName),
      )
    : undefined;
  const entries: MenuEntry[] = [
    renderBackRow(),
    menuDivider("back-divider"),
    renderCapabilityMenuState(
      "tool-heading",
      <span class="agent-chat__capability-menu-label">
        <strong translate="no">{serverName}</strong>
        {tools.length ? (
          <span class="agent-chat__capability-menu-note">
            {t(
              tools.length === 1
                ? "chat.composer.menu.toolAccess.summaryOne"
                : "chat.composer.menu.toolAccess.summary",
              {
                enabled: String(tools.filter((tool) => !isToolDenied(menu, tool)).length),
                total: String(tools.length),
              },
            )}
          </span>
        ) : null}
      </span>,
    ),
  ];
  if (menu.toolsEffectiveLoading) {
    entries.push(
      renderCapabilityMenuState(
        "tools-loading",
        t("chat.composer.menu.toolAccess.loading"),
        "status",
      ),
    );
  } else if (menu.toolsEffectiveError) {
    entries.push(
      renderCapabilityMenuState(
        "tools-error",
        t("chat.composer.menu.toolAccess.loadFailed"),
        "alert",
      ),
    );
  } else if (notice || !tools.length) {
    entries.push(
      renderCapabilityMenuState(
        "tools-notice",
        notice ? formatUiExternalText(notice.message) : t("chat.composer.menu.toolAccess.noTools"),
        notice ? "status" : undefined,
      ),
    );
  }
  for (const tool of tools) {
    const label = tool.label?.trim();
    entries.push(
      renderCapabilityToggleRow({
        value: `mcp-tool:${tool.mcpToolName}`,
        label: tool.mcpToolName,
        checked: !isToolDenied(menu, tool),
        disabled: menu.toolAccessMutationBlockedReason !== null,
        title: menu.toolAccessMutationBlockedReason,
        note: label !== tool.mcpToolName ? label : null,
      }),
    );
  }
  return entries;
}

function handleMenuSelection(
  { id: value }: MenuItem,
  event: CustomEvent<MenuItem>,
  overlay: MenuHandle["overlay"],
  ownerProps: { menu: ChatComposerPlusMenuContentProps },
) {
  const props = ownerProps.menu;
  const { surface, trigger } = overlay;
  if (
    uploadsEnabled(props.attachments.uploadConfig) &&
    handleChatAttachmentMenuSelection(surface, value, trigger)
  ) {
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
    props.onViewChange(view);
    onSettled(() => {
      const active = surface.ownerDocument.activeElement;
      // A controlled close can settle before Menu applies it; newer focus also wins.
      if (
        overlay.open &&
        ownerProps.menu.open &&
        (active === focused || (active === surface.ownerDocument.body && !focused?.isConnected))
      ) {
        surface.querySelector<HTMLElement>('[role^="menuitem"]:not([disabled])')?.focus();
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
    changeView(
      props.view.startsWith("tools:")
        ? "connectors"
        : props.view.startsWith("library:")
          ? "skills"
          : "root",
    );
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
  if (value.startsWith("connector:")) {
    event.preventDefault();
    const server = props.mcpServers.find(
      (entry) => entry.name === value.slice("connector:".length),
    );
    if (server && !props.mutationBlockedReason) {
      const enabled = resolveToolOverrideState(
        server.enabled,
        readOwnEntry(props.toolOverrides?.mcpServers, server.name),
      );
      toggleCapability("mcpServers", server.name, enabled, server.enabled);
    }
    return;
  }
  if (value.startsWith("tools:")) {
    event.preventDefault();
    const server = props.mcpServers.find((entry) => entry.name === value.slice("tools:".length));
    if (server) {
      props.onOpenToolAccess?.(server.name);
      changeView(`tools:${server.name}`);
    }
    return;
  }
  if (value.startsWith("mcp-tool:") && props.view.startsWith("tools:")) {
    event.preventDefault();
    if (props.toolAccessMutationBlockedReason) {
      return;
    }
    const serverName = props.view.slice("tools:".length);
    const tool = toolsForServer(props.toolsEffectiveResult, serverName).find(
      (entry) => entry.mcpToolName === value.slice("mcp-tool:".length),
    );
    if (tool?.mcpToolName) {
      props.onPatchToolOverrides(
        nextMcpToolsDenyOverrides(
          props.toolOverrides,
          serverName,
          tool.mcpToolName,
          !isToolDenied(props, tool),
        ),
      );
    }
    return;
  }
  if (value === "add-server") {
    props.onAddServer?.();
  }
}

function PlusMenuSurface(props: { menu: ChatComposerPlusMenuContentProps }) {
  let handle!: MenuHandle;
  let host!: HTMLDivElement;
  const id = createUniqueId();
  const view = createMemo(() => (props.menu.showCapabilities ? props.menu.view : "root"));
  const inputs = createMemo(
    () => ({ view: view(), values: menuRenderInputs(props.menu, view()) }),
    {
      lazy: true,
      equals: (previous, next) =>
        previous.view === next.view &&
        previous.values.length === next.values.length &&
        previous.values.every((value, index) => Object.is(value, next.values[index])),
    },
  );
  const items = createMemo(
    () => {
      const current = inputs().view;
      // Actions keep reading current props; only presentation owns these retained nodes.
      return untrack(() =>
        current === "skills"
          ? skillItems(props.menu)
          : current === "connectors"
            ? connectorItems(props.menu)
            : current.startsWith("tools:")
              ? toolItems(props.menu, current.slice("tools:".length))
              : current.startsWith("library:")
                ? composerLibraryMenuItems(props.menu.library, current.slice("library:".length))
                : rootItems(props.menu),
      );
    },
    { lazy: true },
  );
  return (
    <>
      <div
        ref={(element) => {
          host = element;
        }}
        class="agent-chat__attach-menu agent-chat__capability-menu"
        data-view={view()}
      >
        <Menu
          lazy
          id={`chat-composer-plus-${id}`}
          panelClass="agent-chat__capability-menu-panel"
          placement="top-start"
          pointerFocus="trigger"
          label={t("chat.composer.addAttachment")}
          open={props.menu.open}
          disabled={props.menu.disabled}
          triggerClass={`agent-chat__input-btn agent-chat__input-btn--attach${countSessionToolOverrides(props.menu.toolOverrides) ? " agent-chat__input-btn--has-overrides" : ""}`}
          triggerAttributes={{ title: t("chat.composer.addAttachment") }}
          trigger={<Icon name="plus" />}
          items={items()}
          ref={(next) => {
            handle = next;
          }}
          onSelect={(item, event) => handleMenuSelection(item, event, handle.overlay, props)}
          onNavigate={({ value }) =>
            props.menu.onNavigate(value === "manage-skills" ? "skills" : "plugins")
          }
          onOpenChange={(open) => {
            host.toggleAttribute("open", open);
            if (open) {
              props.menu.onLoadSkills();
            }
            if (open !== props.menu.open) {
              props.menu.onOpenChange(open);
            }
          }}
        />
      </div>
      <ComposerContent>{props.menu.addServerDialog}</ComposerContent>
      <ComposerContent>{props.menu.libraryDialog}</ComposerContent>
    </>
  );
}

export function ChatComposerPlusMenu(props: { menu: ChatComposerPlusMenuProps }) {
  // Reconnects can replace the capability owner while this menu stays open.
  createEffect(
    () => ({
      open: props.menu.open,
      view: props.menu.view,
      load: props.menu.capabilityMenu?.onLoadView,
    }),
    ({ open, view, load }) => {
      if (open) {
        load?.(view);
      }
    },
  );
  const resolved = createMemo(() => {
    const current = props.menu;
    const capabilityMenu = current.capabilityMenu;
    if (
      !capabilityMenu &&
      !current.rootToggles?.length &&
      !uploadsEnabled(current.attachments.uploadConfig)
    ) {
      return null;
    }
    return {
      ...current,
      ...capabilityMenu,
      showCapabilities: capabilityMenu !== undefined,
      basePath: capabilityMenu?.basePath ?? "",
      skills: capabilityMenu?.skills ?? null,
      skillsLoading: capabilityMenu?.skillsLoading ?? false,
      skillsError: capabilityMenu?.skillsError ?? false,
      mcpServers: capabilityMenu?.mcpServers ?? [],
      toolsEffectiveResult: capabilityMenu?.toolsEffectiveResult ?? null,
      toolsEffectiveLoading: capabilityMenu?.toolsEffectiveLoading ?? false,
      toolsEffectiveError: capabilityMenu?.toolsEffectiveError ?? false,
      toolAccessMutationBlockedReason: capabilityMenu?.toolAccessMutationBlockedReason ?? null,
      webSearchBaseEnabled: capabilityMenu?.webSearchBaseEnabled ?? true,
      mutationBlockedReason: capabilityMenu?.mutationBlockedReason ?? null,
      canAdmin: capabilityMenu?.canAdmin ?? false,
      adminBlockedReason: capabilityMenu?.adminBlockedReason ?? null,
      onLoadSkills: capabilityMenu?.onLoadSkills ?? (() => {}),
      onPatchToolOverrides: capabilityMenu?.onPatchToolOverrides ?? (() => {}),
      onNavigate: capabilityMenu?.onNavigate ?? (() => {}),
    };
  });
  return <Show when={resolved()}>{(menu) => <PlusMenuSurface menu={menu()} />}</Show>;
}
