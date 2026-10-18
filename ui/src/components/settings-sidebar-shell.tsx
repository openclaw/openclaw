import { createMemo } from "solid-js";
import type { ShellViewHost } from "../app/app-shell-view-state.ts";
import type { SettingsSidebarFallbackProps } from "./settings-sidebar-lazy.tsx";
import {
  renderSettingsSidebar as SettingsSidebar,
  type SettingsSidebarProps,
} from "./settings-sidebar.tsx";

/** Prepare Settings-only state after its existing lazy renderer has loaded. */
export function ShellSettingsSidebar(props: {
  host: ShellViewHost;
  sidebarProps: SettingsSidebarFallbackProps;
}) {
  const sidebarProps = createMemo<SettingsSidebarProps>(() => {
    const host = props.host;
    host.shellRevision();
    const context = host.context!;
    const gatewaySnapshot = context.gateway.snapshot;
    const config = context.config.current;
    const runtimeConfig = context.runtimeConfig.state;
    const overlaySnapshot = context.overlays.snapshot;
    const callbacks = host.viewCallbacks;
    // The install outlives update.run; reconciliation owns the busy state.
    const updateBusy = overlaySnapshot.updateRunning || overlaySnapshot.updateReconciliationPending;
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
      searchQuery: props.sidebarProps.presentation === "embed-list" ? "" : host.settingsSearchQuery,
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
      onNavigate: host.navigate,
      onPreload: callbacks.preloadRoute,
      onSearchQueryChange: (nextQuery: string) =>
        void host.handleSettingsSearchQueryChange(nextQuery),
      preloadTimers: host.settingsPreloadTimers,
      saveIndicator: {
        status: runtimeConfig.configRecoveryError ? "recovery" : runtimeConfig.configAutoSaveStatus,
        lastError: runtimeConfig.configRecoveryError ?? runtimeConfig.lastError,
        needsApply: runtimeConfig.configNeedsApply,
        applying: runtimeConfig.configApplying,
        applyDisabled:
          context.runtimeConfig.canApply === false ||
          runtimeConfig.configLoading ||
          runtimeConfig.configSaving ||
          (runtimeConfig.configFormDirty && runtimeConfig.configFormMode === "raw") ||
          updateBusy,
        onRetry: () => void context.runtimeConfig.retry(),
        onSave: () => void context.runtimeConfig.save(),
        onReload: () => void context.runtimeConfig.discardDraft(),
        onApply: () => void context.runtimeConfig.apply(),
      },
    };
  });
  return <SettingsSidebar {...sidebarProps()} />;
}
