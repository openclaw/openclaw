/* oxlint-disable max-lines -- TODO: split the inherited config-page controller after the rendering cutover. */
import { asNullableRecord as asConfigRecord } from "@openclaw/normalization-core/record-coerce";
import type {
  PluginsListResult,
  SessionsCatalogListResult,
  SystemInfoResult,
} from "../../../../packages/gateway-protocol/src/index.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { ModelCatalogEntry } from "../../api/types.ts";
import { titleForRoute } from "../../app-navigation.ts";
import { pathForRoute } from "../../app-route-paths.ts";
import type { ApplicationContext } from "../../app/context-types.ts";
import { hasOperatorAdminAccess } from "../../app/operator-access.ts";
import { resetServerUiPref, selectThemeSettings } from "../../app/server-prefs-controls.ts";
import { canSyncAppearancePreference } from "../../app/server-prefs-profile-runtime.ts";
import * as serverUiPrefs from "../../app/server-prefs-reconcile.ts";
import { isAppearancePref, type ResettableServerUiPrefKey } from "../../app/server-prefs-state.ts";
import {
  loadSettings,
  normalizeCatalogOpenTarget,
  normalizeTextScale,
  normalizeChatSendShortcut,
  patchSettings,
  UI_APPEARANCE_DEFAULTS,
  type UiSettings,
} from "../../app/settings.ts";
import type { ThemeMode, ThemeName } from "../../app/theme.ts";
import type { TypefaceId } from "../../app/typography.ts";
import {
  loadStoredHiddenSessionCatalogIds,
  SIDEBAR_HIDDEN_SESSION_CATALOGS_CHANGED_EVENT,
  setStoredSessionCatalogHidden,
} from "../../components/app-sidebar-session-types.ts";
import { getLobsterdex } from "../../components/lobster-dex.ts";
import { LOBSTER_PET_PALETTES } from "../../components/lobster-pet-palettes.ts";
import { i18n, isSupportedLocale, type Locale } from "../../i18n/index.ts";
import { registerSettingsEnglish } from "../../i18n/locales/en-settings.ts";
import { resolveAgentAvatarUrl } from "../../lib/avatar.ts";
import { resolveControlUiServerQueueMode } from "../../lib/chat/follow-up-mode.ts";
import { formatUiError } from "../../lib/format-error.ts";
import { isMissingOperatorReadScopeError } from "../../lib/gateway-errors.ts";
import { canCallGatewayMethod } from "../../lib/gateway-methods.ts";
import { loadModelCatalog } from "../../lib/model-catalog-store.ts";
import { registerEnglishCatalog, t } from "../../lib/reactive/i18n.ts";
import { resolveScrollBehavior } from "../../lib/scroll-behavior.ts";
import {
  canReadSystemInfo,
  readSystemInfo,
  SYSTEM_INFO_POLL_INTERVAL_MS,
} from "../../lib/system-info.ts";
import {
  discoverRealtimeTalkCameras,
  discoverRealtimeTalkInputs,
  observeRealtimeTalkDevices,
  realtimeTalkDeviceIssueMessage,
} from "../chat/talk/input.ts";
import { switchActiveRealtimeTalkCameras } from "../chat/talk/session.ts";
import { isUnknownSystemInfoMethodError } from "../connection/system-info.ts";
import {
  configSectionKeysForPage,
  configSelectionFromSearch,
  defaultConfigSelection,
  normalizeConfigSelection,
  type ConfigSelection,
  SCOPED_CONFIG_SECTION_KEYS,
  type ConfigPageId,
} from "./config-sections.ts";
import * as themeImport from "./custom-theme-import-owner.ts";
import { importCustomThemeFromUrl } from "./custom-theme-import.ts";
import { localPresentationProps } from "./local-presentation-props.ts";
import { configTargetIdFromHash, type ConfigRouteData } from "./route-data.ts";
import type { SecurityOverview } from "./security.tsx";
import {
  buildSessionObserverTogglePatch,
  buildSessionObserverUtilityModelPatch,
} from "./session-observer-settings.ts";
import { createConfigViewState } from "./view-state.ts";
import type { ConfigProps, ConfigViewState } from "./view-types.ts";

registerEnglishCatalog(registerSettingsEnglish);

const EMPTY_SESSION_CATALOG_LABELS: ReadonlyMap<string, string> = new Map();

function createMediaDeviceState(): Omit<
  NonNullable<ConfigProps["microphone"]>,
  "selectedDeviceId"
> & {
  loaded: boolean;
  requestsPermission: boolean;
} {
  return {
    devices: [],
    permissionRequired: true,
    loading: false,
    error: null,
    loaded: false,
    requestsPermission: false,
  };
}

export function extractQuickSettingsSecurity(root: Record<string, unknown>): SecurityOverview {
  const gateway = asConfigRecord(root.gateway);
  const auth = asConfigRecord(gateway?.auth);
  const tools = asConfigRecord(root.tools);
  const exec = asConfigRecord(tools?.exec) ?? {};
  const browser = asConfigRecord(root.browser);
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
  const profile = tools?.profile;
  const security = exec.security;
  return {
    gatewayAuth,
    execPolicy: typeof security === "string" && security.trim() ? security.trim() : "allowlist",
    browserEnabled: browser?.enabled !== false,
    browserEnabledOverridden: browser !== null && Object.hasOwn(browser, "enabled"),
    toolProfile: typeof profile === "string" ? profile.trim() : "",
    toolProfileOverridden: tools !== null && Object.hasOwn(tools, "profile"),
  };
}

function applyTextScale(value: unknown) {
  if (typeof document === "undefined") {
    return;
  }
  document.documentElement.style.setProperty(
    "--control-ui-text-scale",
    (normalizeTextScale(value) / 100).toFixed(2),
  );
}

/** Coordinates page-local drafts and requests; config and preference writes stay with their owners. */
export class ConfigPageController {
  pageId: ConfigPageId = "advanced";
  routeData: ConfigRouteData | null = null;
  private host: HTMLElement | null = null;
  private connected = false;
  private settings = loadSettings();
  private hiddenSessionCatalogIds = loadStoredHiddenSessionCatalogIds();
  private systemInfo: SystemInfoResult | null = null;
  private systemInfoUnavailable = false;
  private sessionObserverModels: ModelCatalogEntry[] = [];
  private sessionObserverModelsUnavailable = false;
  private hiddenSessionCatalogLabels: ReadonlyMap<string, string> = EMPTY_SESSION_CATALOG_LABELS;
  private installedSessionSourcePluginIds: Set<string> | null = null;
  private sessionSourcePluginsLoading = false;
  private formModes: Partial<Record<ConfigPageId, ConfigProps["formMode"]>> = {};
  private selections: Partial<Record<ConfigPageId, ConfigSelection>> = {};
  private customThemeImport = themeImport.INITIAL_CUSTOM_THEME_IMPORT_STATE;
  private readonly customThemeImportOwner = new themeImport.CustomThemeImportOwner((next) => {
    this.customThemeImport = next;
    this.invalidate();
  });
  private configViewState: ConfigViewState = createConfigViewState();
  private runtimeConfigSource: ApplicationContext["runtimeConfig"] | null = null;
  private updateStatusClient: GatewayBrowserClient | null = null;
  private mediaDeviceWatch: (() => void) | null = null;
  private readonly mediaDevices = {
    microphone: createMediaDeviceState(),
    camera: createMediaDeviceState(),
  };
  private cameraSelectionRequest = 0;
  private systemInfoAbort: AbortController | null = null;
  private modelsAbort: AbortController | null = null;
  private pluginsAbort: AbortController | null = null;
  private labelsAbort: AbortController | null = null;
  private previousGateway: ApplicationContext["gateway"] | null = null;
  private previousClient: GatewayBrowserClient | null = null;
  private previousHello: unknown;
  private previousPhase: string | null = null;
  private modelsAgent: string | null = null;
  private pluginsClient: GatewayBrowserClient | null = null;
  private labelsKey = "";
  private poll: ReturnType<typeof setInterval> | undefined;
  private countdown: ReturnType<typeof setInterval> | undefined;
  private routeInitialized = false;
  private targetBlockId: string | null = null;
  private scrollFrame: number | null = null;

  constructor(
    private context: ApplicationContext,
    private readonly invalidate: () => void,
    private readonly observe: () => unknown = () => undefined,
  ) {}

  get nowMs() {
    this.observe();
    return Date.now();
  }

  get application() {
    return this.context;
  }
  get browserLinksEnabled() {
    this.observe();
    return this.settings.openLinksInControlUiBrowser === true;
  }
  get configObject() {
    this.observe();
    const state = this.context.runtimeConfig.state;
    return asConfigRecord(state.configForm ?? state.configSnapshot?.config) ?? {};
  }
  get mutationDisabled() {
    this.observe();
    return this.isCuratedConfigMutationDisabled();
  }
  get updateBusy() {
    this.observe();
    return this.isUpdateBusy();
  }

  connect(host: HTMLElement) {
    this.host = host;
    this.connected = true;
    this.settings = loadSettings();
    this.hiddenSessionCatalogsChanged();
    window.addEventListener(
      SIDEBAR_HIDDEN_SESSION_CATALOGS_CHANGED_EVENT,
      this.hiddenSessionCatalogsChanged,
    );
    document.addEventListener("visibilitychange", this.visibilityChanged);
    window.addEventListener("focus", this.visibilityChanged);
    this.customThemeImportOwner.connect(
      this.context.gateway.connection.gatewayUrl,
      this.context.theme.serverSelection,
    );
    this.mediaDeviceWatch = observeRealtimeTalkDevices(() => {
      void this.refreshMediaDevices("microphone", false);
      void this.refreshMediaDevices("camera", false);
    });
    this.synchronize();
  }

  dispose() {
    this.connected = false;
    window.removeEventListener(
      SIDEBAR_HIDDEN_SESSION_CATALOGS_CHANGED_EVENT,
      this.hiddenSessionCatalogsChanged,
    );
    document.removeEventListener("visibilitychange", this.visibilityChanged);
    window.removeEventListener("focus", this.visibilityChanged);
    this.customThemeImportOwner.retireImport();
    this.retireMediaPermissionRequests();
    this.mediaDeviceWatch?.();
    this.mediaDeviceWatch = null;
    clearInterval(this.poll);
    clearInterval(this.countdown);
    this.abortRequests();
    if (this.scrollFrame !== null) {
      cancelAnimationFrame(this.scrollFrame);
      this.scrollFrame = null;
    }
    this.host = null;
    this.runtimeConfigSource = null;
    this.resetConfigViewState();
  }

  updateRoute(pageId: ConfigPageId, routeData: ConfigRouteData | null) {
    if (this.routeInitialized && pageId === this.pageId && routeData === this.routeData) {
      return;
    }
    this.routeInitialized = true;
    if (this.pageId === "appearance" && pageId !== "appearance") {
      this.customThemeImportOwner.retireImport();
      this.retireMediaPermissionRequests();
    }
    this.abortRequests();
    this.pageId = pageId;
    this.routeData = routeData;
    const selection = routeData
      ? normalizeConfigSelection(pageId, routeData.section, null)
      : configSelectionFromSearch(pageId, globalThis.location?.search ?? "");
    this.selections = { ...this.selections, [pageId]: selection };
    if (this.scrollFrame !== null) {
      cancelAnimationFrame(this.scrollFrame);
      this.scrollFrame = null;
    }
    this.targetBlockId =
      routeData?.targetBlockId ?? configTargetIdFromHash(globalThis.location?.hash ?? "");
    this.synchronize();
    this.invalidate();
  }

  private readonly hiddenSessionCatalogsChanged = () => {
    this.hiddenSessionCatalogIds = loadStoredHiddenSessionCatalogIds();
    this.synchronize();
    this.invalidate();
  };
  private readonly visibilityChanged = () => {
    this.synchronize();
  };

  private retireMediaPermissionRequests() {
    for (const device of Object.values(this.mediaDevices)) {
      device.requestsPermission = false;
    }
  }

  private abortRequests() {
    this.systemInfoAbort?.abort();
    this.systemInfoAbort = null;
    this.modelsAbort?.abort();
    this.modelsAbort = null;
    this.pluginsAbort?.abort();
    this.pluginsAbort = null;
    this.labelsAbort?.abort();
    this.labelsAbort = null;
    this.modelsAgent = null;
    this.pluginsClient = null;
    this.labelsKey = "";
  }

  /** Reads current owners after each publication, never copies their state into a store. */
  synchronize() {
    if (!this.connected) {
      return;
    }
    const gateway = this.context.gateway;
    const snapshot = gateway.snapshot;
    const connectionChanged =
      gateway !== this.previousGateway ||
      snapshot.client !== this.previousClient ||
      snapshot.hello !== this.previousHello ||
      snapshot.phase !== this.previousPhase;
    if (connectionChanged) {
      this.abortRequests();
      this.systemInfo = null;
      this.systemInfoUnavailable = false;
      this.sessionObserverModels = [];
      this.sessionObserverModelsUnavailable = false;
      this.resetConfigViewState();
      this.updateStatusClient = null;
      this.previousGateway = gateway;
      this.previousClient = snapshot.client;
      this.previousHello = snapshot.hello;
      this.previousPhase = snapshot.phase;
    }
    this.customThemeImportOwner.synchronizeScope(
      gateway.connection.gatewayUrl,
      this.context.theme.serverSelection,
    );
    this.synchronizeRuntimeConfig(this.context.runtimeConfig);
    this.settings = this.customThemeImportOwner.adoptSettings(
      this.settings,
      loadSettings(),
      this.context.theme.serverSelection,
    );
    const client = this.systemInfoRequestClient();
    if (!client) {
      clearInterval(this.poll);
      this.poll = undefined;
      this.systemInfoAbort?.abort();
      this.systemInfoAbort = null;
      this.modelsAbort?.abort();
      this.modelsAbort = null;
    } else if (connectionChanged || !this.systemInfo || !this.poll) {
      this.startSystemInfoPolling();
      void this.refreshSystemInfo();
    } else {
      void this.refreshSessionObserverModels();
    }
    this.syncAppearanceRequests();
    const updateClient =
      this.pageId === "updates" && canCallGatewayMethod(snapshot, "update.status", "operator.admin")
        ? snapshot.client
        : null;
    if (updateClient !== this.updateStatusClient) {
      this.updateStatusClient = updateClient;
      if (updateClient) {
        void this.context.overlays.refreshUpdateStatus();
      }
    }
    const campaign = this.context.overlays.snapshot.updateSchedule?.campaign;
    const ticking =
      this.pageId === "updates" &&
      (campaign?.state === "countdown" || campaign?.state === "waiting-for-idle");
    if (ticking && !this.countdown) {
      this.countdown = setInterval(this.invalidate, 1_000);
    }
    if (!ticking) {
      clearInterval(this.countdown);
      this.countdown = undefined;
    }
    if (this.pageId === "appearance") {
      for (const kind of ["microphone", "camera"] as const) {
        if (!this.mediaDevices[kind].loaded) {
          this.mediaDevices[kind].loaded = true;
          void this.refreshMediaDevices(kind, false);
        }
      }
      if (snapshot.phase === "connected") {
        void this.context.agentIdentity.ensure([this.context.agentSelection.state.selectedId]);
      }
    }
  }

  afterCommit() {
    if (!this.targetBlockId || this.scrollFrame !== null) {
      return;
    }
    this.scrollFrame = requestAnimationFrame(() => {
      this.scrollFrame = null;
      const target = [...(this.host?.querySelectorAll<HTMLElement>("[id]") ?? [])].find(
        (element) => element.id === this.targetBlockId,
      );
      if (!target) {
        return;
      }
      target.scrollIntoView?.({ behavior: resolveScrollBehavior(), block: "start" });
      this.targetBlockId = null;
    });
  }

  private startSystemInfoPolling() {
    clearInterval(this.poll);
    this.poll = setInterval(() => {
      void this.refreshSystemInfo();
    }, SYSTEM_INFO_POLL_INTERVAL_MS);
  }

  private systemInfoRequestClient(): GatewayBrowserClient | null {
    if (
      !this.connected ||
      document.visibilityState === "hidden" ||
      this.pageId !== "appearance" ||
      this.systemInfoUnavailable ||
      !canReadSystemInfo(this.context.gateway.snapshot)
    ) {
      return null;
    }
    return this.context.gateway.snapshot.client;
  }

  private async refreshSystemInfo() {
    const client = this.systemInfoRequestClient();
    if (!client || this.systemInfoAbort) {
      return;
    }
    const abort = new AbortController();
    this.systemInfoAbort = abort;
    try {
      const sample = await readSystemInfo(this.context.gateway, abort.signal);
      if (abort.signal.aborted || this.systemInfoRequestClient() !== client) {
        return;
      }
      this.systemInfo = sample.value;
      this.startSystemInfoPolling();
      void this.refreshSessionObserverModels(true);
    } catch (error) {
      if (abort.signal.aborted) {
        return;
      }
      if (isMissingOperatorReadScopeError(error) || isUnknownSystemInfoMethodError(error)) {
        this.systemInfo = null;
        this.systemInfoUnavailable = true;
      }
    } finally {
      if (this.systemInfoAbort === abort) {
        this.systemInfoAbort = null;
      }
      if (!abort.signal.aborted) {
        this.invalidate();
      }
    }
  }

  private async refreshSessionObserverModels(force = false) {
    const client = this.systemInfo ? this.systemInfoRequestClient() : null;
    const agentId = this.context.settingsAgentSelection.state.selectedId;
    if (!client || !agentId) {
      this.modelsAbort?.abort();
      this.modelsAbort = null;
      this.sessionObserverModels = [];
      this.sessionObserverModelsUnavailable = !agentId;
      return;
    }
    if (this.modelsAgent === agentId && (this.modelsAbort || !force)) {
      return;
    }
    const changed = this.modelsAgent !== agentId;
    this.modelsAbort?.abort();
    const abort = new AbortController();
    this.modelsAbort = abort;
    this.modelsAgent = agentId;
    if (changed) {
      this.sessionObserverModels = [];
      this.sessionObserverModelsUnavailable = false;
    }
    try {
      const { models } = await loadModelCatalog(client, {
        agentId,
        preparedOnly: true,
        signal: abort.signal,
      });
      if (
        abort.signal.aborted ||
        this.systemInfoRequestClient() !== client ||
        this.context.settingsAgentSelection.state.selectedId !== agentId
      ) {
        return;
      }
      this.sessionObserverModels = models;
      this.sessionObserverModelsUnavailable = false;
    } catch {
      if (!abort.signal.aborted) {
        this.sessionObserverModels = [];
        this.sessionObserverModelsUnavailable = true;
      }
    } finally {
      if (this.modelsAbort === abort) {
        this.modelsAbort = null;
      }
      if (!abort.signal.aborted) {
        this.invalidate();
      }
    }
  }

  private syncAppearanceRequests() {
    const snapshot = this.context.gateway.snapshot;
    const active = this.pageId === "appearance";
    const pluginsClient =
      active && canCallGatewayMethod(snapshot, "plugins.list", "operator.read")
        ? snapshot.client
        : null;
    if (pluginsClient !== this.pluginsClient) {
      this.pluginsAbort?.abort();
      this.pluginsAbort = null;
      this.pluginsClient = pluginsClient;
      this.installedSessionSourcePluginIds = null;
      this.sessionSourcePluginsLoading = Boolean(pluginsClient);
      if (pluginsClient) {
        const abort = new AbortController();
        this.pluginsAbort = abort;
        void pluginsClient
          .request<PluginsListResult>("plugins.list", {}, { signal: abort.signal })
          .then((result) => {
            if (!abort.signal.aborted) {
              this.installedSessionSourcePluginIds = new Set(
                result.plugins.filter((plugin) => plugin.installed).map((plugin) => plugin.id),
              );
            }
          })
          .catch(() => undefined)
          .finally(() => {
            if (!abort.signal.aborted) {
              this.sessionSourcePluginsLoading = false;
              this.invalidate();
            }
          });
      }
    }
    const agentId = this.context.settingsAgentSelection.state.selectedId;
    const labelsClient =
      active &&
      this.hiddenSessionCatalogIds.size > 0 &&
      canCallGatewayMethod(snapshot, "sessions.catalog.list", "operator.read")
        ? snapshot.client
        : null;
    const key = labelsClient
      ? `${agentId}\0${[...this.hiddenSessionCatalogIds].toSorted().join("\0")}`
      : "";
    if (key !== this.labelsKey) {
      this.labelsAbort?.abort();
      this.labelsAbort = null;
      this.labelsKey = key;
      this.hiddenSessionCatalogLabels = EMPTY_SESSION_CATALOG_LABELS;
      if (labelsClient) {
        const abort = new AbortController();
        this.labelsAbort = abort;
        void labelsClient
          .request<SessionsCatalogListResult>(
            "sessions.catalog.list",
            { ...(agentId ? { agentId } : {}), metadataOnly: true },
            { signal: abort.signal },
          )
          .then((result) => {
            if (!abort.signal.aborted) {
              this.hiddenSessionCatalogLabels = new Map(
                result.catalogs.map((catalog) => [catalog.id, catalog.label]),
              );
            }
          })
          .catch(() => undefined)
          .finally(() => {
            if (!abort.signal.aborted) {
              this.invalidate();
            }
          });
      }
    }
  }

  private get tabIconProps() {
    const context = this.context;
    const id = context.agentSelection.state.selectedId;
    const agent = context.agents.state.agentsList?.agents.find((entry) => entry.id === id);
    const unlocked = getLobsterdex();
    return {
      tabIcon: this.settings.tabIcon,
      lobsterdexEnabled: context.theme.branding.lobsterdex,
      tabIconAgentAvatar: agent
        ? resolveAgentAvatarUrl(agent, context.agentIdentity.get(id))
        : null,
      tabIconLobsters: LOBSTER_PET_PALETTES.filter((palette) => unlocked.has(palette.id)),
      setTabIconMode: (preference: NonNullable<UiSettings["tabIcon"]>) => {
        if (
          preference.startsWith("lobster:") &&
          (!context.theme.branding.lobsterdex ||
            !LOBSTER_PET_PALETTES.some((palette) => palette.id === preference.slice(8)) ||
            !getLobsterdex().has(preference.slice(8)))
        ) {
          return;
        }
        this.applySettings({ tabIcon: preference });
      },
    };
  }

  private async refreshMediaDevices(kind: "microphone" | "camera", requestPermission: boolean) {
    const device = this.mediaDevices[kind];
    if (device.loading) {
      device.requestsPermission ||= requestPermission;
      return;
    }
    device.loading = true;
    device.requestsPermission = requestPermission;
    device.error = null;
    this.invalidate();
    try {
      const discover =
        kind === "microphone" ? discoverRealtimeTalkInputs : discoverRealtimeTalkCameras;
      const result = await discover(() => device.requestsPermission);
      device.devices = result.devices;
      device.permissionRequired = result.permissionRequired;
      device.error = result.issue
        ? realtimeTalkDeviceIssueMessage(
            result.issue,
            kind === "microphone" ? "audioinput" : "videoinput",
          )
        : null;
    } catch (error) {
      // Discovery is best-effort in blocked/inactive contexts; a rejection
      // must not wedge the picker in its loading state.
      device.error = formatUiError(error);
    } finally {
      device.loading = false;
      device.requestsPermission = false;
      this.invalidate();
    }
  }

  private synchronizeRuntimeConfig(runtimeConfig: ApplicationContext["runtimeConfig"]) {
    if (runtimeConfig !== this.runtimeConfigSource) {
      if (this.runtimeConfigSource) {
        this.customThemeImportOwner.retireImport();
      }
      this.runtimeConfigSource = runtimeConfig;
      this.resetConfigViewState();
    }
    const config = runtimeConfig.state;
    if (!config.configSnapshot && !config.configLoading) {
      void runtimeConfig
        .ensureLoaded()
        .then(() =>
          this.runtimeConfigSource === runtimeConfig && this.pageId !== "updates"
            ? runtimeConfig.ensureSchemaLoaded()
            : undefined,
        )
        .catch(() => undefined);
      return;
    }
    if (this.pageId !== "updates" && !config.configSchema && !config.configSchemaLoading) {
      void runtimeConfig.ensureSchemaLoaded().catch(() => undefined);
    }
  }

  private resetConfigViewState() {
    // Revealed secrets and raw caches never cross a capability/source epoch.
    this.configViewState = createConfigViewState();
    this.invalidate();
  }

  private setActiveSection(section: string | null) {
    this.selections = {
      ...this.selections,
      [this.pageId]: { activeSection: section, activeSubsection: null },
    };
    this.invalidate();
  }

  private setActiveSubsection(section: string | null) {
    this.selections = {
      ...this.selections,
      [this.pageId]: {
        ...(this.selections[this.pageId] ?? defaultConfigSelection(this.pageId)),
        activeSubsection: section,
      },
    };
    this.invalidate();
  }

  private applySettings(patch: Partial<UiSettings>, selectedTheme?: ThemeName) {
    this.settings = selectedTheme
      ? selectThemeSettings(selectedTheme, patch)
      : patchSettings(patch);
    applyTextScale(this.settings.textScale);
    // theme.refresh() also republishes non-theme appearance prefs (text
    // scale, lobster pet visits/sounds) to app-host subscribers.
    this.context.theme.refresh();
    this.invalidate();
  }

  private setLocale(locale: Locale | undefined) {
    if (locale === undefined) {
      this.resetSyncedPref("locale");
      return;
    }
    this.settings = patchSettings({ locale });
    void i18n.setLocale(locale);
    this.invalidate();
  }

  private currentSyncedPref<K extends ResettableServerUiPrefKey>(key: K) {
    const appearance = isAppearancePref(key);
    return serverUiPrefs.resolveServerUiPrefState(
      this.context.runtimeConfig.state.configSnapshot?.config,
      key,
      this.context.gateway.connection.gatewayUrl,
      this.settings,
      {
        canSync: canSyncAppearancePreference(this.context, appearance ? key : undefined),
        profileId: appearance ? this.context.gateway.snapshot?.selfUser?.id : undefined,
      },
    );
  }

  private setFont(key: "fontUi" | "fontChat", font: TypefaceId | undefined) {
    const preference = this.currentSyncedPref(key);
    if (preference.overridden && font === preference.resetValue) {
      this.resetSyncedPref(key);
    } else {
      this.applySettings({ [key]: font });
    }
  }

  private resetSyncedPref(key: ResettableServerUiPrefKey) {
    this.settings = resetServerUiPref(
      key,
      this.currentSyncedPref(key),
      this.context.gateway.connection.gatewayUrl,
      this.context.gateway.snapshot?.selfUser?.id,
    );
    if (key === "locale") {
      if (isSupportedLocale(this.settings.locale)) {
        void i18n.setLocale(this.settings.locale);
      } else {
        void i18n.useSystemLocale();
      }
    } else {
      this.context.theme.refresh();
      this.invalidate();
    }
  }

  private setTheme(theme: ThemeName) {
    const preference = this.currentSyncedPref("theme");
    const reset = preference.overridden && theme === preference.resetValue;
    this.customThemeImportOwner.recordActivation(reset ? null : theme);
    if (reset) {
      this.resetSyncedPref("theme");
    } else {
      this.applySettings({}, theme);
    }
  }

  private setThemeMode(mode: ThemeMode) {
    const preference = this.currentSyncedPref("themeMode");
    if (preference.overridden && mode === preference.resetValue) {
      this.resetSyncedPref("themeMode");
    } else {
      this.context.theme.setMode(mode);
    }
  }

  private async selectCamera(deviceId: string) {
    const request = ++this.cameraSelectionRequest;
    const videoDeviceId = deviceId.trim() || undefined;
    this.mediaDevices.camera.error = null;
    this.invalidate();
    try {
      await switchActiveRealtimeTalkCameras(videoDeviceId);
      if (request !== this.cameraSelectionRequest) {
        return;
      }
      // Persist only a camera the active Talk session accepted. A superseded
      // request must not overwrite the newer confirmed selection.
      this.applySettings({
        realtimeTalkVideoDeviceId: videoDeviceId,
      });
    } catch (error) {
      if (request === this.cameraSelectionRequest) {
        this.mediaDevices.camera.error = formatUiError(error);
        this.invalidate();
      }
    }
  }

  private async importCustomTheme() {
    await this.customThemeImportOwner.import({
      config: this.context.runtimeConfig.state,
      hasCustomTheme: Boolean(this.settings.customTheme),
      load: importCustomThemeFromUrl,
      apply: (customTheme, activate) =>
        this.applySettings({ customTheme }, activate ? "custom" : this.settings.theme),
      messages: {
        blocked: (reason) => t(reason === "loading" ? "common.loading" : "common.unsavedChanges"),
        imported: (label) => t("configPage.themeImported", { name: label }),
      },
    });
  }

  private clearCustomTheme() {
    this.customThemeImportOwner.clear({
      apply: () =>
        this.applySettings(
          { customTheme: undefined },
          this.settings.theme === "custom" ? "claw" : this.settings.theme,
        ),
      message: t("configPage.themeRemoved"),
    });
  }

  private isUpdateBusy(): boolean {
    const update = this.context.overlays.snapshot;
    return update.updateRunning || update.updateReconciliationPending;
  }

  private isCuratedConfigMutationDisabled(): boolean {
    const runtimeState = this.context.runtimeConfig.state;
    return (
      !runtimeState.connected ||
      runtimeState.configLoading ||
      runtimeState.configSaving ||
      runtimeState.configApplying ||
      this.isUpdateBusy() ||
      this.context.overlays.snapshot.updateStatusRefreshing ||
      !this.context.runtimeConfig.canSet ||
      !hasOperatorAdminAccess(this.context.gateway.snapshot.hello?.auth ?? null)
    );
  }

  get configProps(): ConfigProps {
    this.observe();
    const configObject = this.configObject;
    const runtimeConfig = this.context.runtimeConfig;
    const configState = runtimeConfig.state;
    const includeSections = configSectionKeysForPage(this.pageId);
    // Advanced shows everything without a curated home elsewhere.
    const excludeSections =
      this.pageId === "advanced" ? [...SCOPED_CONFIG_SECTION_KEYS] : undefined;
    const currentSelection = this.selections[this.pageId] ?? defaultConfigSelection(this.pageId);
    const selection = normalizeConfigSelection(
      this.pageId,
      currentSelection.activeSection,
      currentSelection.activeSubsection,
    );
    const activeSection = this.pageId === "mcp" ? "mcp" : selection.activeSection;
    const activeSubsection = this.pageId === "mcp" ? null : selection.activeSubsection;
    const gatewayConfig = asConfigRecord(configObject.gateway);
    const controlUiConfig = asConfigRecord(gatewayConfig?.controlUi);
    const agentsDefaults = asConfigRecord(asConfigRecord(configObject.agents)?.defaults);
    const themePref = this.currentSyncedPref("theme");
    const themeModePref = this.currentSyncedPref("themeMode");
    const accentPref = this.currentSyncedPref("accent");
    const localePref = this.currentSyncedPref("locale");
    const chatSendShortcutPref = this.currentSyncedPref("chatSendShortcut");
    const chatFollowUpModePref = this.currentSyncedPref("chatFollowUpMode");
    const sessionObserverBusy =
      !configState.connected ||
      configState.configSaving ||
      configState.configApplying ||
      this.isUpdateBusy() ||
      this.context.overlays.snapshot.updateStatusRefreshing ||
      !hasOperatorAdminAccess(this.context.gateway.snapshot.hello?.auth ?? null);
    const withConfigMutation =
      <Args extends unknown[]>(mutate: (...args: Args) => void) =>
      (...args: Args) => {
        this.customThemeImportOwner.retireForConfigMutation(t("common.unsavedChanges"));
        mutate(...args);
      };
    return {
      onAppearanceChange: (patch) => this.applySettings(patch),
      raw: configState.configRaw,
      originalRaw: configState.configRawOriginal,
      valid: configState.configValid,
      issues: configState.configIssues,
      loading: configState.configLoading,
      saving: configState.configSaving,
      applying: configState.configApplying,
      updating: this.isUpdateBusy() || this.context.overlays.snapshot.updateStatusRefreshing,
      connected: configState.connected,
      mutationAllowed: runtimeConfig.canSet,
      openFileAllowed: runtimeConfig.canOpenFile,
      schema: configState.configSchema,
      schemaLoading: configState.configSchemaLoading,
      uiHints: configState.configUiHints,
      formMode: this.formModes[this.pageId] ?? "form",
      rawDraftPending: configState.configFormMode === "raw" && configState.configFormDirty,
      viewState: this.configViewState,
      rawAvailable: Boolean(
        configState.configSnapshot?.config || configState.configForm || configState.configRaw,
      ),
      showModeToggle: this.pageId === "advanced",
      formValue: configState.configForm,
      activeSection,
      activeSubsection,
      onRawChange: withConfigMutation((next) => runtimeConfig.setRaw(next)),
      onFormModeChange: (mode) => {
        this.formModes = { ...this.formModes, [this.pageId]: mode };
        this.invalidate();
      },
      onViewStateChange: () => this.invalidate(),
      onFormPatch: withConfigMutation((path, value) => runtimeConfig.patchForm(path, value)),
      onFormRemove: withConfigMutation((path) => runtimeConfig.removeFormValue(path)),
      onSectionChange: (section) => this.setActiveSection(section),
      onSubsectionChange: (section) => this.setActiveSubsection(section),
      onSave: () => void runtimeConfig.save(),
      onRawDiscard: () => void runtimeConfig.discardDraft(),
      onOpenFile: () => void runtimeConfig.openFile(),
      theme: this.settings.theme,
      themeOverridden: themePref.overridden,
      themeProvenance: themePref.provenance,
      themeResetValue: themePref.resetValue ?? UI_APPEARANCE_DEFAULTS.theme,
      themeMode: this.settings.themeMode,
      themeModeOverridden: themeModePref.overridden,
      themeModeProvenance: themeModePref.provenance,
      themeModeResetValue: themeModePref.resetValue ?? UI_APPEARANCE_DEFAULTS.themeMode,
      accent: this.settings.accent,
      accentProvenance: accentPref.provenance,
      accentResetValue: accentPref.resetValue,
      fontUi: this.settings.fontUi,
      fontChat: this.settings.fontChat,
      fontUiProvenance: this.currentSyncedPref("fontUi").provenance,
      fontChatProvenance: this.currentSyncedPref("fontChat").provenance,
      setFontUi: (font) => this.setFont("fontUi", font),
      setFontChat: (font) => this.setFont("fontChat", font),
      systemLocale: i18n.getSystemLocale(),
      localeOverride: isSupportedLocale(localePref.value) ? localePref.value : undefined,
      localeOverridden: localePref.overridden,
      localeProvenance: localePref.provenance,
      localeResetValue: isSupportedLocale(localePref.resetValue)
        ? localePref.resetValue
        : undefined,
      onLocaleChange: (locale) => this.setLocale(locale),
      themeCatalog: this.pageId === "appearance" ? this.context.theme.catalog : undefined,
      onRetryThemeCatalog: () => this.context.theme.retryCatalog?.(),
      setTheme: (theme) => this.setTheme(theme),
      setThemeMode: (mode) => this.setThemeMode(mode),
      setAccent: (accent) =>
        accent === undefined ? this.resetSyncedPref("accent") : this.applySettings({ accent }),
      hasCustomTheme: Boolean(this.settings.customTheme),
      customThemeLabel: this.settings.customTheme?.label ?? null,
      customThemeSourceUrl: this.settings.customTheme?.sourceUrl ?? null,
      customThemeImportUrl: this.customThemeImport.url,
      customThemeImportBusy: this.customThemeImport.busy,
      customThemeImportMessage: this.customThemeImport.message,
      customThemeImportExpanded: this.customThemeImport.expanded,
      customThemeImportFocusToken: this.customThemeImport.focusToken,
      onCustomThemeImportUrlChange: (next) => this.customThemeImportOwner.setUrl(next),
      onImportCustomTheme: () => void this.importCustomTheme(),
      onClearCustomTheme: () => this.clearCustomTheme(),
      onOpenCustomThemeImport: () => this.customThemeImportOwner.open(),
      ...this.tabIconProps,
      textScale: this.settings.textScale ?? UI_APPEARANCE_DEFAULTS.textScale,
      textScaleOverridden: this.settings.textScale !== undefined,
      setTextScale: (value) =>
        this.applySettings({
          textScale:
            value === UI_APPEARANCE_DEFAULTS.textScale ? undefined : normalizeTextScale(value),
        }),
      sidebarLiveActivity:
        this.settings.sidebarLiveActivity ?? UI_APPEARANCE_DEFAULTS.sidebarLiveActivity,
      hiddenSessionCatalogIds: this.hiddenSessionCatalogIds,
      hiddenSessionCatalogLabels: this.hiddenSessionCatalogLabels,
      setSessionCatalogHidden: setStoredSessionCatalogHidden,
      ...localPresentationProps(this.settings, (patch) => this.applySettings(patch)),
      forceShowAdvanced: this.pageId === "advanced",
      forceAdvancedSection: this.routeData?.advanced
        ? (this.routeData.section ?? defaultConfigSelection(this.pageId).activeSection)
        : null,
      sessionObserverEnabled: controlUiConfig?.sessionObserver !== false,
      sessionObserverUtilityModel:
        typeof agentsDefaults?.utilityModel === "string" ? agentsDefaults.utilityModel : undefined,
      sessionObserverResolvedModel: this.systemInfo?.defaultAgentUtilityModel,
      sessionObserverModels: this.sessionObserverModels,
      sessionObserverModelsUnavailable: this.sessionObserverModelsUnavailable,
      sessionObserverDisabled: sessionObserverBusy,
      setSessionObserverEnabled: (enabled) => {
        void runtimeConfig.patch({
          raw: buildSessionObserverTogglePatch(enabled),
          note: t("configView.sessionObserver.toggleNote"),
        });
      },
      setSessionObserverUtilityModel: (modelSelection) => {
        void runtimeConfig
          .patch({
            raw: buildSessionObserverUtilityModelPatch(modelSelection),
            note: t("configView.sessionObserver.modelNote"),
          })
          .then((saved) => {
            if (saved) {
              void this.refreshSystemInfo();
            }
          });
      },
      lobsterPetVisits: this.settings.lobsterPetVisits ?? UI_APPEARANCE_DEFAULTS.lobsterPetVisits,
      sessionDeleteConfirm:
        this.settings.sessionDeleteConfirm ?? UI_APPEARANCE_DEFAULTS.sessionDeleteConfirm,
      lobsterPetSounds: this.settings.lobsterPetSounds ?? UI_APPEARANCE_DEFAULTS.lobsterPetSounds,
      lobsterdexHref: pathForRoute("lobsterdex", this.context.basePath),
      onOpenLobsterdex: () => this.context.navigate("lobsterdex"),
      chatSendShortcut: normalizeChatSendShortcut(this.settings.chatSendShortcut),
      chatSendShortcutOverridden: chatSendShortcutPref.overridden,
      chatSendShortcutProvenance: chatSendShortcutPref.provenance,
      chatSendShortcutResetValue:
        chatSendShortcutPref.resetValue ?? UI_APPEARANCE_DEFAULTS.chatSendShortcut,
      chatFollowUpMode: this.settings.chatFollowUpMode,
      chatFollowUpModeOverridden: chatFollowUpModePref.overridden,
      chatFollowUpModeProvenance: chatFollowUpModePref.provenance,
      serverQueueMode: configState.configSnapshot
        ? resolveControlUiServerQueueMode(configState.configSnapshot.runtimeConfig, {
            configNeedsApply: configState.configNeedsApply,
          })
        : undefined,
      resetChatFollowUpMode: () => this.resetSyncedPref("chatFollowUpMode"),
      catalogOpenTarget: normalizeCatalogOpenTarget(this.settings.catalogOpenTarget),
      pluginsHref: pathForRoute("plugin-settings", this.context.basePath),
      installedSessionSourcePluginIds: this.installedSessionSourcePluginIds,
      sessionSourcePluginsLoading: this.sessionSourcePluginsLoading,
      microphone: {
        ...this.mediaDevices.microphone,
        selectedDeviceId: this.settings.realtimeTalkInputDeviceId ?? "",
      },
      composerHoldToRecord: this.settings.composerHoldToRecord !== false,
      onMicrophoneRefresh: () => void this.refreshMediaDevices("microphone", true),
      onMicrophoneSelect: (deviceId) =>
        this.applySettings({ realtimeTalkInputDeviceId: deviceId.trim() || undefined }),
      camera: {
        ...this.mediaDevices.camera,
        selectedDeviceId: this.settings.realtimeTalkVideoDeviceId ?? "",
      },
      onCameraRefresh: () => void this.refreshMediaDevices("camera", true),
      onCameraSelect: (deviceId) => void this.selectCamera(deviceId),
      gatewayUrl: this.context.gateway.connection.gatewayUrl,
      assistantName: this.context.config.current.assistantIdentity.name,
      configPath: configState.configSnapshot?.path ?? null,
      navRootLabel: this.pageId === "advanced" ? undefined : titleForRoute(this.pageId),
      showSectionDocs: this.pageId !== "communications",
      showRootTab: !includeSections?.length,
      includeSections: includeSections ? [...includeSections] : undefined,
      excludeSections,
      includeVirtualSections: this.pageId === "appearance" || this.pageId === "notifications",
      settingsLayout: this.pageId === "advanced" ? "accordion" : undefined,
      nativeNotifications: this.context.nativeNotifications?.snapshot,
      onNativeNotificationsRequestPermission: () =>
        this.context.nativeNotifications?.requestPermission(),
      onNativeNotificationsSendTest: () => this.context.nativeNotifications?.sendTest(),
      webPush: this.context.webPush.snapshot,
      onWebPushSubscribe: () => void this.context.webPush.run({ kind: "enable" }),
      onWebPushUnsubscribe: () => void this.context.webPush.run({ kind: "disable" }),
      onWebPushTest: () => void this.context.webPush.run({ kind: "test" }),
      onWebPushSetUserPreferences: (preferences) =>
        void this.context.webPush.run({ kind: "set", scope: "user", preferences }),
      onWebPushSetDevicePreferences: (preferences) =>
        void this.context.webPush.run({ kind: "set", scope: "device", preferences }),
    } satisfies ConfigProps;
  }
}
