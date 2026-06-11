import { html, nothing } from "lit";
import { t } from "../i18n/index.ts";
import type { AppViewState } from "./app-view-state.ts";
import { setAssistantAvatarOverride } from "./controllers/assistant-identity.ts";
import {
  applyConfig,
  loadConfig,
  openConfigFile,
  resetConfigPendingChanges,
  runUpdate,
  saveConfig,
  stageConfigPreset,
  updateConfigFormValue,
} from "./controllers/config.ts";
import { patchSession } from "./controllers/sessions.ts";
import { normalizeOptionalString } from "./string-coerce.ts";
import { getPresetById } from "./views/config-presets.ts";
import { renderQuickSettings, type QuickSettingsChannel } from "./views/config-quick.ts";
import { renderConfig, type ConfigProps } from "./views/config.ts";

const COMMUNICATION_SECTION_KEYS = [
  "channels",
  "messages",
  "broadcast",
  "__notifications__",
  "talk",
  "audio",
] as const;
const APPEARANCE_SECTION_KEYS = ["__appearance__", "ui", "wizard"] as const;
const AUTOMATION_SECTION_KEYS = [
  "commands",
  "hooks",
  "bindings",
  "cron",
  "approvals",
  "plugins",
] as const;
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

type ConfigSectionSelection = {
  activeSection: string | null;
  activeSubsection: string | null;
};

type ConfigTabOverrides = Pick<
  ConfigProps,
  | "formMode"
  | "searchQuery"
  | "activeSection"
  | "activeSubsection"
  | "onFormModeChange"
  | "onSearchChange"
  | "onSectionChange"
  | "onSubsectionChange"
> &
  Partial<
    Pick<
      ConfigProps,
      | "showModeToggle"
      | "navRootLabel"
      | "includeSections"
      | "excludeSections"
      | "includeVirtualSections"
      | "settingsLayout"
      | "onBackToQuick"
      | "webPush"
      | "onWebPushSubscribe"
      | "onWebPushUnsubscribe"
      | "onWebPushTest"
    >
  >;

const SCOPED_CONFIG_SECTION_KEYS = new Set<string>([
  ...COMMUNICATION_SECTION_KEYS,
  ...APPEARANCE_SECTION_KEYS,
  ...AUTOMATION_SECTION_KEYS,
  ...INFRASTRUCTURE_SECTION_KEYS,
  ...AI_AGENTS_SECTION_KEYS,
]);

const KNOWN_CHANNEL_IDS = [
  { id: "telegram", label: "Telegram" },
  { id: "discord", label: "Discord" },
  { id: "slack", label: "Slack" },
  { id: "whatsapp", label: "WhatsApp" },
  { id: "signal", label: "Signal" },
  { id: "imessage", label: "iMessage" },
] as const;

export type ConfigTabRenderOptions = {
  requestHostUpdate?: () => void;
  localAssistantAvatarOverride: string | null;
  configAssistantAvatar: string | null;
  configAssistantAvatarUrl: string | null;
  configAssistantAvatarSource: string | null;
  configAssistantAvatarStatus: "none" | "local" | "remote" | "data" | null;
  configAssistantAvatarReason: string | null;
};

function normalizeMainConfigSelection(
  activeSection: string | null,
  activeSubsection: string | null,
): ConfigSectionSelection {
  if (activeSection && SCOPED_CONFIG_SECTION_KEYS.has(activeSection)) {
    return { activeSection: null, activeSubsection: null };
  }
  return { activeSection, activeSubsection };
}

function normalizeScopedConfigSelection(
  activeSection: string | null,
  activeSubsection: string | null,
  includedSections: readonly string[],
): ConfigSectionSelection {
  if (activeSection && !includedSections.includes(activeSection)) {
    return { activeSection: null, activeSubsection: null };
  }
  return { activeSection, activeSubsection };
}

function resolveAssistantAvatarOverride(config: unknown): string | null {
  if (!config || typeof config !== "object" || Array.isArray(config)) {
    return null;
  }
  const ui = (config as { ui?: unknown }).ui;
  if (!ui || typeof ui !== "object" || Array.isArray(ui)) {
    return null;
  }
  const assistant = (ui as { assistant?: unknown }).assistant;
  if (!assistant || typeof assistant !== "object" || Array.isArray(assistant)) {
    return null;
  }
  return normalizeOptionalString((assistant as { avatar?: unknown }).avatar) ?? null;
}

function formatQuickSettingsLabel(id: string): string {
  const trimmed = id.trim();
  if (!trimmed) {
    return "Unknown";
  }
  return trimmed
    .split(/[-_]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function extractQuickSettingsChannels(state: AppViewState): QuickSettingsChannel[] {
  const config = state.configForm ?? state.configSnapshot?.config;
  if (!config || typeof config !== "object") {
    return [];
  }
  const channelsConfig =
    "channels" in config && config.channels && typeof config.channels === "object"
      ? (config.channels as Record<string, unknown>)
      : {};
  const configuredIds = Object.keys(channelsConfig).filter((id) => id.trim().length > 0);
  const channelIds =
    configuredIds.length > 0
      ? configuredIds.toSorted((a, b) => a.localeCompare(b))
      : KNOWN_CHANNEL_IDS.map(({ id }) => id);
  const knownLabels = new Map<string, string>(
    KNOWN_CHANNEL_IDS.map(({ id, label }) => [id, label]),
  );
  const channels: QuickSettingsChannel[] = [];
  for (const id of channelIds) {
    const channelConfig = channelsConfig[id];
    const hasConfig =
      channelConfig != null &&
      typeof channelConfig === "object" &&
      Object.keys(channelConfig).length > 0;
    channels.push({
      id,
      label: knownLabels.get(id) ?? formatQuickSettingsLabel(id),
      connected: hasConfig,
      detail: hasConfig ? "Configured" : undefined,
    });
  }
  return channels;
}

function extractMcpServerCount(state: AppViewState): number {
  const config = state.configForm ?? state.configSnapshot?.config;
  if (!config || typeof config !== "object") {
    return 0;
  }
  const mcp = config.mcp;
  if (!mcp || typeof mcp !== "object") {
    return 0;
  }
  const servers =
    "servers" in mcp && mcp.servers && typeof mcp.servers === "object"
      ? (mcp.servers as Record<string, unknown>)
      : {};
  return Object.keys(servers).length;
}

function extractQuickSettingsSecurity(state: AppViewState): {
  gatewayAuth: string;
  execPolicy: string;
  deviceAuth: boolean;
} {
  const config = state.configForm ?? state.configSnapshot?.config;
  if (!config || typeof config !== "object") {
    return { gatewayAuth: "unknown", execPolicy: "unknown", deviceAuth: false };
  }
  const cfg = config;
  const gateway =
    "gateway" in cfg && cfg.gateway && typeof cfg.gateway === "object"
      ? (cfg.gateway as Record<string, unknown>)
      : null;
  const auth =
    gateway && "auth" in gateway && gateway.auth && typeof gateway.auth === "object"
      ? (gateway.auth as Record<string, unknown>)
      : null;
  let gatewayAuth = "unknown";
  if (auth) {
    const mode = typeof auth.mode === "string" ? auth.mode.trim() : "";
    if (mode) {
      gatewayAuth = mode;
    } else if (auth.password) {
      gatewayAuth = "password";
    } else if (auth.token) {
      gatewayAuth = "token";
    } else {
      gatewayAuth = "configured";
    }
  }
  const tools =
    "tools" in cfg && cfg.tools && typeof cfg.tools === "object"
      ? (cfg.tools as Record<string, unknown>)
      : null;
  const exec =
    tools && "exec" in tools && tools.exec && typeof tools.exec === "object"
      ? (tools.exec as Record<string, unknown>)
      : null;
  let execPolicy = "allowlist";
  if (exec) {
    const candidate =
      typeof exec.security === "string"
        ? exec.security
        : typeof exec.policy === "string"
          ? exec.policy
          : typeof exec.mode === "string"
            ? exec.mode
            : "";
    execPolicy = candidate.trim() || "allowlist";
  }
  const devices =
    "devices" in cfg && cfg.devices && typeof cfg.devices === "object"
      ? (cfg.devices as Record<string, unknown>)
      : null;
  let deviceAuth = false;
  if (devices) {
    if (typeof devices.enabled === "boolean") {
      deviceAuth = devices.enabled;
    } else if (typeof devices.pairing === "boolean") {
      deviceAuth = devices.pairing;
    } else if (devices.tokens && typeof devices.tokens === "object") {
      deviceAuth = true;
    }
  }
  return { gatewayAuth, execPolicy, deviceAuth };
}

function resolveQuickSettingsSessionRow(state: AppViewState) {
  return state.sessionsResult?.sessions?.find((row) => row.key === state.sessionKey);
}

export function renderConfigTabForActiveTab(state: AppViewState, options: ConfigTabRenderOptions) {
  const requestHostUpdate = options.requestHostUpdate;
  const commonConfigProps = {
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
    onRawChange: (next: string) => {
      state.configRaw = next;
    },
    onRequestUpdate: requestHostUpdate,
    onFormPatch: (path: Array<string | number>, value: unknown) =>
      updateConfigFormValue(state, path, value),
    onReload: () => loadConfig(state, { discardPendingChanges: true }),
    onReset: () => resetConfigPendingChanges(state),
    onSave: () => saveConfig(state),
    onApply: () => applyConfig(state),
    onUpdate: () => runUpdate(state),
    onOpenFile: () => openConfigFile(state),
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
    gatewayUrl: state.settings.gatewayUrl,
    assistantName: state.assistantName,
    configPath: state.configSnapshot?.path ?? null,
    rawAvailable: typeof state.configSnapshot?.raw === "string",
  } satisfies Omit<
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
    | "includeSections"
    | "excludeSections"
    | "includeVirtualSections"
  >;
  const renderConfigTab = (overrides: ConfigTabOverrides) =>
    renderConfig({
      ...commonConfigProps,
      includeVirtualSections: false,
      ...overrides,
    });

  const configSelection = normalizeMainConfigSelection(
    state.configActiveSection,
    state.configActiveSubsection,
  );
  const communicationsSelection = normalizeScopedConfigSelection(
    state.communicationsActiveSection,
    state.communicationsActiveSubsection,
    COMMUNICATION_SECTION_KEYS,
  );
  const appearanceSelection = normalizeScopedConfigSelection(
    state.appearanceActiveSection,
    state.appearanceActiveSubsection,
    APPEARANCE_SECTION_KEYS,
  );
  const automationSelection = normalizeScopedConfigSelection(
    state.automationActiveSection,
    state.automationActiveSubsection,
    AUTOMATION_SECTION_KEYS,
  );
  const infrastructureSelection = normalizeScopedConfigSelection(
    state.infrastructureActiveSection,
    state.infrastructureActiveSubsection,
    INFRASTRUCTURE_SECTION_KEYS,
  );
  const aiAgentsSelection = normalizeScopedConfigSelection(
    state.aiAgentsActiveSection,
    state.aiAgentsActiveSubsection,
    AI_AGENTS_SECTION_KEYS,
  );

  switch (state.tab) {
    case "config": {
      if (state.configSettingsMode === "quick") {
        const configObj = state.configForm ?? state.configSnapshot?.config ?? {};
        const assistantAvatarOverride =
          options.localAssistantAvatarOverride ?? resolveAssistantAvatarOverride(configObj);
        const agentsDefaults = ((configObj.agents as Record<string, unknown> | undefined)
          ?.defaults ?? {}) as Record<string, unknown>;
        const activeSession = resolveQuickSettingsSessionRow(state);
        const currentModel =
          typeof activeSession?.model === "string"
            ? activeSession.model
            : typeof agentsDefaults.model === "string"
              ? agentsDefaults.model
              : "default";
        const thinkingLevel =
          typeof activeSession?.thinkingLevel === "string"
            ? activeSession.thinkingLevel
            : typeof agentsDefaults.thinkingLevel === "string"
              ? agentsDefaults.thinkingLevel
              : "off";
        const fastMode =
          typeof activeSession?.fastMode === "boolean"
            ? activeSession.fastMode
            : agentsDefaults.fastMode === true;
        return renderQuickSettings({
          currentModel,
          thinkingLevel,
          fastMode,
          onModelChange: () => {
            state.configSettingsMode = "advanced";
            state.tab = "aiAgents" as import("./navigation.ts").Tab;
            state.aiAgentsActiveSection = "models";
            requestHostUpdate?.();
          },
          onThinkingChange: (level) => {
            void patchSession(state, state.sessionKey, { thinkingLevel: level }).then(() =>
              requestHostUpdate?.(),
            );
          },
          onFastModeToggle: () => {
            void patchSession(state, state.sessionKey, { fastMode: !fastMode }).then(() =>
              requestHostUpdate?.(),
            );
          },
          channels: extractQuickSettingsChannels(state),
          onChannelConfigure: () => {
            state.tab = "communications" as import("./navigation.ts").Tab;
            state.communicationsActiveSection = "channels";
            requestHostUpdate?.();
          },
          automation: {
            cronJobCount: state.cronJobs?.length ?? 0,
            skillCount: state.skillsReport?.skills?.length ?? 0,
            mcpServerCount: extractMcpServerCount(state),
          },
          onManageCron: () => {
            state.tab = "cron" as import("./navigation.ts").Tab;
            requestHostUpdate?.();
          },
          onBrowseSkills: () => {
            state.tab = "skills" as import("./navigation.ts").Tab;
            requestHostUpdate?.();
          },
          onConfigureMcp: () => {
            state.tab = "infrastructure" as import("./navigation.ts").Tab;
            state.infrastructureActiveSection = "mcp";
            requestHostUpdate?.();
          },
          security: extractQuickSettingsSecurity(state),
          onSecurityConfigure: () => {
            state.configSettingsMode = "advanced";
            state.configActiveSection = "auth";
            requestHostUpdate?.();
          },
          theme: state.theme,
          themeMode: state.themeMode,
          hasCustomTheme: Boolean(state.settings.customTheme),
          customThemeLabel: state.settings.customTheme?.label ?? null,
          borderRadius: state.settings.borderRadius,
          setTheme: (theme, context) => state.setTheme(theme, context),
          onOpenCustomThemeImport: () => {
            state.setTab("appearance");
            state.appearanceFormMode = "form";
            state.appearanceSearchQuery = "";
            state.appearanceActiveSection = "__appearance__";
            state.appearanceActiveSubsection = null;
            state.openCustomThemeImport();
            requestHostUpdate?.();
          },
          setThemeMode: (mode, context) => state.setThemeMode(mode, context),
          setBorderRadius: (value) => state.setBorderRadius(value),
          userAvatar: state.userAvatar ?? null,
          onUserAvatarChange: (avatar) => state.applyLocalUserIdentity?.({ avatar }),
          assistantAvatar: options.configAssistantAvatar,
          assistantAvatarUrl: options.configAssistantAvatarUrl,
          assistantAvatarSource: options.configAssistantAvatarSource,
          assistantAvatarStatus: options.configAssistantAvatarStatus,
          assistantAvatarReason: options.configAssistantAvatarReason,
          assistantAvatarOverride,
          assistantAvatarUploadBusy: state.assistantAvatarUploadBusy,
          assistantAvatarUploadError: state.assistantAvatarUploadError,
          onAssistantAvatarOverrideChange: (dataUrl) => {
            setAssistantAvatarOverride(state, dataUrl);
            state.chatAvatarUrl = dataUrl;
            state.chatAvatarSource = dataUrl;
            state.chatAvatarStatus = "data";
            state.chatAvatarReason = null;
            state.assistantAvatarUploadError = null;
            requestHostUpdate?.();
          },
          onAssistantAvatarClearOverride: () => {
            setAssistantAvatarOverride(state, null);
            state.chatAvatarUrl = null;
            state.chatAvatarSource = null;
            state.chatAvatarStatus = null;
            state.chatAvatarReason = null;
            state.assistantAvatarUploadError = null;
            void state.loadAssistantIdentity?.().finally(() => requestHostUpdate?.());
            requestHostUpdate?.();
          },
          basePath: state.basePath ?? "",
          configObject: configObj,
          savedConfigObject: (state.configSnapshot?.config as Record<string, unknown> | null) ?? {},
          configDirty: state.configFormDirty,
          configSaving: state.configSaving,
          configApplying: state.configApplying,
          configReady: Boolean(state.configSnapshot?.hash),
          onSelectPreset: (presetId) => {
            const preset = getPresetById(presetId);
            if (!preset) {
              return;
            }
            stageConfigPreset(state, preset.patch);
            requestHostUpdate?.();
          },
          onResetConfig: () => resetConfigPendingChanges(state),
          onSaveConfig: () => saveConfig(state),
          onApplyConfig: () => applyConfig(state),
          onAdvancedSettings: () => {
            state.configSettingsMode = "advanced";
            requestHostUpdate?.();
          },
          connected: state.connected,
          gatewayUrl: state.settings.gatewayUrl,
          assistantName: state.assistantName,
          version: state.hello?.server?.version ?? "",
        });
      }
      return renderConfigTab({
        formMode: state.configFormMode,
        searchQuery: state.configSearchQuery,
        activeSection: configSelection.activeSection,
        activeSubsection: configSelection.activeSubsection,
        onFormModeChange: (mode) => (state.configFormMode = mode),
        onSearchChange: (query) => (state.configSearchQuery = query),
        onSectionChange: (section) => {
          state.configActiveSection = section;
          state.configActiveSubsection = null;
        },
        onSubsectionChange: (section) => (state.configActiveSubsection = section),
        showModeToggle: true,
        settingsLayout: "accordion",
        onBackToQuick: () => {
          state.configSettingsMode = "quick";
          requestHostUpdate?.();
        },
        excludeSections: [
          ...COMMUNICATION_SECTION_KEYS,
          ...AUTOMATION_SECTION_KEYS,
          ...INFRASTRUCTURE_SECTION_KEYS,
          ...AI_AGENTS_SECTION_KEYS,
          "ui",
          "wizard",
        ],
      });
    }
    case "communications":
      return renderConfigTab({
        formMode: state.communicationsFormMode,
        searchQuery: state.communicationsSearchQuery,
        activeSection: communicationsSelection.activeSection,
        activeSubsection: communicationsSelection.activeSubsection,
        onFormModeChange: (mode) => (state.communicationsFormMode = mode),
        onSearchChange: (query) => (state.communicationsSearchQuery = query),
        onSectionChange: (section) => {
          state.communicationsActiveSection = section;
          state.communicationsActiveSubsection = null;
        },
        onSubsectionChange: (section) => (state.communicationsActiveSubsection = section),
        navRootLabel: "Communication",
        includeSections: [...COMMUNICATION_SECTION_KEYS],
        includeVirtualSections: true,
        webPush: {
          supported: state.webPushSupported,
          permission: state.webPushPermission,
          subscribed: state.webPushSubscribed,
          loading: state.webPushLoading,
        },
        onWebPushSubscribe: () => state.handleWebPushSubscribe(),
        onWebPushUnsubscribe: () => state.handleWebPushUnsubscribe(),
        onWebPushTest: () => state.handleWebPushTest(),
      });
    case "appearance":
      return renderConfigTab({
        formMode: state.appearanceFormMode,
        searchQuery: state.appearanceSearchQuery,
        activeSection: appearanceSelection.activeSection,
        activeSubsection: appearanceSelection.activeSubsection,
        onFormModeChange: (mode) => (state.appearanceFormMode = mode),
        onSearchChange: (query) => (state.appearanceSearchQuery = query),
        onSectionChange: (section) => {
          state.appearanceActiveSection = section;
          state.appearanceActiveSubsection = null;
        },
        onSubsectionChange: (section) => (state.appearanceActiveSubsection = section),
        navRootLabel: t("tabs.appearance"),
        includeSections: [...APPEARANCE_SECTION_KEYS],
        includeVirtualSections: true,
      });
    case "automation":
      return renderConfigTab({
        formMode: state.automationFormMode,
        searchQuery: state.automationSearchQuery,
        activeSection: automationSelection.activeSection,
        activeSubsection: automationSelection.activeSubsection,
        onFormModeChange: (mode) => (state.automationFormMode = mode),
        onSearchChange: (query) => (state.automationSearchQuery = query),
        onSectionChange: (section) => {
          state.automationActiveSection = section;
          state.automationActiveSubsection = null;
        },
        onSubsectionChange: (section) => (state.automationActiveSubsection = section),
        navRootLabel: "Automation",
        includeSections: [...AUTOMATION_SECTION_KEYS],
      });
    case "infrastructure":
      return renderConfigTab({
        formMode: state.infrastructureFormMode,
        searchQuery: state.infrastructureSearchQuery,
        activeSection: infrastructureSelection.activeSection,
        activeSubsection: infrastructureSelection.activeSubsection,
        onFormModeChange: (mode) => (state.infrastructureFormMode = mode),
        onSearchChange: (query) => (state.infrastructureSearchQuery = query),
        onSectionChange: (section) => {
          state.infrastructureActiveSection = section;
          state.infrastructureActiveSubsection = null;
        },
        onSubsectionChange: (section) => (state.infrastructureActiveSubsection = section),
        navRootLabel: "Infrastructure",
        includeSections: [...INFRASTRUCTURE_SECTION_KEYS],
      });
    case "aiAgents":
      return renderConfigTab({
        formMode: state.aiAgentsFormMode,
        searchQuery: state.aiAgentsSearchQuery,
        activeSection: aiAgentsSelection.activeSection,
        activeSubsection: aiAgentsSelection.activeSubsection,
        onFormModeChange: (mode) => (state.aiAgentsFormMode = mode),
        onSearchChange: (query) => (state.aiAgentsSearchQuery = query),
        onSectionChange: (section) => {
          state.aiAgentsActiveSection = section;
          state.aiAgentsActiveSubsection = null;
        },
        onSubsectionChange: (section) => (state.aiAgentsActiveSubsection = section),
        navRootLabel: "AI & Agents",
        includeSections: [...AI_AGENTS_SECTION_KEYS],
      });
    default:
      return nothing;
  }
}
