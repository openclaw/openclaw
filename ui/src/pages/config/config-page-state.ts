/* oxlint-disable max-lines -- The Settings presentation factory keeps its existing request and preference contracts together. */
import { asNullableRecord as asConfigRecord } from "@openclaw/normalization-core/record-coerce";
import { createEffect, createMemo, createSignal, createStore, onSettled } from "solid-js";
import type { SystemInfoResult } from "../../../../packages/gateway-protocol/src/index.js";
import type * as Push from "../../../../packages/gateway-protocol/src/schema/push.js";
import { createChangeListeners } from "../../../../src/shared/listeners.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { titleForRoute } from "../../app-navigation.ts";
import { pathForRoute, sameRouteLocation } from "../../app-route-paths.ts";
import type { ApplicationContext } from "../../app/context-types.ts";
import { hasOperatorAdminAccess } from "../../app/operator-access.ts";
import { resetServerUiPref, selectThemeSettings } from "../../app/server-prefs-controls.ts";
import { canSyncAppearancePreference } from "../../app/server-prefs-profile-runtime.ts";
import * as serverUiPrefs from "../../app/server-prefs-reconcile.ts";
import { isAppearancePref, type ResettableServerUiPrefKey } from "../../app/server-prefs-state.ts";
import {
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
import { getLobsterdex, subscribeLobsterdex } from "../../components/lobster-dex.ts";
import { LOBSTER_PET_PALETTES } from "../../components/lobster-pet-palettes.ts";
import { i18n, isSupportedLocale, type Locale } from "../../i18n/index.ts";
import { registerSettingsEnglish } from "../../i18n/locales/en-settings.ts";
import { resolveAgentAvatarUrl } from "../../lib/avatar.ts";
import { resolveControlUiServerQueueMode } from "../../lib/chat/follow-up-mode.ts";
import { currentConfigRead } from "../../lib/config/config-state-model.ts";
import { isMissingOperatorReadScopeError } from "../../lib/gateway-errors.ts";
import { modelSettingPrimary, readModelSetting } from "../../lib/model-setting.ts";
import { createPageRequest } from "../../lib/page-request.ts";
import { registerEnglishCatalog, t } from "../../lib/reactive/i18n.ts";
import { listen } from "../../lib/reactive/listener.ts";
import { projectOwner, projectSource } from "../../lib/reactive/projection.ts";
import { resolveScrollBehavior } from "../../lib/scroll-behavior.ts";
import {
  canReadSystemInfo,
  readSystemInfo,
  SYSTEM_INFO_POLL_INTERVAL_MS,
} from "../../lib/system-info.ts";
import { createAppearanceCatalogs } from "./appearance-catalogs.ts";
import { createConfigPageModels } from "./config-page-models.ts";
import {
  configSectionKeysForPage,
  configSelectionFromSearch,
  defaultConfigSelection,
  normalizeConfigSelection,
  type ConfigSelection,
  ADVANCED_EXCLUDED_SECTIONS,
  type ConfigPageId,
} from "./config-sections.ts";
import * as themeImport from "./custom-theme-import-owner.ts";
import { importCustomThemeFromUrl } from "./custom-theme-import.ts";
import { createMediaDevicePreferences } from "./media-device-discovery.ts";
import { admitMemoryRoute } from "./memory-route-admission.ts";
import {
  configTargetIdFromHash,
  type ConfigRouteData,
  type ConfigRouteSource,
} from "./route-data.ts";
import {
  buildSessionObserverTogglePatch,
  buildSessionObserverUtilityModelPatch,
  type SessionObserverModelSelection,
} from "./session-observer-settings.ts";
import { createConfigUpdatesPresentation } from "./updates-page-presentation.ts";
import { createConfigViewState } from "./view-state.ts";
import type * as View from "./view-state.ts";

registerEnglishCatalog(registerSettingsEnglish);

const EMPTY_SESSION_CATALOG_LABELS: ReadonlyMap<string, string> = new Map();

/** Coordinates page-local drafts and requests; config and preference writes stay with their owners. */
export function createConfigPage(
  context: ApplicationContext,
  route: () => { pageId: ConfigPageId; routeData: ConfigRouteData | null },
  host: () => HTMLElement,
) {
  const applicationConfig = projectOwner(context.config, (owner) => owner.current);
  const agents = projectOwner(context.agents, (owner) => owner.state);
  const identities = projectOwner(context.agentIdentity, (owner) => owner);
  const lobsterdex = projectSource(subscribeLobsterdex, {
    read: getLobsterdex,
    subscribe: (subscribe, notify) => subscribe(notify),
    equality: "revision",
  });
  const webPush = projectOwner(context.webPush, (owner) => owner.snapshot);
  const notifications = context.nativeNotifications
    ? projectOwner(context.nativeNotifications, (owner) => owner.snapshot)
    : null;
  // Imperative owner notifications can arrive while a descendant is rendering.
  const [revision, publish] = createSignal(0, { ownedWrite: true });
  const invalidate = () => {
    publish((value) => value + 1);
    onSettled(afterCommit);
  };
  const [presentation, setPresentation] = createStore<{
    formModes: Partial<Record<ConfigPageId, View.ConfigFormMode>>;
    selections: Partial<Record<ConfigPageId, ConfigSelection>>;
  }>({ formModes: {}, selections: {} });
  let pageId: ConfigPageId = "advanced";
  let routeData: ConfigRouteData | null = null;
  const routeListeners = createChangeListeners();
  const admittedRoute: ConfigRouteSource = {
    read: () => routeData,
    subscribe: routeListeners.subscribe,
  };
  let connected = false;
  const settings = () => context.theme.settings;
  let hiddenSessionCatalogIds = loadStoredHiddenSessionCatalogIds();
  let systemInfo: SystemInfoResult | null = null;
  let systemInfoUnavailable = false;
  const observerModels = createConfigPageModels({
    invalidate,
    requestClient: systemInfoRequestClient,
    hasSystemInfo: () => systemInfo !== null,
    selectedAgent: () => context.settingsAgentSelection.state.selectedId,
  });
  const catalogs = createAppearanceCatalogs(invalidate);
  const pluginsRead = createMemo(() => {
    revision();
    return catalogs.pluginsRead;
  });
  const sessionSourcePlugins = createMemo(async () => {
    const catalog = await pluginsRead().value;
    return catalog
      ? new Set(catalog.plugins.filter((plugin) => plugin.installed).map((plugin) => plugin.id))
      : null;
  });
  const labelsRead = createMemo(() => {
    revision();
    return catalogs.labelsRead;
  });
  const sessionCatalogLabels = createMemo(async () => {
    const catalog = await labelsRead().value;
    return catalog
      ? new Map(catalog.catalogs.map((entry) => [entry.id, entry.label]))
      : EMPTY_SESSION_CATALOG_LABELS;
  });
  const customThemeImportOwner = new themeImport.CustomThemeImportOwner(invalidate);
  let configViewState: View.ConfigViewState = createConfigViewState();
  let runtimeConfigSource: ApplicationContext["runtimeConfig"] | null = null;
  // Release command presentation before a reactive scope change can park its cleanup.
  let commandLifetime = Promise.withResolvers<void>();
  function retireCommands() {
    commandLifetime.resolve();
    commandLifetime = Promise.withResolvers<void>();
  }
  const updates = createConfigUpdatesPresentation(context);
  const mediaDeviceOwner = createMediaDevicePreferences(
    (videoDeviceId) => applySettings({ realtimeTalkVideoDeviceId: videoDeviceId }),
    invalidate,
  );
  const mediaDevices = mediaDeviceOwner.devices;
  let previousGateway: ApplicationContext["gateway"] | null = null;
  let previousClient: GatewayBrowserClient | null = null;
  let previousHello: unknown;
  let previousPhase: string | null = null;
  let poll: ReturnType<typeof setInterval> | undefined;
  let countdown: ReturnType<typeof setInterval> | undefined;
  let routeInitialized = false;
  let normalizedMemoryLocation = "";
  let targetBlockId: string | null = null;
  let scrollFrame: number | null = null;

  function nowMs() {
    revision();
    return Date.now();
  }

  function readConfigObject() {
    revision();
    const state = context.runtimeConfig.state;
    return asConfigRecord(state.configForm ?? state.configSnapshot?.config) ?? {};
  }

  function mutationDisabled() {
    const state = context.runtimeConfig.state;
    return mutationBusy() || state.configLoading || !context.runtimeConfig.canSet;
  }
  function mutationBusy() {
    revision();
    const state = context.runtimeConfig.state;
    return (
      !state.connected ||
      state.configSaving ||
      state.configApplying ||
      updates.busy() ||
      context.overlays.snapshot.updateStatusRefreshing ||
      !hasOperatorAdminAccess(context.gateway.snapshot.hello?.auth ?? null)
    );
  }
  function updateBusy() {
    revision();
    return updates.busy();
  }

  function updateRoute(nextPageId: ConfigPageId, nextRouteData: ConfigRouteData | null) {
    if (routeInitialized && nextPageId === pageId && nextRouteData === routeData) {
      return;
    }
    routeInitialized = true;
    retireCommands();
    if (pageId === "appearance" && nextPageId !== "appearance") {
      customThemeImportOwner.retireImport();
      mediaDeviceOwner.retire();
    }
    abortRequests();
    pageId = nextPageId;
    routeData = nextRouteData;
    admitMemoryRoute(context, pageId, routeData, normalizedMemoryLocation, (location) => {
      normalizedMemoryLocation = location;
    });
    const selection = routeData
      ? normalizeConfigSelection(pageId, routeData.section, null)
      : configSelectionFromSearch(pageId, globalThis.location?.search ?? "");
    setPresentation((draft) => {
      draft.selections[pageId] = selection;
    });
    if (scrollFrame !== null) {
      cancelAnimationFrame(scrollFrame);
      scrollFrame = null;
    }
    targetBlockId =
      routeData?.targetBlockId ?? configTargetIdFromHash(globalThis.location?.hash ?? "");
    synchronize();
    invalidate();
    routeListeners.publish();
  }

  const hiddenSessionCatalogsChanged = () => {
    hiddenSessionCatalogIds = loadStoredHiddenSessionCatalogIds();
    synchronize();
    invalidate();
  };

  function abortRequests() {
    systemInfoTask.cancel();
    observerModels.retire();
    catalogs.retire();
  }

  /** Reads current owners after each publication, never copies their state into a store. */
  function synchronize() {
    if (!connected) {
      return;
    }
    const gateway = context.gateway;
    const snapshot = gateway.snapshot;
    const connectionChanged =
      gateway !== previousGateway ||
      snapshot.client !== previousClient ||
      snapshot.hello !== previousHello ||
      snapshot.phase !== previousPhase;
    if (connectionChanged) {
      retireCommands();
      abortRequests();
      systemInfo = null;
      systemInfoUnavailable = false;
      observerModels.reset();
      resetConfigViewState();
      updates.reset();
      previousGateway = gateway;
      previousClient = snapshot.client;
      previousHello = snapshot.hello;
      previousPhase = snapshot.phase;
    }
    synchronizeRuntimeConfig(context.runtimeConfig);
    customThemeImportOwner.synchronize(
      gateway.connection.gatewayUrl,
      settings().customTheme?.importedAt,
    );
    const client = systemInfoRequestClient();
    if (!client) {
      clearInterval(poll);
      poll = undefined;
      systemInfoTask.cancel();
      observerModels.cancel();
    } else if (connectionChanged || !systemInfo || !poll) {
      startSystemInfoPolling();
      void refreshSystemInfo();
    } else {
      observerModels.refresh();
    }
    catalogs.synchronize(
      pageId === "appearance",
      snapshot,
      context.settingsAgentSelection.state.selectedId,
      hiddenSessionCatalogIds,
    );
    updates.synchronize(pageId);
    const campaign = context.overlays.snapshot.updateSchedule?.campaign;
    const ticking =
      pageId === "updates" &&
      (campaign?.state === "countdown" || campaign?.state === "waiting-for-idle");
    if (ticking && !countdown) {
      countdown = setInterval(invalidate, 1_000);
    }
    if (!ticking) {
      clearInterval(countdown);
      countdown = undefined;
    }
    if (pageId === "appearance") {
      mediaDeviceOwner.load();
      if (snapshot.phase === "connected") {
        void context.agentIdentity.ensure([context.agentSelection.state.selectedId]);
      }
    }
  }

  function afterCommit() {
    if (!connected || !targetBlockId || scrollFrame !== null) {
      return;
    }
    scrollFrame = requestAnimationFrame(() => {
      scrollFrame = null;
      // Settings routes share one live page; keep the document's ID lookup scoped to it.
      const target = targetBlockId ? host().ownerDocument.getElementById(targetBlockId) : null;
      if (!target || !host().contains(target)) {
        return;
      }
      target.scrollIntoView?.({ behavior: resolveScrollBehavior(), block: "start" });
      targetBlockId = null;
    });
  }

  function startSystemInfoPolling() {
    clearInterval(poll);
    poll = setInterval(() => {
      void refreshSystemInfo();
    }, SYSTEM_INFO_POLL_INTERVAL_MS);
  }

  function systemInfoRequestClient(): GatewayBrowserClient | null {
    if (
      !connected ||
      document.visibilityState === "hidden" ||
      pageId !== "appearance" ||
      systemInfoUnavailable ||
      !canReadSystemInfo(context.gateway.snapshot)
    ) {
      return null;
    }
    return context.gateway.snapshot.client;
  }

  const systemInfoTask = createPageRequest(invalidate, {
    task: async (client: GatewayBrowserClient, { signal }) => {
      const sample = await readSystemInfo(context.gateway, signal);
      return systemInfoRequestClient() === client ? sample : null;
    },
    onComplete: (sample) => {
      if (sample) {
        systemInfo = sample.value;
        startSystemInfoPolling();
        observerModels.refresh(true);
      }
    },
    onError: (error) => {
      if (isMissingOperatorReadScopeError(error)) {
        systemInfo = null;
        systemInfoUnavailable = true;
      }
    },
  });
  async function refreshSystemInfo() {
    const client = systemInfoRequestClient();
    if (client && !systemInfoTask.pending) {
      await systemInfoTask.run(client);
    }
  }

  function synchronizeRuntimeConfig(runtimeConfig: ApplicationContext["runtimeConfig"]) {
    if (runtimeConfig !== runtimeConfigSource) {
      retireCommands();
      if (runtimeConfigSource) {
        customThemeImportOwner.retireImport();
      }
      runtimeConfigSource = runtimeConfig;
      resetConfigViewState();
    }
    const config = runtimeConfig.state;
    if (!config.configSnapshot && !config.configLoading && !currentConfigRead(config)) {
      void runtimeConfig
        .ensureLoaded()
        .then(() =>
          runtimeConfigSource === runtimeConfig && pageId !== "updates" && !runtimeConfig.schemaRead
            ? runtimeConfig.ensureSchemaLoaded()
            : undefined,
        )
        .catch(() => undefined);
    } else if (pageId !== "updates" && !config.configSchema && !runtimeConfig.schemaRead) {
      void runtimeConfig.ensureSchemaLoaded().catch(() => undefined);
    }
  }

  function resetConfigViewState() {
    // Revealed secrets and raw caches never cross a capability/source epoch.
    configViewState = createConfigViewState();
    invalidate();
  }

  function applySettings(patch: Partial<UiSettings>, selectedTheme?: ThemeName) {
    if (selectedTheme) {
      selectThemeSettings(selectedTheme, patch);
    } else {
      patchSettings(patch);
    }
    // theme.refresh() also republishes non-theme appearance prefs (text
    // scale, lobster pet visits/sounds) to app-host subscribers.
    context.theme.refresh();
    invalidate();
  }

  function currentSyncedPref<K extends ResettableServerUiPrefKey>(key: K) {
    const appearance = isAppearancePref(key);
    return serverUiPrefs.resolveServerUiPrefState(
      context.runtimeConfig.state.configSnapshot?.config,
      key,
      context.gateway.connection.gatewayUrl,
      settings(),
      {
        canSync: canSyncAppearancePreference(context, appearance ? key : undefined),
        profileId: appearance ? context.gateway.snapshot?.selfUser?.id : undefined,
      },
    );
  }

  function setFont(key: "fontUi" | "fontChat", font: TypefaceId | undefined) {
    const preference = currentSyncedPref(key);
    if (preference.overridden && font === preference.resetValue) {
      resetSyncedPref(key);
    } else {
      applySettings({ [key]: font });
    }
  }

  function resetSyncedPref(key: ResettableServerUiPrefKey) {
    const resetSettings = resetServerUiPref(
      key,
      currentSyncedPref(key),
      context.gateway.connection.gatewayUrl,
      context.gateway.snapshot?.selfUser?.id,
    );
    if (key === "locale") {
      if (isSupportedLocale(resetSettings.locale)) {
        void i18n.setLocale(resetSettings.locale);
      } else {
        void i18n.useSystemLocale();
      }
    } else {
      context.theme.refresh();
      invalidate();
    }
  }

  function configProps() {
    revision();
    const configObject = readConfigObject();
    const runtimeConfig = context.runtimeConfig;
    const configState = runtimeConfig.state;
    const includeSections = configSectionKeysForPage(pageId);
    const currentSelection = presentation.selections[pageId] ?? defaultConfigSelection(pageId);
    const selection = normalizeConfigSelection(
      pageId,
      currentSelection.activeSection,
      currentSelection.activeSubsection,
    );
    const controlUiConfig = asConfigRecord(asConfigRecord(configObject.gateway)?.controlUi);
    const agentsDefaults = asConfigRecord(asConfigRecord(configObject.agents)?.defaults);
    const utilityModel = readModelSetting(agentsDefaults?.utilityModel);
    const id = context.agentSelection.state.selectedId;
    const agent = agents.read().agentsList?.agents.find((entry) => entry.id === id);
    const unlocked = lobsterdex.read();
    const themePref = currentSyncedPref("theme");
    const themeModePref = currentSyncedPref("themeMode");
    const accentPref = currentSyncedPref("accent");
    const localePref = currentSyncedPref("locale");
    const chatSendShortcutPref = currentSyncedPref("chatSendShortcut");
    const chatFollowUpModePref = currentSyncedPref("chatFollowUpMode");
    const observerLifetime = commandLifetime.promise;
    const observerResult = (saved: boolean) => {
      if (!saved && observerLifetime === commandLifetime.promise && configState.lastError) {
        throw new Error(configState.lastError);
      }
      return saved;
    };
    const withConfigMutation =
      <Args extends unknown[]>(mutate: (...args: Args) => void) =>
      (...args: Args) => {
        customThemeImportOwner.retireForConfigMutation(t("common.unsavedChanges"));
        mutate(...args);
      };
    return {
      onAppearanceChange: applySettings,
      raw: configState.configRaw,
      originalRaw: configState.configRawOriginal,
      valid: configState.configValid,
      issues: configState.configIssues,
      loading: configState.configLoading,
      configLoaded: configState.configSnapshot !== null,
      configRecoveryError: configState.configRecoveryError,
      configRead: currentConfigRead(configState)?.completion.promise ?? null,
      onRetryConfig: () => void runtimeConfig.refresh(),
      saving: configState.configSaving,
      applying: configState.configApplying,
      updating: updates.busy() || context.overlays.snapshot.updateStatusRefreshing,
      connected: configState.connected,
      mutationAllowed: runtimeConfig.canSet,
      openFileAllowed: runtimeConfig.canOpenFile,
      schema: configState.configSchema,
      schemaLoading: configState.configSchemaLoading,
      schemaRead: runtimeConfig.schemaRead,
      onRetrySchema: () => void runtimeConfig.refreshSchema(),
      uiHints: configState.configUiHints,
      formMode: presentation.formModes[pageId] ?? "form",
      rawDraftPending: configState.configFormMode === "raw" && configState.configFormDirty,
      viewState: configViewState,
      rawAvailable: Boolean(
        configState.configSnapshot?.config || configState.configForm || configState.configRaw,
      ),
      showModeToggle: pageId === "advanced",
      formValue: configState.configForm,
      activeSection: pageId === "mcp" ? "mcp" : selection.activeSection,
      activeSubsection: pageId === "mcp" ? null : selection.activeSubsection,
      onRawChange: withConfigMutation((next: string) => runtimeConfig.setRaw(next)),
      onFormModeChange: (mode: View.ConfigFormMode) => {
        const currentMode =
          configState.configFormMode === "raw" && configState.configFormDirty
            ? "raw"
            : (presentation.formModes[pageId] ?? "form");
        if (mode !== currentMode) {
          retireCommands();
        }
        setPresentation((draft) => {
          draft.formModes[pageId] = mode;
        });
        invalidate();
      },
      onViewStateChange: () => invalidate(),
      onFormPatch: withConfigMutation((path: Array<string | number>, value: unknown) =>
        runtimeConfig.patchForm(path, value),
      ),
      onFormRemove: withConfigMutation((path: Array<string | number>) =>
        runtimeConfig.removeFormValue(path),
      ),
      onSectionChange: (section: string | null) => {
        retireCommands();
        setPresentation((draft) => {
          draft.selections[pageId] = { activeSection: section, activeSubsection: null };
        });
        invalidate();
      },
      onSubsectionChange: (section: string | null) => {
        retireCommands();
        setPresentation((draft) => {
          draft.selections[pageId] = {
            ...(draft.selections[pageId] ?? defaultConfigSelection(pageId)),
            activeSubsection: section,
          };
        });
        invalidate();
      },
      onSave: () => runtimeConfig.save(),
      presentationRetired: () => commandLifetime.promise,
      onRawDiscard: () => runtimeConfig.discardDraft(),
      onOpenFile: () => runtimeConfig.openFile(),
      theme: settings().theme,
      themeOverridden: themePref.overridden,
      themeProvenance: themePref.provenance,
      themeResetValue: themePref.resetValue ?? UI_APPEARANCE_DEFAULTS.theme,
      themeMode: settings().themeMode,
      themeModeOverridden: themeModePref.overridden,
      themeModeProvenance: themeModePref.provenance,
      themeModeResetValue: themeModePref.resetValue ?? UI_APPEARANCE_DEFAULTS.themeMode,
      accent: settings().accent,
      accentProvenance: accentPref.provenance,
      accentResetValue: accentPref.resetValue,
      fontUi: settings().fontUi,
      fontChat: settings().fontChat,
      fontUiProvenance: currentSyncedPref("fontUi").provenance,
      fontChatProvenance: currentSyncedPref("fontChat").provenance,
      setFontUi: (font: TypefaceId | undefined) => setFont("fontUi", font),
      setFontChat: (font: TypefaceId | undefined) => setFont("fontChat", font),
      systemLocale: i18n.getSystemLocale(),
      localeOverride: isSupportedLocale(localePref.value) ? localePref.value : undefined,
      localeOverridden: localePref.overridden,
      localeProvenance: localePref.provenance,
      localeResetValue: isSupportedLocale(localePref.resetValue)
        ? localePref.resetValue
        : undefined,
      onLocaleChange: (locale: Locale | undefined) => {
        if (locale === undefined) {
          resetSyncedPref("locale");
          return;
        }
        patchSettings({ locale });
        void i18n.setLocale(locale);
        invalidate();
      },
      themeCatalog: pageId === "appearance" ? context.theme.catalog : undefined,
      onRetryThemeCatalog: () => context.theme.retryCatalog?.(),
      setTheme: (theme: ThemeName) => {
        const preference = currentSyncedPref("theme");
        if (preference.overridden && theme === preference.resetValue) {
          resetSyncedPref("theme");
        } else {
          applySettings({}, theme);
        }
      },
      setThemeMode: (mode: ThemeMode) => {
        const preference = currentSyncedPref("themeMode");
        if (preference.overridden && mode === preference.resetValue) {
          resetSyncedPref("themeMode");
        } else {
          context.theme.setMode(mode);
        }
      },
      setAccent: (accent: string | undefined) =>
        accent === undefined ? resetSyncedPref("accent") : applySettings({ accent }),
      hasCustomTheme: Boolean(settings().customTheme),
      customThemeLabel: settings().customTheme?.label ?? null,
      customThemeSourceUrl: settings().customTheme?.sourceUrl ?? null,
      customThemeImportUrl: customThemeImportOwner.snapshot.url,
      customThemeImportCompletion: customThemeImportOwner.completedImport,
      customThemeImportMessage: customThemeImportOwner.snapshot.message,
      customThemeImportExpanded: customThemeImportOwner.snapshot.expanded,
      onCustomThemeImportUrlChange: (next: string) => customThemeImportOwner.setUrl(next),
      onImportCustomTheme: () =>
        customThemeImportOwner.import({
          config: context.runtimeConfig.state,
          hasCustomTheme: Boolean(settings().customTheme),
          readTheme: () => settings().theme,
          load: importCustomThemeFromUrl,
          apply: (customTheme, activate) =>
            applySettings({ customTheme }, activate ? "custom" : settings().theme),
          messages: {
            blocked: (reason) =>
              t(reason === "loading" ? "common.loading" : "common.unsavedChanges"),
            imported: (label) => t("configPage.themeImported", { name: label }),
          },
        }),
      onClearCustomTheme: () => {
        customThemeImportOwner.clear({
          apply: () =>
            applySettings(
              { customTheme: undefined },
              settings().theme === "custom" ? "claw" : settings().theme,
            ),
          message: t("configPage.themeRemoved"),
        });
      },
      onOpenCustomThemeImport: () => customThemeImportOwner.open(),
      tabIcon: settings().tabIcon,
      lobsterdexEnabled: context.theme.branding.lobsterdex,
      tabIconAgentAvatar: agent ? resolveAgentAvatarUrl(agent, identities.read().get(id)) : null,
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
        applySettings({ tabIcon: preference });
      },
      textScale: settings().textScale ?? UI_APPEARANCE_DEFAULTS.textScale,
      textScaleOverridden: settings().textScale !== undefined,
      setTextScale: (value: number) =>
        applySettings({
          textScale:
            value === UI_APPEARANCE_DEFAULTS.textScale ? undefined : normalizeTextScale(value),
        }),
      sidebarLiveActivity:
        settings().sidebarLiveActivity ?? UI_APPEARANCE_DEFAULTS.sidebarLiveActivity,
      hiddenSessionCatalogIds,
      hiddenSessionCatalogLabels: { read: sessionCatalogLabels, scope: labelsRead().value },
      setSessionCatalogHidden: setStoredSessionCatalogHidden,
      terminalFontFamily: settings().terminalFontFamily,
      setTerminalFontFamily: (value: string | undefined) =>
        applySettings({ terminalFontFamily: value }),
      chatMessageMaxWidth: settings().chatMessageMaxWidth,
      chatShowTaskProgress:
        settings().chatShowTaskProgress ?? UI_APPEARANCE_DEFAULTS.chatShowTaskProgress,
      openLinksExternally: settings().openLinksExternally === true,
      openLinksInControlUiBrowser: settings().openLinksInControlUiBrowser === true,
      chatCollapseTaskProgress: settings().chatCollapseTaskProgress === true,
      showAdvancedSettings: settings().showAdvancedSettings === true,
      forceShowAdvanced: pageId === "advanced",
      forceAdvancedSection: routeData?.advanced
        ? (routeData.section ?? defaultConfigSelection(pageId).activeSection)
        : null,
      sessionObserverEnabled: controlUiConfig?.sessionObserver !== false,
      sessionObserverUtilityModel: modelSettingPrimary(utilityModel),
      sessionObserverResolvedModel: systemInfo?.defaultAgentUtilityModel,
      sessionObserverModels: observerModels.models,
      sessionObserverModelsScope: observerModels.scope,
      sessionObserverModelsUnavailable: observerModels.unavailable,
      sessionObserverDisabled: mutationBusy(),
      setSessionObserverEnabled: (enabled: boolean) =>
        runtimeConfig
          .patch({
            raw: buildSessionObserverTogglePatch(enabled),
            note: t("configView.sessionObserver.toggleNote"),
          })
          .then(observerResult),
      setSessionObserverUtilityModel: (modelSelection: SessionObserverModelSelection) => {
        const retired = commandLifetime.promise;
        return runtimeConfig
          .patch({
            raw: buildSessionObserverUtilityModelPatch(modelSelection, utilityModel),
            note: t("configView.sessionObserver.modelNote"),
            replacePaths: ["agents.defaults.utilityModel.fallbacks"],
          })
          .then(async (saved) => {
            observerResult(saved);
            if (saved && retired === commandLifetime.promise) {
              await refreshSystemInfo();
            }
            return saved;
          });
      },
      lobsterPetVisits: settings().lobsterPetVisits ?? UI_APPEARANCE_DEFAULTS.lobsterPetVisits,
      sessionDeleteConfirm:
        settings().sessionDeleteConfirm ?? UI_APPEARANCE_DEFAULTS.sessionDeleteConfirm,
      lobsterPetSounds: settings().lobsterPetSounds ?? UI_APPEARANCE_DEFAULTS.lobsterPetSounds,
      lobsterdexHref: pathForRoute("lobsterdex", context.basePath),
      onOpenLobsterdex: () => context.navigate("lobsterdex"),
      chatSendShortcut: normalizeChatSendShortcut(settings().chatSendShortcut),
      chatSendShortcutOverridden: chatSendShortcutPref.overridden,
      chatSendShortcutProvenance: chatSendShortcutPref.provenance,
      chatSendShortcutResetValue:
        chatSendShortcutPref.resetValue ?? UI_APPEARANCE_DEFAULTS.chatSendShortcut,
      chatFollowUpMode: settings().chatFollowUpMode,
      chatFollowUpModeOverridden: chatFollowUpModePref.overridden,
      chatFollowUpModeProvenance: chatFollowUpModePref.provenance,
      serverQueueMode: configState.configSnapshot
        ? resolveControlUiServerQueueMode(configState.configSnapshot.runtimeConfig, {
            configNeedsApply: configState.configNeedsApply,
          })
        : undefined,
      resetChatFollowUpMode: () => resetSyncedPref("chatFollowUpMode"),
      catalogOpenTarget: normalizeCatalogOpenTarget(settings().catalogOpenTarget),
      pluginsHref: pathForRoute("plugin-settings", context.basePath),
      sessionSourcePlugins: { read: sessionSourcePlugins, scope: pluginsRead().value },
      microphone: {
        ...mediaDevices.microphone,
        selectedDeviceId: settings().realtimeTalkInputDeviceId ?? "",
      },
      composerHoldToRecord: settings().composerHoldToRecord !== false,
      onMicrophoneRefresh: () => void mediaDeviceOwner.refresh("microphone", true),
      onMicrophoneSelect: (deviceId: string) =>
        applySettings({ realtimeTalkInputDeviceId: deviceId.trim() || undefined }),
      camera: {
        ...mediaDevices.camera,
        selectedDeviceId: settings().realtimeTalkVideoDeviceId ?? "",
      },
      onCameraRefresh: () => void mediaDeviceOwner.refresh("camera", true),
      onCameraSelect: mediaDeviceOwner.selectCamera,
      gatewayUrl: context.gateway.connection.gatewayUrl,
      assistantName: applicationConfig.read().assistantIdentity.name,
      configPath: configState.configSnapshot?.path ?? null,
      navRootLabel: pageId === "advanced" ? undefined : titleForRoute(pageId),
      showSectionDocs: pageId !== "communications",
      showRootTab: !includeSections?.length,
      includeSections,
      // Advanced shows everything without a curated home elsewhere.
      excludeSections: pageId === "advanced" ? ADVANCED_EXCLUDED_SECTIONS : undefined,
      includeVirtualSections: pageId === "appearance" || pageId === "notifications",
      settingsLayout: pageId === "advanced" ? ("accordion" as const) : undefined,
      nativeNotifications: notifications?.read(),
      onNativeNotificationsRequestPermission: () =>
        context.nativeNotifications?.requestPermission(),
      onNativeNotificationsSendTest: () => context.nativeNotifications?.sendTest(),
      // Downstream equality checks need a new value for the mutable owner snapshot.
      webPush: { ...webPush.read() },
      onWebPushSubscribe: () => context.webPush.run({ kind: "enable" }),
      onWebPushUnsubscribe: () => context.webPush.run({ kind: "disable" }),
      onWebPushTest: () => context.webPush.run({ kind: "test" }),
      onWebPushSetUserPreferences: (preferences: Push.WebPushNotificationPreferences) =>
        context.webPush.run({ kind: "set", scope: "user", preferences }),
      onWebPushSetDevicePreferences: (preferences: Push.WebPushDevicePreferences) =>
        context.webPush.run({ kind: "set", scope: "device", preferences }),
    };
  }
  const refresh = () => {
    synchronize();
    invalidate();
  };
  // Route changes synchronize the config owners, lazy requests, and polling.
  createEffect(route, (next) => updateRoute(next.pageId, next.routeData));
  onSettled(() => {
    // These notifications admit requests and retire connection-scoped work synchronously.
    const subscriptions = [
      context.gateway,
      context.runtimeConfig,
      context.settingsAgentSelection,
      context.agentSelection,
      context.overlays,
    ].map((source) => source.subscribe(refresh));
    // Server selection intent can change while the stored preferences stay equal.
    subscriptions.push(context.theme.subscribe(refresh));
    let location = context.router.getState().location;
    subscriptions.push(
      context.router.subscribe(() => {
        const next = context.router.getState().location;
        if (!sameRouteLocation(next, location)) {
          location = next;
          retireCommands();
        }
      }),
    );
    connected = true;
    hiddenSessionCatalogsChanged();
    subscriptions.push(
      listen(window, SIDEBAR_HIDDEN_SESSION_CATALOGS_CHANGED_EVENT, hiddenSessionCatalogsChanged),
      listen(document, "visibilitychange", synchronize),
      listen(window, "focus", synchronize),
    );
    subscriptions.push(mediaDeviceOwner.observe(context.router));
    synchronize();
    return () => {
      commandLifetime.resolve();
      subscriptions.forEach((stop) => stop());
      connected = false;
      customThemeImportOwner.retireImport();
      mediaDeviceOwner.retire();
      clearInterval(poll);
      clearInterval(countdown);
      abortRequests();
      if (scrollFrame !== null) {
        cancelAnimationFrame(scrollFrame);
        scrollFrame = null;
      }
      runtimeConfigSource = null;
      resetConfigViewState();
    };
  });
  return {
    admittedRoute,
    application() {
      revision();
      return context;
    },
    configProps: createMemo(configProps),
    configObject: createMemo(readConfigObject),
    nowMs,
    mutationDisabled,
    updateBusy,
    updates,
  };
}
