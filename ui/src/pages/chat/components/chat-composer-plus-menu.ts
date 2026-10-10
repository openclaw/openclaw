import { html, nothing, type TemplateResult } from "lit";
import type { ToolsEffectiveEntry, ToolsEffectiveResult } from "../../../api/types.ts";
import { pathForRoute } from "../../../app-route-paths.ts";
import type { ApplicationNavigationOptions } from "../../../app/context.ts";
import { icons } from "../../../components/icons.ts";
import "@awesome.me/webawesome/dist/components/switch/switch.js";
import { t } from "../../../i18n/index.ts";
import { registerMcpEnglish } from "../../../i18n/locales/en-mcp.ts";
import type { McpServerSummary } from "../../../lib/config/mcp-servers.ts";
import { formatUiExternalText } from "../../../lib/format-error.ts";
import type { SessionToolOverrides } from "../../../lib/sessions/patch.ts";
import {
  countSessionToolOverrides,
  nextBooleanToolOverrides,
  nextMcpToolsDenyOverrides,
  nextWebSearchToolOverrides,
  readOwnEntry,
  resolveToolOverrideState,
  resolveWebSearchToolOverrideState,
} from "../../../lib/sessions/tool-overrides.ts";
import "../../../components/tooltip.ts";
import "../../../components/web-awesome.ts";
import { uploadsEnabled } from "../../../lib/uploads.ts";
import type { ComposerLibraryProps } from "../composer-library-session.ts";
import type { ChatAttachmentControlsProps } from "./chat-attachment-controls.types.ts";
import {
  handleChatAttachmentMenuSelection,
  renderChatAttachmentMenuOptions,
  renderChatAttachmentMenuTrigger,
} from "./chat-attachment-inputs.ts";
import {
  handleComposerLibrarySelection,
  renderComposerLibraryMenu,
} from "./chat-composer-library-menu.ts";
import {
  renderBackRow,
  renderCapabilityMenuState,
  renderCapabilityToggleRow,
  menuDivider,
} from "./chat-composer-menu-rows.ts";

registerMcpEnglish();

export type ChatComposerPlusMenuView =
  | "root"
  | "skills"
  | "connectors"
  | `tools:${string}`
  | `library:${string}`;

export type ChatComposerMenuSkill = {
  key: string;
  name: string;
  enabled: boolean;
  baseEnabled: boolean;
  missingDeps?: boolean;
  blocked?: boolean;
};

type ChatComposerRootToggle = {
  value: string;
  label: string;
  icon?: TemplateResult;
  checked: boolean;
  disabled: boolean;
  title?: string;
  onChange: (checked: boolean) => void;
};

type MenuRoute = "mcp" | "plugins" | "skills";

type ChatComposerPlusMenuProps = {
  attachments: ChatAttachmentControlsProps;
  capabilityMenu?: ChatComposerCapabilityMenuProps;
  disabled: boolean;
  open: boolean;
  view: ChatComposerPlusMenuView;
  toolOverrides: SessionToolOverrides | null | undefined;
  rootToggles?: readonly ChatComposerRootToggle[];
  onOpenChange: (open: boolean) => void;
  onViewChange: (view: ChatComposerPlusMenuView) => void;
};

export type ChatComposerCapabilityMenuProps = {
  basePath: string;
  skills: readonly ChatComposerMenuSkill[] | null;
  skillsLoading: boolean;
  skillsError: boolean;
  library?: ComposerLibraryProps;
  libraryDialog?: TemplateResult | typeof nothing;
  mcpServers: readonly McpServerSummary[];
  toolsEffectiveResult: ToolsEffectiveResult | null;
  toolsEffectiveLoading: boolean;
  toolsEffectiveError: boolean;
  toolAccessMutationBlockedReason: string | null;
  webSearchBaseEnabled: boolean;
  mutationBlockedReason: string | null;
  canAdmin: boolean;
  adminBlockedReason: string | null;
  addServerDialog?: TemplateResult | typeof nothing;
  onLoadSkills: () => void;
  onPatchToolOverrides: (next: SessionToolOverrides | null) => void;
  onNavigate: (routeId: MenuRoute, options?: ApplicationNavigationOptions) => void;
  onAddServer?: () => void;
  onOpenToolAccess?: (serverName: string) => void;
};

type ChatComposerPlusMenuContentProps = ChatComposerPlusMenuProps &
  ChatComposerCapabilityMenuProps & { showCapabilities: boolean };

function internalLink(href: string, label: string): TemplateResult {
  return html`<a
    class="agent-chat__capability-menu-link"
    href=${href}
    tabindex="-1"
    @click=${(event: MouseEvent) => event.preventDefault()}
    >${label}</a
  >`;
}

function renderRootView(props: ChatComposerPlusMenuContentProps) {
  const overrideCount = countSessionToolOverrides(props.toolOverrides);
  const connectorCount = props.mcpServers.filter((server) =>
    resolveToolOverrideState(
      server.enabled,
      readOwnEntry(props.toolOverrides?.mcpServers, server.name),
    ),
  ).length;
  const hasSkillOverrides = Object.keys(props.toolOverrides?.skills ?? {}).length > 0;
  const enabledSkillCount = props.skills?.filter((skill) => skill.enabled).length ?? 0;
  const webSearchEnabled = resolveWebSearchToolOverrideState(
    props.webSearchBaseEnabled,
    props.toolOverrides?.webSearch,
  );
  const staleWebSearchEnable =
    !props.webSearchBaseEnabled && props.toolOverrides?.webSearch === true;
  const webSearchDisabled =
    props.mutationBlockedReason !== null || (!props.webSearchBaseEnabled && !staleWebSearchEnable);
  const webSearchTitle =
    props.mutationBlockedReason ??
    (staleWebSearchEnable
      ? t("chat.composer.menu.webSearchClearStaleEnable")
      : !props.webSearchBaseEnabled
        ? t("chat.composer.menu.webSearchGloballyDisabled")
        : "");
  const canUpload = uploadsEnabled(props.attachments.uploadConfig);
  const attachments = canUpload ? renderChatAttachmentMenuOptions() : nothing;
  const rootToggles = props.rootToggles ?? [];
  if (!props.showCapabilities && rootToggles.length === 0) {
    return attachments;
  }
  // Core gates managed and Codex-native search. Config sniffing misses env/native providers;
  // without a provider, this session override is a harmless no-op.
  return html`
    ${attachments} ${canUpload ? menuDivider() : nothing}
    ${rootToggles.map(renderCapabilityToggleRow)}
    ${
      props.showCapabilities
        ? html`${(
              [
                [
                  "skills",
                  icons.book,
                  hasSkillOverrides
                    ? t("chat.composer.menu.enabledCount", { count: String(enabledSkillCount) })
                    : null,
                ],
                ["connectors", icons.plug, connectorCount],
              ] as const
            ).map(
              ([view, icon, badge]) => html`<wa-dropdown-item
                class="agent-chat__capability-menu-item"
                value=${`open-${view}`}
              >
                <span slot="icon" aria-hidden="true">${icon}</span>
                <span>${t(`chat.composer.menu.${view}`)}</span>
                <span slot="details" class="agent-chat__capability-menu-details">
                  ${badge === null ? nothing : html`<span class="agent-chat__capability-menu-badge">${badge}</span>`}
                  <span class="agent-chat__capability-menu-chevron" aria-hidden="true"
                    >${icons.chevronRight}</span
                  >
                </span>
              </wa-dropdown-item>`,
            )}
            ${renderCapabilityToggleRow({
              value: "toggle-web-search",
              label: t("chat.composer.menu.webSearch"),
              checked: webSearchEnabled,
              disabled: webSearchDisabled,
              title: webSearchTitle,
              icon: icons.globe,
              checkbox: true,
            })}
            ${menuDivider()}
            <wa-dropdown-item class="agent-chat__capability-menu-item" value="manage-plugins">
              <span slot="icon" aria-hidden="true">${icons.plug}</span>
              ${internalLink(
                pathForRoute("plugins", props.basePath),
                t("chat.composer.menu.managePlugins"),
              )}
            </wa-dropdown-item>
            ${
              overrideCount > 0
                ? html`
                    <wa-dropdown-item
                      class="agent-chat__capability-menu-item agent-chat__capability-menu-overrides"
                      value="clear-overrides"
                      ?disabled=${props.mutationBlockedReason !== null}
                      title=${props.mutationBlockedReason ?? ""}
                    >
                      <span slot="icon" aria-hidden="true">${icons.settings}</span>
                      <span
                        >${t(
                          overrideCount === 1
                            ? "chat.composer.overrides.countOne"
                            : "chat.composer.overrides.count",
                          { count: String(overrideCount) },
                        )}</span
                      >
                      <span
                        slot="details"
                        class="agent-chat__capability-menu-clear-overrides"
                        aria-hidden="true"
                        >${icons.x}</span
                      >
                    </wa-dropdown-item>
                  `
                : nothing
            }`
        : nothing
    }
  `;
}

function renderSkillView(props: ChatComposerPlusMenuContentProps) {
  const disabledReason = props.mutationBlockedReason;
  const rows = props.skillsLoading
    ? renderCapabilityMenuState(t("chat.composer.menu.loadingSkills"), "status")
    : props.skillsError
      ? renderCapabilityMenuState(t("chat.composer.menu.skillsLoadFailed"), "alert")
      : !props.skills || props.skills.length === 0
        ? renderCapabilityMenuState(t("chat.composer.menu.noSkills"))
        : props.skills.map((skill, index) => {
            const title = skill.missingDeps
              ? t("chat.composer.menu.depsMissing")
              : skill.blocked
                ? t("chat.composer.menu.skillBlocked")
                : disabledReason;
            return renderCapabilityToggleRow({
              value: `skill:${index}`,
              label: skill.name,
              checked: skill.enabled,
              disabled: skill.missingDeps || skill.blocked || disabledReason !== null,
              title,
              note:
                skill.missingDeps || skill.blocked
                  ? html`<span class="agent-chat__capability-menu-note">${title}</span>`
                  : nothing,
            });
          });
  return html`
    ${renderBackRow()} ${renderComposerLibraryMenu(props.library)} ${rows} ${menuDivider()}
    <wa-dropdown-item class="agent-chat__capability-menu-item" value="manage-skills">
      ${internalLink(pathForRoute("skills", props.basePath), t("chat.composer.menu.manageSkills"))}
    </wa-dropdown-item>
  `;
}

function renderConnectorView(props: ChatComposerPlusMenuContentProps) {
  const disabledReason = props.mutationBlockedReason;
  const rows =
    props.mcpServers.length === 0
      ? renderCapabilityMenuState(t("chat.composer.menu.noConnectors"))
      : props.mcpServers.map((server, index) => {
          const override = readOwnEntry(props.toolOverrides?.mcpServers, server.name);
          const enabled = resolveToolOverrideState(server.enabled, override);
          return html`
            ${renderCapabilityToggleRow({
              value: `connector:${index}`,
              label: server.name,
              checked: enabled,
              disabled: disabledReason !== null,
              title: disabledReason,
              note: html`<span class="agent-chat__capability-menu-note">
                ${enabled ? t("common.enabled") : t("common.disabled")}
                ${
                  override !== undefined
                    ? html`<span class="agent-chat__capability-menu-session-tag"
                        >${t("chat.composer.menu.sessionTag")}</span
                      >`
                    : nothing
                }
              </span>`,
            })}
            ${
              props.onOpenToolAccess
                ? html`<wa-dropdown-item
                    class="agent-chat__capability-menu-item agent-chat__capability-menu-subrow"
                    value=${`tools:${index}`}
                  >
                    <span slot="icon" aria-hidden="true">${icons.wrench}</span>
                    <span>${t("chat.composer.menu.toolAccess.label")}</span>
                  </wa-dropdown-item>`
                : nothing
            }
          `;
        });
  const adminDisabled = !props.canAdmin;
  return html`
    ${renderBackRow()} ${rows} ${menuDivider()}
    ${
      props.onAddServer
        ? html`<wa-dropdown-item
            class="agent-chat__capability-menu-item"
            value="add-server"
            ?disabled=${adminDisabled}
            title=${adminDisabled ? (props.adminBlockedReason ?? "") : ""}
          >
            <span slot="icon" aria-hidden="true">${icons.plus}</span>
            <span>${t("chat.composer.menu.addMcpServer")}</span>
          </wa-dropdown-item>`
        : nothing
    }
  `;
}

type McpToolEntry = ToolsEffectiveEntry & { mcpServer: string; mcpToolName: string };

function toolsForServer(result: ToolsEffectiveResult | null, serverName: string): McpToolEntry[] {
  return (result?.groups ?? [])
    .flatMap((group) => group.tools)
    .filter(
      (tool): tool is McpToolEntry =>
        tool.source === "mcp" && tool.mcpServer === serverName && Boolean(tool.mcpToolName),
    );
}

const MCP_DISCOVERY_NOTICE_IDS = new Set([
  "mcp-not-yet-connected",
  "mcp-not-yet-listed",
  "mcp-stale-catalog",
]);

function mcpDiscoveryNotice(result: ToolsEffectiveResult | null, serverName: string) {
  return result?.notices?.find(
    (notice) =>
      MCP_DISCOVERY_NOTICE_IDS.has(notice.id) && notice.servers?.includes(serverName) === true,
  );
}

function isToolDenied(props: ChatComposerPlusMenuContentProps, tool: McpToolEntry): boolean {
  const serverName = tool.mcpServer;
  const rawToolName = tool.mcpToolName;
  if (!serverName) {
    return false;
  }
  if (props.toolOverrides != null) {
    return (
      readOwnEntry(props.toolOverrides.mcpToolsDeny, serverName)?.includes(rawToolName) ?? false
    );
  }
  return tool.deniedBySession === true;
}

function renderToolAccessView(props: ChatComposerPlusMenuContentProps, serverName: string) {
  const tools = toolsForServer(props.toolsEffectiveResult, serverName);
  const discoveryNotice =
    tools.length === 0 ? mcpDiscoveryNotice(props.toolsEffectiveResult, serverName) : null;
  const enabledCount = tools.filter((tool) => !isToolDenied(props, tool)).length;
  const summary = t(
    tools.length === 1
      ? "chat.composer.menu.toolAccess.summaryOne"
      : "chat.composer.menu.toolAccess.summary",
    { enabled: String(enabledCount), total: String(tools.length) },
  );
  const rows = props.toolsEffectiveLoading
    ? renderCapabilityMenuState(t("chat.composer.menu.toolAccess.loading"), "status")
    : props.toolsEffectiveError
      ? renderCapabilityMenuState(t("chat.composer.menu.toolAccess.loadFailed"), "alert")
      : discoveryNotice
        ? renderCapabilityMenuState(formatUiExternalText(discoveryNotice.message), "status")
        : tools.length === 0
          ? renderCapabilityMenuState(t("chat.composer.menu.toolAccess.noTools"))
          : tools.map((tool, index) => {
              const rawToolName = tool.mcpToolName;
              const label = tool.label?.trim();
              const denied = isToolDenied(props, tool);
              return renderCapabilityToggleRow({
                value: `mcp-tool:${index}`,
                label: rawToolName,
                checked: !denied,
                disabled: props.toolAccessMutationBlockedReason !== null,
                title: props.toolAccessMutationBlockedReason,
                note:
                  label && label !== rawToolName
                    ? html`<span class="agent-chat__capability-menu-note">${label}</span>`
                    : nothing,
              });
            });
  return html`
    ${renderBackRow()}
    <div class="agent-chat__capability-menu-state">
      <span class="agent-chat__capability-menu-label">
        <strong translate="no">${serverName}</strong>
        ${
          tools.length > 0
            ? html`<span class="agent-chat__capability-menu-note">${summary}</span>`
            : nothing
        }
      </span>
    </div>
    ${rows}
  `;
}

function handleMenuSelection(
  event: CustomEvent<{ item: { value?: string } }>,
  props: ChatComposerPlusMenuContentProps,
) {
  const value = event.detail.item.value ?? "";
  if (uploadsEnabled(props.attachments.uploadConfig) && handleChatAttachmentMenuSelection(event)) {
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
  const menu = event.currentTarget as HTMLElement;
  const changeView = (view: ChatComposerPlusMenuView) => {
    props.onViewChange(view);
    requestAnimationFrame(() =>
      menu.querySelector<HTMLElement>("wa-dropdown-item:not([disabled])")?.focus(),
    );
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
    const enabled = resolveWebSearchToolOverrideState(
      props.webSearchBaseEnabled,
      props.toolOverrides?.webSearch,
    );
    props.onPatchToolOverrides(
      nextWebSearchToolOverrides(
        props.toolOverrides,
        props.webSearchBaseEnabled && !enabled,
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
    const skill = props.skills?.[Number(value.slice("skill:".length))];
    if (skill && !skill.missingDeps && !skill.blocked && !props.mutationBlockedReason) {
      toggleCapability("skills", skill.key, skill.enabled, skill.baseEnabled);
    }
    return;
  }
  if (value.startsWith("connector:")) {
    event.preventDefault();
    const server = props.mcpServers[Number(value.slice("connector:".length))];
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
    const server = props.mcpServers[Number(value.slice("tools:".length))];
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
    const tool = toolsForServer(props.toolsEffectiveResult, serverName)[
      Number(value.slice("mcp-tool:".length))
    ];
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
    return;
  }
  if (value === "manage-skills") {
    props.onNavigate("skills");
  } else if (value === "manage-plugins") {
    props.onNavigate("plugins");
  }
}

function renderChatComposerPlusMenuContent(props: ChatComposerPlusMenuContentProps) {
  const hasOverrides = countSessionToolOverrides(props.toolOverrides) > 0;
  const view = props.showCapabilities ? props.view : "root";
  const content =
    view === "skills"
      ? renderSkillView(props)
      : view === "connectors"
        ? renderConnectorView(props)
        : view.startsWith("tools:")
          ? renderToolAccessView(props, view.slice("tools:".length))
          : view.startsWith("library:")
            ? renderComposerLibraryMenu(props.library, view.slice("library:".length))
            : renderRootView(props);
  return html`
    <wa-dropdown
      class="agent-chat__attach-menu agent-chat__capability-menu"
      placement="top-start"
      aria-label=${t("chat.composer.addAttachment")}
      .open=${props.open}
      @wa-select=${(event: CustomEvent<{ item: { value?: string } }>) =>
        handleMenuSelection(event, props)}
      @wa-show=${() => {
        if (!props.open) {
          props.onOpenChange(true);
        }
        props.onLoadSkills();
      }}
      @wa-hide=${() => {
        if (props.open) {
          props.onOpenChange(false);
        }
      }}
      data-view=${view}
    >
      ${renderChatAttachmentMenuTrigger(props.disabled, hasOverrides)} ${content}
    </wa-dropdown>
    ${props.addServerDialog ?? nothing} ${props.libraryDialog ?? nothing}
  `;
}

export function renderChatComposerPlusMenu(props: ChatComposerPlusMenuProps) {
  const capabilityMenu = props.capabilityMenu;
  if (
    !capabilityMenu &&
    !props.rootToggles?.length &&
    !uploadsEnabled(props.attachments.uploadConfig)
  ) {
    return nothing;
  }
  return renderChatComposerPlusMenuContent({
    ...props,
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
  });
}
