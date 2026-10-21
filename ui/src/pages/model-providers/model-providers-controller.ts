import { asNullableRecord as asConfigRecord } from "@openclaw/normalization-core/record-coerce";
import { createEffect, createSignal, onSettled } from "solid-js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { ApplicationContext } from "../../app/context.ts";
import { hasOperatorAdminAccess, hasOperatorReadAccess } from "../../app/operator-access.ts";
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
import { observeState } from "../../lib/reactive/observe-state.ts";
import { UsageRefreshPolicy } from "../usage/refresh-policy.ts";
import type { ModelAccountUsageElement } from "./account-usage.tsx";
import {
  modelProviderConfigBusy,
  modelProviderConfigMutationBlockedReason,
  modelDefaultsActions,
  modelProviderErrorMessage,
  readModelBehaviorConfig,
  runModelProviderApiKeyMutation,
  runModelProviderDefaultsMutation,
  type ModelProviderRowMessage,
} from "./config-mutation.ts";
import { ModelProviderCoreLoader, type ModelProviderRefreshReason } from "./core-load.ts";
import { buildModelProviderPresentation, type DefaultsDraft } from "./data.ts";
import { createModelProviderDiscovery } from "./discovery-controller.tsx";
import { createInstalledAgents } from "./installed-agents.tsx";
import { EMPTY_MODEL_PROVIDERS_DATA } from "./load.ts";
import { createModelProviderLogin } from "./login-controller.ts";
import { createModelProvidersState } from "./page-state.ts";
import { createModelProviderProfileActions } from "./profile-actions-controller.ts";
import { updateRecordEntry } from "./record-state.ts";
import type { ModelProvidersRouteData } from "./route.ts";
import { ModelProviderSupplementalLoader } from "./supplemental-load.ts";

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
  const projection = observeState(createModelProvidersState());
  const state = projection.state;
  const notify = projection.invalidate;
  const mutationBlockedReason = (): string | null =>
    modelProviderConfigMutationBlockedReason(context) ??
    (state.selectedAgentId ? null : t("agents.noAgents"));
  const canMutate = (): boolean =>
    mutationBlockedReason() === null && !modelProviderConfigBusy(context);
  let loaderPending = false;
  let connected = false;
  const accountUsages = new Set<ModelAccountUsageElement>();
  let pendingConnection = false;
  let pendingCredentialInvalidation = false;
  let profilesVisible = false;
  let readAccess = false;
  let stopCatalog: (() => void) | undefined;

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
        state.data = {
          ...state.data,
          providerOutcomes: result.providerOutcomes ?? [],
          catalogError: null,
        };
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
    setData: (data) => (state.data = data),
    setDataClient: (client) => (dataClient = client),
    refreshPolicy,
  });
  const gateway = new GatewayPageBinding(notify, {
    getGateway: () => context.gateway,
    onIdentityChange: () => resetConnectionState(),
    invalidateRequests,
    ensureInitialData,
    onSnapshot: (change) => {
      if (change.clientChanged) {
        stopCatalog?.();
        stopCatalog = change.snapshot.client
          ? modelCatalog.subscribeModelCatalogCache(change.snapshot.client, notify, () => ({
              agentId: state.selectedAgentId || undefined,
            }))
          : undefined;
      }
      if (change.initial) {
        resetConnectionState();
      } else if (change.connectionChanged && !change.identityChanged) {
        state.busy = {};
        installedAgents.reset({ preserveVisibleData: true });
      }
      if (change.snapshot.phase === "connected") {
        const auth = change.snapshot.hello?.auth;
        const allowed = auth?.scopes !== undefined && hasOperatorAdminAccess(auth);
        const canRead = hasOperatorReadAccess(auth ?? null);
        if ((profilesVisible && !allowed) || (readAccess && !canRead)) {
          gateway.invalidate();
          invalidateRequests();
          resetConnectionState();
        }
        profilesVisible = allowed;
        readAccess = canRead;
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
    setData: (data) => (state.data = data),
    setOrders: (orders) => (state.profileOrders = orders),
    clearMessage: (cardId) => setMessage(cardId, null),
    canMutate: () => canMutate(),
    cancelRefresh: () => core.invalidate(),
    refresh: () => refresh("forced"),
    isCurrentClient: (client, epoch) => gateway.isCurrent({ client, epoch }),
    isBusy: (key) => Boolean(state.busy[key]),
    setBusy: (key, value) => setBusy(key, value),
    setProbeResult: (cardId, result) =>
      (state.probeResults = updateRecordEntry(state.probeResults, cardId, result)),
    setProbeError: (cardId, error) => setMessage(cardId, { kind: "error", text: error }),
    getConfig: () => context.runtimeConfig,
  });
  const discovery = createModelProviderDiscovery({
    canOpen: canMutate,
    getOwner: () => ({
      client: context.gateway.snapshot.client,
      agentId: context.settingsAgentSelection.state.selectedId,
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
      state.addProviderId = provider;
      state.addProviderKey = "";
      setAddProviderOpen(true);
      setMessage("add", null);
    },
    canContinue: () => mutationBlockedReason() === null,
    refresh: (providerId) => refresh("replacement", providerId),
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
      // The catalog can change after preload completes but before this page subscribes.
      const catalogScope = { agentId: state.selectedAgentId };
      const catalogCurrent =
        !data.client ||
        !modelCatalog.peekModelCatalog(data.client, catalogScope, { allowStale: true }) ||
        modelCatalog.peekModelCatalog(data.client, catalogScope) !== undefined;
      if (
        readAccess &&
        (data.agentId ?? "") === state.selectedAgentId &&
        data.selectionIntentRevision === context.settingsAgentSelection.intentRevision &&
        gateway.isRouteDataCurrent(data)
      ) {
        supplemental.adoptCoreData(data.client, data.data);
        if (!catalogCurrent) {
          retryCatalog();
        }
      } else {
        state.data = null;
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

  // Route results drive the Gateway loading owner while the page stays mounted.
  createEffect(
    () => ({ routeData: inputs.routeData, pending: inputs.loaderPending ?? false }),
    (value) => synchronizeRoute(value.routeData, value.pending),
  );
  // Dispatch deferred login/catalog requests once their owner admits them.
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
      syncConfig();
      if (pendingConnection && state.data && canMutate() && !core.loading) {
        pendingConnection = false;
        void login.open();
      }
      if (pendingCredentialInvalidation && !loginBusy) {
        void refresh("replacement");
      }
    },
  );
  function syncConfig() {
    if (!context.runtimeConfig.state.configSnapshot && !context.runtimeConfig.state.configLoading) {
      void context.runtimeConfig.ensureLoaded().catch(() => undefined);
    }
    profileActions.flushPendingOrders();
  }
  onSettled(() => {
    connected = true;
    gateway.connect();
    const syncAgent = () => {
      discovery.synchronize();
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
      // Config-change events refresh installed agents after externally committed enablement changes.
      installedAgents.subscribe(context.gateway),
      // Selection receipts retire probes, logins, confirmations, and queued orders for the old agent.
      context.settingsAgentSelection.subscribe(syncAgent),
    ];
    syncConfig();
    syncAgent();
    synchronizeRoute(inputs.routeData, inputs.loaderPending ?? false);
    return () => {
      projection.dispose();
      connected = false;
      for (const cleanup of cleanups) {
        cleanup();
      }
      profileActions.resetOrders();
      refreshPolicy.dispose();
      stopCatalog?.();
      gateway.dispose();
    };
  });

  function ensureInitialData() {
    if (!readAccess) {
      return;
    }
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
    if (!gateway.connected || !readAccess || !client || !agentId) {
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
    profileActions.cancelLogout();
    core.invalidate();
    supplemental.invalidate();
    login.invalidateInventory();
  }

  function resetConnectionState() {
    profilesVisible = false;
    readAccess = false;
    state.data = null;
    dataClient = null;
    refreshPolicy.resetPayload();
    discovery.cancelLoading();
    installedAgents.reset();
    resetAgentScopeState();
    profileActions.resetProbes();
    state.defaultsDraft = null;
  }

  function resetAgentScopeState() {
    pendingCredentialInvalidation = false;
    login.reset();
    state.busy = {};
    state.messages = {};
    state.probeResults = {};
    closeKeyEditor();
    profileActions.cancelLogout();
    profileActions.resetOrders();
    setAddProviderOpen(false);
    state.addProviderId = "";
    state.addProviderKey = "";
  }

  function setSelectedAgent(agentId: string): boolean {
    if (agentId === state.selectedAgentId) {
      return false;
    }
    state.selectedAgentId = agentId;
    agentEpoch += 1;
    resetAgentScopeState();
    return true;
  }

  function syncSelectedAgent() {
    if (!setSelectedAgent(context.settingsAgentSelection.state.selectedId ?? "")) {
      return;
    }
    invalidateRequests();
    state.data = null;
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
    if (!gateway.connected || !readAccess || !client) {
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
    (state.busy = updateRecordEntry(state.busy, key, value ? true : null));

  const setMessage = (key: string, message: ModelProviderRowMessage | null) =>
    (state.messages = updateRecordEntry(state.messages, key, message));

  function closeKeyEditor() {
    state.keyEditorProvider = null;
    state.keyDraft = "";
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
            state.data = previous;
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
          state.addProviderId = "";
        }
        state.addProviderKey = "";
      }
    } else if (state.keyEditorProvider === provider && state.keyDraft.trim() === apiKey) {
      closeKeyEditor();
    }
  }

  async function saveDefaults() {
    const defaults = state.defaultsDraft;
    if (!defaults) {
      return;
    }
    const capturedAgentEpoch = agentEpoch;
    const settled = await runModelProviderDefaultsMutation(context, gateway, {
      defaults,
      busy: Boolean(state.busy.defaults),
      isCurrentAgent: () => agentEpoch === capturedAgentEpoch,
      setBusy: (busy) => setBusy("defaults", busy),
      setMessage: (message) => setMessage("defaults", message),
    });
    // Retry retains rejected writes in the config owner; the picker shows saved defaults.
    if (settled !== null && state.defaultsDraft === defaults) {
      state.defaultsDraft = null;
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
    const data = state.data ?? EMPTY_MODEL_PROVIDERS_DATA;
    const configState = context.runtimeConfig.state;
    // Retained config is presentation only; mutation admission still requires a current snapshot.
    const configObject =
      currentConfigObject(configState) ??
      (gatewaySnapshot.phase !== "connected" && dataClient && dataClient === gatewaySnapshot.client
        ? configState.configForm
        : null);
    const catalog = modelCatalog.readAgentModelCatalog(
      readAccess ? gatewaySnapshot.client : null,
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
      state.defaultsDraft = {
        ...(state.defaultsDraft ?? configuredDefaults),
        ...patch,
      };
      setMessage("defaults", null);
      void saveDefaults();
    };
    const advertised = isGatewayMethodAdvertised(gatewaySnapshot, "models.probe");
    const usageAvailable = isGatewayMethodAdvertised(gatewaySnapshot, "codex.accountUsage");
    const pageLogin = login.pageActions;
    const props = {
      installedAgents: undefined,
      providerQuery: providerQuery(),
      onProviderQueryChange: setProviderQuery,
      onConnectProvider: () => void login.connectProvider(values.configuredModels),
      usageClient: !mutationBlockedReason() && usageAvailable ? gatewaySnapshot.client : null,
      usageAgentId: state.selectedAgentId,
      registerAccountUsage: (element: ModelAccountUsageElement) => {
        accountUsages.add(element);
        return () => accountUsages.delete(element);
      },
      connected: gatewaySnapshot.phase === "connected",
      loading: state.data === null && !rosterError && !noSelectableAgents,
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
      canViewProfiles: profilesVisible,
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
      onOpenKeyEditor: (provider: string) => {
        state.keyEditorProvider = provider;
        state.keyDraft = "";
        setMessage(provider, null);
      },
      onCloseKeyEditor: () => closeKeyEditor(),
      onKeyDraftChange: (value: string) => (state.keyDraft = value),
      onSaveKey: (provider: string, configKey: string) =>
        void mutateApiKey(provider, configKey, state.keyDraft.trim()),
      onRemoveKey: (provider: string, configKey: string) =>
        void mutateApiKey(provider, configKey, null),
      onProbe: (cardId: string, providers: string[]) =>
        void profileActions.probe(cardId, providers),
      onRequestLogout: (pending: Parameters<typeof profileActions.requestLogout>[0]) =>
        void profileActions.requestLogout(pending),
      onProfileOrderChange: profileActions.setOrder,
      onAddProviderToggle: () => {
        setAddProviderOpen((open) => !open);
        state.addProviderKey = "";
        setMessage("add", null);
      },
      onAddProviderKeyChange: (value: string) => (state.addProviderKey = value),
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
