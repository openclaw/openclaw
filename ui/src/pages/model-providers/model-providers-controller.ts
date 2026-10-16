import { asNullableRecord as asConfigRecord } from "@openclaw/normalization-core/record-coerce";
import { createEffect, createSignal, onSettled } from "solid-js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { ModelsProbeResult } from "../../api/types.ts";
import type { ApplicationContext } from "../../app/context.ts";
import { hasOperatorAdminAccess } from "../../app/operator-access.ts";
import { showConfirmDialog } from "../../components/confirm-dialog.ts";
import { currentConfigObject } from "../../lib/config/config-state-model.ts";
import { isGatewayMethodAdvertised } from "../../lib/gateway-methods.ts";
import { GatewayPageBinding } from "../../lib/gateway-page-binding.ts";
import { canonicalModelAuthProviderId } from "../../lib/model-auth.ts";
import * as modelCatalog from "../../lib/model-catalog-store.ts";
import {
  projectGateway,
  projectAgentSelection,
  projectOverlays,
} from "../../lib/reactive/application.ts";
import { projectAgents, projectRuntimeConfig } from "../../lib/reactive/domain-capabilities.ts";
import { i18nRevision, t } from "../../lib/reactive/i18n.ts";
import { projectSource } from "../../lib/reactive/projection.ts";
import { UsageRefreshPolicy } from "../usage/refresh-policy.ts";
import type { ModelAccountUsageElement } from "./account-usage.tsx";
import {
  buildDefaultsPatch,
  DEFAULT_MODELS_REPLACE_PATHS,
  modelProviderConfigBusy,
  modelProviderConfigMutationBlockedReason,
  modelDefaultsActions,
  modelProviderErrorMessage,
  readModelBehaviorConfig,
  runModelProviderApiKeyMutation,
  runModelProviderConfigMutation,
  type ModelProviderRowMessage,
} from "./config-mutation.ts";
import { ModelProviderCoreLoader, type ModelProviderRefreshReason } from "./core-load.ts";
import {
  buildModelProviderPresentation,
  type DefaultsDraft,
  type ModelProviderPendingLogout,
} from "./data.ts";
import { createModelProviderDiscovery } from "./discovery-controller.tsx";
import { createInstalledAgents } from "./installed-agents.tsx";
import { EMPTY_MODEL_PROVIDERS_DATA, type ModelProvidersData } from "./load.ts";
import { createModelProviderLogin } from "./login-controller.ts";
import { createModelProviderProfileActions } from "./profile-actions-controller.ts";
import { updateRecordEntry } from "./record-state.ts";
import type { ModelProvidersRouteData } from "./route.ts";
import { ModelProviderSupplementalLoader } from "./supplemental-load.ts";
import type { ModelProvidersViewProps } from "./view.tsx";
type ModelProvidersState = {
  data: ModelProvidersData | null;
  busy: Record<string, boolean>;
  messages: Record<string, ModelProviderRowMessage>;
  probeResults: Record<string, ModelsProbeResult>;
  keyEditorProvider: string | null;
  keyDraft: string;
  profileOrders: Record<string, string[]>;
  addProviderId: string;
  addProviderKey: string;
  defaultsDraft: DefaultsDraft | null;
  selectedAgentId: string;
};

export function createModelProviders(
  context: ApplicationContext,
  inputs: { readonly routeData?: ModelProvidersRouteData; readonly loaderPending?: boolean },
) {
  const [providerQuery, setProviderQuery] = createSignal("");
  const [addProviderOpen, setAddProviderOpen] = createSignal(false);
  const runtimeConfig = projectRuntimeConfig(context.runtimeConfig);
  const agents = projectAgents(context.agents);
  const gatewayState = projectGateway(context.gateway);
  const selection = projectAgentSelection(context.settingsAgentSelection);
  const overlays = projectOverlays(context.overlays);
  const listeners = new Set<() => void>();
  const notify = () => listeners.forEach((listener) => listener());
  const mutationBlockedReason = (): string | null =>
    modelProviderConfigMutationBlockedReason(context) ??
    (state.selectedAgentId ? null : t("agents.noAgents"));
  const canMutate = (): boolean =>
    mutationBlockedReason() === null && !modelProviderConfigBusy(context);
  let loaderPending = false;
  let connected = false;
  const accountUsages = new Set<ModelAccountUsageElement>();
  const state: ModelProvidersState = {
    data: null,
    busy: {},
    messages: {},
    probeResults: {},
    keyEditorProvider: null,
    keyDraft: "",
    profileOrders: {},
    addProviderId: "",
    addProviderKey: "",
    defaultsDraft: null,
    selectedAgentId: "",
  };
  let logoutConfirmation: AbortController | null = null;
  let pendingConnection = false;
  let pendingCredentialInvalidation = false;

  function setState<Key extends keyof ModelProvidersState>(
    key: Key,
    value: ModelProvidersState[Key],
  ) {
    if (!Object.is(state[key], value)) {
      state[key] = value;
      notify();
    }
    return value;
  }

  /** Client the current data was loaded from; a new client means stale data. */
  let dataClient: GatewayBrowserClient | null = null;
  let routeDataObserved = false;
  // Global config writes survive agent switches; their card state does not.
  let agentEpoch = 0;
  const core = new ModelProviderCoreLoader(notify, {
    onStart: (reason) => {
      supplemental.beginCoreRefresh(reason === "forced");
      if (reason === "forced") {
        for (const account of accountUsages) {
          account.refreshUsage();
        }
      }
    },
    onComplete: ({ client, data }) => {
      // A page refresh settles its feedback; an overlapping picker Retry is best effort.
      core.resetCatalog();
      supplemental.adoptCoreData(client, data);
    },
    onCatalogComplete: (result) => {
      if (state.data) {
        setState("data", {
          ...state.data,
          providerOutcomes: result.providerOutcomes ?? [],
          catalogError: null,
        });
      }
    },
  });
  const refreshPolicy = new UsageRefreshPolicy({
    isLoading: () =>
      loaderPending || !routeDataObserved || core.loading || supplemental.usageLoading,
    // Usage convergence must not restart the independent local-cost request.
    reload: () => supplemental.loadUsage(),
    onIncompleteUsageExhausted: notify,
  });
  const supplemental = new ModelProviderSupplementalLoader(notify, {
    isCoreLoading: () => loaderPending,
    getGateway: () => gateway,
    getData: () => state.data,
    getDataClient: () => dataClient,
    setData: (data) => setState("data", data),
    setDataClient: (client) => (dataClient = client),
    refreshPolicy,
  });
  const gateway = new GatewayPageBinding(notify, {
    getGateway: () => context.gateway,
    onIdentityChange: () => resetConnectionState(),
    invalidateRequests,
    ensureInitialData,
    onSnapshot: (change) => {
      if (change.initial) {
        resetConnectionState();
      } else if (change.connectionChanged && !change.identityChanged) {
        // Keep the last snapshot visible while the canonical reconnect load replaces it.
        resetConnectionState({ preserveVisibleData: true });
      }
      installedAgents.synchronize();
      if (change.becameConnected && !change.initial && routeDataObserved && !loaderPending) {
        void refresh("replacement");
      }
    },
    onPageActivation: () => void refreshPolicy.request("focus"),
  });
  const installedAgents = createInstalledAgents({
    gateway,
    context,
  });
  const profileActions = createModelProviderProfileActions({
    getAgentEpoch: () => agentEpoch,
    getAgentId: () => state.selectedAgentId,
    getClient: () => context.gateway.snapshot.client,
    getClientEpoch: () => gateway.epoch,
    getData: () => state.data,
    getOrders: () => state.profileOrders,
    setData: (data) => setState("data", data),
    setOrders: (orders) => setState("profileOrders", orders),
    clearMessage: (cardId) => setMessage(cardId, null),
    canMutate: () => canMutate(),
    cancelRefresh: () => core.invalidate(),
    refresh: () => refresh("forced"),
    isCurrentClient: (client, epoch) => gateway.isCurrent({ client, epoch }),
    isBusy: (key) => Boolean(state.busy[key]),
    setBusy: (key, value) => setBusy(key, value),
    setProbeResult: (cardId, result) =>
      setState("probeResults", updateRecordEntry(state.probeResults, cardId, result)),
    setProbeError: (cardId, error) => setMessage(cardId, { kind: "error", text: error }),
    getConfig: () => context.runtimeConfig,
  });
  const discovery = createModelProviderDiscovery({
    canOpen: canMutate,
    getOwner: () => ({
      client: gatewayState.read().snapshot.client,
      agentId: selection.read().state.selectedId,
    }),
    onClose: () => void refresh("replacement"),
    onError: (error) =>
      setMessage("connection", { kind: "error", text: modelProviderErrorMessage(error) }),
  });
  const login = createModelProviderLogin({
    getScope: () => {
      projection.read();
      runtimeConfig.read();
      gatewayState.read();
      selection.read();
      overlays.read();
      return {
        context,
        agentId: state.selectedAgentId,
        authStatus: state.data?.authStatus ?? null,
      };
    },
    canStart: canMutate,
    onDiscover: () => {
      setMessage("connection", null);
      void discovery.open();
    },
    onApiKey: (provider) => {
      setState("addProviderId", provider);
      setState("addProviderKey", "");
      setAddProviderOpen(true);
      setMessage("add", null);
    },
    canContinue: () => mutationBlockedReason() === null,
    refresh: (providerId) => refresh("replacement", providerId),
  });
  const projection = projectSource(state, {
    read: (value) => value,
    subscribe: (_, listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    equality: "revision",
  });
  let previousRouteData: ModelProvidersRouteData | undefined;
  let previousLoaderPending: boolean | undefined;

  function synchronizeRoute(data: ModelProvidersRouteData | undefined, pending: boolean) {
    loaderPending = pending;
    if (!connected) {
      return;
    }
    const previous = previousRouteData;
    const routeChanged = data !== previous;
    const loaderChanged = pending !== previousLoaderPending;
    previousRouteData = data;
    previousLoaderPending = pending;
    if (routeChanged && data) {
      if (data.connect && !previous?.connect) {
        pendingConnection = true;
      }
      // Revalidation must not replace a search edited after navigation.
      if (data.provider !== previous?.provider) {
        setProviderQuery(canonicalModelAuthProviderId(data.provider ?? ""));
      }
      core.invalidate();
      routeDataObserved = true;
      setSelectedAgent(context.settingsAgentSelection.state.selectedId ?? "");
      if (
        (data.agentId ?? "") === state.selectedAgentId &&
        data.selectionIntentRevision === context.settingsAgentSelection.intentRevision &&
        gateway.isRouteDataCurrent(data)
      ) {
        supplemental.adoptCoreData(data.client, data.data);
      } else {
        setState("data", null);
        dataClient = null;
        refreshPolicy.resetPayload();
      }
      ensureInitialData();
    }
    if (loaderChanged && !pending) {
      supplemental.resume();
    }
    notify();
  }

  createEffect(
    () => ({ routeData: inputs.routeData, pending: inputs.loaderPending ?? false }),
    (value) => synchronizeRoute(value.routeData, value.pending),
  );
  createEffect(
    () => ({
      revision: projection.revision(),
      configRevision: runtimeConfig.revision(),
      overlayRevision: overlays.revision(),
      loginBusy: login.busy,
    }),
    ({ loginBusy }) => {
      if (!connected) {
        return;
      }
      if (pendingConnection && state.data && canMutate() && !core.loading) {
        pendingConnection = false;
        void login.open();
      }
      if (pendingCredentialInvalidation && !loginBusy) {
        void refresh("replacement");
      }
    },
  );
  createEffect(
    () => gatewayState.read().snapshot.client,
    (client) => (client ? modelCatalog.subscribeModelCatalogCache(client, notify) : undefined),
  );
  onSettled(() => {
    connected = true;
    gateway.connect();
    const syncConfig = () => {
      if (
        !context.runtimeConfig.state.configSnapshot &&
        !context.runtimeConfig.state.configLoading
      ) {
        void context.runtimeConfig.ensureLoaded().catch(() => undefined);
      }
      profileActions.flushPendingOrders();
    };
    const syncAgent = () => {
      syncSelectedAgent();
      installedAgents.synchronize();
    };
    const cleanups = [
      modelCatalog.subscribeModelCatalogChanges(context.gateway, () => {
        if (login.busy) {
          pendingCredentialInvalidation = true;
        } else {
          void refresh("publication");
        }
      }),
      installedAgents.subscribe(context.gateway),
      context.runtimeConfig.subscribe(syncConfig),
      context.overlays.subscribe(() => profileActions.flushPendingOrders()),
      context.agents.subscribe(syncAgent),
      context.settingsAgentSelection.subscribe(syncAgent),
    ];
    syncConfig();
    syncAgent();
    synchronizeRoute(inputs.routeData, inputs.loaderPending ?? false);
    return () => {
      listeners.clear();
      connected = false;
      for (const cleanup of cleanups) {
        cleanup();
      }
      profileActions.resetOrders();
      refreshPolicy.dispose();
      gateway.dispose();
    };
  });

  function ensureInitialData() {
    if (
      !context.agents.state.agentsList &&
      !context.agents.state.agentsLoading &&
      !context.agents.state.agentsError
    ) {
      void context.agents.ensureList();
    }
    // The route owns initial loading, even when its page module is already cached.
    const client = gateway.client;
    if (
      !routeDataObserved ||
      loaderPending ||
      !gateway.connected ||
      !client ||
      !state.selectedAgentId ||
      core.loading ||
      (state.data !== null && state.data.updatedAt !== null && client === dataClient)
    ) {
      return;
    }
    void refresh("replacement");
  }

  function retryCatalog() {
    const { client, epoch } = gateway;
    const agentId = state.selectedAgentId;
    const capturedAgentEpoch = agentEpoch;
    if (!gateway.connected || !client || !agentId) {
      return;
    }
    void core.discoverCatalog(
      client,
      agentId,
      () =>
        gateway.isCurrent({ client, epoch }) &&
        state.selectedAgentId === agentId &&
        agentEpoch === capturedAgentEpoch,
    );
  }

  function invalidateRequests() {
    logoutConfirmation?.abort();
    core.invalidate();
    supplemental.invalidate();
  }

  function resetConnectionState(options: { preserveVisibleData?: boolean } = {}) {
    if (!options.preserveVisibleData) {
      setState("data", null);
      dataClient = null;
    }
    refreshPolicy.resetPayload();
    discovery.cancelLoading();
    installedAgents.reset(options);
    resetAgentScopeState();
    profileActions.resetProbes();
    setState("defaultsDraft", null);
  }

  function resetAgentScopeState() {
    pendingCredentialInvalidation = false;
    login.reset();
    setState("busy", {});
    setState("messages", {});
    setState("probeResults", {});
    closeKeyEditor();
    logoutConfirmation?.abort();
    profileActions.resetOrders();
    setAddProviderOpen(false);
    setState("addProviderId", "");
    setState("addProviderKey", "");
  }

  function setSelectedAgent(agentId: string): boolean {
    if (agentId === state.selectedAgentId) {
      return false;
    }
    setState("selectedAgentId", agentId);
    agentEpoch += 1;
    resetAgentScopeState();
    return true;
  }

  function syncSelectedAgent() {
    if (!setSelectedAgent(context.settingsAgentSelection.state.selectedId ?? "")) {
      return;
    }
    invalidateRequests();
    setState("data", null);
    dataClient = null;
    refreshPolicy.resetPayload();
    // probeEpochs stays: per-card counters must remain monotonic across agent
    // switches, or an in-flight probe from the old agent can reuse an epoch
    // and clobber a newer probe's state (A->B->A ABA race).
    notify();
    ensureInitialData();
  }

  function refresh(reason: ModelProviderRefreshReason, providerId?: string): Promise<void> {
    if (!state.selectedAgentId) {
      return Promise.resolve();
    }
    const client = gateway.client;
    if (!gateway.connected || !client) {
      refreshPolicy.markLoadDeferred();
      return Promise.resolve();
    }
    // Another client's write is outside the selected owner, so reconcile every provider.
    const crossClient = pendingCredentialInvalidation;
    pendingCredentialInvalidation = false;
    const reconcile = providerId !== undefined || crossClient;
    const target = reconcile && state.data ? state.data : undefined;
    return core.refresh(
      client,
      state.selectedAgentId,
      reason,
      target && {
        providerId: crossClient ? undefined : providerId,
        data: target,
      },
    );
  }

  const setBusy = (key: string, value: boolean) =>
    setState("busy", updateRecordEntry(state.busy, key, value ? true : null));

  const setMessage = (key: string, message: ModelProviderRowMessage | null) =>
    setState("messages", updateRecordEntry(state.messages, key, message));

  function closeKeyEditor() {
    setState("keyEditorProvider", null);
    setState("keyDraft", "");
  }

  async function mutateApiKey(
    provider: string,
    configKey: string,
    apiKey: string | null,
    action: "edit" | "add" = "edit",
  ) {
    const client = gateway.client;
    const key = action === "add" ? "add" : `key:${provider}`;
    if (!client || !canMutate() || state.busy[key] || apiKey === "") {
      return;
    }
    const clientEpoch = gateway.epoch;
    const capturedAgentEpoch = agentEpoch;
    const isCurrent = () =>
      gateway.isCurrent({ client, epoch: clientEpoch }) && agentEpoch === capturedAgentEpoch;
    profileActions.clearProbe(provider);
    const result = await runModelProviderApiKeyMutation(
      {
        runtimeConfig: context.runtimeConfig,
        isCurrentClient: isCurrent,
        isCurrentAgent: isCurrent,
        canMutate: () => canMutate(),
        refreshProviders: async () => {
          const previous = state.data;
          await refresh("replacement");
          if (isCurrent() && state.data?.error) {
            const warning = state.data.error;
            setState("data", previous);
            return warning;
          }
          return state.data?.error ?? state.data?.catalogError ?? null;
        },
        setBusy: (busy) => setBusy(key, busy),
        setMessage: (message) => {
          setMessage(provider, message);
          if (action === "add") {
            setMessage("add", message);
          }
        },
      },
      {
        client,
        agentId: state.selectedAgentId,
        provider: configKey,
        apiKey,
        success: t(
          action === "add"
            ? "modelProviders.add.saved"
            : apiKey === null
              ? "modelProviders.apiKey.removed"
              : "modelProviders.apiKey.saved",
          { provider },
        ),
      },
    );
    if (!result.ok || !isCurrent()) {
      return;
    }
    if (action === "add") {
      if (state.addProviderId === provider && state.addProviderKey.trim() === apiKey) {
        setAddProviderOpen(Boolean(result.warning));
        if (!result.warning) {
          setState("addProviderId", "");
        }
        setState("addProviderKey", "");
      }
    } else if (state.keyEditorProvider === provider && state.keyDraft.trim() === apiKey) {
      closeKeyEditor();
    }
  }

  async function requestLogout(pending: ModelProviderPendingLogout) {
    if (logoutConfirmation || !canMutate() || state.busy[`logout:${pending.cardId}`]) {
      return;
    }
    // Agent changes, reconnects and navigation abort this decision before it can
    // authorize a logout under a different scope.
    const controller = new AbortController();
    logoutConfirmation = controller;
    const confirmed = await showConfirmDialog({
      title: t("modelProviders.logout.actionFor", { account: pending.label }),
      message: t("modelProviders.logout.confirm", { provider: pending.label }),
      confirmLabel: t("modelProviders.logout.action"),
      danger: true,
      signal: controller.signal,
    }).finally(() => {
      logoutConfirmation = null;
    });
    if (confirmed && !controller.signal.aborted && canMutate()) {
      await profileActions.logout(pending.cardId, pending.target);
    }
  }

  async function saveDefaults() {
    const defaults = state.defaultsDraft;
    if (!defaults) {
      return;
    }
    const client = context.gateway.snapshot.client;
    let mutation: Promise<void> | undefined;
    // Global defaults remain editable when the configured roster is empty.
    if (
      client &&
      !modelProviderConfigMutationBlockedReason(context) &&
      !modelProviderConfigBusy(context) &&
      !state.busy.defaults
    ) {
      const clientEpoch = gateway.epoch;
      const capturedAgentEpoch = agentEpoch;
      mutation = runModelProviderConfigMutation(
        {
          runtimeConfig: context.runtimeConfig,
          isCurrentClient: () => gateway.isCurrent({ client, epoch: clientEpoch }),
          isCurrentAgent: () => agentEpoch === capturedAgentEpoch,
          setBusy: (busy) => setBusy("defaults", busy),
          setMessage: (message) => setMessage("defaults", message),
        },
        {
          raw: buildDefaultsPatch(defaults),
          note: t("modelProviders.notes.defaultModel"),
          replacePaths: DEFAULT_MODELS_REPLACE_PATHS,
        },
      );
    }
    await mutation;
    // Global defaults outlive agent selection. Connection resets clear the draft;
    // object identity protects newer edits.
    if (state.defaultsDraft === defaults) {
      setState("defaultsDraft", null);
    }
  }

  function viewProps() {
    i18nRevision();
    projection.read();
    runtimeConfig.read();
    agents.read();
    gatewayState.read();
    selection.read();
    overlays.read();
    const gatewaySnapshot = context.gateway.snapshot;
    const operatorAuth = gatewaySnapshot.hello?.auth;
    const data = state.data ?? EMPTY_MODEL_PROVIDERS_DATA;
    const configObject = currentConfigObject(context.runtimeConfig.state);
    const catalog = modelCatalog.readAgentModelCatalog(
      gatewaySnapshot.client,
      state.selectedAgentId,
    );
    const { configuredDefaults, cards, noSelectableAgents, rosterError, agentLabel, values } =
      buildModelProviderPresentation({
        configObject,
        behavior: readModelBehaviorConfig(
          asConfigRecord(asConfigRecord(configObject?.agents)?.defaults),
        ),
        catalog,
        data,
        agentsState: context.agents.state,
        agentId: state.selectedAgentId,
        defaultsDraft: state.defaultsDraft,
      });
    const stageDefaults = (patch: Partial<DefaultsDraft>) => {
      setState("defaultsDraft", {
        ...(state.defaultsDraft ?? configuredDefaults),
        ...patch,
      });
      setMessage("defaults", null);
      void saveDefaults();
    };
    const advertised = isGatewayMethodAdvertised(gatewaySnapshot, "models.probe");
    const usageAvailable = isGatewayMethodAdvertised(gatewaySnapshot, "codex.accountUsage");
    const pageLogin = login.pageActions;
    const props: ModelProvidersViewProps = {
      installedAgents: undefined,
      providerQuery: providerQuery(),
      onProviderQueryChange: setProviderQuery,
      onConnectProvider: () => void login.connectProvider(values.configuredModels),
      usageClient: !mutationBlockedReason() && usageAvailable ? gatewaySnapshot.client : null,
      usageAgentId: state.selectedAgentId,
      registerAccountUsage: (element) => {
        accountUsages.add(element);
        return () => accountUsages.delete(element);
      },
      connected: gatewaySnapshot.phase === "connected",
      loading:
        gatewaySnapshot.phase === "connected" &&
        state.data === null &&
        !rosterError &&
        !noSelectableAgents,
      refreshing: core.loading,
      error: rosterError ?? (noSelectableAgents ? t("agents.noAgents") : data.error),
      providerUsageFailed: data.providerUsage?.ok === false,
      supplementalLoading: loaderPending || supplemental.loading,
      updatedAt: data.updatedAt,
      credentialAgentLabel: agentLabel,
      cards: noSelectableAgents ? [] : installedAgents.filterProviders(cards),
      ...values,
      catalogDiscovering: core.catalogLoading || Boolean(catalog?.pendingProviders?.length),
      catalogDiscoveryError: core.catalogLoading ? null : (core.catalogError ?? data.catalogError),
      configBusy: modelProviderConfigBusy(context),
      canViewProfiles:
        gatewaySnapshot.phase === "connected" &&
        operatorAuth?.scopes !== undefined &&
        hasOperatorAdminAccess(operatorAuth),
      mutationBlockedReason: mutationBlockedReason(),
      defaultsMutationBlockedReason: modelProviderConfigMutationBlockedReason(context),
      providerUsageStalled: refreshPolicy.incompleteUsageExhausted,
      probeAvailable: advertised !== false,
      busy: state.busy,
      messages: state.messages,
      probeResults: state.probeResults,
      keyEditorProvider: state.keyEditorProvider,
      keyDraft: state.keyDraft,
      profileOrders: state.profileOrders,
      addProviderOpen: addProviderOpen(),
      addProviderId: state.addProviderId,
      addProviderKey: state.addProviderKey,
      onRefresh: () =>
        void (rosterError
          ? context.agents.refreshList()
          : Promise.all([
              context.runtimeConfig.refresh({ background: true }),
              refresh("forced", core.retryProvider),
            ])),
      onOpenKeyEditor: (provider) => {
        setState("keyEditorProvider", provider);
        setState("keyDraft", "");
        setMessage(provider, null);
      },
      onCloseKeyEditor: () => closeKeyEditor(),
      onKeyDraftChange: (value) => setState("keyDraft", value),
      onSaveKey: (provider, configKey) =>
        void mutateApiKey(provider, configKey, state.keyDraft.trim()),
      onRemoveKey: (provider, configKey) => void mutateApiKey(provider, configKey, null),
      onProbe: (cardId, providers) => void profileActions.probe(cardId, providers),
      onRequestLogout: (pending) => void requestLogout(pending),
      onProfileOrderChange: (cardId, provider, profileIds) =>
        profileActions.setOrder(cardId, provider, profileIds),
      onAddProviderToggle: () => {
        setAddProviderOpen((open) => !open);
        setState("addProviderKey", "");
        setMessage("add", null);
      },
      onAddProviderKeyChange: (value) => setState("addProviderKey", value),
      onAddProvider: () => {
        const provider = state.addProviderId;
        if (provider) {
          void mutateApiKey(provider, provider, state.addProviderKey.trim(), "add");
        }
      },
      ...modelDefaultsActions(() => state.defaultsDraft ?? configuredDefaults, stageDefaults),
      onCatalogRetry: () => retryCatalog(),
      ...login.providerActions,
    };
    return {
      props,
      cards,
      installedAgentsAvailable: installedAgents.available(),
      scope: {
        agentLabel,
        onConnect: pageLogin.onConnect,
        connectDisabled: pageLogin.connectDisabled || discovery.busy || addProviderOpen(),
      },
      loginMessage: state.messages.connection ?? pageLogin.loginMessage,
      discovery: {
        agentLabel,
        credentialChoices:
          data.authStatus?.providerCapabilities?.flatMap(
            (provider) => provider.loginOptions?.map((option) => option.id) ?? [],
          ) ?? [],
      },
    };
  }
  return {
    viewProps,
    installedAgents,
    discovery,
    login,
    retryCatalog,
  };
}

export type ModelProvidersOwner = ReturnType<typeof createModelProviders>;
