import type { JSX } from "@solidjs/web";
// The URL owns the active tab; Settings owners supply agent and configuration state.
import { createMemo, createSignal, createStore, onSettled, Show } from "solid-js";
import type { ControlUiSettingsSnapshot } from "../../../../src/plugin-sdk/control-ui-settings.js";
import { pathForMemoryTab } from "../../app-route-paths.ts";
import type { ApplicationContext, ApplicationGatewaySnapshot } from "../../app/context.ts";
import { readGatewayOperatorAccess } from "../../app/operator-access.ts";
import { ShellLayoutBoundary } from "../../app/shell-layout-traits-solid.tsx";
import { i18n } from "../../i18n/lib/translate.ts";
import { registerSettingsEnglish } from "../../i18n/locales/en-settings.ts";
import { currentConfigObject } from "../../lib/config/config-state-model.ts";
import { formatUiError } from "../../lib/format-error.ts";
import {
  loadPluginCatalog,
  runPluginConfigMutation,
  setPluginEnabled,
} from "../../lib/plugins/index.ts";
import { projectAgentSelection, projectGateway } from "../../lib/reactive/application.ts";
import { useApplication } from "../../lib/reactive/context.ts";
import { projectRuntimeConfig } from "../../lib/reactive/domain-capabilities.ts";
import { t, getLocale, registerEnglishCatalog } from "../../lib/reactive/i18n.ts";
import { ControlUiSettingsPresentation } from "../../plugins/control-ui-settings-view.solid.tsx";
import {
  resolveConfiguredDreaming,
  resolveDreamingConfigPathSupport,
  type DreamingConfigPathSupport,
} from "../agents/memory/dreaming.ts";
import { AgentMemoryPanel } from "../agents/memory/memory-panel.tsx";
import { createCuratedSettingsEditor } from "./curated-settings-editor.ts";
import { curatedSettingsPresentation } from "./curated-settings-presentation.ts";
import { CuratedSettingsPanel } from "./curated-settings.tsx";
import {
  memoryTabForRoute,
  resolveMemoryEngineSelection,
  selectedEngineId,
  type MemoryEngineSelection,
  type MemoryTab,
} from "./memory-schema.ts";
import {
  buildMemoryAddonRows,
  buildMemoryEngineOptions,
  Memory,
  findMemoryCatalogPlugin as findMemoryPlugin,
  resolveMemoryPluginState as pluginState,
  type MemoryCatalogState as MemoryCatalog,
  type MemoryEngineOutcome,
  type MemoryPluginState,
} from "./memory.tsx";
import type { ConfigRouteData, ConfigRouteSource } from "./route-data.ts";

registerEnglishCatalog(registerSettingsEnglish);

/** Explicit-off sentinel; resolveSlotSelection maps it to an `off` selection. */
const MEMORY_SLOT_OFF = "none";
const MEMORY_SLOT_PATH = ["plugins", "slots", "memory"];
// This compatible Dreaming placement is owned by Memory Core; the current engine
// remains the config owner, including custom engines and same-ID overrides.
const DREAMING_SETTINGS = curatedSettingsPresentation("memory-dreaming-settings");

type GatewayClient = NonNullable<ApplicationContext["gateway"]["snapshot"]["client"]>;

/** Object identity is the connection generation for both catalog and status reads. */
type CatalogConnection = {
  client: GatewayClient | null;
  connected: boolean;
  bootId: string | undefined;
};

type MemoryAddonNotice = {
  message: string;
  bootId: string | undefined;
};

export type MemorySettingsPageProps = {
  configObject: Record<string, unknown>;
  mutationDisabled: boolean;
  pluginsHref: string;
  memoryImportHref: string;
  routeData: ConfigRouteData | null;
  admittedRoute: ConfigRouteSource;
  buildEditor: () => JSX.Element;
};

export function MemorySettingsPage(props: MemorySettingsPageProps) {
  const application = useApplication();
  const gateway = projectGateway(application.gateway);
  const agentSelection = projectAgentSelection(application.settingsAgentSelection);
  const runtime = projectRuntimeConfig(application.runtimeConfig);
  const dreamingConfigOwner = createMemo(
    () => resolveConfiguredDreaming(currentConfigObject(runtime.read().state)).pluginId,
  );
  const [catalog, setCatalog] = createSignal<MemoryCatalog>({
    kind: "unavailable",
  });

  const [engineBusy, setEngineBusy] = createSignal(false);

  const [engineOutcome, setEngineOutcome] = createSignal<MemoryEngineOutcome | null>(null);

  const [addonOutcomes, setAddonOutcomes] = createStore<{
    busy: Partial<Record<string, true>>;
    errors: Partial<Record<string, string>>;
    notices: Partial<Record<string, MemoryAddonNotice>>;
    refreshWarnings: Partial<Record<string, string>>;
  }>({ busy: {}, errors: {}, notices: {}, refreshWarnings: {} });

  let settingsEpoch = 0;
  const settingsListeners = new Set<() => void>();
  function publishSettings() {
    for (const notify of settingsListeners) {
      notify();
    }
  }
  function retireSettingsReads() {
    settingsEpoch += 1;
    publishSettings();
  }

  const [support, setSupport] = createSignal<DreamingConfigPathSupport>("unknown");

  let pageConnection: CatalogConnection | null = null;

  let pagePluginGeneration: number | undefined = undefined;

  let pageCatalogRequest = 0;

  let pageSupportPluginId: string | null = null;

  let pageSupportProbe: {
    pluginId: string;
  } | null = null;

  const addonNoticeOperations = new Map<string, object>();

  let active = false;

  function activeTab(routeData = props.routeData): MemoryTab {
    return memoryTabForRoute(routeData ?? {}, application?.basePath ?? "") ?? "overview";
  }

  function syncGateway(snapshot: ApplicationGatewaySnapshot) {
    const { client } = snapshot;
    const connected = snapshot.phase === "connected";
    const bootId = snapshot.hello?.server?.bootId;
    const generation = snapshot.pluginCapabilities?.generation;
    const pluginsChanged = generation !== pagePluginGeneration;
    pagePluginGeneration = generation;
    if (
      pageConnection?.client === client &&
      pageConnection.connected === connected &&
      pageConnection.bootId === bootId
    ) {
      if (pluginsChanged && client && connected) {
        refreshPluginReads(client, pageConnection);
      }
      return;
    }
    const connection: CatalogConnection = {
      client,
      connected,
      bootId,
    };
    pageConnection = connection;
    setEngineBusy(false);
    setEngineOutcome(null);
    setAddonOutcomes((draft) => {
      draft.busy = {};
      draft.refreshWarnings = {};
    });
    retireSettingsReads();
    if (!client || !connected) {
      setCatalog({
        kind: "unavailable",
      });
      onSettled(publishSettings);
      return;
    }
    setCatalog({
      kind: "loading",
    });
    onSettled(publishSettings);
    setAddonOutcomes((draft) => {
      for (const [pluginId, notice] of Object.entries(draft.notices)) {
        if (!notice?.bootId || notice.bootId !== bootId) {
          delete draft.notices[pluginId];
        }
      }
    });
    refreshPluginReads(client, connection);
  }

  function refreshPluginReads(client: GatewayClient, connection: CatalogConnection) {
    // Publication supersedes reads, not the connection or a mutation waiting on its receipt.
    retireSettingsReads();
    pageSupportPluginId = null;
    pageSupportProbe = null;
    syncSupport(application.runtimeConfig);
    void loadCatalog(client, connection);
  }

  async function loadCatalog(client: GatewayClient, connection: CatalogConnection) {
    const request = ++pageCatalogRequest;
    try {
      const result = await loadPluginCatalog(client);
      applyCatalog(connection, request, {
        kind: "ready",
        plugins: result.plugins,
        mutationAllowed: result.mutationAllowed,
      });
    } catch {
      applyCatalog(connection, request, {
        kind: "unavailable",
      });
    }
  }

  function applyCatalog(
    connection: CatalogConnection,
    request: number,
    nextCatalog: MemoryCatalog,
  ) {
    if (!active || pageConnection !== connection || pageCatalogRequest !== request) {
      return;
    }
    setCatalog(nextCatalog);
    onSettled(publishSettings);
  }

  function engineState(selection: MemoryEngineSelection): MemoryPluginState {
    const engineId = selectedEngineId(selection);
    return engineId === null
      ? "unknown"
      : pluginState(catalog(), findMemoryPlugin(catalog(), engineId));
  }

  function applyPluginRefreshOutcome(
    connection: CatalogConnection,
    refreshError: string | null,
    pluginId?: string,
  ) {
    if (pageConnection !== connection) {
      return;
    }
    if (!refreshError) {
      setAddonOutcomes((draft) => {
        draft.refreshWarnings = {};
      });
      if (engineOutcome()?.kind === "warning") {
        setEngineOutcome(null);
      }
      return;
    }
    const message = t("pluginsPage.configRefreshFailed", {
      error: refreshError,
    });
    if (pluginId) {
      setAddonOutcomes((draft) => {
        draft.refreshWarnings[pluginId] = message;
      });
    } else {
      setEngineOutcome({
        kind: "warning",
        message,
      });
    }
  }

  async function changeAddon(pluginId: string, enabled: boolean) {
    if (
      addonOutcomes.busy[pluginId] ||
      props.mutationDisabled ||
      catalog().kind !== "ready" ||
      !catalogCanMutate() ||
      !readGatewayOperatorAccess(application.gateway.snapshot).canAdmin
    ) {
      return;
    }
    const entry = findMemoryPlugin(catalog(), pluginId);
    const addonState = pluginState(catalog(), entry);
    const connection = pageConnection;
    const client = connection?.connected ? connection.client : null;
    if (!connection || !client || (addonState !== "enabled" && addonState !== "disabled")) {
      return;
    }
    const noticeOperation = {};
    addonNoticeOperations.set(pluginId, noticeOperation);
    setAddonOutcomes((draft) => {
      draft.busy[pluginId] = true;
      delete draft.errors[pluginId];
      delete draft.refreshWarnings[pluginId];
    });
    try {
      const mutation = await runPluginConfigMutation(
        application.runtimeConfig,
        client,
        async (current) => {
          const bootId = application.gateway.snapshot.hello?.server?.bootId;
          return {
            result: await setPluginEnabled(current, pluginId, enabled),
            bootId,
          };
        },
        {
          canDispatch: () => canDispatchPluginMutation(connection),
        },
      );
      const { result, bootId } = mutation.value;
      const warnings = "warnings" in result ? (result.warnings ?? []) : [];
      const notice = warnings.join(" ");
      if (addonNoticeOperations.get(pluginId) === noticeOperation) {
        applyPluginRefreshOutcome(connection, mutation.refreshError, pluginId);
        const currentBootId = application.gateway.snapshot.hello?.server?.bootId;
        const keepNotice =
          notice &&
          (bootId && currentBootId ? bootId === currentBootId : pageConnection === connection);
        setAddonOutcomes((draft) => {
          if (keepNotice) {
            draft.notices[pluginId] = { message: notice, bootId };
          } else {
            delete draft.notices[pluginId];
          }
        });
      }
      const currentConnection = pageConnection;
      if (currentConnection?.connected && currentConnection.client) {
        await loadCatalog(currentConnection.client, currentConnection);
      }
    } catch (error) {
      if (pageConnection === connection) {
        setAddonOutcomes((draft) => {
          draft.errors[pluginId] = formatUiError(error);
        });
      }
    } finally {
      if (addonNoticeOperations.get(pluginId) === noticeOperation) {
        addonNoticeOperations.delete(pluginId);
      }
      if (pageConnection === connection) {
        setAddonOutcomes((draft) => {
          delete draft.busy[pluginId];
        });
      }
    }
  }

  function catalogCanMutate() {
    const current = catalog();
    return current.kind === "ready" && current.mutationAllowed;
  }
  function catalogBlocksMutation() {
    const current = catalog();
    return current.kind === "ready" && !current.mutationAllowed;
  }
  function canDispatchPluginMutation(connection: CatalogConnection) {
    return (
      pageConnection === connection &&
      !props.mutationDisabled &&
      !catalogBlocksMutation() &&
      readGatewayOperatorAccess(application.gateway.snapshot).canAdmin
    );
  }

  async function changeEngine(engineId: string | null, currentSelection: MemoryEngineSelection) {
    if (engineBusy() || props.mutationDisabled || catalogBlocksMutation()) {
      return;
    }
    if (engineId === selectedEngineId(currentSelection)) {
      if (engineId === null || engineState(currentSelection) === "enabled") {
        return;
      }
    }
    setEngineOutcome(null);
    if (!engineId) {
      application.runtimeConfig.patchForm(MEMORY_SLOT_PATH, MEMORY_SLOT_OFF);
      return;
    }
    const connection = pageConnection;
    const client = connection?.connected ? connection.client : null;
    if (!connection || !client) {
      return;
    }
    setEngineBusy(true);
    try {
      const mutation = await runPluginConfigMutation(
        application.runtimeConfig,
        client,
        (current) => setPluginEnabled(current, engineId, true),
        {
          canDispatch: () => canDispatchPluginMutation(connection),
        },
      );
      applyPluginRefreshOutcome(connection, mutation.refreshError);
      const currentConnection = pageConnection;
      if (currentConnection?.connected && currentConnection.client) {
        await loadCatalog(currentConnection.client, currentConnection);
      }
    } catch (error) {
      if (pageConnection === connection) {
        setEngineOutcome({
          kind: "error",
          message: formatUiError(error),
        });
      }
    } finally {
      if (pageConnection === connection) {
        setEngineBusy(false);
      }
    }
  }

  function syncSupport(runtimeConfig: ApplicationContext["runtimeConfig"]) {
    const pluginId = resolveConfiguredDreaming(currentConfigObject(runtimeConfig.state)).pluginId;
    let currentSupport = support();
    if (pluginId !== pageSupportPluginId) {
      pageSupportPluginId = pluginId;
      currentSupport = "unknown";
      setSupport("unknown");
    }
    const connected = runtimeConfig.state.connected;
    if (pageSupportProbe && (pageSupportProbe.pluginId !== pluginId || !connected)) {
      pageSupportProbe = null;
    }
    if (currentSupport !== "unknown" || pageSupportProbe || !connected) {
      return;
    }
    const probe = {
      pluginId,
    };
    pageSupportProbe = probe;
    void resolveDreamingConfigPathSupport(runtimeConfig, pluginId).then((resolvedSupport) => {
      if (pageSupportProbe !== probe) {
        return;
      }
      pageSupportProbe = null;
      if (active) {
        setSupport(resolvedSupport);
      }
    });
  }

  const editCuratedSettings = createCuratedSettingsEditor(DREAMING_SETTINGS, {
    read: () => currentConfigObject(application.runtimeConfig.state),
    parameters: (config) => ({ configOwner: resolveConfiguredDreaming(config).pluginId }),
    canEdit: () =>
      active &&
      !props.mutationDisabled &&
      application.runtimeConfig.state.connected &&
      application.gateway.snapshot.phase === "connected" &&
      readGatewayOperatorAccess(application.gateway.snapshot).canAdmin,
    patch: (path, value) => application.runtimeConfig.patchForm(path, value),
    remove: (path) => application.runtimeConfig.removeFormValue(path),
  });

  function navigateTab(tab: MemoryTab) {
    application.navigate("memory", {
      pathname: pathForMemoryTab(tab, application.basePath),
    });
  }
  onSettled(() => {
    active = true;
    const unsubscribe = [
      // Retire pending reads on every connection transition, even within one render.
      gateway.subscribe(() => syncGateway(application.gateway.snapshot)),
      // Config receipts retire obsolete support probes before their results can settle.
      runtime.subscribe(() => syncSupport(application.runtimeConfig)),
      // Route receipts retire the plugin's settings scope before its pending reads settle.
      props.admittedRoute.subscribe(publishSettings),
    ];
    syncGateway(gateway.read().snapshot);
    return () => {
      active = false;
      pageConnection = null;
      pageSupportProbe = null;
      addonNoticeOperations.clear();
      unsubscribe.forEach((stop) => stop());
    };
  });

  const engineSelection = () => resolveMemoryEngineSelection(props.configObject);
  const currentEngineState = () => engineState(engineSelection());
  const agentId = () => agentSelection.read().state.selectedId;
  function readSettingsSnapshot(): ControlUiSettingsSnapshot {
    // Read authority directly from each live owner.
    const selection = resolveMemoryEngineSelection(
      currentConfigObject(application.runtimeConfig.state) ?? {},
    );
    const id = selectedEngineId(selection);
    const entry = findMemoryPlugin(catalog(), id);
    const routeData = props.admittedRoute.read();
    return {
      agentId: application.settingsAgentSelection.state.selectedId,
      agentsLoading: application.agents.state.agentsLoading,
      agentsError: application.agents.state.agentsError,
      engine: {
        kind: selection.kind,
        id,
        availability:
          catalog().kind === "ready" && id && !entry?.installed
            ? "missing"
            : engineState(selection),
      },
      connected: application.gateway.snapshot.phase === "connected",
      advertisedMethods: application.gateway.snapshot.hello?.features?.methods,
      connectionEpoch: settingsEpoch,
      routeIntent: JSON.stringify([routeData?.pathname, routeData?.search, routeData?.hash]),
      locale: getLocale(),
    };
  }

  function subscribeSettings(listener: () => void) {
    settingsListeners.add(listener);
    // The plugin bridge must retire its request scope synchronously, before a batched render.
    const stops = [agentSelection, gateway, runtime, application.agents, i18n].map((source) =>
      source.subscribe(listener),
    );
    return () => {
      settingsListeners.delete(listener);
      stops.forEach((stop) => stop());
    };
  }

  return (
    <openclaw-memory-settings>
      <Memory
        activeTab={activeTab()}
        onTabChange={navigateTab}
        engineOptions={buildMemoryEngineOptions(catalog(), engineSelection())}
        engineSelection={engineSelection()}
        engineState={currentEngineState()}
        engineBusy={engineBusy() || props.mutationDisabled || catalogBlocksMutation()}
        engineOutcome={engineOutcome()}
        onEngineChange={(nextEngineId) => void changeEngine(nextEngineId, engineSelection())}
        addons={buildMemoryAddonRows(catalog(), addonOutcomes)}
        canToggleAddons={
          catalogCanMutate() &&
          !props.mutationDisabled &&
          readGatewayOperatorAccess(gateway.read().snapshot).canAdmin
        }
        onAddonChange={(pluginId, enabled) => void changeAddon(pluginId, enabled)}
        pluginsHref={props.pluginsHref}
        memoryImportHref={props.memoryImportHref}
        canImportMemory={readGatewayOperatorAccess(gateway.read().snapshot).canAdmin}
        overview={
          <ShellLayoutBoundary traits={{ settingsPage: true }}>
            <ControlUiSettingsPresentation
              application={application}
              placement={{ section: "memory", panel: "overview" }}
              readSnapshot={readSettingsSnapshot}
              subscribe={subscribeSettings}
              navigate={navigateTab}
              refreshAgents={() => {
                void application.agents.ensureList();
              }}
            />
          </ShellLayoutBoundary>
        }
        memories={
          <ShellLayoutBoundary traits={{ settingsPage: true }}>
            <ControlUiSettingsPresentation
              application={application}
              placement={{ section: "memory", panel: "memories" }}
              readSnapshot={readSettingsSnapshot}
              subscribe={subscribeSettings}
              navigate={navigateTab}
              refreshAgents={() => {
                void application.agents.ensureList();
              }}
            />
          </ShellLayoutBoundary>
        }
        dreams={
          <Show when={agentId()} keyed>
            {(id) => {
              const agentTarget = {
                read: () => id,
                subscribe: () => () => {},
              };
              return <AgentMemoryPanel initialAgentTarget={agentTarget} />;
            }}
          </Show>
        }
        editor={activeTab() === "settings" ? props.buildEditor() : null}
        dreamingSettings={
          activeTab() === "settings" ? (
            <CuratedSettingsPanel
              presentation={DREAMING_SETTINGS}
              parameters={{ configOwner: dreamingConfigOwner() }}
              messageParameters={{ plugin: dreamingConfigOwner() }}
              config={currentConfigObject(runtime.read().state)}
              support={support()}
              disabled={props.mutationDisabled}
              onPatch={editCuratedSettings}
            />
          ) : null
        }
      />
    </openclaw-memory-settings>
  );
}
