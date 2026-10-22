import type { JSX } from "@solidjs/web";
// The URL owns the active tab; Settings owners supply agent and configuration state.
import {
  action,
  createMemo,
  createOptimistic,
  createSignal,
  createStore,
  onSettled,
  Show,
} from "solid-js";
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
import { projectMutableSource } from "../../lib/reactive/projection.ts";
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
import { memoryAddonPresentations } from "./memory-addon-presentation.ts";
import {
  memoryTabForRoute,
  resolveMemoryEngineSelection,
  selectedEngineId,
  type MemoryEngineSelection,
  type MemoryTab,
} from "./memory-schema.ts";
import {
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
  // The accepted receipt serves synchronous mutation and plugin-settings policy.
  // Rendering observes only the owner-issued read, never a second data cache.
  const initialCatalog: MemoryCatalog = { kind: "unavailable" };
  const catalogState: {
    value: MemoryCatalog;
    read: MemoryCatalog | Promise<MemoryCatalog>;
  } = { value: initialCatalog, read: initialCatalog };
  const catalogSource = projectMutableSource(catalogState, (state) => state);
  const catalog = createMemo(async () => catalogSource.read().read);
  let pageConnection: CatalogConnection | null = null;
  const catalogScope = createMemo(() => {
    catalogSource.revision();
    return pageConnection;
  });

  function createMutation<T>() {
    const [preview, setPreview] = createOptimistic<{ connection: CatalogConnection; value: T }>();
    const [saving, setSaving] = createOptimistic(false);
    const current = () => {
      const next = preview();
      return next?.connection === catalogScope() ? next : undefined;
    };
    return {
      current,
      busy: () => current() !== undefined && saving(),
      run: action(function* (connection: CatalogConnection, value: T, worker: () => Promise<void>) {
        setPreview({ connection, value });
        setSaving(true);
        try {
          yield worker();
        } finally {
          // Re-enable completed controls; native action settlement retires their preview.
          if (pageConnection === connection) {
            setSaving(false);
          }
        }
      }),
    };
  }
  const engineMutation = createMutation<string>();
  const addonMutations = new Map(
    memoryAddonPresentations.map(({ id }) => [id, createMutation<boolean>()]),
  );

  const [engineOutcome, setEngineOutcome] = createSignal<MemoryEngineOutcome | null>(null);

  const [addonOutcomes, setAddonOutcomes] = createStore<{
    errors: Partial<Record<string, string>>;
    notices: Partial<Record<string, MemoryAddonNotice>>;
    refreshWarnings: Partial<Record<string, string>>;
  }>({ errors: {}, notices: {}, refreshWarnings: {} });

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

  const supportState: {
    value: DreamingConfigPathSupport;
    read: DreamingConfigPathSupport | Promise<DreamingConfigPathSupport>;
  } = { value: "unknown", read: "unknown" };
  const supportSource = projectMutableSource(supportState, (state) => state.read);
  const support = createMemo(() => {
    const read = supportSource.read();
    // Each admitted read starts unknown without replacing the editable panel.
    return createMemo<DreamingConfigPathSupport>(() => read, { loadingValue: "unknown" });
  });

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
    setEngineOutcome(null);
    setAddonOutcomes((draft) => {
      draft.refreshWarnings = {};
    });
    retireSettingsReads();
    if (!client || !connected) {
      catalogState.value = { kind: "unavailable" };
      catalogState.read = catalogState.value;
      catalogSource.publish();
      onSettled(publishSettings);
      return;
    }
    catalogState.value = { kind: "loading" };
    catalogState.read = catalogState.value;
    catalogSource.publish();
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
    const read = (async (): Promise<MemoryCatalog> => {
      const result = await loadPluginCatalog(client);
      return {
        kind: "ready",
        plugins: result.plugins,
        mutationAllowed: result.mutationAllowed,
      };
    })();
    catalogState.read = read;
    catalogSource.publish();
    try {
      applyCatalog(connection, request, await read);
    } catch {
      applyCatalog(connection, request, { kind: "unavailable" }, read);
    }
  }

  function applyCatalog(
    connection: CatalogConnection,
    request: number,
    nextCatalog: MemoryCatalog,
    read: MemoryCatalog | Promise<MemoryCatalog> = nextCatalog,
  ) {
    if (!active || pageConnection !== connection || pageCatalogRequest !== request) {
      return;
    }
    catalogState.value = nextCatalog;
    catalogState.read = read;
    catalogSource.publish();
    onSettled(publishSettings);
  }

  function engineState(selection: MemoryEngineSelection): MemoryPluginState {
    const engineId = selectedEngineId(selection);
    return engineId === null
      ? "unknown"
      : pluginState(catalogState.value, findMemoryPlugin(catalogState.value, engineId));
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
    const addonMutation = addonMutations.get(pluginId);
    if (
      !addonMutation ||
      addonMutation.busy() ||
      props.mutationDisabled ||
      catalogState.value.kind !== "ready" ||
      !catalogCanMutate() ||
      !readGatewayOperatorAccess(application.gateway.snapshot).canAdmin
    ) {
      return;
    }
    const entry = findMemoryPlugin(catalogState.value, pluginId);
    const addonState = pluginState(catalogState.value, entry);
    const connection = pageConnection;
    const client = connection?.connected ? connection.client : null;
    if (!connection || !client || (addonState !== "enabled" && addonState !== "disabled")) {
      return;
    }
    const noticeOperation = {};
    addonNoticeOperations.set(pluginId, noticeOperation);
    setAddonOutcomes((draft) => {
      delete draft.errors[pluginId];
      delete draft.refreshWarnings[pluginId];
    });
    await addonMutation.run(connection, enabled, async () => {
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
      }
    });
  }

  function catalogCanMutate() {
    const current = catalogState.value;
    return current.kind === "ready" && current.mutationAllowed;
  }
  function catalogBlocksMutation() {
    const current = catalogState.value;
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
    if (engineMutation.busy() || props.mutationDisabled || catalogBlocksMutation()) {
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
    await engineMutation.run(connection, engineId, async () => {
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
      }
    });
  }

  function syncSupport(runtimeConfig: ApplicationContext["runtimeConfig"]) {
    const pluginId = resolveConfiguredDreaming(currentConfigObject(runtimeConfig.state)).pluginId;
    let currentSupport = supportState.value;
    if (pluginId !== pageSupportPluginId) {
      pageSupportPluginId = pluginId;
      currentSupport = "unknown";
      supportState.value = "unknown";
      supportState.read = "unknown";
      supportSource.publish();
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
    const read = resolveDreamingConfigPathSupport(runtimeConfig, pluginId).then((resolved) =>
      active && pageSupportProbe === probe ? resolved : supportState.value,
    );
    supportState.read = read;
    supportSource.publish();
    void read.then((resolvedSupport) => {
      if (pageSupportProbe !== probe) {
        return;
      }
      pageSupportProbe = null;
      if (active) {
        supportState.value = resolvedSupport;
        supportState.read = resolvedSupport;
        supportSource.publish();
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
  const displayedEngineSelection = (): MemoryEngineSelection => {
    const next = engineMutation.current();
    return next ? { kind: "pinned", pluginId: next.value } : engineSelection();
  };
  const agentId = () => agentSelection.read().state.selectedId;
  function readSettingsSnapshot(): ControlUiSettingsSnapshot {
    // Read authority directly from each live owner.
    const selection = resolveMemoryEngineSelection(
      currentConfigObject(application.runtimeConfig.state) ?? {},
    );
    const id = selectedEngineId(selection);
    const entry = findMemoryPlugin(catalogState.value, id);
    const routeData = props.admittedRoute.read();
    return {
      agentId: application.settingsAgentSelection.state.selectedId,
      agentsLoading: application.agents.state.agentsLoading,
      agentsError: application.agents.state.agentsError,
      engine: {
        kind: selection.kind,
        id,
        availability:
          catalogState.value.kind === "ready" && id && !entry?.installed
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
        catalog={catalog()}
        catalogScope={catalogScope()}
        addonOutcomes={addonOutcomes}
        readAddonExpected={(id) => addonMutations.get(id)?.current()?.value}
        readAddonBusy={(id) => addonMutations.get(id)?.busy() ?? false}
        engineSelection={displayedEngineSelection()}
        enginePending={engineMutation.current() !== undefined}
        engineBusy={engineMutation.busy() || props.mutationDisabled}
        engineOutcome={engineOutcome()}
        onEngineChange={(nextEngineId) => void changeEngine(nextEngineId, engineSelection())}
        canToggleAddons={
          !props.mutationDisabled && readGatewayOperatorAccess(gateway.read().snapshot).canAdmin
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
              support={support()()}
              disabled={props.mutationDisabled}
              onPatch={editCuratedSettings}
            />
          ) : null
        }
      />
    </openclaw-memory-settings>
  );
}
