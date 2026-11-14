import "./boot-capabilities.ts";
import { gatewayCredentialScope } from "@openclaw/gateway-client/browser";
import type { RouteLocation } from "@openclaw/uirouter";
import { ConnectErrorDetailCodes } from "../../../packages/gateway-protocol/src/connect-error-details.js";
import type { GatewayBrowserClient } from "../api/gateway.ts";
import { isSettingsTakeover } from "../app-navigation.ts";
import { sameRouteLocation } from "../app-route-paths.ts";
import {
  createApplicationRouter,
  locationForRoute,
  routeIdFromPath,
  startApplicationRouter,
  warmApplicationRouteModule,
  type RouteId,
} from "../app-routes.ts";
import { sessionRefFromPath } from "../app-session-route-paths.ts";
import { i18n, isSupportedLocale } from "../i18n/index.ts";
import { createAgentIdentityCapability } from "../lib/agents/identity.ts";
import { createAgentCapability } from "../lib/agents/index.ts";
import type { ChannelCapability, createChannelCapability } from "../lib/channels/index.ts";
import { createRuntimeConfigCapability } from "../lib/config/runtime-config-capability.ts";
import { createSessionCapability } from "../lib/sessions/index.ts";
import { openPreferredApplicationSession } from "../lib/sessions/route-navigation.ts";
import { parseAgentSessionKey } from "../lib/sessions/session-key.ts";
import { sendSessionObserverVisibility } from "../pages/chat/chat-observer.ts";
import {
  isDefaultChatLanding,
  startModelSetupFirstRunRedirectAfterLocation,
} from "../pages/model-setup/first-run.ts";
import { ControlUiPluginRuntime } from "../plugins/control-ui-runtime.ts";
import { createAgentSelectionCapability } from "./agent-selection.ts";
import { selectShellRouteState } from "./app-host-route-state.ts";
import { AssistantDock } from "./assistant-dock.ts";
import { prepareApplicationStartup } from "./bootstrap-connection.ts";
import {
  applicationRouteLocation,
  createInitialApplicationLocationResolver,
  isResolvedDefaultLanding,
  normalizeInitialApplicationLocation,
  resolveBootstrapModelCatalogTarget,
  resolveInitialApplicationLocation,
  subscribeForegroundChatBootstrap,
} from "./bootstrap-location.ts";
import { createApplicationNavigationPreferences } from "./bootstrap-navigation-preferences.ts";
import { createApplicationTheme } from "./bootstrap-theme.ts";
import {
  subscribeBootRecordPersistence,
  subscribeWarmBootConnection,
} from "./bootstrap-warm-boot.ts";
import { startBrowserAuthRecovery } from "./browser-auth-recovery.tsx";
import { createChatAttachmentHandoff } from "./chat-attachment-handoff.ts";
import { createChatSubmissions } from "./chat-submissions.ts";
import { createApplicationConfigCapability } from "./config.ts";
import { createConnectionBootstrapCoordinator } from "./connection-bootstrap.ts";
import type { MountedApplicationShell } from "./context-types.ts";
import type { ApplicationNavigationOptions, ApplicationContext } from "./context.ts";
import { createScopeUpgradeCapability } from "./device-scope-upgrade.ts";
import type { EarlyApplicationGateway } from "./early-gateway.ts";
import { startGatewayPageActivation } from "./gateway-page-activation.ts";
import { startGatewayPresenceActivity } from "./gateway-presence-activity.ts";
import { createApplicationGateway } from "./gateway-store.ts";
import { createGuestWelcome } from "./guest-welcome-handle.ts";
import { startLinkReaderRouting } from "./link-reader-routing.ts";
import { startMcpAppRouting } from "./mcp-app-link-routing.ts";
import { createNativeChatDrafts } from "./native-bridge.ts";
import type { NativeConversationBridge } from "./native-conversation-types.ts";
import { prepareNativeUpdateFallback, startNativeLinkRouting } from "./native-link-routing.ts";
import { createApplicationOverlays } from "./overlays.ts";
import { isBrowserPanelAvailable } from "./panel-availability.ts";
import {
  rememberProfileAppearanceIdentity,
  seedProfileAppearancePrefs,
} from "./server-prefs-profile.ts";
import { applyServerUiPrefs } from "./server-prefs-reconcile.ts";
import { extractProfileUiPrefs, PROFILE_UI_PREFERENCE_KEYS } from "./server-prefs-state.ts";
import { createApplicationPlacementStartup } from "./session-placement-startup.ts";
import {
  loadGatewaySessionSelection,
  loadSettings,
  patchSettings,
  resolveGatewayCredentialsForUrlEdit,
} from "./settings.ts";
import { createSidebarAttentionStore } from "./sidebar-attention-store.ts";
import { createStartupLifecycle, type StartupStep } from "./startup-lifecycle.ts";
import { bindUpdateConfigWriteInterlock } from "./update-config-interlock.ts";
import { openUpdateFailureTriage } from "./update-triage.ts";
import { seedUserPreferences } from "./user-prefs-cache.ts";
import { createWebPushCapability } from "./web-push.ts";

export type { ApplicationRuntime } from "./application-runtime.ts";

type PendingRouterStartNavigation = {
  location: RouteLocation;
  mode: "push" | "replace";
};

export function bootstrapApplication(
  initial = prepareApplicationStartup(),
  earlyGateway?: EarlyApplicationGateway,
): import("./application-runtime.ts").ApplicationRuntime {
  const {
    history,
    basePath,
    resourceBasePath,
    documentMode,
    startup,
    settings,
    applicationLocation,
    focusLocation,
    startsApplicationRouter,
    ownsWarmBoot,
    hasPendingGateway,
  } = initial;
  const firstRunDefaultLanding =
    startsApplicationRouter && isDefaultChatLanding(applicationLocation, basePath, routeIdFromPath);
  const gateway = createApplicationGateway(
    settings,
    startup.password ?? "",
    hasPendingGateway ? "" : (startup.pendingBootstrapToken ?? ""),
    {
      earlyGateway,
      persistDefaultConnectionSettings: documentMode === null,
      ownsWarmBoot,
      resourceBasePath,
      getModelCatalogTarget: (gatewayUrl) =>
        resolveBootstrapModelCatalogTarget(history.location(), basePath, gatewayUrl),
      ...(!hasPendingGateway && startup.pendingBootstrapProfile
        ? { bootstrapProfile: startup.pendingBootstrapProfile }
        : {}),
      ...(startup.nativeClient ? { clientOptions: startup.nativeClient } : {}),
    },
  );
  const getGatewayAuth = () => ({
    hello: gateway.snapshot.hello,
    settings: { token: gateway.connection.token },
    password: gateway.connection.password,
  });
  const documentGatewayScope = gatewayCredentialScope(
    `${window.location.protocol === "https:" ? "wss:" : "ws:"}//${window.location.host}${resourceBasePath}`,
  );
  const isDocumentGateway = () =>
    gatewayCredentialScope(gateway.connection.gatewayUrl) === documentGatewayScope;
  const stopBrowserAuthRecovery = startBrowserAuthRecovery(resourceBasePath, () =>
    isDocumentGateway() ? getGatewayAuth() : {},
  );
  const connectionBootstrap = createConnectionBootstrapCoordinator();
  const chatSubmissions = createChatSubmissions();
  const router = createApplicationRouter();
  const bootRecord = initial.bootRecord;
  let warmBoot = bootRecord !== null;
  const warmBootConnectionRevision = gateway.connectionRevision;
  initial.prewarmChatSnapshot();
  if (startsApplicationRouter && !firstRunDefaultLanding) {
    // Explicit routes download alongside snapshot reads, before shell construction.
    warmApplicationRouteModule(router, applicationLocation, basePath);
  }
  const stopWarmBootConnection = ownsWarmBoot
    ? subscribeWarmBootConnection(gateway, bootRecord, () => {
        warmBoot = false;
      })
    : undefined;
  const agents = createAgentCapability(gateway);
  const startupLifecycle = createStartupLifecycle();
  const parsedInitialSession = parseAgentSessionKey(settings.sessionKey);
  const deferInitialLocationUntilGateway = firstRunDefaultLanding && !parsedInitialSession;
  let resolveInitialFirstRunDecision: (() => void) | null = null;
  const initialFirstRunDecision = deferInitialLocationUntilGateway
    ? new Promise<void>((resolve) => {
        resolveInitialFirstRunDecision = resolve;
      })
    : null;
  const resolveInitialLocation = createInitialApplicationLocationResolver({
    fallback: applicationLocation,
    signal: startupLifecycle.signal,
    resolve: () =>
      documentMode || focusLocation
        ? Promise.resolve(applicationLocation)
        : resolveInitialApplicationLocation({
            location: applicationLocation,
            basePath,
            sessionKey: settings.sessionKey,
            gateway,
            agentsList: () => agents.state.agentsList,
            ensureAgentsList: () => agents.ensureList(),
            selectedAgentId: settings.selectedAgentId,
            signal: startupLifecycle.signal,
          }),
  });
  const initialRoutingLocation =
    firstRunDefaultLanding && parsedInitialSession
      ? normalizeInitialApplicationLocation(
          applicationLocation,
          basePath,
          settings.sessionKey,
          parsedInitialSession.agentId,
        )
      : applicationLocation;
  const initialRoutingLocationReady = firstRunDefaultLanding
    ? Promise.resolve(initialRoutingLocation)
    : resolveInitialLocation();
  const config = createApplicationConfigCapability({
    resourceBasePath,
    getAuth: getGatewayAuth,
  });
  const documentPreferences = isDocumentGateway() ? config.preferences : undefined;
  if (documentPreferences) {
    const scope = gateway.connection.gatewayUrl;
    const { profileId, entries } = documentPreferences;
    rememberProfileAppearanceIdentity(scope, profileId ?? null);
    if (profileId && entries) {
      seedProfileAppearancePrefs(scope, profileId, extractProfileUiPrefs(entries));
    }
    applyServerUiPrefs(documentPreferences.config ?? {}, {
      scope,
      profileId,
      navigationConfirmed: entries !== undefined,
      onApplied: (patch) => Object.assign(settings, patch),
    });
    if (isSupportedLocale(settings.locale)) {
      void i18n.setLocale(settings.locale);
    }
  }
  let firstPreferencesConnection = true;
  // Seed profile preferences before later connected observers start their reads.
  const stopBootstrapPreferences = gateway.subscribe((snapshot) => {
    if (snapshot.phase !== "connected" || !snapshot.client || !firstPreferencesConnection) {
      return;
    }
    firstPreferencesConnection = false;
    const { profileId, entries } = documentPreferences ?? {};
    if (isDocumentGateway() && profileId === snapshot.selfUser?.id && profileId && entries) {
      seedUserPreferences(snapshot.client, profileId, PROFILE_UI_PREFERENCE_KEYS, entries);
    }
  });
  const theme = createApplicationTheme(settings, gateway);
  const agentSelection = createAgentSelectionCapability(
    gateway,
    agents,
    startsApplicationRouter
      ? {
          load: (gatewayUrl) => loadGatewaySessionSelection(gatewayUrl).selectedAgentId ?? null,
          save: (gatewayUrl, selectedAgentId) => {
            if (gateway.connection.gatewayUrl === gatewayUrl) {
              patchSettings({ selectedAgentId: selectedAgentId ?? undefined });
            }
          },
        }
      : undefined,
    {
      get settings() {
        return theme.settings;
      },
      subscribe: theme.subscribe,
      patch: patchSettings,
    },
  );
  const settingsAgentSelection = createAgentSelectionCapability(
    gateway,
    agents,
    undefined,
    undefined,
    { requireConfiguredAgent: true },
  );
  let channels: ChannelCapability | undefined;
  const acquireChannels = (create: typeof createChannelCapability): ChannelCapability => {
    // A lazy route can finish importing after application teardown.
    startupLifecycle.signal.throwIfAborted();
    if (!channels) {
      const owner = create(gateway);
      channels = owner;
      startupLifecycle.addDisposer(() => owner.dispose());
    }
    return channels;
  };
  const stopForegroundBootstrap = subscribeForegroundChatBootstrap({
    router,
    chatSubmissions,
    gateway,
    agents,
    agentSelection,
    connectionBootstrap,
    initialChatRoute:
      startsApplicationRouter &&
      sessionRefFromPath(applicationLocation.pathname, basePath) !== null,
  });
  const scopeUpgrade = createScopeUpgradeCapability(gateway);
  const sessions = createSessionCapability(gateway, agentSelection, {
    bootRecord,
    connectionBootstrap,
  });
  const bootRecordPersistence = ownsWarmBoot
    ? subscribeBootRecordPersistence({ gateway, agents, sessions }, bootRecord)
    : undefined;
  const runtimeConfig = createRuntimeConfigCapability(gateway, {
    current: () => {
      const preferences = config.preferences;
      return isDocumentGateway() &&
        (gateway.snapshot.phase !== "connected" ||
          preferences?.profileId === gateway.snapshot.selfUser?.id)
        ? (preferences?.config ?? null)
        : null;
    },
    subscribe: config.subscribe,
  });
  const overlays = createApplicationOverlays(gateway, {
    connectionBootstrap,
    getActiveSessionKey: () => gateway.snapshot.sessionKey || undefined,
    drainConfigWrites: () => runtimeConfig.waitForPendingWrites(),
    onUpdateFailure: (failure, admission) =>
      void openUpdateFailureTriage(context, failure, admission),
  });
  const sidebarAttention = createSidebarAttentionStore({
    gateway,
    agentSelection,
    agents,
    overlays,
    scopeUpgrade,
    connectionBootstrap,
  });
  const stopConfigWriteSuspension = bindUpdateConfigWriteInterlock(overlays, runtimeConfig);
  const navigation = createApplicationNavigationPreferences(theme);
  const nativeChatDrafts = createNativeChatDrafts();
  let shell: MountedApplicationShell | undefined;
  const shouldOpenExternally = () => theme.settings.openLinksExternally === true;
  const mcpAppRouting = startMcpAppRouting({
    navigate: (route, options) => context.navigate(route, options),
  });
  const linkReaderRouting = startLinkReaderRouting(() => gateway.snapshot, {
    shouldOpenExternally,
  });
  const nativeLinkRouting = startNativeLinkRouting({
    shouldOpenExternally,
    signal: startupLifecycle.signal,
    canPresentBrowserPanel: () => {
      return (
        shell?.element.isConnected === true &&
        !isSettingsTakeover(selectShellRouteState(router.getState()).routeId)
      );
    },
    prepareNativeUpdateFallback: () => prepareNativeUpdateFallback(overlays),
    shouldOpenInControlUiBrowser: () =>
      loadSettings().openLinksInControlUiBrowser === true &&
      isBrowserPanelAvailable(gateway.snapshot) &&
      shell?.element.isConnected === true,
  });
  let nativeDeviceSettings: ApplicationContext["nativeDeviceSettings"] = null;
  let nativeNotifications: ApplicationContext["nativeNotifications"] = null;
  const webPush = createWebPushCapability(gateway, { connectionBootstrap });
  const placementStartup = createApplicationPlacementStartup({
    gateway,
    sessions,
    chatSubmissions,
  });
  const chatAttachmentHandoff = createChatAttachmentHandoff(gateway);
  let routerStarted = false;
  // Pre-start navigations are invisible to history; retain the latest request so
  // router.start() cannot resolve the stale browser URL over the user's route.
  let pendingRouterStartNavigation: PendingRouterStartNavigation | null = null;
  let pendingGatewayConnection =
    startup.pendingGatewayUrl !== null
      ? {
          gatewayUrl: startup.pendingGatewayUrl,
          token: startup.pendingGatewayToken,
          bootstrapToken: startup.pendingBootstrapToken ?? "",
          ...(startup.pendingBootstrapProfile
            ? { bootstrapProfile: startup.pendingBootstrapProfile }
            : {}),
        }
      : null;
  let lastPostConnectClient: GatewayBrowserClient | null = null;
  let lastRecoveryClient: GatewayBrowserClient | null = null;
  let browserBootstrapAttempted = Boolean(
    hasPendingGateway || startup.nativeClient || startup.pendingBootstrapToken,
  );
  const initialConnectionRevision = gateway.connectionRevision;
  let firstConfigConnection = true;
  // Start shared reads and connection recovery independently of mounted views.
  const stopPostConnect = gateway.subscribe((snapshot) => {
    if (snapshot.phase === "connected") {
      browserBootstrapAttempted = true;
    }
    if (
      !browserBootstrapAttempted &&
      snapshot.phase === "stopped" &&
      (snapshot.lastErrorCode === ConnectErrorDetailCodes.AUTH_TOKEN_MISSING ||
        snapshot.lastErrorCode === ConnectErrorDetailCodes.AUTH_PASSWORD_MISSING)
    ) {
      browserBootstrapAttempted = true;
      // Recovery stays off the startup path; loading it cannot revive a replaced connection.
      startupLifecycle.trackDisposer(
        import("./browser-bootstrap.runtime.ts").then(({ startBrowserBootstrapRecovery }) =>
          gateway.snapshot.client === snapshot.client &&
          gateway.connectionRevision === initialConnectionRevision &&
          !startupLifecycle.signal.aborted
            ? startBrowserBootstrapRecovery(gateway, basePath)
            : () => {},
        ),
        () => {},
      );
    }
    if (snapshot.phase !== "connected" || !snapshot.client) {
      lastPostConnectClient = null;
      lastRecoveryClient = null;
      return;
    }
    const client = snapshot.client;
    if (lastPostConnectClient !== client) {
      lastPostConnectClient = client;
      const ifNeeded = firstConfigConnection;
      firstConfigConnection = false;
      void config.refresh({ ifNeeded, signal: startupLifecycle.signal });
      void connectionBootstrap.run("session-observer", () =>
        sendSessionObserverVisibility(gateway.snapshot),
      );
    }
    // Recovery scope resolves after hello, so dedupe its later publication independently.
    if (!client.recoveryScopeReady || lastRecoveryClient === client) {
      return;
    }
    lastRecoveryClient = client;
    placementStartup.resumeRecovery();
  });
  const confirmPendingGatewayConnection = () => {
    const pending = pendingGatewayConnection;
    if (!pending) {
      return;
    }
    pendingGatewayConnection = null;
    const credentials = resolveGatewayCredentialsForUrlEdit(
      gateway.connection.gatewayUrl,
      pending.gatewayUrl,
      gateway.connection,
    );
    gateway.connect({
      gatewayUrl: pending.gatewayUrl,
      token: pending.bootstrapToken ? "" : (pending.token ?? credentials.token),
      password: credentials.password,
      bootstrapToken: pending.bootstrapToken,
      bootstrapProfile: pending.bootstrapProfile,
    });
  };
  const cancelPendingGatewayConnection = () => {
    pendingGatewayConnection = null;
  };
  const navigateWithMode = (
    routeId: RouteId,
    options: ApplicationNavigationOptions | undefined,
    requested: "push" | "replace",
  ) => {
    const location = applicationRouteLocation(router, basePath, routeId, options);
    // Preserve pre-start navigation exactly as the fire-and-forget entry point does.
    if (!routerStarted) {
      pendingRouterStartNavigation = { location, mode: requested };
    }
    // Re-clicking the active nav item must not stack identical history
    // entries: Back would appear dead until every duplicate is popped.
    const samePage = routerStarted && sameRouteLocation(history.location(), location);
    const historyMode = samePage ? "replace" : requested;
    const navigationPromise = router.navigate(routeId, context, { history: historyMode }, location);
    void navigationPromise.catch((error: unknown) => {
      console.error("[openclaw] route navigation failed", error);
    });
    return navigationPromise;
  };
  const navigateAndWait = (routeId: RouteId, options?: ApplicationNavigationOptions) =>
    navigateWithMode(routeId, options, "push");
  const plugins = new ControlUiPluginRuntime(() => context);
  const guestWelcome = startsApplicationRouter
    ? createGuestWelcome({
        gateway,
        // Home is only the default landing the app resolved; explicit links are never replaced.
        isHomeLanding: async () =>
          firstRunDefaultLanding &&
          isResolvedDefaultLanding(resolveInitialLocation(), history, basePath),
        openSession: (sessionKey, agentId) =>
          openPreferredApplicationSession(context, sessionKey, agentId),
      })
    : undefined;
  let nativeConversation: NativeConversationBridge | null = null;
  const context: ApplicationContext = {
    basePath,
    resourceBasePath,
    lifecycleAbortSignal: startupLifecycle.signal,
    router,
    get routeOutlet() {
      return shell?.routeOutlet;
    },
    gateway,
    connectionBootstrap,
    agents,
    get offlineSessionDefaults() {
      return warmBoot && gateway.connectionRevision === warmBootConnectionRevision
        ? (bootRecordPersistence?.readSessionDefaults() ?? null)
        : null;
    },
    agentIdentity: createAgentIdentityCapability(gateway, bootRecordPersistence?.readAgentIdentity),
    agentSelection,
    settingsAgentSelection,
    acquireChannels,
    config,
    scopeUpgrade,
    sidebarAttention,
    runtimeConfig,
    sessions,
    placementStartup,
    plugins,
    guestWelcome,
    assistantDock: new AssistantDock(),
    overlays,
    navigation,
    theme,
    nativeChatDrafts,
    get nativeConversation() {
      return nativeConversation;
    },
    get nativeDeviceSettings() {
      return nativeDeviceSettings;
    },
    get nativeNotifications() {
      return nativeNotifications;
    },
    webPush,
    chatSubmissions,
    chatAttachmentHandoff,
    navigate: (routeId, options) => {
      void navigateAndWait(routeId, options);
    },
    navigateAndWait,
    replace: (routeId, options) => {
      void navigateWithMode(routeId, options, "replace");
    },
    revalidate: (routeId) => router.revalidate(context, routeId),
    preload: (routeId) => router.preloadLocation(locationForRoute(routeId, basePath), context),
  };
  return {
    context,
    router,
    documentMode,
    get readOnlyConfig() {
      return isDocumentGateway() ? config.current.readOnlyConfig : undefined;
    },
    get warmBoot() {
      return warmBoot && gateway.connectionRevision === warmBootConnectionRevision;
    },
    focusLocation,
    get pendingGatewayConnection() {
      return pendingGatewayConnection;
    },
    confirmPendingGatewayConnection,
    cancelPendingGatewayConnection,
    setShell: (owner) => {
      shell = owner;
    },
    start: () => {
      if (!startupLifecycle.signal.aborted) {
        void config.refresh({ ifNeeded: true, signal: startupLifecycle.signal });
      }
      const stopRouter = () => router.stop();
      const earlyNewConnection = earlyGateway !== undefined && !earlyGateway.credentials;
      if (startsApplicationRouter) {
        startupLifecycle.addDisposer(stopRouter);
      }
      const steps: StartupStep[] = [
        () => {
          gateway.start();
          return () => {
            if (earlyNewConnection && !gateway.snapshot.client) {
              earlyGateway.transport.client.stop();
            }
            gateway.stop();
          };
        },
        () => startGatewayPageActivation(gateway, document, window),
        () => startGatewayPresenceActivity(gateway, document),
        () => guestWelcome?.start(),
        () => {
          plugins.start();
          return () => plugins.dispose();
        },
      ];
      // Native bridge parsers and listeners stay out of browser startup.
      // SAFETY: WebKit supplies the optional handler map; the native initializer checks each callable.
      const nativeWindow = window as Window & { webkit?: { messageHandlers?: unknown } };
      if (nativeWindow.webkit?.messageHandlers) {
        steps.unshift(async () => {
          const { startNativeCapabilities } = await import("./native-startup.runtime.ts");
          return startNativeCapabilities(context, startupLifecycle, (capabilities) => {
            nativeConversation = capabilities.conversation;
            nativeDeviceSettings = capabilities.deviceSettings;
            nativeNotifications = capabilities.notifications;
          });
        });
      }
      // Resolve first-run setup before routing: the default Chat route owns the
      // workspace graph, which setup users would otherwise fetch and discard.
      steps.push(() =>
        startModelSetupFirstRunRedirectAfterLocation({
          context,
          enabled: firstRunDefaultLanding,
          history,
          initialLocationReady: initialRoutingLocationReady,
          ...(deferInitialLocationUntilGateway
            ? {
                redirect: () =>
                  history.replace({
                    ...locationForRoute("model-setup", basePath),
                    search: "?firstRun=1",
                  }),
                onInitialDecision: () => resolveInitialFirstRunDecision?.(),
              }
            : {}),
        }),
      );
      if (startsApplicationRouter) {
        if (initialFirstRunDecision) {
          steps.push(() => initialFirstRunDecision);
        }
        steps.push(async () => {
          const pendingNavigation = pendingRouterStartNavigation;
          pendingRouterStartNavigation = null;
          routerStarted = true;
          if (pendingNavigation) {
            history[pendingNavigation.mode](pendingNavigation.location);
          }
          await startApplicationRouter(router, history, basePath, context);
          return stopRouter;
        });
      }
      if (firstRunDefaultLanding) {
        steps.push(() => {
          // Post-connect validation may replace only the provisional landing;
          // navigation during startup remains authoritative.
          startupLifecycle.trackDisposer(
            startModelSetupFirstRunRedirectAfterLocation({
              context,
              enabled: false,
              history,
              initialLocationReady: resolveInitialLocation(),
              installLocation: async (location) => {
                const routeId = routeIdFromPath(location.pathname, basePath);
                if (routeId) {
                  await router.navigate(routeId, context, { history: "replace" }, location);
                } else {
                  history.replace(location);
                }
              },
              shouldInstallLocation: () =>
                parsedInitialSession
                  ? sameRouteLocation(history.location(), initialRoutingLocation)
                  : isDefaultChatLanding(history.location(), basePath, routeIdFromPath),
            }),
            (error) => {
              console.error("[openclaw] initial session location failed", error);
            },
          );
        });
      }
      return startupLifecycle.run(steps);
    },
    stop: () => {
      stopBrowserAuthRecovery();
      startupLifecycle.stop();
      stopWarmBootConnection?.();
      bootRecordPersistence?.dispose();
      stopPostConnect();
      stopForegroundBootstrap();
      connectionBootstrap.reset();
      agents.dispose();
      agentSelection.dispose();
      settingsAgentSelection.dispose();
      scopeUpgrade.dispose();
      sidebarAttention.dispose();
      placementStartup.dispose();
      sessions.dispose();
      stopConfigWriteSuspension();
      stopBootstrapPreferences();
      runtimeConfig.dispose();
      overlays.dispose();
      theme.dispose();
      nativeChatDrafts.dispose();
      linkReaderRouting.dispose();
      mcpAppRouting.dispose();
      nativeLinkRouting.dispose();
      webPush.dispose();
      chatSubmissions.clear();
      chatAttachmentHandoff.dispose();
    },
  };
}
