import { createMemo, onSettled } from "solid-js";
import { sameRouteLocation } from "../app-route-paths.ts";
import type { ShellViewHost } from "../app/app-shell-view-state.ts";
import { currentConfigConnectionEpoch } from "../lib/config/config-state-model.ts";
import { listen } from "../lib/reactive/listener.ts";
import {
  SettingsSaveIndicator,
  type SettingsSaveIndicatorProps,
} from "./settings-save-indicator.tsx";
import type { SettingsSidebarFallbackProps } from "./settings-sidebar-lazy.tsx";
import {
  renderSettingsSidebar as SettingsSidebar,
  type SettingsSidebarProps,
} from "./settings-sidebar.tsx";

/** Save feedback props, with commands retired when the route or connection moves on. */
function useSaveIndicatorProps(host: () => ShellViewHost) {
  let commandLifetime = Promise.withResolvers<void>();
  const retireCommands = () => {
    commandLifetime.resolve();
    commandLifetime = Promise.withResolvers<void>();
  };
  onSettled(() => {
    const context = host().context!;
    let location = context.router.getState().location;
    let epoch = currentConfigConnectionEpoch(context.runtimeConfig.state);
    // Owner notifications release actions before a held transition can park cleanup.
    const stopRoute = context.router.subscribe(() => {
      const next = context.router.getState().location;
      if (!sameRouteLocation(next, location)) {
        location = next;
        retireCommands();
      }
    });
    const stopConfig = context.runtimeConfig.subscribe(() => {
      const next = currentConfigConnectionEpoch(context.runtimeConfig.state);
      if (next !== epoch) {
        epoch = next;
        retireCommands();
      }
    });
    const stopLifecycle = context.lifecycleAbortSignal
      ? listen(context.lifecycleAbortSignal, "abort", retireCommands)
      : undefined;
    return () => {
      commandLifetime.resolve();
      stopRoute();
      stopConfig();
      stopLifecycle?.();
    };
  });
  return createMemo<SettingsSaveIndicatorProps>(() => {
    host().shellRevision();
    const context = host().context!;
    const runtimeConfig = context.runtimeConfig.state;
    const overlaySnapshot = context.overlays.snapshot;
    // The install outlives update.run; reconciliation owns the busy state.
    const updateBusy = overlaySnapshot.updateRunning || overlaySnapshot.updateReconciliationPending;
    return {
      status: runtimeConfig.configRecoveryError
        ? "recovery"
        : !runtimeConfig.connected && runtimeConfig.configAutoSaveStatus === "paused"
          ? // Nothing can save yet; the connection notice already says why. The draft stays.
            "idle"
          : runtimeConfig.configAutoSaveStatus,
      lastError: runtimeConfig.configRecoveryError ?? runtimeConfig.lastError,
      needsApply:
        runtimeConfig.connected &&
        runtimeConfig.configNeedsApply &&
        !runtimeConfig.configApplyPromptHeld,
      // A dirty draft whose autosave is blocked has no save coming, so it never reads as one.
      pending: runtimeConfig.connected && runtimeConfig.configAutoSaveScheduled,
      savedNotice: runtimeConfig.configSavedNotice,
      saving: runtimeConfig.configSaving,
      applying: runtimeConfig.configApplying,
      applyDisabled:
        context.runtimeConfig.canApply === false ||
        runtimeConfig.configLoading ||
        runtimeConfig.configSaving ||
        (runtimeConfig.configFormDirty && runtimeConfig.configFormMode === "raw") ||
        updateBusy,
      presentationRetired: () => {
        host().shellRevision();
        return commandLifetime.promise;
      },
      onRetry: () => context.runtimeConfig.retry(),
      onSave: () => context.runtimeConfig.save(),
      onReload: () => context.runtimeConfig.discardDraft(),
      onApply: () => context.runtimeConfig.apply(),
    };
  });
}

/** Floats over the page at every width, so a phone sees it with the drawer closed. */
export function ShellSettingsSaveStatus(props: { host: ShellViewHost }) {
  const indicator = useSaveIndicatorProps(() => props.host);
  return <SettingsSaveIndicator {...indicator()} />;
}

/** Prepare Settings-only state after its existing lazy renderer has loaded. */
export function ShellSettingsSidebar(props: {
  host: ShellViewHost;
  sidebarProps: SettingsSidebarFallbackProps;
}) {
  const saveIndicator = useSaveIndicatorProps(() => props.host);
  const sidebarProps = createMemo<SettingsSidebarProps>(() => {
    const host = props.host;
    host.shellRevision();
    const context = host.context!;
    const gatewaySnapshot = context.gateway.snapshot;
    const config = context.config.current;
    const runtimeConfig = context.runtimeConfig.state;
    const callbacks = host.viewCallbacks;
    return {
      ...props.sidebarProps,
      basePath: context.basePath,
      agents: context.agents.state.agentsList?.agents ?? [],
      agentIdentity: context.agentIdentity,
      settingsAgentSelection: context.settingsAgentSelection,
      activePathname: host.routeState.location?.pathname ?? "",
      activeSearch: host.routeState.location?.search ?? "",
      activeHash: host.routeState.location?.hash ?? "",
      lastError: gatewaySnapshot.lastError,
      gatewayVersion: config.serverVersion ?? gatewaySnapshot.hello?.server?.version ?? "",
      searchQuery: host.settingsSearchQuery,
      searchParams: {
        query: host.settingsSearchQuery,
        schema: runtimeConfig.configSchema,
        value: runtimeConfig.configForm ?? runtimeConfig.configSnapshot?.config ?? null,
        uiHints: runtimeConfig.configUiHints,
        identityAvailable: Boolean(gatewaySnapshot.selfUser),
        multipleProfiles:
          gatewaySnapshot.hello?.policy?.hasMultipleSessionSharingIdentities === true,
        basePath: context.basePath,
        canAdmin: props.sidebarProps.canAdmin,
        nativeDeviceSettings: context.nativeDeviceSettings,
      },
      onRetryConnect: callbacks.retryGateway,
      onNavigate: host.shellNavigation.navigate,
      onSearchQueryChange: (nextQuery: string) =>
        void host.handleSettingsSearchQueryChange(nextQuery),
      saveIndicator: saveIndicator(),
    };
  });
  return <SettingsSidebar {...sidebarProps()} />;
}
