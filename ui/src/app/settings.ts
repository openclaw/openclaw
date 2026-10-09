import { gatewayCredentialScope, gatewayOriginScope } from "@openclaw/gateway-client/browser";
import { safeParseJson } from "@openclaw/normalization-core";
import { normalizeAgentId } from "@openclaw/normalization-core/agent-id";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { normalizeUniqueTrimmedStringList } from "@openclaw/normalization-core/string-normalization";
import {
  normalizeTabIconPreference,
  UI_PREFERENCE_DEFAULTS,
} from "../../../packages/gateway-protocol/src/schema/ui-appearance-preferences.ts";
import { CONTROL_UI_TOKEN_SESSION_KEY_PREFIX } from "../../../src/shared/control-ui-storage.js";
import { DEFAULT_SIDEBAR_ENTRIES, normalizeSidebarEntries } from "../app-navigation.ts";
import { configuredUiDevGateway } from "../dev-gateway.ts";
import { isSupportedLocale } from "../i18n/index.ts";
import { normalizeBoardSessionViews } from "../lib/board/settings.ts";
import { getSafeLocalStorage, getSafeSessionStorage } from "../local-storage.ts";
import { normalizeChatBubbleSessionKeys } from "../pages/chat/chat-bubble-mode.ts";
import {
  normalizeSidebarSessionActivePanels,
  normalizeSidebarSessionLayouts,
} from "../pages/chat/sidebar-layout-persistence.ts";
import { normalizeChatSplitLayout } from "../pages/chat/split-layout-persistence.ts";
import { resolveControlUiPaths } from "./browser.ts";
import { parseImportedCustomTheme } from "./custom-theme.ts";
import { resolveProfileAppearanceProfileId } from "./server-prefs-profile.ts";
import {
  loadBackgroundPreference,
  saveBackgroundPreference,
  subscribeBackgroundPreferenceIdentity,
} from "./settings-background.ts";
import {
  normalizeAccentColor,
  normalizeCatalogOpenTarget,
  normalizeChatFollowUpModeOverride,
  normalizeChatSendShortcut,
  normalizeChatWorkspaceDock,
  normalizeTextScale,
  UI_APPEARANCE_DEFAULTS,
  type UiPreferences,
  type UiSettings,
} from "./settings-contract.ts";
import type {
  ScopedSessionSelection,
  PersistedUiSettings,
  PersistedSettingsSource,
  ProfileNavigation,
  SettingsStorageFallback,
} from "./settings-storage-types.ts";
import { normalizeTerminalFontFamily } from "./terminal-font.ts";
import { parseThemeSelection } from "./theme.ts";
import { normalizeTypefaceOverride } from "./typography.ts";
import { normalizeLocalUserIdentity, type LocalUserIdentity } from "./user-identity.ts";

export {
  normalizeCatalogOpenTarget,
  normalizeChatFollowUpMode,
  normalizeChatFollowUpModeOverride,
  normalizeChatSendShortcut,
  normalizeTextScale,
  TEXT_SCALE_STOPS,
  UI_APPEARANCE_DEFAULTS,
} from "./settings-contract.ts";
export type {
  CatalogOpenTarget,
  ChatFollowUpMode,
  ChatSendShortcut,
  TextScaleStop,
  UiPreferences,
  UiSettings,
} from "./settings-contract.ts";

const SETTINGS_KEY_PREFIX = "openclaw.control.settings.v1:";
const LEGACY_SETTINGS_KEY = "openclaw.control.settings.v1";
export const NAV_WIDTH_MIN = 240;
export const NAV_WIDTH_MAX = 400;
const NAV_WIDTH_DEFAULT = 258;
const CURRENT_GATEWAY_SELECTION_KEY_PREFIX = "openclaw.control.currentGateway.v1:";
const LOCAL_USER_IDENTITY_KEY = "openclaw.control.user.v1";
const LEGACY_TOKEN_SESSION_KEY = "openclaw.control.token.v1";
const MAX_SCOPED_SESSION_ENTRIES = 10;

export function settingsKeyForGateway(gatewayUrl: string): string {
  return `${SETTINGS_KEY_PREFIX}${gatewayOriginScope(gatewayUrl)}`;
}

function currentGatewaySelectionKeyForPage(pageUrl: string): string {
  return `${CURRENT_GATEWAY_SELECTION_KEY_PREFIX}${gatewayOriginScope(pageUrl)}`;
}

const CSS_WIDTH_KEYWORDS = new Set(["none", "min-content", "max-content"]);
const CSS_WIDTH_FUNCTIONS = new Set(["calc", "clamp", "fit-content", "max", "min"]);
const CSS_WIDTH_UNITS = new Set(["ch", "em", "rem", "vh", "vmax", "vmin", "vw", "px"]);
const CSS_WIDTH_ALLOWED_CHARS = /^[0-9A-Za-z.%+\-*/(),\s]+$/;
const CSS_WIDTH_IDENTIFIER_RE = /[A-Za-z][A-Za-z0-9-]*/g;
const CSS_WIDTH_SIMPLE_RE = /^(?:\d+(?:\.\d+)?|\.\d+)(?:px|rem|em|ch|vw|vh|vmin|vmax|%)$/i;
const CSS_WIDTH_MAX_LENGTH = 96;

function hasAllowedWidthIdentifiers(value: string): boolean {
  for (const match of value.matchAll(CSS_WIDTH_IDENTIFIER_RE)) {
    const identifier = match[0].toLowerCase();
    if (
      !CSS_WIDTH_FUNCTIONS.has(identifier) &&
      !CSS_WIDTH_KEYWORDS.has(identifier) &&
      !CSS_WIDTH_UNITS.has(identifier)
    ) {
      return false;
    }
  }
  return true;
}

export function normalizeChatMessageMaxWidth(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = value.trim().replace(/\s+/g, " ");
  if (normalized.length === 0 || normalized.length > CSS_WIDTH_MAX_LENGTH) {
    return undefined;
  }
  if (CSS_WIDTH_KEYWORDS.has(normalized.toLowerCase()) || CSS_WIDTH_SIMPLE_RE.test(normalized)) {
    return normalized;
  }
  if (
    !CSS_WIDTH_ALLOWED_CHARS.test(normalized) ||
    !CSS.supports("max-width", normalized) ||
    !hasAllowedWidthIdentifiers(normalized)
  ) {
    return undefined;
  }
  return /^(?:calc|clamp|fit-content|max|min)\(.+\)$/i.test(normalized) ? normalized : undefined;
}

function normalizeSidebarPreTeamScope(value: unknown): string | null | undefined {
  const agentId = normalizeOptionalString(value);
  return value === null ? null : agentId ? normalizeAgentId(agentId) : undefined;
}

type BooleanSettingKey = {
  [K in keyof UiPreferences]-?: UiPreferences[K] extends boolean | undefined ? K : never;
}[keyof UiPreferences] &
  keyof PersistedUiSettings;

function isViteDevPage(): boolean {
  if (typeof document === "undefined") {
    return false;
  }
  return Boolean(document.querySelector('script[src*="/@vite/client"]'));
}

function deriveDefaultGatewayUrl(): { pageUrl: string; effectiveUrl: string } {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  const basePath = resolveControlUiPaths(location.pathname)[0];
  const pageUrl = `${proto}://${location.host}${basePath}`;
  const devGateway = configuredUiDevGateway();
  if (devGateway) {
    return { pageUrl, effectiveUrl: devGateway.gatewayUrl };
  }
  if (!isViteDevPage()) {
    return { pageUrl, effectiveUrl: pageUrl };
  }
  // location.hostname already carries brackets for IPv6 literals; wrapping
  // again would produce an undialable ws://[[::1]]:port default.
  const hostname = location.hostname;
  const host = hostname.includes(":") && !hostname.startsWith("[") ? `[${hostname}]` : hostname;
  return { pageUrl, effectiveUrl: `${proto}://${host}:18789` };
}

/**
 * Standalone documents are owned by the Gateway that served their URL. Do not
 * let the full app's persisted remote selection retarget a security decision.
 * Native auth and explicit URL overrides are applied after this default.
 */
export function resolvePageGatewaySettings(settings: UiSettings): UiSettings {
  const { effectiveUrl } = deriveDefaultGatewayUrl();
  if (gatewayOriginScope(settings.gatewayUrl) === gatewayOriginScope(effectiveUrl)) {
    return settings;
  }
  const session = loadGatewaySessionSelection(effectiveUrl);
  return {
    ...settings,
    gatewayUrl: effectiveUrl,
    token: resolveGatewayCredentialsForUrlEdit(settings.gatewayUrl, effectiveUrl, {
      token: settings.token,
      password: "",
    }).token,
    sessionKey: session.sessionKey,
    lastActiveSessionKey: session.lastActiveSessionKey,
  };
}

export function readSettingsForGateway(
  storage: Storage | null,
  targetUrl: string,
): PersistedSettingsSource | null {
  const key = settingsKeyForGateway(targetUrl);
  const cached = settingsFallback?.key === key ? settingsFallback : null;
  let scoped: PersistedUiSettings | null | undefined;
  try {
    if (!storage && cached) {
      return { gatewayUrl: targetUrl, parsed: cached.record, available: false };
    }
    scoped = safeParseJson(storage?.getItem(key) ?? "") as PersistedUiSettings | null | undefined;
  } catch (error) {
    if (!cached) {
      throw error;
    }
    return { gatewayUrl: targetUrl, parsed: cached.record, available: false };
  }
  const storedUrl = normalizeOptionalString(scoped?.gatewayUrl);
  if (storedUrl && gatewayOriginScope(storedUrl) !== gatewayOriginScope(targetUrl)) {
    scoped = null;
  }
  if (cached?.pendingNavigation) {
    scoped = {
      ...scoped,
      ...cached.record,
      navigationByProfile: { ...scoped?.navigationByProfile, ...cached.pendingNavigation },
    };
  }
  if (!scoped) {
    if (cached) {
      settingsFallback = null;
    }
    return null;
  }
  const record = { ...scoped, gatewayUrl: normalizeOptionalString(scoped.gatewayUrl) ?? targetUrl };
  if (cached || !settingsFallback?.pendingNavigation) {
    settingsFallback = { key, record, pendingNavigation: cached?.pendingNavigation ?? null };
  }
  return {
    gatewayUrl: record.gatewayUrl,
    parsed: record,
    available: Boolean(storage),
  };
}

export function profileNavigation(
  parsed: PersistedUiSettings | undefined,
  profileId: string,
): ProfileNavigation | null {
  const entry = asOptionalRecord(parsed?.navigationByProfile?.[profileId]);
  const sidebarEntries = normalizeSidebarEntries(entry?.sidebarEntries);
  return sidebarEntries
    ? { sidebarEntries, navigationScope: entry?.navigationScope === "all" ? "all" : "mine" }
    : null;
}

function tokenSessionKeyForGateway(gatewayUrl: string): string {
  return `${CONTROL_UI_TOKEN_SESSION_KEY_PREFIX}${gatewayOriginScope(gatewayUrl)}`;
}

function resolveScopedSessionSelection(
  gatewayUrl: string,
  parsed: PersistedUiSettings,
  fallback: ScopedSessionSelection,
): ScopedSessionSelection {
  const scoped = parsed.sessionsByGateway?.[gatewayOriginScope(gatewayUrl)];
  const scopedSessionKey = normalizeOptionalString(scoped?.sessionKey);
  const scopedLastActiveSessionKey = normalizeOptionalString(scoped?.lastActiveSessionKey);
  const scopedSelectedAgentId = normalizeOptionalString(scoped?.selectedAgentId);
  if (scopedSessionKey && scopedLastActiveSessionKey) {
    return {
      sessionKey: scopedSessionKey,
      lastActiveSessionKey: scopedLastActiveSessionKey,
      ...(scopedSelectedAgentId
        ? { selectedAgentId: normalizeAgentId(scopedSelectedAgentId) }
        : {}),
    };
  }

  return fallback;
}

export function loadGatewaySessionSelection(gatewayUrl: string): ScopedSessionSelection {
  const fallback = { sessionKey: "main", lastActiveSessionKey: "main" };
  try {
    const storage = getSafeLocalStorage();
    const source = readSettingsForGateway(storage, gatewayUrl);
    return source ? resolveScopedSessionSelection(gatewayUrl, source.parsed, fallback) : fallback;
  } catch {
    return fallback;
  }
}

function loadSessionToken(gatewayUrl: string): string {
  try {
    const storage = getSafeSessionStorage();
    if (!storage) {
      return "";
    }
    storage.removeItem(LEGACY_TOKEN_SESSION_KEY);
    const token = storage.getItem(tokenSessionKeyForGateway(gatewayUrl));
    return normalizeOptionalString(token) ?? "";
  } catch {
    return "";
  }
}

export function resolveGatewayCredentialsForUrlEdit(
  currentGatewayUrl: string,
  nextGatewayUrl: string,
  credentials: { token: string; password: string },
): { token: string; password: string } {
  const sameTokenScope =
    gatewayOriginScope(currentGatewayUrl) === gatewayOriginScope(nextGatewayUrl);
  const sameCredentialScope =
    gatewayCredentialScope(currentGatewayUrl) === gatewayCredentialScope(nextGatewayUrl);
  return {
    // Gateway tokens stay session-scoped across endpoint edits.
    token: sameTokenScope ? credentials.token : loadSessionToken(nextGatewayUrl),
    password: sameCredentialScope ? credentials.password : "",
  };
}

export function persistSessionToken(gatewayUrl: string, token: string) {
  try {
    const storage = getSafeSessionStorage();
    if (!storage) {
      return;
    }
    storage.removeItem(LEGACY_TOKEN_SESSION_KEY);
    const key = tokenSessionKeyForGateway(gatewayUrl);
    const normalized = normalizeOptionalString(token) ?? "";
    if (normalized) {
      storage.setItem(key, normalized);
      return;
    }
    storage.removeItem(key);
  } catch {
    // best-effort
  }
}

// Fresh storage always wins unless a write failed. Only locally dirty profile snapshots
// are replayed over recovery reads, so saving one profile cannot revert a sibling's edits.
let settingsFallback: SettingsStorageFallback | null = null;

type LivePreferenceOwner = { gatewayUrl: () => string; refresh: () => void };
let livePreferenceOwner: LivePreferenceOwner | null = null;

/** Bind local writes to the mounted runtime, never its credentials. */
export function bindUiPreferences(owner: LivePreferenceOwner): () => void {
  livePreferenceOwner = owner;
  const stopIdentity = subscribeBackgroundPreferenceIdentity(() => {
    if (livePreferenceOwner === owner) {
      owner.refresh();
    }
  });
  return () => {
    stopIdentity();
    if (livePreferenceOwner === owner) {
      livePreferenceOwner = null;
    }
  };
}

// Another tab's persisted selector never retargets a mounted runtime's reads.
export function loadSettings(gatewayUrl = livePreferenceOwner?.gatewayUrl()): UiSettings {
  const preferences = loadUiPreferences(gatewayUrl);
  return { ...preferences, token: loadSessionToken(preferences.gatewayUrl) };
}

export function loadUiPreferences(
  requestedGatewayUrl = configuredUiDevGateway()?.gatewayUrl,
): UiPreferences {
  const storage = getSafeLocalStorage();
  const targetGatewayUrl =
    requestedGatewayUrl ??
    (settingsFallback && (settingsFallback.pendingNavigation || !storage)
      ? settingsFallback.record.gatewayUrl
      : undefined);
  const { pageUrl: pageDerivedUrl, effectiveUrl: defaultUrl } = deriveDefaultGatewayUrl();

  const defaults: UiPreferences = {
    gatewayUrl: targetGatewayUrl ?? defaultUrl,
    sessionKey: "main",
    lastActiveSessionKey: "main",
    theme: UI_APPEARANCE_DEFAULTS.theme,
    themeMode: UI_APPEARANCE_DEFAULTS.themeMode,
    chatShowThinking: UI_PREFERENCE_DEFAULTS.chatShowThinking,
    chatShowToolCalls: UI_PREFERENCE_DEFAULTS.chatShowToolCalls,
    chatPersistCommentary: UI_PREFERENCE_DEFAULTS.chatPersistCommentary,
    chatShowTaskProgress: UI_APPEARANCE_DEFAULTS.chatShowTaskProgress,
    chatCollapseTaskProgress: UI_APPEARANCE_DEFAULTS.chatCollapseTaskProgress,
    chatSendShortcut: UI_APPEARANCE_DEFAULTS.chatSendShortcut,
    catalogOpenTarget: UI_APPEARANCE_DEFAULTS.catalogOpenTarget,
    navCollapsed: false,
    navWidth: NAV_WIDTH_DEFAULT,
    sidebarAgentsMode: "chip",
    sidebarEntries: [...DEFAULT_SIDEBAR_ENTRIES],
    navigationScope: "mine",
    sidebarLiveActivity: UI_APPEARANCE_DEFAULTS.sidebarLiveActivity,
    showAdvancedSettings: false,
    pinnedAgentIds: [],
    composerHoldToRecord: UI_APPEARANCE_DEFAULTS.composerHoldToRecord,
  };

  try {
    let selectedGatewayUrl = targetGatewayUrl;
    if (!selectedGatewayUrl) {
      try {
        selectedGatewayUrl = normalizeOptionalString(
          storage?.getItem(currentGatewaySelectionKeyForPage(pageDerivedUrl)),
        );
      } catch {
        selectedGatewayUrl = settingsFallback?.record.gatewayUrl;
      }
    }
    const source =
      (selectedGatewayUrl ? readSettingsForGateway(storage, selectedGatewayUrl) : null) ??
      (targetGatewayUrl ? null : readSettingsForGateway(storage, defaultUrl));
    if (!source) {
      return { ...defaults, background: loadBackgroundPreference(defaults.gatewayUrl) };
    }
    const parsed = source.parsed;
    const parsedGatewayUrl = source.gatewayUrl;
    const gatewayUrl =
      targetGatewayUrl ?? (parsedGatewayUrl === pageDerivedUrl ? defaultUrl : parsedGatewayUrl);
    const scopedSessionSelection = resolveScopedSessionSelection(gatewayUrl, parsed, defaults);
    const customTheme = parseImportedCustomTheme(parsed.customTheme);
    const { theme, mode } = parseThemeSelection(parsed.theme, parsed.themeMode);
    const textScale = normalizeTextScale(parsed.textScale);
    const parsedRecord = asOptionalRecord(parsed) ?? {};
    const profileId = resolveProfileAppearanceProfileId(gatewayUrl);
    const personalNavigation = profileId ? profileNavigation(parsed, profileId) : null;
    const hasSidebarEntries = Boolean(profileId) || Object.hasOwn(parsedRecord, "sidebarEntries");
    // One-time read of the retired route-only shape; all writes use sidebarEntries.
    const migratedSidebarEntries = hasSidebarEntries
      ? null
      : Array.isArray(parsedRecord.sidebarPinnedRoutes)
        ? normalizeSidebarEntries(
            parsedRecord.sidebarPinnedRoutes.map((value) =>
              typeof value === "string" ? `route:${value}` : value,
            ),
          )
        : null;
    const booleanSetting = <K extends BooleanSettingKey>(key: K) => {
      const value = parsed[key];
      return typeof value === "boolean" ? value : defaults[key];
    };
    const settings: UiPreferences = {
      gatewayUrl,
      sessionKey: scopedSessionSelection.sessionKey,
      lastActiveSessionKey: scopedSessionSelection.lastActiveSessionKey,
      selectedAgentId: scopedSessionSelection.selectedAgentId,
      theme: theme === "custom" && !customTheme ? "claw" : theme,
      themeMode: mode,
      accent: normalizeAccentColor(parsed.accent),
      fontUi: normalizeTypefaceOverride(parsed.fontUi),
      fontChat: normalizeTypefaceOverride(parsed.fontChat),
      background: loadBackgroundPreference(gatewayUrl),
      tabIcon: normalizeTabIconPreference(parsed.tabIcon),
      terminalFontFamily: normalizeTerminalFontFamily(parsed.terminalFontFamily),
      chatShowThinking: booleanSetting("chatShowThinking"),
      chatShowToolCalls: booleanSetting("chatShowToolCalls"),
      chatPersistCommentary: booleanSetting("chatPersistCommentary"),
      chatShowTaskProgress: booleanSetting("chatShowTaskProgress"),
      chatCollapseTaskProgress: booleanSetting("chatCollapseTaskProgress"),
      chatBubbleSessionKeys: normalizeChatBubbleSessionKeys(parsed.chatBubbleSessionKeys),
      chatSendShortcut: normalizeChatSendShortcut(parsed.chatSendShortcut),
      chatFollowUpMode: normalizeChatFollowUpModeOverride(parsed.chatFollowUpMode),
      catalogOpenTarget: normalizeCatalogOpenTarget(parsed.catalogOpenTarget),
      realtimeTalkInputDeviceId: normalizeOptionalString(parsed.realtimeTalkInputDeviceId),
      realtimeTalkVideoDeviceId: normalizeOptionalString(parsed.realtimeTalkVideoDeviceId),
      composerHoldToRecord: booleanSetting("composerHoldToRecord"),
      talkCameraAutoEnable:
        typeof parsed.talkCameraAutoEnable === "boolean" ? parsed.talkCameraAutoEnable : undefined,
      chatSplitLayout: normalizeChatSplitLayout(parsed.chatSplitLayout),
      chatWorkspaceDock: normalizeChatWorkspaceDock(parsed.chatWorkspaceDock),
      boardSessionViews: normalizeBoardSessionViews(parsed.boardSessionViews),
      sidebarSessionLayouts: normalizeSidebarSessionLayouts(parsed.sidebarSessionLayouts),
      sidebarSessionActivePanels: normalizeSidebarSessionActivePanels(
        parsed.sidebarSessionActivePanels,
      ),
      navCollapsed: defaults.navCollapsed,
      navWidth:
        typeof parsed.navWidth === "number" &&
        parsed.navWidth >= NAV_WIDTH_MIN &&
        parsed.navWidth <= NAV_WIDTH_MAX
          ? parsed.navWidth
          : defaults.navWidth,
      sidebarAgentsMode: parsed.sidebarAgentsMode === "roster" ? "roster" : "chip",
      sidebarPreTeamScope: normalizeSidebarPreTeamScope(parsed.sidebarPreTeamScope),
      sidebarCollapsedAgentIds: normalizeUniqueTrimmedStringList(parsed.sidebarCollapsedAgentIds),
      sidebarEntries: profileId
        ? (personalNavigation?.sidebarEntries ?? defaults.sidebarEntries)
        : (normalizeSidebarEntries(parsedRecord.sidebarEntries) ??
          migratedSidebarEntries ??
          defaults.sidebarEntries),
      navigationScope: profileId
        ? (personalNavigation?.navigationScope ?? "mine")
        : parsed.navigationScope === "all"
          ? "all"
          : "mine",
      sidebarLiveActivity: booleanSetting("sidebarLiveActivity"),
      chatMessageMaxWidth: normalizeChatMessageMaxWidth(parsed.chatMessageMaxWidth),
      showAdvancedSettings: booleanSetting("showAdvancedSettings"),
      pinnedAgentIds: normalizeUniqueTrimmedStringList(parsed.pinnedAgentIds),
      textScale: textScale !== UI_APPEARANCE_DEFAULTS.textScale ? textScale : undefined,
      customTheme: customTheme ?? undefined,
      locale: isSupportedLocale(parsed.locale) ? parsed.locale : undefined,
      ...(parsed.lobsterPetVisits === false ? { lobsterPetVisits: false } : {}),
      ...(parsed.lobsterPetSounds === true ? { lobsterPetSounds: true } : {}),
      ...(parsed.sessionDeleteConfirm === false ? { sessionDeleteConfirm: false } : {}),
      ...(parsed.openLinksInControlUiBrowser === true ? { openLinksInControlUiBrowser: true } : {}),
      ...(parsed.openLinksExternally === true ? { openLinksExternally: true } : {}),
    };
    if (migratedSidebarEntries !== null) {
      saveSettings(
        { ...settings, token: loadSessionToken(gatewayUrl) },
        { selectGateway: !targetGatewayUrl },
      );
    }
    return settings;
  } catch {
    return defaults;
  }
}

// Single change seam over the one write channel every settings mutation uses;
// the server-prefs sync (app/server-prefs.ts) listens here to write synced
// prefs through to config ui.prefs without each call site knowing about it.
type SettingsChangeListener = (previous: UiSettings, next: UiSettings) => void;
let settingsChangeListener: SettingsChangeListener | null = null;

export function setSettingsChangeListener(listener: SettingsChangeListener | null) {
  settingsChangeListener = listener;
}

export function patchSettings(
  patch: Partial<UiSettings>,
  options: { selectGateway?: boolean } = {},
): UiSettings {
  const previous = loadSettings(patch.gatewayUrl);
  const next = { ...previous, ...patch };
  saveSettings(next, {
    selectGateway: options.selectGateway ?? patch.gatewayUrl !== undefined,
    writeNavigation:
      Object.hasOwn(patch, "sidebarEntries") || Object.hasOwn(patch, "navigationScope"),
  });
  settingsChangeListener?.(previous, next);
  return next;
}

export function loadLocalUserIdentity(): LocalUserIdentity {
  const storage = getSafeLocalStorage();
  try {
    const raw = storage?.getItem(LOCAL_USER_IDENTITY_KEY);
    if (!raw) {
      return normalizeLocalUserIdentity();
    }
    return normalizeLocalUserIdentity(JSON.parse(raw) as Partial<LocalUserIdentity>);
  } catch {
    return normalizeLocalUserIdentity();
  }
}

export function saveSettings(
  next: UiSettings,
  options: { selectGateway?: boolean; writeNavigation?: boolean } = {},
) {
  const storage = getSafeLocalStorage();
  const scope = gatewayOriginScope(next.gatewayUrl);
  const scopedKey = settingsKeyForGateway(next.gatewayUrl);
  let existingSessionsByGateway: Record<string, ScopedSessionSelection> = {};
  let source: PersistedSettingsSource | null = null;
  let available = Boolean(storage);
  try {
    source = readSettingsForGateway(storage, next.gatewayUrl);
    available &&= source?.available !== false;
    if (source) {
      const parsed = source.parsed;
      if (parsed.sessionsByGateway && typeof parsed.sessionsByGateway === "object") {
        existingSessionsByGateway = parsed.sessionsByGateway;
      }
    }
  } catch {
    available = false;
  }
  const profileId = resolveProfileAppearanceProfileId(next.gatewayUrl);
  const authoredNavigation = options.writeNavigation !== false;
  const navigation = { sidebarEntries: next.sidebarEntries, navigationScope: next.navigationScope };
  const pendingNavigation = {
    ...(settingsFallback?.key === scopedKey ? settingsFallback.pendingNavigation : null),
    ...(profileId &&
    authoredNavigation &&
    JSON.stringify(navigation) !== JSON.stringify(profileNavigation(source?.parsed, profileId))
      ? { [profileId]: navigation }
      : {}),
  };
  const sessionsByGateway = Object.fromEntries(
    [
      ...Object.entries(existingSessionsByGateway).filter(([key]) => key !== scope),
      [
        scope,
        {
          sessionKey: next.sessionKey,
          lastActiveSessionKey: next.lastActiveSessionKey,
          ...(normalizeOptionalString(next.selectedAgentId)
            ? { selectedAgentId: normalizeAgentId(next.selectedAgentId) }
            : {}),
        },
      ],
    ].slice(-MAX_SCOPED_SESSION_ENTRIES),
  );
  const persisted: PersistedUiSettings = {
    gatewayUrl: next.gatewayUrl,
    theme: next.theme,
    themeMode: next.themeMode,
    accent: normalizeAccentColor(next.accent),
    fontUi: normalizeTypefaceOverride(next.fontUi),
    fontChat: normalizeTypefaceOverride(next.fontChat),
    tabIcon: normalizeTabIconPreference(next.tabIcon),
    terminalFontFamily: normalizeTerminalFontFamily(next.terminalFontFamily),
    chatShowThinking: next.chatShowThinking,
    chatShowToolCalls: next.chatShowToolCalls,
    chatPersistCommentary: next.chatPersistCommentary ?? true,
    chatShowTaskProgress: next.chatShowTaskProgress === false ? false : undefined,
    chatCollapseTaskProgress: next.chatCollapseTaskProgress === true ? true : undefined,
    chatBubbleSessionKeys: normalizeChatBubbleSessionKeys(next.chatBubbleSessionKeys),
    chatSendShortcut: next.chatSendShortcut === "modifier-enter" ? "modifier-enter" : undefined,
    chatFollowUpMode: normalizeChatFollowUpModeOverride(next.chatFollowUpMode),
    catalogOpenTarget: next.catalogOpenTarget === "terminal" ? "terminal" : undefined,
    realtimeTalkInputDeviceId: normalizeOptionalString(next.realtimeTalkInputDeviceId),
    realtimeTalkVideoDeviceId: normalizeOptionalString(next.realtimeTalkVideoDeviceId),
    composerHoldToRecord: next.composerHoldToRecord === false ? false : undefined,
    talkCameraAutoEnable:
      typeof next.talkCameraAutoEnable === "boolean" ? next.talkCameraAutoEnable : undefined,
    chatSplitLayout: next.chatSplitLayout || undefined,
    // Right dock is the default; only the opt-in bottom dock persists.
    chatWorkspaceDock: next.chatWorkspaceDock === "bottom" ? "bottom" : undefined,
    boardSessionViews:
      next.boardSessionViews && Object.keys(next.boardSessionViews).length > 0
        ? normalizeBoardSessionViews(next.boardSessionViews)
        : undefined,
    sidebarSessionLayouts:
      next.sidebarSessionLayouts && Object.keys(next.sidebarSessionLayouts).length > 0
        ? normalizeSidebarSessionLayouts(next.sidebarSessionLayouts)
        : undefined,
    sidebarSessionActivePanels:
      next.sidebarSessionActivePanels && Object.keys(next.sidebarSessionActivePanels).length > 0
        ? normalizeSidebarSessionActivePanels(next.sidebarSessionActivePanels)
        : undefined,
    navWidth: next.navWidth, // Persist size, not visibility: shared localStorage leaks across tabs.
    sidebarAgentsMode: next.sidebarAgentsMode === "roster" ? "roster" : "chip",
    sidebarPreTeamScope: normalizeSidebarPreTeamScope(next.sidebarPreTeamScope),
    sidebarCollapsedAgentIds: next.sidebarCollapsedAgentIds?.length
      ? normalizeUniqueTrimmedStringList(next.sidebarCollapsedAgentIds)
      : undefined,
    sidebarEntries:
      !profileId && authoredNavigation ? next.sidebarEntries : source?.parsed.sidebarEntries,
    navigationScope:
      !profileId && authoredNavigation ? next.navigationScope : source?.parsed.navigationScope,
    navigationByProfile: { ...source?.parsed.navigationByProfile, ...pendingNavigation },
    sidebarLiveActivity: next.sidebarLiveActivity === false ? false : undefined,
    chatMessageMaxWidth: normalizeChatMessageMaxWidth(next.chatMessageMaxWidth),
    showAdvancedSettings: next.showAdvancedSettings === true ? true : undefined,
    // Empty pin list is the default; only real pins persist.
    pinnedAgentIds: next.pinnedAgentIds?.length ? next.pinnedAgentIds : undefined,
    textScale: next.textScale !== undefined ? normalizeTextScale(next.textScale) : undefined,
    customTheme: next.customTheme || undefined,
    sessionsByGateway,
    locale: next.locale || undefined,
    // Visits default on; only an explicit opt-out persists. Sounds default
    // off; only an explicit opt-in persists.
    lobsterPetVisits: next.lobsterPetVisits === false ? false : undefined,
    lobsterPetSounds: next.lobsterPetSounds === true ? true : undefined,
    // Only the opted-out value is persisted; absence means the safe default.
    sessionDeleteConfirm: next.sessionDeleteConfirm === false ? false : undefined,
    // External links keep host behavior unless the operator explicitly opts in.
    openLinksInControlUiBrowser: next.openLinksInControlUiBrowser === true ? true : undefined,
    openLinksExternally: next.openLinksExternally === true ? true : undefined,
  };
  saveBackgroundPreference(next.gatewayUrl, next.background);
  const serialized = JSON.stringify(persisted);
  settingsFallback = { key: scopedKey, record: persisted, pendingNavigation };
  try {
    const { pageUrl } = deriveDefaultGatewayUrl();
    const selectionKey = currentGatewaySelectionKeyForPage(pageUrl);
    if (available && storage) {
      storage.setItem(scopedKey, serialized);
      if (options.selectGateway || storage.getItem(selectionKey) == null) {
        storage.setItem(selectionKey, next.gatewayUrl);
      }
      storage.removeItem(LEGACY_SETTINGS_KEY);
      settingsFallback.pendingNavigation = null;
    }
  } catch {
    // best-effort — quota exceeded or security restrictions should not
    // prevent in-memory settings and visual updates from being applied;
    // settingsFallback keeps this tab consistent until storage recovers
  }
  const owner = livePreferenceOwner;
  if (owner && gatewayOriginScope(owner.gatewayUrl()) === scope) {
    owner.refresh();
  }
}
