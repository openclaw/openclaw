import type { JSX } from "@solidjs/web";
// Controller for the Memory destination page. The URL owns the active tab;
// this element projects Settings agent selection into Overview status and
// consumes the global configuration controllers used by Settings.
import { createEffect, createSignal, onCleanup, onSettled, Show, untrack } from "solid-js";
import type { DoctorMemoryStatusPayload } from "../../../../src/gateway/server-methods/doctor.ts";
import { pathForMemoryTab } from "../../app-route-paths.ts";
import type { ApplicationContext, ApplicationGatewaySnapshot } from "../../app/context.ts";
import { readGatewayOperatorAccess } from "../../app/operator-access.ts";
import { registerSettingsEnglish } from "../../i18n/locales/en-settings.ts";
import { currentConfigObject } from "../../lib/config/config-state-model.ts";
import { formatUiError } from "../../lib/format-error.ts";
import { isGatewayMethodAdvertised } from "../../lib/gateway-methods.ts";
import {
  loadPluginCatalog,
  runPluginConfigMutation,
  setPluginEnabled,
} from "../../lib/plugins/index.ts";
import { projectAgentSelection, projectGateway } from "../../lib/reactive/application.ts";
import { useApplication } from "../../lib/reactive/context.ts";
import { projectAgents, projectRuntimeConfig } from "../../lib/reactive/domain-capabilities.ts";
import { t, registerEnglishCatalog } from "../../lib/reactive/i18n.ts";
import { normalizeAgentId } from "../../lib/sessions/session-key.ts";
import { defineSolidBridge } from "../../lit/solid-bridge.ts";
import {
  resolveConfiguredDreaming,
  resolveDreamingConfigPathSupport,
  type DreamingConfigPathSupport,
} from "../agents/memory/dreaming.ts";
import { AgentMemoryPanel } from "../agents/memory/memory-panel.tsx";
import { dreamingConfigPath } from "./memory-defaults.ts";
import { MemoryDreamingControls } from "./memory-dreaming.tsx";
import { MemoryMemories } from "./memory-memories.tsx";
import { MemoryOverview, type MemoryOverviewStatus } from "./memory-overview.tsx";
import {
  canonicalMemoryRouteLocation,
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
import type { ConfigRouteData } from "./route-data.ts";

registerEnglishCatalog(registerSettingsEnglish);

/** Explicit-off sentinel; resolveSlotSelection maps it to an `off` selection. */
const MEMORY_SLOT_OFF = "none";
const MEMORY_SLOT_PATH = ["plugins", "slots", "memory"];

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
  buildEditor: () => JSX.Element;
};

export function MemorySettingsContent(props: MemorySettingsPageProps) {
  const application = useApplication();
  const gateway = projectGateway(application.gateway);
  const agentSelection = projectAgentSelection(application.settingsAgentSelection);
  const runtime = projectRuntimeConfig(application.runtimeConfig);
  const agents = projectAgents(application.agents);
  const [catalog, setCatalog] = createSignal<MemoryCatalog>({
    kind: "unavailable",
  });

  const [engineBusy, setEngineBusy] = createSignal(false);

  const [engineOutcome, setEngineOutcome] = createSignal<MemoryEngineOutcome | null>(null);

  const [addonBusy, setAddonBusy] = createSignal(new Set<string>());

  const [addonErrors, setAddonErrors] = createSignal(new Map<string, string>());

  const [addonNotices, setAddonNotices] = createSignal(new Map<string, MemoryAddonNotice>());

  const [addonRefreshWarnings, setAddonRefreshWarnings] = createSignal(new Map<string, string>());

  let previousSelectedAgentId: string | null = null;

  const [overviewStatus, setOverviewStatus] = createSignal<MemoryOverviewStatus>({
    kind: "idle",
  });

  const [probingEmbeddings, setProbingEmbeddings] = createSignal(false);

  const [support, setSupport] = createSignal<DreamingConfigPathSupport>("unknown");

  let pageConnection: CatalogConnection | null = null;

  let pagePluginGeneration: number | undefined = undefined;

  let pageCatalogRequest = 0;

  let pageOverviewRequest: {
    connection: CatalogConnection;
    agentId: string;
  } | null = null;

  let pageSupportPluginId: string | null = null;

  let pageSupportProbe: {
    pluginId: string;
  } | null = null;

  const addonNoticeOperations = new Map<string, object>();

  let normalizedLocation = "";
  let active = true;

  function syncRouteAgent() {
    const routeAgentId = new URLSearchParams(props.routeData?.search).get("agent")?.trim();
    const intent = props.routeData?.agentSelectionIntent;
    const selection = application.settingsAgentSelection;
    if (
      routeAgentId &&
      intent?.owner === selection &&
      intent.revision === selection.intentRevision
    ) {
      selection.set(normalizeAgentId(routeAgentId));
    }
  }

  function activeTab(routeData = props.routeData): MemoryTab {
    return memoryTabForRoute(routeData ?? {}, application?.basePath ?? "") ?? "overview";
  }

  function syncCanonicalLocation() {
    const routeData = props.routeData;
    if (!routeData) {
      return;
    }
    const canonical = canonicalMemoryRouteLocation(routeData, application.basePath);
    if (!canonical) {
      normalizedLocation = "";
      return;
    }
    const source = `${routeData.pathname}${routeData.search}${routeData.hash}`;
    if (normalizedLocation === source) {
      return;
    }
    // One source location gets one replace. Route-data updates clear the guard
    // once the canonical path arrives, so returning to an old link still works.
    normalizedLocation = source;
    application.replace("memory", canonical);
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
    setAddonBusy(new Set<string>());
    setAddonRefreshWarnings(new Map());
    pageOverviewRequest = null;
    setProbingEmbeddings(false);
    if (!client || !connected) {
      setCatalog({
        kind: "unavailable",
      });
      if (activeTab() === "overview") {
        setOverviewStatus({
          kind: "error",
          message: t("memoryPage.overview.hero.gatewayOffline"),
        });
      }
      return;
    }
    setCatalog({
      kind: "loading",
    });
    setAddonNotices(
      (current) =>
        new Map([...current].filter(([, notice]) => notice.bootId && notice.bootId === bootId)),
    );
    refreshPluginReads(client, connection);
  }

  function refreshPluginReads(client: GatewayClient, connection: CatalogConnection) {
    // Publication supersedes reads, not the connection or a mutation waiting on its receipt.
    pageOverviewRequest = null;
    setProbingEmbeddings(false);
    pageSupportPluginId = null;
    pageSupportProbe = null;
    syncSupport(application.runtimeConfig);
    void loadCatalog(client, connection);
    void loadOverviewStatus();
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
  }

  function selectAgent(agentId: string | null) {
    if (previousSelectedAgentId === agentId) {
      return;
    }
    previousSelectedAgentId = agentId;
    pageOverviewRequest = null;
    setOverviewStatus({
      kind: "idle",
    });
    setProbingEmbeddings(false);
    void loadOverviewStatus();
  }

  async function loadOverviewStatus(
    options: {
      force?: boolean;
      probeEmbeddings?: boolean;
    } = {},
  ) {
    if (activeTab() !== "overview") {
      return;
    }
    if (resolveMemoryEngineSelection(props.configObject).kind === "off") {
      pageOverviewRequest = null;
      setOverviewStatus({
        kind: "idle",
      });
      setProbingEmbeddings(false);
      return;
    }
    const connection = pageConnection;
    const client = connection?.connected ? connection.client : null;
    const agentId = application.settingsAgentSelection.state.selectedId;
    if (!connection || !client) {
      setOverviewStatus({
        kind: "error",
        message: t("memoryPage.overview.hero.gatewayOffline"),
      });
      setProbingEmbeddings(false);
      return;
    }
    if (!agentId) {
      return;
    }
    if (
      !options.force &&
      pageOverviewRequest?.connection === connection &&
      pageOverviewRequest.agentId === agentId
    ) {
      return;
    }
    const probeEmbeddings = options.probeEmbeddings === true;
    const request = {
      connection,
      agentId,
    };
    pageOverviewRequest = request;
    setProbingEmbeddings(probeEmbeddings);
    if (!probeEmbeddings) {
      setOverviewStatus({
        kind: "loading",
      });
    }
    try {
      const payload = await client.request<DoctorMemoryStatusPayload>("doctor.memory.status", {
        agentId,
        ...(probeEmbeddings
          ? {
              probe: true,
            }
          : {}),
      });
      if (!active || pageOverviewRequest !== request) {
        return;
      }
      setOverviewStatus({
        kind: "ready",
        payload,
      });
    } catch (error) {
      if (!active || pageOverviewRequest !== request) {
        return;
      }
      setOverviewStatus({
        kind: "error",
        message: formatUiError(error),
      });
    } finally {
      if (pageOverviewRequest === request) {
        setProbingEmbeddings(false);
      }
    }
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
      setAddonRefreshWarnings(new Map());
      if (engineOutcome()?.kind === "warning") {
        setEngineOutcome(null);
      }
      return;
    }
    const message = t("pluginsPage.configRefreshFailed", {
      error: refreshError,
    });
    if (pluginId) {
      setAddonRefreshWarnings((current) => new Map(current).set(pluginId, message));
    } else {
      setEngineOutcome({
        kind: "warning",
        message,
      });
    }
  }

  async function changeAddon(pluginId: string, enabled: boolean) {
    if (
      addonBusy().has(pluginId) ||
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
    setAddonBusy((current) => new Set(current).add(pluginId));
    setAddonErrors((current) => {
      const errors = new Map(current);
      errors.delete(pluginId);
      return errors;
    });
    setAddonRefreshWarnings((current) => {
      const warnings = new Map(current);
      warnings.delete(pluginId);
      return warnings;
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
        setAddonNotices((current) => {
          const notices = new Map(current);
          if (keepNotice) {
            notices.set(pluginId, { message: notice, bootId });
          } else {
            notices.delete(pluginId);
          }
          return notices;
        });
      }
      const currentConnection = pageConnection;
      if (currentConnection?.connected && currentConnection.client) {
        await loadCatalog(currentConnection.client, currentConnection);
      }
    } catch (error) {
      if (pageConnection === connection) {
        setAddonErrors((current) => new Map(current).set(pluginId, formatUiError(error)));
      }
    } finally {
      if (addonNoticeOperations.get(pluginId) === noticeOperation) {
        addonNoticeOperations.delete(pluginId);
      }
      if (pageConnection === connection) {
        setAddonBusy((current) => {
          const busy = new Set(current);
          busy.delete(pluginId);
          return busy;
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

  function patchDreaming(path: readonly string[], value: unknown) {
    if (props.mutationDisabled) {
      return;
    }
    const config = currentConfigObject(application.runtimeConfig.state);
    const writePath = dreamingConfigPath(resolveConfiguredDreaming(config).pluginId, path);
    if (value === undefined) {
      application.runtimeConfig.removeFormValue(writePath);
      return;
    }
    application.runtimeConfig.patchForm(writePath, value);
  }

  function navigateTab(tab: MemoryTab) {
    application.navigate("memory", {
      pathname: pathForMemoryTab(tab, application.basePath),
    });
  }
  let previousTab: MemoryTab | undefined;
  createEffect(
    () => props.routeData,
    () => {
      const nextTab = activeTab();
      const changed = previousTab !== undefined && previousTab !== nextTab;
      previousTab = nextTab;
      if (changed) {
        pageOverviewRequest = null;
        setProbingEmbeddings(false);
      }
      syncRouteAgent();
      syncCanonicalLocation();
      if (changed) {
        void loadOverviewStatus();
      }
    },
  );
  // Owner notifications are synchronous: a disconnect/reconnect pair must retire
  // pending reads even when Solid batches both publications into one render.
  onSettled(() => {
    const unsubscribe = [
      agentSelection.subscribe(() =>
        untrack(() => selectAgent(agentSelection.read().state.selectedId)),
      ),
      gateway.subscribe(() => untrack(() => syncGateway(gateway.read().snapshot))),
      runtime.subscribe(() => untrack(() => syncSupport(application.runtimeConfig))),
      agents.subscribe(() => untrack(() => void loadOverviewStatus())),
    ];
    syncRouteAgent();
    selectAgent(agentSelection.read().state.selectedId);
    syncGateway(gateway.read().snapshot);
    return () => {
      for (const stop of unsubscribe) {
        stop();
      }
    };
  });
  let previousEngine: string | null | undefined;
  createEffect(
    () => selectedEngineId(resolveMemoryEngineSelection(props.configObject)),
    (engine) => {
      const changed = previousEngine !== undefined && engine !== previousEngine;
      previousEngine = engine;
      if (!changed) {
        return;
      }
      pageOverviewRequest = null;
      setProbingEmbeddings(false);
      void loadOverviewStatus();
    },
  );
  onCleanup(() => {
    active = false;
    pageConnection = null;
    pageOverviewRequest = null;
    pageSupportProbe = null;
    addonNoticeOperations.clear();
  });

  const engineSelection = () => resolveMemoryEngineSelection(props.configObject);
  const currentEngineState = () => engineState(engineSelection());
  const agentId = () => agentSelection.read().state.selectedId;
  const agentError = () => (agentId() ? null : agents.read().agentsError);

  return (
    <Memory
      activeTab={activeTab()}
      onTabChange={navigateTab}
      engineOptions={buildMemoryEngineOptions(catalog(), engineSelection())}
      engineSelection={engineSelection()}
      engineState={currentEngineState()}
      engineBusy={engineBusy() || props.mutationDisabled || catalogBlocksMutation()}
      engineOutcome={engineOutcome()}
      onEngineChange={(nextEngineId) => void changeEngine(nextEngineId, engineSelection())}
      addons={buildMemoryAddonRows(catalog(), {
        busy: addonBusy(),
        errors: addonErrors(),
        notices: addonNotices(),
        refreshWarnings: addonRefreshWarnings(),
      })}
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
        <MemoryOverview
          agentId={agentId()}
          engineSelection={engineSelection()}
          engineDisabled={currentEngineState() === "disabled"}
          status={agentError() ? { kind: "error", message: agentError()! } : overviewStatus()}
          probingEmbeddings={probingEmbeddings()}
          onRefresh={() =>
            agentId()
              ? void loadOverviewStatus({ force: true })
              : void application.agents.ensureList()
          }
          onProbeEmbeddings={() => void loadOverviewStatus({ force: true, probeEmbeddings: true })}
          onNavigate={navigateTab}
        />
      }
      memories={
        <MemoryMemories
          client={gateway.read().snapshot.client}
          connected={gateway.read().snapshot.phase === "connected"}
          methodAdvertised={
            isGatewayMethodAdvertised(gateway.read().snapshot, "memory.search") === true
          }
          agentId={agentId()}
        />
      }
      dreams={
        <Show when={agentId()} keyed>
          {(id) => <AgentMemoryPanel agentId={id} />}
        </Show>
      }
      editor={activeTab() === "settings" ? props.buildEditor() : null}
      dreamingSettings={
        activeTab() === "settings" ? (
          <MemoryDreamingControls
            config={currentConfigObject(runtime.read().state)}
            support={support()}
            disabled={props.mutationDisabled}
            onPatch={patchDreaming}
          />
        ) : null
      }
    />
  );
}

export const MemorySettingsPage = defineSolidBridge<MemorySettingsPageProps>(
  "openclaw-memory-settings",
  (props) => <MemorySettingsContent {...props} />,
  {
    properties: {
      configObject: { default: {}, attribute: false },
      mutationDisabled: { default: false, type: Boolean },
      pluginsHref: { default: "" },
      memoryImportHref: { default: "" },
      routeData: { default: null, attribute: false },
      buildEditor: { default: () => null, attribute: false },
    },
  },
);
