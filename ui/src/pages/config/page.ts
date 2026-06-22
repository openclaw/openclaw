import { html } from "lit";
import type { RouteRenderContext } from "../../app-routes.ts";
import { renderSettingsWorkspace } from "../../components/settings-workspace.ts";
import { t } from "../../i18n/index.ts";
import type { AppViewState } from "../../ui/app-view-state.ts";
import { setAssistantAvatarOverride } from "../../ui/controllers/assistant-identity.ts";
import { patchSession } from "../../ui/controllers/sessions.ts";
import { buildAgentMainSessionKey, parseAgentSessionKey } from "../../ui/session-key.ts";
import { loadLocalAssistantIdentity } from "../../ui/storage.ts";
import { normalizeOptionalString } from "../../ui/string-coerce.ts";
import type { FastMode } from "../../ui/types.ts";
import { isRenderableControlUiAvatarUrl } from "../../ui/views/agents-utils.ts";
import { renderMcp } from "../../ui/views/mcp.ts";
import {
  applyConfig,
  loadConfig,
  openConfigFile,
  resetConfigPendingChanges,
  runUpdate,
  saveConfig,
  stageConfigPreset,
  updateConfigFormValue,
  updateConfigRawValue,
  updateMcpServerEnabled,
} from "./data.ts";
import { getPresetById } from "./presets.ts";
import { renderQuickSettings, type QuickSettingsChannel } from "./quick.ts";
import { renderConfig, type ConfigProps } from "./view.ts";

export type ConfigPageId =
  | "config"
  | "communications"
  | "appearance"
  | "automation"
  | "mcp"
  | "infrastructure"
  | "ai-agents";

type ConfigRenderContext = {
  state: AppViewState;
  pageId: ConfigPageId;
  navigate: RouteRenderContext["navigate"];
};

const COMMUNICATION_SECTION_KEYS = [
  "messages",
  "broadcast",
  "__notifications__",
  "talk",
  "audio",
  "channels",
] as const;
const APPEARANCE_SECTION_KEYS = ["__appearance__", "ui", "wizard"] as const;
const AUTOMATION_SECTION_KEYS = ["commands", "hooks", "bindings", "cron", "approvals", "plugins"];
const INFRASTRUCTURE_SECTION_KEYS = [
  "gateway",
  "web",
  "browser",
  "nodeHost",
  "canvasHost",
  "discovery",
  "media",
  "acp",
  "mcp",
] as const;
const AI_AGENTS_SECTION_KEYS = [
  "agents",
  "models",
  "skills",
  "tools",
  "memory",
  "session",
] as const;
const SCOPED_CONFIG_SECTION_KEYS = new Set<string>([
  ...COMMUNICATION_SECTION_KEYS,
  ...APPEARANCE_SECTION_KEYS,
  ...AUTOMATION_SECTION_KEYS,
  ...INFRASTRUCTURE_SECTION_KEYS,
  ...AI_AGENTS_SECTION_KEYS,
]);
const KNOWN_CHANNELS = [
  { id: "telegram", label: "Telegram" },
  { id: "discord", label: "Discord" },
  { id: "slack", label: "Slack" },
  { id: "whatsapp", label: "WhatsApp" },
  { id: "signal", label: "Signal" },
  { id: "imessage", label: "iMessage" },
] as const;

function normalizeConfigSelection(
  pageId: ConfigPageId,
  activeSection: string | null,
  activeSubsection: string | null,
): { activeSection: string | null; activeSubsection: string | null } {
  const sections: readonly string[] | null =
    pageId === "communications"
      ? COMMUNICATION_SECTION_KEYS
      : pageId === "appearance"
        ? APPEARANCE_SECTION_KEYS
        : pageId === "automation"
          ? AUTOMATION_SECTION_KEYS
          : pageId === "mcp" || pageId === "infrastructure"
            ? INFRASTRUCTURE_SECTION_KEYS
            : pageId === "ai-agents"
              ? AI_AGENTS_SECTION_KEYS
              : null;
  if (pageId === "config" && activeSection && SCOPED_CONFIG_SECTION_KEYS.has(activeSection)) {
    return { activeSection: null, activeSubsection: null };
  }
  if (sections && activeSection && !sections.includes(activeSection)) {
    return { activeSection: null, activeSubsection: null };
  }
  return { activeSection, activeSubsection };
}

function mcpServerCount(config: unknown): number {
  if (!config || typeof config !== "object" || Array.isArray(config)) {
    return 0;
  }
  const mcp = (config as Record<string, unknown>).mcp;
  if (!mcp || typeof mcp !== "object" || Array.isArray(mcp)) {
    return 0;
  }
  const servers = (mcp as Record<string, unknown>).servers;
  return servers && typeof servers === "object" && !Array.isArray(servers)
    ? Object.keys(servers).length
    : 0;
}

function countSchemaSections(
  schema: unknown,
  include?: readonly string[],
  exclude?: readonly string[],
) {
  const properties =
    schema && typeof schema === "object" && !Array.isArray(schema)
      ? (schema as { properties?: unknown }).properties
      : null;
  if (!properties || typeof properties !== "object" || Array.isArray(properties)) {
    return 0;
  }
  const includeSet = include?.length ? new Set(include) : null;
  const excludeSet = exclude?.length ? new Set(exclude) : null;
  return Object.keys(properties).filter(
    (key) => (!includeSet || includeSet.has(key)) && !excludeSet?.has(key),
  ).length;
}

function assistantAvatarUrl(state: AppViewState): string | undefined {
  const agentId =
    parseAgentSessionKey(state.sessionKey)?.agentId ?? state.agentsList?.defaultId ?? "main";
  const identity = state.agentsList?.agents?.find((agent) => agent.id === agentId)?.identity;
  const candidate = identity?.avatarUrl ?? identity?.avatar;
  return typeof candidate === "string" && isRenderableControlUiAvatarUrl(candidate)
    ? candidate
    : undefined;
}

function assistantAvatarOverride(config: unknown): string | null {
  if (!config || typeof config !== "object" || Array.isArray(config)) {
    return null;
  }
  const assistant = (config as { ui?: { assistant?: { avatar?: unknown } } }).ui?.assistant;
  return normalizeOptionalString(assistant?.avatar) ?? null;
}

function assistantAvatarRoute(state: AppViewState, agentId: string): string {
  const base = (state.basePath ?? "").replace(/\/+$/, "");
  return `${base}/avatar/${encodeURIComponent(agentId)}`;
}

function activeAvatarAgentId(state: AppViewState): string {
  const parsed = parseAgentSessionKey(state.sessionKey);
  if (parsed) {
    return parsed.agentId;
  }
  const sessionKey = normalizeOptionalString(state.sessionKey)?.toLowerCase();
  if (sessionKey === "global" || sessionKey === "unknown") {
    return normalizeOptionalString(state.assistantAgentId) ?? state.agentsList?.defaultId ?? "main";
  }
  return state.agentsList?.defaultId ?? "main";
}

function quickChannels(state: AppViewState): QuickSettingsChannel[] {
  const config = state.configForm ?? state.configSnapshot?.config;
  const channels =
    config && typeof config === "object" && "channels" in config && config.channels
      ? config.channels
      : null;
  const configured =
    channels && typeof channels === "object" && !Array.isArray(channels)
      ? (channels as Record<string, unknown>)
      : {};
  const configuredIds = Object.keys(configured).filter((id) => id.trim().length > 0);
  const channelIds =
    configuredIds.length > 0
      ? configuredIds.toSorted((left, right) => left.localeCompare(right))
      : KNOWN_CHANNELS.map(({ id }) => id);
  const labels = new Map(KNOWN_CHANNELS.map(({ id, label }) => [id, label]));
  return channelIds.map((id) => {
    const value = configured[id];
    const connected = Boolean(value && typeof value === "object" && Object.keys(value).length);
    return {
      id,
      label:
        labels.get(id) ??
        id.replace(/[-_]+/g, " ").replace(/\b\w/g, (character) => character.toUpperCase()),
      connected,
      detail: connected ? "Configured" : undefined,
    };
  });
}

export function extractQuickSettingsSecurity(state: AppViewState): {
  gatewayAuth: string;
  execPolicy: string;
  deviceAuth: boolean;
  browserEnabled: boolean;
  toolProfile: string;
} {
  const config = state.configForm ?? state.configSnapshot?.config;
  if (!config || typeof config !== "object") {
    return {
      gatewayAuth: "unknown",
      execPolicy: "unknown",
      deviceAuth: false,
      browserEnabled: true,
      toolProfile: "full",
    };
  }
  const root = config as Record<string, unknown>;
  const gateway =
    root.gateway && typeof root.gateway === "object"
      ? (root.gateway as Record<string, unknown>)
      : null;
  const auth =
    gateway?.auth && typeof gateway.auth === "object"
      ? (gateway.auth as Record<string, unknown>)
      : null;
  const tools =
    root.tools && typeof root.tools === "object" ? (root.tools as Record<string, unknown>) : {};
  const exec =
    tools.exec && typeof tools.exec === "object" ? (tools.exec as Record<string, unknown>) : {};
  let gatewayAuth = "unknown";
  if (auth) {
    const mode = typeof auth.mode === "string" ? auth.mode.trim() : "";
    gatewayAuth = mode
      ? mode
      : auth.password
        ? "password"
        : auth.token
          ? "token"
          : auth.trustedProxy
            ? "trusted-proxy"
            : "none";
  }
  const profile = tools.profile;
  const security = exec.security;
  const browser =
    root.browser && typeof root.browser === "object"
      ? (root.browser as Record<string, unknown>)
      : null;
  const controlUi =
    gateway?.controlUi && typeof gateway.controlUi === "object"
      ? (gateway.controlUi as Record<string, unknown>)
      : null;
  return {
    gatewayAuth,
    execPolicy: typeof security === "string" && security.trim() ? security.trim() : "allowlist",
    deviceAuth: controlUi?.dangerouslyDisableDeviceAuth !== true,
    browserEnabled: browser?.enabled !== false,
    toolProfile: typeof profile === "string" && profile.trim() ? profile.trim() : "full",
  };
}

function renderConfigPage({ state, navigate, pageId }: ConfigRenderContext) {
  const requestUpdate = (state as AppViewState & { requestUpdate?: () => void }).requestUpdate;
  const configObject =
    state.configForm ?? (state.configSnapshot?.config as Record<string, unknown> | null) ?? {};
  const localAvatar =
    normalizeOptionalString(
      loadLocalAssistantIdentity({ agentId: activeAvatarAgentId(state) }).avatar,
    ) ?? null;
  const configuredAvatar = localAvatar ?? assistantAvatarOverride(configObject);
  const avatarStatus = localAvatar
    ? "data"
    : (state.assistantAvatarStatus ?? state.chatAvatarStatus ?? null);
  const avatarReason = localAvatar
    ? null
    : (state.assistantAvatarReason ?? state.chatAvatarReason ?? null);
  const missingAvatar = avatarStatus === "none" && avatarReason === "missing";
  const currentAvatar = missingAvatar || avatarStatus === "local" ? null : state.assistantAvatar;
  const currentAvatarUrl =
    localAvatar ??
    (avatarStatus === "local" && state.assistantAgentId
      ? assistantAvatarRoute(state, state.assistantAgentId)
      : (state.chatAvatarUrl ?? (missingAvatar ? null : (assistantAvatarUrl(state) ?? null))));
  const activeSession = state.sessionsResult?.sessions.find((row) => row.key === state.sessionKey);
  const agentsDefaults =
    configObject && typeof configObject === "object" && !Array.isArray(configObject)
      ? (((configObject as Record<string, unknown>).agents as Record<string, unknown> | undefined)
          ?.defaults as Record<string, unknown> | undefined)
      : undefined;
  const currentModel =
    typeof activeSession?.model === "string"
      ? activeSession.model
      : typeof agentsDefaults?.model === "string"
        ? agentsDefaults.model
        : "default";
  const thinkingLevel =
    typeof activeSession?.thinkingLevel === "string"
      ? activeSession.thinkingLevel
      : typeof agentsDefaults?.thinkingLevel === "string"
        ? agentsDefaults.thinkingLevel
        : "off";
  const resolvedFastMode =
    activeSession?.effectiveFastMode ?? activeSession?.fastMode ?? agentsDefaults?.fastMode;
  const fastMode: FastMode =
    resolvedFastMode === "auto" || typeof resolvedFastMode === "boolean" ? resolvedFastMode : false;

  const common: Omit<
    ConfigProps,
    | "formMode"
    | "searchQuery"
    | "activeSection"
    | "activeSubsection"
    | "onFormModeChange"
    | "onSearchChange"
    | "onSectionChange"
    | "onSubsectionChange"
    | "showModeToggle"
    | "navRootLabel"
    | "showRootTab"
    | "includeSections"
    | "excludeSections"
    | "includeVirtualSections"
  > = {
    raw: state.configRaw,
    originalRaw: state.configRawOriginal,
    valid: state.configValid,
    issues: state.configIssues,
    loading: state.configLoading,
    saving: state.configSaving,
    applying: state.configApplying,
    updating: state.updateRunning,
    connected: state.connected,
    schema: state.configSchema,
    schemaLoading: state.configSchemaLoading,
    uiHints: state.configUiHints,
    formValue: state.configForm,
    originalValue: state.configFormOriginal,
    onRawChange: (next) => updateConfigRawValue(state, next),
    onRequestUpdate: requestUpdate,
    onFormPatch: (path, value) => updateConfigFormValue(state, path, value),
    onReload: () => void loadConfig(state, { discardPendingChanges: true }),
    onReset: () => resetConfigPendingChanges(state),
    onSave: () => void saveConfig(state),
    onApply: () => void applyConfig(state),
    onUpdate: () => void runUpdate(state),
    onOpenFile: () => void openConfigFile(state),
    version: state.hello?.server?.version ?? "",
    theme: state.theme,
    themeMode: state.themeMode,
    setTheme: (theme, context) => state.setTheme(theme, context),
    setThemeMode: (mode, context) => state.setThemeMode(mode, context),
    hasCustomTheme: Boolean(state.settings.customTheme),
    customThemeLabel: state.settings.customTheme?.label ?? null,
    customThemeSourceUrl: state.settings.customTheme?.sourceUrl ?? null,
    customThemeImportUrl: state.customThemeImportUrl,
    customThemeImportBusy: state.customThemeImportBusy,
    customThemeImportMessage: state.customThemeImportMessage,
    customThemeImportExpanded: state.customThemeImportExpanded,
    customThemeImportFocusToken: state.customThemeImportFocusToken,
    onCustomThemeImportUrlChange: (next) => state.setCustomThemeImportUrl(next),
    onOpenCustomThemeImport: () => state.openCustomThemeImport(),
    onImportCustomTheme: () => void state.importCustomTheme(),
    onClearCustomTheme: () => state.clearCustomTheme(),
    borderRadius: state.settings.borderRadius,
    setBorderRadius: (value) => state.setBorderRadius(value),
    textScale: state.settings.textScale ?? 100,
    setTextScale: (value) => state.setTextScale(value),
    gatewayUrl: state.settings.gatewayUrl,
    assistantName: state.assistantName,
    configPath: state.configSnapshot?.path ?? null,
    rawAvailable: Boolean(state.configSnapshot?.config || state.configForm || state.configRaw),
  };

  const renderTab = (options: {
    formMode: "form" | "raw";
    searchQuery: string;
    activeSection: string | null;
    activeSubsection: string | null;
    onFormModeChange: (mode: "form" | "raw") => void;
    onSearchChange: (query: string) => void;
    onSectionChange: (section: string | null) => void;
    onSubsectionChange: (section: string | null) => void;
    includeSections?: readonly string[];
    excludeSections?: readonly string[];
    navRootLabel?: string;
    showModeToggle?: boolean;
    includeVirtualSections?: boolean;
    settingsLayout?: "tabs" | "accordion";
    onBackToQuick?: () => void;
    webPush?: ConfigProps["webPush"];
    onWebPushSubscribe?: () => void;
    onWebPushUnsubscribe?: () => void;
    onWebPushTest?: () => void;
  }) =>
    renderConfig({
      ...common,
      ...options,
      includeSections: options.includeSections ? [...options.includeSections] : undefined,
      excludeSections: options.excludeSections ? [...options.excludeSections] : undefined,
      includeVirtualSections: options.includeVirtualSections ?? false,
      showRootTab: !options.includeSections?.length,
      schemaSectionCount: countSchemaSections(
        common.schema,
        options.includeSections,
        options.excludeSections,
      ),
    } as ConfigProps);

  const config = state.configForm ?? state.configSnapshot?.config ?? {};
  const statePrefix =
    pageId === "ai-agents" ? "aiAgents" : pageId === "mcp" ? "infrastructure" : pageId;
  const activeSelection = normalizeConfigSelection(
    pageId,
    state[`${statePrefix}ActiveSection` as "configActiveSection"],
    state[`${statePrefix}ActiveSubsection` as "configActiveSubsection"],
  );
  const tabBody = renderTab({
    formMode:
      pageId === "config"
        ? state.configFormMode
        : pageId === "communications"
          ? state.communicationsFormMode
          : pageId === "appearance"
            ? state.appearanceFormMode
            : pageId === "automation"
              ? state.automationFormMode
              : pageId === "infrastructure" || pageId === "mcp"
                ? state.infrastructureFormMode
                : state.aiAgentsFormMode,
    searchQuery:
      pageId === "config"
        ? state.configSearchQuery
        : pageId === "communications"
          ? state.communicationsSearchQuery
          : pageId === "appearance"
            ? state.appearanceSearchQuery
            : pageId === "automation"
              ? state.automationSearchQuery
              : pageId === "infrastructure" || pageId === "mcp"
                ? state.infrastructureSearchQuery
                : state.aiAgentsSearchQuery,
    activeSection: pageId === "mcp" ? "mcp" : activeSelection.activeSection,
    activeSubsection: pageId === "mcp" ? null : activeSelection.activeSubsection,
    onFormModeChange: (mode) => {
      if (pageId === "config") state.configFormMode = mode;
      else if (pageId === "communications") state.communicationsFormMode = mode;
      else if (pageId === "appearance") state.appearanceFormMode = mode;
      else if (pageId === "automation") state.automationFormMode = mode;
      else if (pageId === "infrastructure" || pageId === "mcp") state.infrastructureFormMode = mode;
      else state.aiAgentsFormMode = mode;
    },
    onSearchChange: (query) => {
      if (pageId === "config") state.configSearchQuery = query;
      else if (pageId === "communications") state.communicationsSearchQuery = query;
      else if (pageId === "appearance") state.appearanceSearchQuery = query;
      else if (pageId === "automation") state.automationSearchQuery = query;
      else if (pageId === "infrastructure" || pageId === "mcp")
        state.infrastructureSearchQuery = query;
      else state.aiAgentsSearchQuery = query;
    },
    onSectionChange: (section) => {
      if (pageId === "config") {
        state.configActiveSection = section;
        state.configActiveSubsection = null;
      } else if (pageId === "communications") {
        state.communicationsActiveSection = section;
        state.communicationsActiveSubsection = null;
      } else if (pageId === "appearance") {
        state.appearanceActiveSection = section;
        state.appearanceActiveSubsection = null;
      } else if (pageId === "automation") {
        state.automationActiveSection = section;
        state.automationActiveSubsection = null;
      } else if (pageId === "infrastructure" || pageId === "mcp") {
        state.infrastructureActiveSection = section;
        state.infrastructureActiveSubsection = null;
      } else {
        state.aiAgentsActiveSection = section;
        state.aiAgentsActiveSubsection = null;
      }
    },
    onSubsectionChange: (section) => {
      if (pageId === "config") state.configActiveSubsection = section;
      else if (pageId === "communications") state.communicationsActiveSubsection = section;
      else if (pageId === "appearance") state.appearanceActiveSubsection = section;
      else if (pageId === "automation") state.automationActiveSubsection = section;
      else if (pageId === "infrastructure" || pageId === "mcp")
        state.infrastructureActiveSubsection = section;
      else state.aiAgentsActiveSubsection = section;
    },
    includeSections:
      pageId === "communications"
        ? COMMUNICATION_SECTION_KEYS
        : pageId === "appearance"
          ? APPEARANCE_SECTION_KEYS
          : pageId === "automation"
            ? AUTOMATION_SECTION_KEYS
            : pageId === "mcp" || pageId === "infrastructure"
              ? INFRASTRUCTURE_SECTION_KEYS
              : pageId === "ai-agents"
                ? AI_AGENTS_SECTION_KEYS
                : undefined,
    excludeSections:
      pageId === "config"
        ? [
            ...COMMUNICATION_SECTION_KEYS,
            ...AUTOMATION_SECTION_KEYS,
            ...INFRASTRUCTURE_SECTION_KEYS,
            ...AI_AGENTS_SECTION_KEYS,
            "ui",
            "wizard",
          ]
        : undefined,
    navRootLabel: pageId === "config" ? undefined : t(`tabs.${pageId}`),
    showModeToggle: pageId === "config",
    settingsLayout: pageId === "config" ? "accordion" : undefined,
    includeVirtualSections: pageId === "communications" || pageId === "appearance",
    onBackToQuick:
      pageId === "config"
        ? () => {
            state.configSettingsMode = "quick";
          }
        : undefined,
    webPush:
      pageId === "communications"
        ? {
            supported: state.webPushSupported,
            permission: state.webPushPermission,
            subscribed: state.webPushSubscribed,
            loading: state.webPushLoading,
          }
        : undefined,
    onWebPushSubscribe:
      pageId === "communications" ? () => void state.handleWebPushSubscribe() : undefined,
    onWebPushUnsubscribe:
      pageId === "communications" ? () => void state.handleWebPushUnsubscribe() : undefined,
    onWebPushTest: pageId === "communications" ? () => void state.handleWebPushTest() : undefined,
  });
  const body =
    pageId === "config" && state.configSettingsMode === "quick"
      ? renderQuickSettings({
          currentModel,
          thinkingLevel,
          fastMode,
          channels: quickChannels(state),
          automation: {
            cronJobCount: state.cronJobs?.length ?? 0,
            skillCount: state.skillsReport?.skills?.length ?? 0,
            mcpServerCount: mcpServerCount(config),
          },
          security: extractQuickSettingsSecurity(state),
          theme: state.theme,
          themeMode: state.themeMode,
          hasCustomTheme: Boolean(state.settings.customTheme),
          customThemeLabel: state.settings.customTheme?.label,
          borderRadius: state.settings.borderRadius,
          textScale: state.settings.textScale ?? 100,
          setTheme: (theme, context) => state.setTheme(theme, context),
          setThemeMode: (mode, context) => state.setThemeMode(mode, context),
          onModelChange: () => {
            state.configSettingsMode = "advanced";
            state.aiAgentsActiveSection = "models";
            navigate("ai-agents");
          },
          setBorderRadius: (value) => state.setBorderRadius(value),
          setTextScale: (value) => state.setTextScale(value),
          onOpenCustomThemeImport: () => {
            navigate("appearance");
            state.appearanceFormMode = "form";
            state.appearanceSearchQuery = "";
            state.appearanceActiveSection = "__appearance__";
            state.appearanceActiveSubsection = null;
            state.openCustomThemeImport();
            state.requestUpdate?.();
          },
          connected: state.connected,
          gatewayUrl: state.settings.gatewayUrl,
          assistantName: state.assistantName,
          version: state.hello?.server?.version ?? "",
          configObject: config as Record<string, unknown>,
          configDirty: state.configFormDirty,
          configSaving: state.configSaving,
          configApplying: state.configApplying,
          configReady: Boolean(state.configSnapshot?.hash),
          onSelectPreset: (id) => {
            const preset = getPresetById(id);
            if (preset) {
              stageConfigPreset(state, preset.patch);
            }
          },
          onResetConfig: () => resetConfigPendingChanges(state),
          onSaveConfig: () => void saveConfig(state),
          onApplyConfig: () => void applyConfig(state),
          onAdvancedSettings: () => {
            state.configSettingsMode = "advanced";
          },
          onThinkingChange: (level) =>
            void patchSession(state, state.sessionKey, { thinkingLevel: level }),
          onFastModeChange: (mode) =>
            void patchSession(state, state.sessionKey, { fastMode: mode }),
          onChannelConfigure: () => navigate("channels"),
          onManageCron: () => navigate("cron"),
          onBrowseSkills: () => navigate("skills"),
          onConfigureMcp: () => navigate("mcp"),
          onSecurityConfigure: () => {
            state.configSettingsMode = "advanced";
            state.configActiveSection = "auth";
          },
          onBrowserEnabledToggle: (enabled) =>
            updateConfigFormValue(state, ["browser", "enabled"], enabled),
          onToolProfileChange: (profile) =>
            updateConfigFormValue(state, ["tools", "profile"], profile),
          assistantAvatar: currentAvatar,
          assistantAvatarUrl: currentAvatarUrl,
          assistantAvatarSource: state.assistantAvatarSource,
          assistantAvatarUploadBusy: state.assistantAvatarUploadBusy,
          assistantAvatarUploadError: state.assistantAvatarUploadError,
          assistantAvatarStatus: avatarStatus,
          assistantAvatarReason: avatarReason,
          assistantAvatarOverride: configuredAvatar,
          basePath: state.basePath,
          userAvatar: state.userAvatar ?? null,
          onUserAvatarChange: (avatar) => state.applyLocalUserIdentity?.({ avatar }),
          onAssistantAvatarOverrideChange: (dataUrl) => {
            setAssistantAvatarOverride(state, dataUrl, activeAvatarAgentId(state));
            state.chatAvatarUrl = dataUrl;
          },
          onAssistantAvatarClearOverride: () => {
            const agentId = activeAvatarAgentId(state);
            setAssistantAvatarOverride(state, null, agentId);
            state.chatAvatarUrl = null;
            void state.loadAssistantIdentity?.({
              sessionKey: buildAgentMainSessionKey({ agentId }),
              expectedSessionKey: state.sessionKey,
            });
          },
        })
      : pageId === "mcp"
        ? renderMcp({
            configObject: config as Record<string, unknown>,
            configDirty: state.configFormDirty,
            configSaving: state.configSaving,
            configApplying: state.configApplying,
            connected: state.connected,
            onSaveConfig: () => void saveConfig(state),
            onApplyConfig: () => void applyConfig(state),
            onServerEnabledChange: (name, enabled) => {
              updateMcpServerEnabled(state, name, enabled);
              requestUpdate?.();
            },
            editor: tabBody,
          })
        : tabBody;

  return html`
    ${renderSettingsWorkspace(
      state,
      html`
        <section class="content-header">
          <div>
            <div class="page-title">
              ${pageId === "config" ? t("nav.settings") : t(`tabs.${pageId}`)}
            </div>
            <div class="page-sub">${t(`subtitles.${pageId}`)}</div>
          </div>
        </section>
        ${body}
      `,
      pageId,
      navigate,
    )}
  `;
}

export function renderConfigRoute(
  state: AppViewState,
  pageId: ConfigPageId,
  navigate: RouteRenderContext["navigate"],
) {
  return renderConfigPage({ state, pageId, navigate });
}
