import type { JSX } from "@solidjs/web";
import { createMemo, For, Show } from "solid-js";
import type { ToolsEffectiveEntry, ToolsEffectiveResult } from "../../../api/types.ts";
import { pathForRoute } from "../../../app-route-paths.ts";
import type { ApplicationNavigationOptions } from "../../../app/context.ts";
import { icons } from "../../../components/icons.ts";
import { Icon } from "../../../components/solid/icon.tsx";
import { registerMcpEnglish } from "../../../i18n/locales/en-mcp.ts";
import "@awesome.me/webawesome/dist/components/switch/switch.js";
import type { McpServerSummary } from "../../../lib/config/mcp-servers.ts";
import { formatUiExternalText } from "../../../lib/format-error.ts";
import { registerEnglishCatalog, t } from "../../../lib/reactive/i18n.ts";
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
import { uploadsEnabled } from "../../../lib/uploads.ts";
import type { ComposerLibraryProps } from "../composer-library-session.ts";
import "../../../components/tooltip.ts";
import "../../../components/web-awesome.ts";
import type { ChatAttachmentControlsProps } from "./chat-attachment-controls.types.ts";
import { handleChatAttachmentMenuSelection } from "./chat-attachment-inputs.ts";
import { useSingleAttachmentPicker } from "./chat-attachment-picker-policy.ts";
import { solidTemplate } from "./chat-composer-controls.ts";
import { LitContent } from "./chat-composer-interop.tsx";
import {
  handleComposerLibrarySelection,
  renderComposerLibraryMenuSolid,
} from "./chat-composer-library-menu.tsx";
import {
  renderBackRow,
  renderCapabilityMenuState,
  renderCapabilityToggleRow as CapabilityToggleRow,
  menuDivider,
} from "./chat-composer-menu-rows.tsx";

registerEnglishCatalog(registerMcpEnglish);

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
  icon?: unknown;
  checked: boolean;
  disabled: boolean;
  title?: string;
  onChange: (checked: boolean) => void;
};

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
  libraryDialog?: unknown;
  mcpServers: readonly McpServerSummary[];
  toolsEffectiveResult: ToolsEffectiveResult | null;
  toolsEffectiveLoading: boolean;
  toolsEffectiveError: boolean;
  toolAccessMutationBlockedReason: string | null;
  webSearchBaseEnabled: boolean;
  mutationBlockedReason: string | null;
  canAdmin: boolean;
  adminBlockedReason: string | null;
  addServerDialog?: unknown;
  onLoadSkills: () => void;
  onPatchToolOverrides: (next: SessionToolOverrides | null) => void;
  onNavigate: (
    routeId: "mcp" | "plugins" | "skills",
    options?: ApplicationNavigationOptions,
  ) => void;
  onAddServer?: () => void;
  onOpenToolAccess?: (serverName: string) => void;
};

type ChatComposerPlusMenuContentProps = ChatComposerPlusMenuProps &
  ChatComposerCapabilityMenuProps & { showCapabilities: boolean };

// The trigger and item hosts stay direct children of Web Awesome's slot owner.
function renderAttachmentOptions() {
  const entries = useSingleAttachmentPicker()
    ? [{ value: "file", icon: icons.paperclip, label: t("chat.composer.attach") }]
    : [
        { value: "camera", icon: icons.camera, label: t("chat.composer.takePhoto") },
        { value: "photo", icon: icons.image, label: t("chat.composer.attachPhoto") },
        { value: "file", icon: icons.paperclip, label: t("chat.composer.attachFileOption") },
      ];
  return (
    <For keyed={(item) => item} each={entries}>
      {(entry) => (
        <wa-dropdown-item class="agent-chat__attach-menu-option" value={entry().value}>
          <span slot="icon" aria-hidden="true">
            <LitContent value={entry().icon} />
          </span>
          <span>{entry().label}</span>
        </wa-dropdown-item>
      )}
    </For>
  );
}

const internalLink = (href: string, label: string): JSX.Element => (
  <a
    class="agent-chat__capability-menu-link"
    href={href}
    tabindex="-1"
    onClick={(event: MouseEvent) => event.preventDefault()}
  >
    {label}
  </a>
);

function RootView(props: { menu: ChatComposerPlusMenuContentProps }) {
  const overrideCount = () => countSessionToolOverrides(props.menu.toolOverrides);
  const connectorCount = () =>
    props.menu.mcpServers.filter((server) =>
      resolveToolOverrideState(
        server.enabled,
        readOwnEntry(props.menu.toolOverrides?.mcpServers, server.name),
      ),
    ).length;
  const hasSkillOverrides = () => Object.keys(props.menu.toolOverrides?.skills ?? {}).length > 0;
  const enabledSkillCount = () => props.menu.skills?.filter((skill) => skill.enabled).length ?? 0;
  const webSearchEnabled = () =>
    resolveWebSearchToolOverrideState(
      props.menu.webSearchBaseEnabled,
      props.menu.toolOverrides?.webSearch,
    );
  const staleWebSearchEnable = () =>
    !props.menu.webSearchBaseEnabled && props.menu.toolOverrides?.webSearch === true;
  const webSearchDisabled = () =>
    props.menu.mutationBlockedReason !== null ||
    (!props.menu.webSearchBaseEnabled && !staleWebSearchEnable());
  const webSearchTitle = () =>
    props.menu.mutationBlockedReason ??
    (staleWebSearchEnable()
      ? t("chat.composer.menu.webSearchClearStaleEnable")
      : !props.menu.webSearchBaseEnabled
        ? t("chat.composer.menu.webSearchGloballyDisabled")
        : "");
  const canUpload = () => uploadsEnabled(props.menu.attachments.uploadConfig);
  return (
    <>
      <Show when={canUpload()}>{renderAttachmentOptions()}</Show>
      <Show when={props.menu.showCapabilities || props.menu.rootToggles?.length}>
        <Show when={canUpload()}>{menuDivider()}</Show>
        <For each={props.menu.rootToggles ?? []} keyed={(toggle) => toggle.value}>
          {(toggle) => (
            <CapabilityToggleRow
              value={toggle().value}
              label={toggle().label}
              checked={toggle().checked}
              disabled={toggle().disabled}
              title={toggle().title}
              icon={toggle().icon}
            />
          )}
        </For>
      </Show>
      <Show when={props.menu.showCapabilities}>
        <For each={["skills", "connectors"] as const} keyed={(view) => view}>
          {(view) => (
            <wa-dropdown-item class="agent-chat__capability-menu-item" value={`open-${view()}`}>
              <span slot="icon" aria-hidden="true">
                <Icon name={view() === "skills" ? "book" : "plug"} />
              </span>
              <span>{t(`chat.composer.menu.${view()}`)}</span>
              <span slot="details" class="agent-chat__capability-menu-details">
                <Show when={view() === "connectors" || hasSkillOverrides()}>
                  <span class="agent-chat__capability-menu-badge">
                    {view() === "connectors"
                      ? connectorCount()
                      : t("chat.composer.menu.enabledCount", {
                          count: String(enabledSkillCount()),
                        })}
                  </span>
                </Show>
                <span class="agent-chat__capability-menu-chevron" aria-hidden="true">
                  <Icon name="chevronRight" />
                </span>
              </span>
            </wa-dropdown-item>
          )}
        </For>
        <CapabilityToggleRow
          value="toggle-web-search"
          label={t("chat.composer.menu.webSearch")}
          checked={webSearchEnabled()}
          disabled={webSearchDisabled()}
          title={webSearchTitle()}
          icon={icons.globe}
          checkbox={true}
        />
        {menuDivider()}
        <wa-dropdown-item class="agent-chat__capability-menu-item" value="manage-plugins">
          <span slot="icon" aria-hidden="true">
            <Icon name="plug" />
          </span>
          {internalLink(
            pathForRoute("plugins", props.menu.basePath),
            t("chat.composer.menu.managePlugins"),
          )}
        </wa-dropdown-item>
        <Show when={overrideCount() > 0}>
          <wa-dropdown-item
            class="agent-chat__capability-menu-item agent-chat__capability-menu-overrides"
            value="clear-overrides"
            disabled={props.menu.mutationBlockedReason !== null}
            title={props.menu.mutationBlockedReason ?? ""}
          >
            <span slot="icon" aria-hidden="true">
              <Icon name="settings" />
            </span>
            <span>
              {t(
                overrideCount() === 1
                  ? "chat.composer.overrides.countOne"
                  : "chat.composer.overrides.count",
                { count: String(overrideCount()) },
              )}
            </span>
            <span
              slot="details"
              class="agent-chat__capability-menu-clear-overrides"
              aria-hidden="true"
            >
              <Icon name="x" />
            </span>
          </wa-dropdown-item>
        </Show>
      </Show>
    </>
  );
}

function SkillView(props: { menu: ChatComposerPlusMenuContentProps }) {
  return (
    <>
      {renderBackRow()} {renderComposerLibraryMenuSolid(props.menu.library)}
      {props.menu.skillsLoading
        ? renderCapabilityMenuState(t("chat.composer.menu.loadingSkills"), "status")
        : props.menu.skillsError
          ? renderCapabilityMenuState(t("chat.composer.menu.skillsLoadFailed"), "alert")
          : !props.menu.skills?.length
            ? renderCapabilityMenuState(t("chat.composer.menu.noSkills"))
            : null}
      <For each={props.menu.skills ?? []} keyed={(skill) => skill.key}>
        {(skill, index) => {
          const title = () =>
            skill().missingDeps
              ? t("chat.composer.menu.depsMissing")
              : skill().blocked
                ? t("chat.composer.menu.skillBlocked")
                : props.menu.mutationBlockedReason;
          return (
            <CapabilityToggleRow
              value={`skill:${index()}`}
              label={skill().name}
              checked={skill().enabled}
              disabled={
                skill().missingDeps || skill().blocked || props.menu.mutationBlockedReason !== null
              }
              title={title()}
              note={
                skill().missingDeps || skill().blocked ? (
                  <span class="agent-chat__capability-menu-note">{title()}</span>
                ) : null
              }
            />
          );
        }}
      </For>
      {menuDivider()}
      <wa-dropdown-item class="agent-chat__capability-menu-item" value="manage-skills">
        {internalLink(
          pathForRoute("skills", props.menu.basePath),
          t("chat.composer.menu.manageSkills"),
        )}
      </wa-dropdown-item>
    </>
  );
}

function ConnectorView(props: { menu: ChatComposerPlusMenuContentProps }) {
  return (
    <>
      {renderBackRow()}
      <Show when={props.menu.mcpServers.length === 0}>
        {renderCapabilityMenuState(t("chat.composer.menu.noConnectors"))}
      </Show>
      <For each={props.menu.mcpServers} keyed={(server) => server.name}>
        {(server, index) => {
          const override = () => readOwnEntry(props.menu.toolOverrides?.mcpServers, server().name);
          const enabled = () => resolveToolOverrideState(server().enabled, override());
          return (
            <>
              <CapabilityToggleRow
                value={`connector:${index()}`}
                label={server().name}
                checked={enabled()}
                disabled={props.menu.mutationBlockedReason !== null}
                title={props.menu.mutationBlockedReason}
                note={
                  <span class="agent-chat__capability-menu-note">
                    {enabled() ? t("common.enabled") : t("common.disabled")}
                    <Show when={override() !== undefined}>
                      <span class="agent-chat__capability-menu-session-tag">
                        {t("chat.composer.menu.sessionTag")}
                      </span>
                    </Show>
                  </span>
                }
              />
              <Show when={props.menu.onOpenToolAccess}>
                <wa-dropdown-item
                  class="agent-chat__capability-menu-item agent-chat__capability-menu-subrow"
                  value={`tools:${index()}`}
                >
                  <span slot="icon" aria-hidden="true">
                    <Icon name="wrench" />
                  </span>
                  <span>{t("chat.composer.menu.toolAccess.label")}</span>
                </wa-dropdown-item>
              </Show>
            </>
          );
        }}
      </For>
      {menuDivider()}
      <Show when={props.menu.onAddServer}>
        <wa-dropdown-item
          class="agent-chat__capability-menu-item"
          value="add-server"
          disabled={!props.menu.canAdmin}
          title={!props.menu.canAdmin ? (props.menu.adminBlockedReason ?? "") : ""}
        >
          <span slot="icon" aria-hidden="true">
            <Icon name="plus" />
          </span>
          <span>{t("chat.composer.menu.addMcpServer")}</span>
        </wa-dropdown-item>
      </Show>
    </>
  );
}

type McpToolEntry = ToolsEffectiveEntry & { mcpServer: string; mcpToolName: string };

const toolsForServer = (result: ToolsEffectiveResult | null, serverName: string): McpToolEntry[] =>
  (result?.groups ?? [])
    .flatMap((group) => group.tools)
    .filter(
      (tool): tool is McpToolEntry =>
        tool.source === "mcp" && tool.mcpServer === serverName && Boolean(tool.mcpToolName),
    );

const MCP_DISCOVERY_NOTICE_IDS = new Set([
  "mcp-not-yet-connected",
  "mcp-not-yet-listed",
  "mcp-stale-catalog",
]);

const mcpDiscoveryNotice = (result: ToolsEffectiveResult | null, serverName: string) =>
  result?.notices?.find(
    (notice) =>
      MCP_DISCOVERY_NOTICE_IDS.has(notice.id) && notice.servers?.includes(serverName) === true,
  );

const isToolDenied = (props: ChatComposerPlusMenuContentProps, tool: McpToolEntry): boolean =>
  props.toolOverrides != null
    ? (readOwnEntry(props.toolOverrides.mcpToolsDeny, tool.mcpServer)?.includes(tool.mcpToolName) ??
      false)
    : tool.deniedBySession === true;

function ToolAccessView(props: { menu: ChatComposerPlusMenuContentProps; serverName: string }) {
  const tools = createMemo(() => toolsForServer(props.menu.toolsEffectiveResult, props.serverName));
  const discoveryNotice = createMemo(() =>
    tools().length === 0
      ? mcpDiscoveryNotice(props.menu.toolsEffectiveResult, props.serverName)
      : null,
  );
  const summary = () =>
    t(
      tools().length === 1
        ? "chat.composer.menu.toolAccess.summaryOne"
        : "chat.composer.menu.toolAccess.summary",
      {
        enabled: String(tools().filter((tool) => !isToolDenied(props.menu, tool)).length),
        total: String(tools().length),
      },
    );
  return (
    <>
      {renderBackRow()}
      <div class="agent-chat__capability-menu-state">
        <span class="agent-chat__capability-menu-label">
          <strong translate="no">{props.serverName}</strong>
          <Show when={tools().length > 0}>
            <span class="agent-chat__capability-menu-note">{summary()}</span>
          </Show>
        </span>
      </div>
      {props.menu.toolsEffectiveLoading ? (
        renderCapabilityMenuState(t("chat.composer.menu.toolAccess.loading"), "status")
      ) : props.menu.toolsEffectiveError ? (
        renderCapabilityMenuState(t("chat.composer.menu.toolAccess.loadFailed"), "alert")
      ) : (
        <Show
          when={discoveryNotice()}
          fallback={
            tools().length === 0
              ? renderCapabilityMenuState(t("chat.composer.menu.toolAccess.noTools"))
              : null
          }
        >
          {(notice) => (
            <>{renderCapabilityMenuState(formatUiExternalText(notice().message), "status")}</>
          )}
        </Show>
      )}
      <For each={tools()} keyed={(tool) => tool.mcpToolName}>
        {(tool, index) => (
          <CapabilityToggleRow
            value={`mcp-tool:${index()}`}
            label={tool().mcpToolName}
            checked={!isToolDenied(props.menu, tool())}
            disabled={props.menu.toolAccessMutationBlockedReason !== null}
            title={props.menu.toolAccessMutationBlockedReason}
            note={
              tool().label?.trim() && tool().label?.trim() !== tool().mcpToolName ? (
                <span class="agent-chat__capability-menu-note">{tool().label?.trim()}</span>
              ) : null
            }
          />
        )}
      </For>
    </>
  );
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
  // SAFETY: This selection handler is registered on the wa-dropdown element.
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

function PlusMenuSurface(props: { menu: ChatComposerPlusMenuContentProps }) {
  const hasOverrides = () => countSessionToolOverrides(props.menu.toolOverrides) > 0;
  const view = () => (props.menu.showCapabilities ? props.menu.view : "root");
  return (
    <>
      <wa-dropdown
        class="agent-chat__attach-menu agent-chat__capability-menu"
        placement="top-start"
        aria-label={t("chat.composer.addAttachment")}
        prop:open={props.menu.open}
        onWa-select={(event: CustomEvent<{ item: { value?: string } }>) =>
          handleMenuSelection(event, props.menu)
        }
        onWa-show={() => {
          if (!props.menu.open) {
            props.menu.onOpenChange(true);
          }
          props.menu.onLoadSkills();
        }}
        onWa-hide={() => {
          if (props.menu.open) {
            props.menu.onOpenChange(false);
          }
        }}
        data-view={view()}
      >
        <button
          slot="trigger"
          type="button"
          class={[
            "agent-chat__input-btn agent-chat__input-btn--attach",
            { "agent-chat__input-btn--has-overrides": hasOverrides() },
          ]}
          aria-label={t("chat.composer.addAttachment")}
          disabled={props.menu.disabled}
          title={t("chat.composer.addAttachment")}
        >
          <Icon name="plus" />
        </button>{" "}
        <Show when={view()} keyed>
          {(activeView) =>
            activeView === "skills" ? (
              <SkillView menu={props.menu} />
            ) : activeView === "connectors" ? (
              <ConnectorView menu={props.menu} />
            ) : activeView.startsWith("tools:") ? (
              <ToolAccessView menu={props.menu} serverName={activeView.slice("tools:".length)} />
            ) : activeView.startsWith("library:") ? (
              <>
                {renderComposerLibraryMenuSolid(
                  props.menu.library,
                  activeView.slice("library:".length),
                )}
              </>
            ) : (
              <RootView menu={props.menu} />
            )
          }
        </Show>
      </wa-dropdown>
      <LitContent value={props.menu.addServerDialog} />{" "}
      <LitContent value={props.menu.libraryDialog} />
    </>
  );
}

function resolvePlusMenuProps(props: ChatComposerPlusMenuProps) {
  const capabilityMenu = props.capabilityMenu;
  if (
    !capabilityMenu &&
    !props.rootToggles?.length &&
    !uploadsEnabled(props.attachments.uploadConfig)
  ) {
    return null;
  }
  return {
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
  };
}

export function ChatComposerPlusMenu(props: { menu: ChatComposerPlusMenuProps }) {
  return (
    <Show when={resolvePlusMenuProps(props.menu)}>
      {(menu) => <PlusMenuSurface menu={menu()} />}
    </Show>
  );
}

export function renderChatComposerPlusMenu(menu: ChatComposerPlusMenuProps) {
  return solidTemplate(ChatComposerPlusMenu, { menu });
}
