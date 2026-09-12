import { consume } from "@lit/context";
import { asNullableRecord as asConfigRecord } from "@openclaw/normalization-core/record-coerce";
import type { PropertyValues } from "lit";
import { property, state } from "lit/decorators.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { ModelsProbeResult } from "../../api/types.ts";
import { applicationContext, type ApplicationContext } from "../../app/context.ts";
import { hasOperatorAdminAccess } from "../../app/operator-access.ts";
import { showConfirmDialog } from "../../components/confirm-dialog.ts";
import { t } from "../../i18n/index.ts";
import { normalizeAgentLabel } from "../../lib/agents/display.ts";
import { isGatewayMethodAdvertised } from "../../lib/gateway-methods.ts";
import { subscribeModelCatalogChanges } from "../../lib/model-catalog-store.ts";
import { normalizeAgentId } from "../../lib/sessions/session-key.ts";
import { GatewayPageController } from "../../lit/gateway-page-controller.ts";
import { OpenClawLightDomElement } from "../../lit/openclaw-element.ts";
import { SubscriptionsController } from "../../lit/subscriptions-controller.ts";
import { UsageRefreshPolicy } from "../usage/refresh-policy.ts";
import type { ModelAccountUsage } from "./account-usage.ts";
import { createCatalogDiscoveryController } from "./catalog-discovery.ts";
import {
  buildDefaultsPatch,
  DEFAULT_MODELS_REPLACE_PATHS,
  isMissingMethodError,
  mergeProbeResults,
  modelProviderApiKeySuccess,
  modelProviderErrorMessage,
  readModelBehaviorConfig,
  runModelProviderApiKeyMutation,
  runModelProviderConfigMutation,
  type ModelBehaviorConfig,
  type ModelProviderConfigMutation,
  type ModelProviderConfigMutationResult,
  type ModelProviderRowMessage,
} from "./config-mutation.ts";
import { ModelProviderCoreLoader, type ModelProviderRefreshReason } from "./core-load.ts";
import {
  buildModelProviderCards,
  buildSelectableDefaultModels,
  buildUnconfiguredProviderOptions,
  readModelProviderConfig,
  type DefaultModelSelection,
  type ModelProviderPendingLogout,
} from "./data.ts";
import {
  EMPTY_MODEL_PROVIDERS_DATA,
  MODEL_PROVIDERS_COST_DAYS,
  type ModelProvidersData,
} from "./load.ts";
import { ModelProviderLoginController } from "./login-controller.ts";
import { ModelProviderProfileActionsController } from "./profile-actions-controller.ts";
import { showProfileActionError, showProfileLogoutSuccess } from "./profiles-view.ts";
import { updateRecordEntry } from "./record-state.ts";
import type { ModelProvidersRouteData } from "./route.ts";
import { ModelProviderSupplementalLoader } from "./supplemental-load.ts";
import { renderModelProviders, renderModelProvidersPageShell } from "./view.ts";

type DefaultsDraft = DefaultModelSelection & ModelBehaviorConfig;

export class ModelProvidersPage extends OpenClawLightDomElement {
  @consume({ context: applicationContext, subscribe: true })
  private context!: ApplicationContext;

  @property({ attribute: false }) routeData: ModelProvidersRouteData | undefined;
  @property({ attribute: false }) loaderPending = false;

  @state() private data: ModelProvidersData | null = null;
  @state() private busy: Record<string, boolean> = {};
  @state() private messages: Record<string, ModelProviderRowMessage> = {};
  @state() private probeResults: Record<string, ModelsProbeResult> = {};
  @state() private probeUnsupported = false;
  @state() private keyEditorProvider: string | null = null;
  @state() private keyDraft = "";
  private logoutConfirmation: AbortController | null = null;
  @state() private profileOrders: Record<string, string[]> = {};
  @state() private addProviderOpen = false;
  @state() private addProviderId = "";
  @state() private addProviderKey = "";
  @state() private defaultsDraft: DefaultsDraft | null = null;
  @state() private selectedAgentId = "";
  /** Client the current data was loaded from; a new client means stale data. */
  private dataClient: GatewayBrowserClient | null = null;
  private routeDataObserved = false;
  // Global config writes survive agent switches; their card state does not.
  private agentEpoch = 0;
  private probeEpochs = new Map<string, number>();
  private coreCatalogGeneration = 0;
  private readonly core = new ModelProviderCoreLoader(this, {
    onStart: (reason) => {
      this.catalogDiscovery.reset({ preserveHistory: reason === "publication" });
      this.coreCatalogGeneration = this.catalogDiscovery.generation;
      this.supplemental.beginCoreRefresh(reason === "forced");
      if (reason === "forced") {
        this.querySelectorAll<ModelAccountUsage>("openclaw-model-account-usage").forEach(
          (account) => account.refreshUsage(),
        );
      }
    },
    onComplete: ({ client, data }) => {
      const current = this.data;
      // Pickers remain usable during core loading, so their newer catalog owns the view.
      this.supplemental.adoptCoreData(
        client,
        current && this.catalogDiscovery.generation !== this.coreCatalogGeneration
          ? {
              ...data,
              models: current.models,
              automaticUtilityModel: current.automaticUtilityModel,
              providerOutcomes: current.providerOutcomes,
              catalogError: current.catalogError,
            }
          : data,
      );
    },
    refreshPublication: () => void this.refresh("publication"),
  });
  private readonly refreshPolicy = new UsageRefreshPolicy({
    isLoading: () =>
      this.loaderPending ||
      !this.routeDataObserved ||
      this.core.loading ||
      this.supplemental.usageLoading,
    // Usage convergence must not restart the independent local-cost request.
    reload: () => this.supplemental.loadUsage(),
    onIncompleteUsageExhausted: () => this.requestUpdate(),
  });
  private readonly supplemental = new ModelProviderSupplementalLoader(this, {
    isCoreLoading: () => this.loaderPending,
    getGateway: () => this.gateway,
    getData: () => this.data,
    getDataClient: () => this.dataClient,
    setData: (data) => (this.data = data),
    setDataClient: (client) => (this.dataClient = client),
    refreshPolicy: this.refreshPolicy,
  });
  private readonly catalogDiscovery = createCatalogDiscoveryController({
    getGateway: () => this.gateway,
    getAgentId: () => this.selectedAgentId,
    getAgentEpoch: () => this.agentEpoch,
    getData: () => this.data,
    setData: (data) => (this.data = data),
    requestUpdate: () => this.requestUpdate(),
  });
  private readonly gateway = new GatewayPageController(this, {
    getGateway: () => this.context?.gateway,
    onIdentityChange: () => this.resetConnectionState(),
    invalidateRequests: () => this.invalidateRequests(),
    ensureInitialData: () => this.ensureInitialData(),
    onSnapshot: (change) => {
      if (change.initial) {
        this.resetConnectionState();
      } else if (change.connectionChanged && !change.identityChanged) {
        // Keep the last snapshot visible while the canonical reconnect load replaces it.
        this.resetConnectionState({ preserveVisibleData: true });
      }
      if (
        change.becameConnected &&
        !change.initial &&
        this.routeDataObserved &&
        !this.loaderPending
      ) {
        void this.refresh("replacement");
      }
    },
    onPageActivation: () => this.refreshPolicy.request("focus"),
  });
  private readonly profileActions = new ModelProviderProfileActionsController({
    getAgentEpoch: () => this.agentEpoch,
    getAgentId: () => this.selectedAgentId,
    getClient: () => this.context.gateway.snapshot.client,
    getClientEpoch: () => this.gateway.epoch,
    getData: () => this.data,
    getOrders: () => this.profileOrders,
    setData: (data) => (this.data = data),
    setError: (_cardId, error) => showProfileActionError(error),
    setOrders: (orders) => (this.profileOrders = orders),
    clearMessage: (cardId) => this.setMessage(cardId, null),
    canMutate: () => this.canMutate(),
    cancelRefresh: () => this.cancelCoreRefresh(),
    refresh: () => this.refresh("forced"),
    isCurrentClient: (client, epoch) => this.gateway.isCurrent({ client, epoch }),
    isBusy: (key) => Boolean(this.busy[key]),
    setBusy: (key, value) => this.setBusy(key, value),
    clearProbe: (cardId) => this.clearProbe(cardId),
    setLogoutSuccess: showProfileLogoutSuccess,
    getConfig: () => this.context.runtimeConfig,
  });
  private readonly login = new ModelProviderLoginController(this, {
    getScope: () => ({ context: this.context, agentId: this.selectedAgentId, data: this.data }),
    canStart: () => this.canMutate(),
    canContinue: () => this.mutationBlockedReason() === null,
    refresh: () => this.refresh("forced"),
  });
  private readonly subscriptions = new SubscriptionsController(this)
    .effect(
      () => this.context?.gateway,
      (gateway) => subscribeModelCatalogChanges(gateway, () => void this.refresh("publication")),
    )
    .watch(
      () => this.context?.runtimeConfig,
      (runtimeConfig, notify) => runtimeConfig.subscribe(notify),
      (runtimeConfig) => {
        if (!runtimeConfig.state.configSnapshot && !runtimeConfig.state.configLoading) {
          void runtimeConfig.ensureLoaded().catch(() => undefined);
        }
        this.profileActions.flushPendingOrders();
      },
    )
    .watch(
      () => this.context?.overlays,
      (overlays, notify) => overlays.subscribe(notify),
      () => this.profileActions.flushPendingOrders(),
    )
    .watch(
      () => this.context?.agents,
      (agents, notify) => agents.subscribe(notify),
      () => this.syncSelectedAgent(),
    )
    .effect(
      () => this.context?.agentSelection,
      (selection) => selection.subscribe(() => this.syncSelectedAgent()),
    );

  override disconnectedCallback() {
    // Pending orders belong to this page; a delayed save must not dispatch
    // them after navigation over a replacement page's newer order.
    this.profileActions.resetOrders();
    this.subscriptions.clear();
    this.refreshPolicy.dispose();
    super.disconnectedCallback();
  }

  override willUpdate(changed: PropertyValues) {
    if (
      (changed.has("routeData") || changed.has("loaderPending")) &&
      this.routeData !== undefined
    ) {
      this.cancelCoreRefresh();
      this.routeDataObserved = true;
      this.setSelectedAgent(this.resolveSelectedAgentId());
      if (
        (this.routeData.agentId ?? "") === this.selectedAgentId &&
        this.gateway.isRouteDataCurrent(this.routeData)
      ) {
        this.supplemental.adoptCoreData(this.routeData.client, this.routeData.data);
      } else {
        this.data = null;
        this.dataClient = null;
        this.refreshPolicy.resetPayload();
      }
      this.ensureInitialData();
    }
  }

  private ensureInitialData() {
    if (
      !this.context.agents.state.agentsList &&
      !this.context.agents.state.agentsLoading &&
      !this.context.agents.state.agentsError
    ) {
      void this.context.agents.ensureList();
    }
    // The route owns initial loading, even when its page module is already cached.
    const client = this.gateway.client;
    if (
      !this.routeDataObserved ||
      this.loaderPending ||
      !this.gateway.connected ||
      !client ||
      !this.selectedAgentId ||
      this.core.loading ||
      (this.data !== null && this.data.updatedAt !== null && client === this.dataClient)
    ) {
      return;
    }
    void this.refresh("replacement");
  }

  private cancelCoreRefresh() {
    this.catalogDiscovery.reset();
    this.core.invalidate();
  }

  private invalidateRequests() {
    this.logoutConfirmation?.abort();
    this.cancelCoreRefresh();
    this.supplemental.invalidate();
  }

  private resetConnectionState(options: { preserveVisibleData?: boolean } = {}) {
    if (!options.preserveVisibleData) {
      this.data = null;
      this.dataClient = null;
    }
    this.refreshPolicy.resetPayload();
    this.resetAgentScopeState();
    this.probeEpochs = new Map();
    this.probeUnsupported = false;
    this.defaultsDraft = null;
  }

  private resetAgentScopeState() {
    this.login.reset();
    this.busy = {};
    this.messages = {};
    this.probeResults = {};
    this.closeKeyEditor();
    this.logoutConfirmation?.abort();
    this.profileActions.resetOrders();
    this.addProviderOpen = false;
    this.addProviderId = "";
    this.addProviderKey = "";
  }

  private resolveSelectedAgentId(): string {
    const selected = this.context.agentSelection.state.selectedId;
    return selected ? normalizeAgentId(selected) : "";
  }

  private setSelectedAgent(agentId: string): boolean {
    if (agentId === this.selectedAgentId) {
      return false;
    }
    this.selectedAgentId = agentId;
    this.agentEpoch += 1;
    this.resetAgentScopeState();
    return true;
  }

  private syncSelectedAgent() {
    if (!this.setSelectedAgent(this.resolveSelectedAgentId())) {
      return;
    }
    this.invalidateRequests();
    this.data = null;
    this.dataClient = null;
    this.refreshPolicy.resetPayload();
    // probeEpochs stays: per-card counters must remain monotonic across agent
    // switches, or an in-flight probe from the old agent can reuse an epoch
    // and clobber a newer probe's state (A->B->A ABA race).
    this.requestUpdate();
    this.ensureInitialData();
  }

  private refresh(reason: ModelProviderRefreshReason): Promise<void> {
    if (!this.selectedAgentId) {
      return Promise.resolve();
    }
    const client = this.gateway.client;
    if (!this.gateway.connected || !client) {
      this.refreshPolicy.markLoadDeferred();
      return Promise.resolve();
    }
    return this.core.refresh(client, this.selectedAgentId, reason);
  }

  private mutationBlockedReason(): string | null {
    const snapshot = this.context.gateway.snapshot;
    if (snapshot.phase !== "connected") {
      return t("modelProviders.readOnly.disconnected");
    }
    if (this.context.runtimeConfig.canPatch !== true) {
      return t("modelProviders.readOnly.adminRequired");
    }
    if (!snapshot.client || !this.selectedAgentId || !this.data?.config) {
      return t("modelProviders.configUnavailable");
    }
    return null;
  }

  private canMutate(): boolean {
    return this.mutationBlockedReason() === null && !this.configBusy();
  }

  private configBusy(): boolean {
    const runtimeState = this.context.runtimeConfig.state;
    const update = this.context.overlays.snapshot;
    return (
      runtimeState.configLoading ||
      runtimeState.configSaving ||
      runtimeState.configApplying ||
      update.updateRunning ||
      update.updateReconciliationPending
    );
  }

  private setBusy = (key: string, value: boolean) =>
    (this.busy = updateRecordEntry(this.busy, key, value ? true : null));

  private setMessage = (key: string, message: ModelProviderRowMessage | null) =>
    (this.messages = updateRecordEntry(this.messages, key, message));

  private clearProbe(provider: string) {
    this.probeEpochs.set(provider, (this.probeEpochs.get(provider) ?? 0) + 1);
    this.setBusy(`probe:${provider}`, false);
    this.probeResults = updateRecordEntry<ModelsProbeResult>(this.probeResults, provider, null);
  }

  private async patchConfig(
    params: ModelProviderConfigMutation,
  ): Promise<ModelProviderConfigMutationResult> {
    const client = this.context.gateway.snapshot.client;
    if (!client || !this.canMutate() || this.busy[params.key]) {
      return { ok: false };
    }
    const clientEpoch = this.gateway.epoch;
    const agentEpoch = this.agentEpoch;
    return runModelProviderConfigMutation(
      {
        runtimeConfig: this.context.runtimeConfig,
        agentEpoch,
        isCurrentClient: () => this.gateway.isCurrent({ client, epoch: clientEpoch }),
        isCurrentAgent: () => this.agentEpoch === agentEpoch,
        refreshProviders: () => this.refresh("forced"),
        setBusy: (busy) => this.setBusy(params.key, busy),
        setMessage: (message) => this.setMessage(params.key, message),
      },
      params,
    );
  }

  private openKeyEditor(provider: string) {
    this.keyEditorProvider = provider;
    this.keyDraft = "";
    this.setMessage(provider, null);
  }

  private closeKeyEditor() {
    this.keyEditorProvider = null;
    this.keyDraft = "";
  }

  private async mutateApiKey(
    provider: string,
    configKey: string,
    apiKey: string | null,
    action: "edit" | "add" = "edit",
  ) {
    const client = this.gateway.client;
    const key = action === "add" ? "add" : `key:${provider}`;
    if (!client || !this.canMutate() || this.busy[key] || apiKey === "") {
      return;
    }
    const clientEpoch = this.gateway.epoch;
    const agentEpoch = this.agentEpoch;
    const isCurrent = () =>
      this.gateway.isCurrent({ client, epoch: clientEpoch }) && this.agentEpoch === agentEpoch;
    this.clearProbe(provider);
    const result = await runModelProviderApiKeyMutation(
      {
        runtimeConfig: this.context.runtimeConfig,
        agentEpoch,
        isCurrentClient: isCurrent,
        isCurrentAgent: isCurrent,
        canMutate: () => this.canMutate(),
        refreshProviders: async () => {
          const previous = this.data;
          await this.refresh("replacement");
          if (isCurrent() && this.data?.error) {
            const warning = this.data.error;
            this.data = previous;
            return warning;
          }
          return this.data?.error ?? this.data?.catalogError ?? null;
        },
        setBusy: (busy) => this.setBusy(key, busy),
        setMessage: (message) => {
          this.setMessage(provider, message);
          if (action === "add") {
            this.setMessage("add", message);
          }
        },
      },
      {
        client,
        agentId: this.selectedAgentId,
        provider: configKey,
        apiKey,
        success: modelProviderApiKeySuccess(action, apiKey, provider),
      },
    );
    if (!result.ok || !isCurrent()) {
      return;
    }
    if (action === "add") {
      if (this.addProviderId === provider && this.addProviderKey.trim() === apiKey) {
        this.addProviderOpen = Boolean(result.warning);
        if (!result.warning) {
          this.addProviderId = "";
        }
        this.addProviderKey = "";
      }
    } else if (this.keyEditorProvider === provider && this.keyDraft.trim() === apiKey) {
      this.closeKeyEditor();
    }
  }

  private async probe(cardId: string, providers: string[]) {
    const client = this.context.gateway.snapshot.client;
    const key = `probe:${cardId}`;
    if (!client || !this.canMutate() || this.busy[key] || this.probeUnsupported) {
      return;
    }
    const clientEpoch = this.gateway.epoch;
    const agentId = this.selectedAgentId;
    const agentEpoch = this.agentEpoch;
    const probeEpoch = (this.probeEpochs.get(cardId) ?? 0) + 1;
    this.probeEpochs.set(cardId, probeEpoch);
    const ownsProbe = () =>
      this.gateway.isCurrent({ client, epoch: clientEpoch }) &&
      this.agentEpoch === agentEpoch &&
      this.selectedAgentId === agentId &&
      this.probeEpochs.get(cardId) === probeEpoch;
    this.setBusy(key, true);
    this.setMessage(cardId, null);
    try {
      const results: ModelsProbeResult[] = [];
      for (const provider of providers) {
        if (!ownsProbe()) {
          return;
        }
        results.push(
          await client.request<ModelsProbeResult>("models.probe", { provider, agentId }),
        );
      }
      if (ownsProbe()) {
        this.probeResults = {
          ...this.probeResults,
          [cardId]: mergeProbeResults(cardId, results),
        };
      }
    } catch (error) {
      if (!ownsProbe()) {
        return;
      }
      if (isMissingMethodError(error)) {
        this.probeUnsupported = true;
        this.setMessage(cardId, {
          kind: "error",
          text: t("modelProviders.probe.unavailable"),
        });
      } else {
        this.setMessage(cardId, { kind: "error", text: modelProviderErrorMessage(error) });
      }
    } finally {
      if (ownsProbe()) {
        this.setBusy(key, false);
      }
    }
  }

  private async requestLogout(pending: ModelProviderPendingLogout) {
    if (this.logoutConfirmation || !this.canMutate() || this.busy[`logout:${pending.cardId}`]) {
      return;
    }
    // Agent changes, reconnects and navigation abort this decision before it can
    // authorize a logout under a different scope.
    const controller = new AbortController();
    this.logoutConfirmation = controller;
    const confirmed = await showConfirmDialog({
      title: t("modelProviders.logout.actionFor", { account: pending.label }),
      message: t("modelProviders.logout.confirm", { provider: pending.label }),
      confirmLabel: t("modelProviders.logout.action"),
      danger: true,
      signal: controller.signal,
    }).finally(() => {
      this.logoutConfirmation = null;
    });
    if (confirmed && !controller.signal.aborted && this.canMutate()) {
      await this.profileActions.logout(pending.cardId, pending.target);
    }
  }

  private async addProvider() {
    const provider = this.addProviderId;
    if (provider) {
      await this.mutateApiKey(provider, provider, this.addProviderKey.trim(), "add");
    }
  }

  private async saveDefaults(defaults = this.defaultsDraft) {
    if (!defaults) {
      return;
    }
    const agentEpoch = this.agentEpoch;
    const result = await this.patchConfig({
      key: "defaults",
      raw: buildDefaultsPatch(defaults),
      note: t("modelProviders.notes.defaultModel"),
      success: t("modelProviders.defaults.saved"),
      replacePaths: DEFAULT_MODELS_REPLACE_PATHS,
    });
    // Keep the draft when fresh provider data is unavailable after commit.
    if (
      this.agentEpoch === agentEpoch &&
      this.defaultsDraft === defaults &&
      (!result.ok || !result.warning)
    ) {
      this.defaultsDraft = null;
    }
  }

  override render() {
    const gatewaySnapshot = this.context.gateway.snapshot;
    const operatorAuth = gatewaySnapshot.hello?.auth;
    const agentsState = this.context.agents.state;
    const agents = agentsState.agentsList?.agents ?? [];
    const rosterError = agentsState.agentsList ? null : agentsState.agentsError;
    const selected = agents.find((agent) => normalizeAgentId(agent.id) === this.selectedAgentId);
    const data = this.data ?? EMPTY_MODEL_PROVIDERS_DATA;
    const config = readModelProviderConfig(data.config);
    const runtimeState = this.context.runtimeConfig.state;
    const configObject =
      asConfigRecord(runtimeState.configForm ?? runtimeState.configSnapshot?.config) ??
      asConfigRecord(data.config) ??
      {};
    const configuredDefaults = {
      ...config.defaults,
      ...readModelBehaviorConfig(asConfigRecord(asConfigRecord(configObject.agents)?.defaults)),
    };
    const defaults = this.defaultsDraft ?? configuredDefaults;
    const stageDefaults = (patch: Partial<DefaultsDraft>) => {
      this.defaultsDraft = { ...(this.defaultsDraft ?? configuredDefaults), ...patch };
      this.setMessage("defaults", null);
      void this.saveDefaults(this.defaultsDraft);
    };
    // This keeps the pre-move General busy gate sourced from the same update state.
    const cards = buildModelProviderCards({
      ...data,
      providerUsage: data.providerUsage?.ok ? data.providerUsage.value : null,
      configProviderIds: config.providerIds,
      configApiKeyProviderIds: config.apiKeyProviderIds,
      configProviderAuthModes: config.providerAuthModes,
    });
    const configuredProviderIds = new Set([
      ...config.providerIds,
      ...(data.authStatus?.providers
        .filter((provider) => Boolean(provider.apiKey) || provider.profiles.length > 0)
        .map((provider) => provider.provider) ?? []),
    ]);
    const advertised = isGatewayMethodAdvertised(gatewaySnapshot, "models.probe");
    const usageAvailable = isGatewayMethodAdvertised(gatewaySnapshot, "codex.accountUsage");
    const body = renderModelProviders({
      usageClient: !this.mutationBlockedReason() && usageAvailable ? gatewaySnapshot.client : null,
      usageAgentId: this.selectedAgentId,
      connected: gatewaySnapshot.phase === "connected",
      loading: gatewaySnapshot.phase === "connected" && this.data === null && !rosterError,
      refreshing: this.core.loading,
      error: rosterError ?? data.error,
      providerUsageFailed: data.providerUsage?.ok === false,
      supplementalLoading: this.loaderPending || this.supplemental.loading,
      updatedAt: data.updatedAt,
      costDays: MODEL_PROVIDERS_COST_DAYS,
      credentialAgentLabel: selected ? normalizeAgentLabel(selected) : this.selectedAgentId,
      cards,
      configuredModels: buildSelectableDefaultModels(data.models, defaults),
      defaultModels: defaults,
      authStatus: data.authStatus,
      automaticUtilityModel: data.automaticUtilityModel,
      thinkingLevel: defaults.thinkingLevel,
      thinkingOverridden: defaults.thinkingOverridden,
      fastMode: defaults.fastMode,
      fastModeOverridden: defaults.fastModeOverridden,
      catalogDiscovering: this.catalogDiscovery.discovering,
      catalogDiscoveryError: this.catalogDiscovery.error ?? data.catalogError,
      configBusy: this.configBusy(),
      quickAddSupported: data.authStatus?.providerCapabilities !== undefined,
      unconfiguredProviders: buildUnconfiguredProviderOptions(
        data.authStatus?.providerCapabilities,
        configuredProviderIds,
      ),
      canViewProfiles:
        gatewaySnapshot.phase === "connected" &&
        operatorAuth?.scopes !== undefined &&
        hasOperatorAdminAccess(operatorAuth),
      mutationBlockedReason: this.mutationBlockedReason(),
      providerUsageStalled: this.refreshPolicy.incompleteUsageExhausted,
      probeAvailable: !this.probeUnsupported && advertised !== false,
      busy: this.busy,
      messages: this.messages,
      probeResults: this.probeResults,
      keyEditorProvider: this.keyEditorProvider,
      keyDraft: this.keyDraft,
      profileOrders: this.profileOrders,
      addProviderOpen: this.addProviderOpen,
      addProviderId: this.addProviderId,
      addProviderKey: this.addProviderKey,
      onRefresh: () =>
        void (rosterError ? this.context.agents.refreshList() : this.refresh("forced")),
      onOpenKeyEditor: (provider) => this.openKeyEditor(provider),
      onCloseKeyEditor: () => this.closeKeyEditor(),
      onKeyDraftChange: (value) => (this.keyDraft = value),
      onSaveKey: (provider, configKey) =>
        void this.mutateApiKey(provider, configKey, this.keyDraft.trim()),
      onRemoveKey: (provider, configKey) => void this.mutateApiKey(provider, configKey, null),
      onProbe: (cardId, providers) => void this.probe(cardId, providers),
      onRequestLogout: (pending) => void this.requestLogout(pending),
      onProfileOrderChange: (cardId, provider, profileIds) =>
        this.profileActions.setOrder(cardId, provider, profileIds),
      onAddProviderToggle: () => {
        this.addProviderOpen = !this.addProviderOpen;
        this.addProviderKey = "";
        this.setMessage("add", null);
      },
      onAddProviderIdChange: (provider) => (this.addProviderId = provider),
      onAddProviderKeyChange: (value) => (this.addProviderKey = value),
      onAddProvider: () => void this.addProvider(),
      onPrimaryChange: (model) => {
        const current = this.defaultsDraft ?? configuredDefaults;
        stageDefaults({
          primary: model,
          fallbacks: current.fallbacks.filter((fallback) => fallback !== model),
        });
      },
      onFallbackChange: (model) => {
        const current = this.defaultsDraft ?? configuredDefaults;
        stageDefaults({
          fallbacks: model
            ? [model, ...current.fallbacks.slice(1).filter((fallback) => fallback !== model)]
            : [],
        });
      },
      onUtilityChange: (model) => stageDefaults({ utilityModel: model }),
      onThinkingChange: (level) =>
        stageDefaults({ thinkingLevel: level, thinkingOverridden: true }),
      onThinkingReset: () => stageDefaults({ thinkingLevel: undefined, thinkingOverridden: false }),
      onFastModeChange: (mode) => stageDefaults({ fastMode: mode, fastModeOverridden: true }),
      onFastModeReset: () => stageDefaults({ fastMode: undefined, fastModeOverridden: false }),
      onModelPickerOpen: () => this.catalogDiscovery.openPicker(),
      onCatalogRetry: () => this.catalogDiscovery.retry(),
      onOpenModelSetup: () => this.context.navigate("model-setup"),
      ...this.login.providerActions,
    });
    return renderModelProvidersPageShell({
      agentSelection: this.context.agentSelection,
      agents,
      onOpenModelSetup: () => this.context.navigate("model-setup"),
      ...this.login.pageActions,
      body,
    });
  }
}

if (!customElements.get("openclaw-model-providers-page")) {
  customElements.define("openclaw-model-providers-page", ModelProvidersPage);
}
