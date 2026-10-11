import { asNullableRecord as asConfigRecord } from "@openclaw/normalization-core/record-coerce";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { ModelsProbeResult } from "../../api/types.ts";
import type { ApplicationContext } from "../../app/context.ts";
import { hasOperatorAdminAccess } from "../../app/operator-access.ts";
import { showConfirmDialog } from "../../components/confirm-dialog.ts";
import { t } from "../../i18n/index.ts";
import { currentConfigObject } from "../../lib/config/config-state-model.ts";
import { isGatewayMethodAdvertised } from "../../lib/gateway-methods.ts";
import { canonicalModelAuthProviderId } from "../../lib/model-auth.ts";
import * as modelCatalog from "../../lib/model-catalog-store.ts";
import { GatewayPageController } from "../../lit/gateway-page-controller.ts";
import { SubscriptionsController } from "../../lit/subscriptions-controller.ts";
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
import { ModelProviderDiscoveryController } from "./discovery-controller.tsx";
import { InstalledAgentsController } from "./installed-agents.tsx";
import { EMPTY_MODEL_PROVIDERS_DATA, type ModelProvidersData } from "./load.ts";
import { ModelProviderLoginController } from "./login-controller.ts";
import { ModelPageController } from "./page-controller.ts";
import { ModelProviderProfileActionsController } from "./profile-actions-controller.ts";
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
  providerQuery: string;
  addProviderOpen: boolean;
  addProviderId: string;
  addProviderKey: string;
  defaultsDraft: DefaultsDraft | null;
  selectedAgentId: string;
};

export class ModelProvidersController extends ModelPageController {
  private readonly mutationBlockedReason = (): string | null =>
    modelProviderConfigMutationBlockedReason(this.context) ??
    (this.state.selectedAgentId ? null : t("agents.noAgents"));
  private readonly canMutate = (): boolean =>
    this.mutationBlockedReason() === null && !modelProviderConfigBusy(this.context);

  context: ApplicationContext;

  private routeDataValue: ModelProvidersRouteData | undefined;
  get routeData() {
    return this.routeDataValue;
  }
  set routeData(value: ModelProvidersRouteData | undefined) {
    if (this.routeDataValue === value) {
      return;
    }
    this.routeDataValue = value;
    this.requestUpdate();
  }
  private loaderPendingValue = false;
  get loaderPending() {
    return this.loaderPendingValue;
  }
  set loaderPending(value: boolean) {
    if (this.loaderPendingValue === value) {
      return;
    }
    this.loaderPendingValue = value;
    this.requestUpdate();
  }

  readonly state: ModelProvidersState = {
    data: null,
    busy: {},
    messages: {},
    probeResults: {},
    keyEditorProvider: null,
    keyDraft: "",
    profileOrders: {},
    providerQuery: "",
    addProviderOpen: false,
    addProviderId: "",
    addProviderKey: "",
    defaultsDraft: null,
    selectedAgentId: "",
  };
  private logoutConfirmation: AbortController | null = null;
  private pendingConnection = false;

  setState<Key extends keyof ModelProvidersState>(key: Key, value: ModelProvidersState[Key]) {
    if (!Object.is(this.state[key], value)) {
      this.state[key] = value;
      this.requestUpdate();
    }
    return value;
  }

  /** Client the current data was loaded from; a new client means stale data. */
  private dataClient: GatewayBrowserClient | null = null;
  private routeDataObserved = false;
  // Global config writes survive agent switches; their card state does not.
  private agentEpoch = 0;
  private coreCatalogGeneration = 0;
  private readonly core = new ModelProviderCoreLoader(this, {
    onStart: (reason) => {
      this.coreCatalogGeneration = this.core.catalogGeneration;
      this.supplemental.beginCoreRefresh(reason === "forced");
      if (reason === "forced") {
        this.querySelectorAll<ModelAccountUsageElement>("openclaw-model-account-usage").forEach(
          (account) => account.refreshUsage(),
        );
      }
    },
    onComplete: ({ client, data }) => {
      const preserveCatalogDiagnostics =
        this.state.data !== null && this.core.catalogGeneration !== this.coreCatalogGeneration;
      if (!preserveCatalogDiagnostics) {
        this.core.resetCatalog();
      }
      this.supplemental.adoptCoreData(client, data, { preserveCatalogDiagnostics });
    },
    onCatalogComplete: (result) => {
      if (this.state.data) {
        this.setState("data", {
          ...this.state.data,
          providerOutcomes: result.providerOutcomes ?? [],
          catalogError: null,
        });
      }
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
    getData: () => this.state.data,
    getDataClient: () => this.dataClient,
    setData: (data) => this.setState("data", data),
    setDataClient: (client) => (this.dataClient = client),
    refreshPolicy: this.refreshPolicy,
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
  readonly installedAgents = new InstalledAgentsController(this, {
    gateway: this.gateway,
    getContext: () => this.context,
  });
  private readonly profileActions = new ModelProviderProfileActionsController({
    getAgentEpoch: () => this.agentEpoch,
    getAgentId: () => this.state.selectedAgentId,
    getClient: () => this.context.gateway.snapshot.client,
    getClientEpoch: () => this.gateway.epoch,
    getData: () => this.state.data,
    getOrders: () => this.state.profileOrders,
    setData: (data) => this.setState("data", data),
    setOrders: (orders) => this.setState("profileOrders", orders),
    clearMessage: (cardId) => this.setMessage(cardId, null),
    canMutate: () => this.canMutate(),
    cancelRefresh: () => this.core.invalidate(),
    refresh: () => this.refresh("forced"),
    isCurrentClient: (client, epoch) => this.gateway.isCurrent({ client, epoch }),
    isBusy: (key) => Boolean(this.state.busy[key]),
    setBusy: (key, value) => this.setBusy(key, value),
    setProbeResult: (cardId, result) =>
      this.setState("probeResults", updateRecordEntry(this.state.probeResults, cardId, result)),
    setProbeError: (cardId, error) => this.setMessage(cardId, { kind: "error", text: error }),
    getConfig: () => this.context.runtimeConfig,
  });
  readonly discovery = new ModelProviderDiscoveryController(this, {
    canOpen: () => this.canMutate(),
    getOwner: () => ({
      client: this.gateway.client,
      agentId: this.context.settingsAgentSelection.state.selectedId,
    }),
    onClose: () => void this.refresh("replacement"),
    onError: (error) =>
      this.setMessage("connection", { kind: "error", text: modelProviderErrorMessage(error) }),
  });
  readonly login = new ModelProviderLoginController(this, {
    getScope: () => ({
      context: this.context,
      agentId: this.state.selectedAgentId,
      authStatus: this.state.data?.authStatus ?? null,
    }),
    canStart: () => this.canMutate(),
    onDiscover: () => {
      this.setMessage("connection", null);
      void this.discovery.open();
    },
    onApiKey: (provider) => {
      this.setState("addProviderId", provider);
      this.setState("addProviderKey", "");
      this.setState("addProviderOpen", true);
      this.setMessage("add", null);
    },
    canContinue: () => this.mutationBlockedReason() === null,
    refresh: () => this.refresh("replacement"),
  });
  private readonly subscriptions = new SubscriptionsController(this)
    .effect(
      () => this.context?.gateway,
      (gateway) =>
        modelCatalog.subscribeModelCatalogChanges(gateway, () => void this.refresh("publication")),
    )
    .effect(
      () => this.context?.gateway,
      (gateway) => this.installedAgents.subscribe(gateway),
    )
    .watch(() => this.context?.gateway.snapshot.client, modelCatalog.subscribeModelCatalogCache)
    .watchStore(
      () => this.context?.runtimeConfig,
      (runtimeConfig) => {
        if (!runtimeConfig.state.configSnapshot && !runtimeConfig.state.configLoading) {
          void runtimeConfig.ensureLoaded().catch(() => undefined);
        }
        this.profileActions.flushPendingOrders();
      },
    )
    .watchStore(
      () => this.context?.overlays,
      () => this.profileActions.flushPendingOrders(),
    )
    .watchStore(
      () => this.context?.agents,
      () => this.syncSelectedAgent(),
    )
    .effect(
      () => this.context?.settingsAgentSelection,
      (selection) => selection.subscribe(() => this.syncSelectedAgent()),
    );

  constructor(element: HTMLElement, context: ApplicationContext, notify: () => void) {
    super(element, notify);
    this.context = context;
  }

  private previousRouteData: ModelProvidersRouteData | undefined;
  private previousLoaderPending: boolean | undefined;

  override disconnect() {
    // Pending orders belong to this page; a delayed save must not dispatch
    // them after navigation over a replacement page's newer order.
    this.profileActions.resetOrders();
    this.subscriptions.clear();
    this.refreshPolicy.dispose();
    super.disconnect();
  }

  override beforeUpdate() {
    super.beforeUpdate();
    const data = this.routeData;
    const previous = this.previousRouteData;
    const routeChanged = data !== previous;
    const loaderChanged = this.loaderPending !== this.previousLoaderPending;
    this.previousRouteData = data;
    this.previousLoaderPending = this.loaderPending;
    if ((routeChanged || loaderChanged) && data) {
      if (data.connect && !previous?.connect) {
        this.pendingConnection = true;
      }
      // Revalidation must not replace a search the operator edited after navigation.
      if (routeChanged && data.provider !== previous?.provider) {
        this.setState("providerQuery", canonicalModelAuthProviderId(data.provider ?? ""));
      }
      this.core.invalidate();
      this.routeDataObserved = true;
      this.setSelectedAgent(this.context.settingsAgentSelection.state.selectedId ?? "");
      if (
        (data.agentId ?? "") === this.state.selectedAgentId &&
        data.selectionIntentRevision === this.context.settingsAgentSelection.intentRevision &&
        this.gateway.isRouteDataCurrent(data)
      ) {
        this.supplemental.adoptCoreData(data.client, data.data);
      } else {
        this.setState("data", null);
        this.dataClient = null;
        this.refreshPolicy.resetPayload();
      }
      this.ensureInitialData();
    }
  }

  override afterUpdate() {
    super.afterUpdate();
    if (!this.isConnected) {
      return;
    }
    if (this.pendingConnection && this.state.data && this.canMutate() && !this.core.loading) {
      this.pendingConnection = false;
      void this.login.open();
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
      !this.state.selectedAgentId ||
      this.core.loading ||
      (this.state.data !== null && this.state.data.updatedAt !== null && client === this.dataClient)
    ) {
      return;
    }
    void this.refresh("replacement");
  }

  retryCatalog() {
    const { client, epoch } = this.gateway;
    const agentId = this.state.selectedAgentId;
    const agentEpoch = this.agentEpoch;
    if (!this.gateway.connected || !client || !agentId) {
      return;
    }
    void this.core.discoverCatalog(
      client,
      agentId,
      () =>
        this.gateway.isCurrent({ client, epoch }) &&
        this.state.selectedAgentId === agentId &&
        this.agentEpoch === agentEpoch,
    );
  }

  private invalidateRequests() {
    this.logoutConfirmation?.abort();
    this.core.invalidate();
    this.supplemental.invalidate();
  }

  private resetConnectionState(options: { preserveVisibleData?: boolean } = {}) {
    if (!options.preserveVisibleData) {
      this.setState("data", null);
      this.dataClient = null;
    }
    this.refreshPolicy.resetPayload();
    this.discovery.cancelLoading();
    this.installedAgents.reset(options);
    this.resetAgentScopeState();
    this.profileActions.resetProbes();
    this.setState("defaultsDraft", null);
  }

  private resetAgentScopeState() {
    this.login.reset();
    this.setState("busy", {});
    this.setState("messages", {});
    this.setState("probeResults", {});
    this.closeKeyEditor();
    this.logoutConfirmation?.abort();
    this.profileActions.resetOrders();
    this.setState("addProviderOpen", false);
    this.setState("addProviderId", "");
    this.setState("addProviderKey", "");
  }

  private setSelectedAgent(agentId: string): boolean {
    if (agentId === this.state.selectedAgentId) {
      return false;
    }
    this.setState("selectedAgentId", agentId);
    this.agentEpoch += 1;
    this.resetAgentScopeState();
    return true;
  }

  private syncSelectedAgent() {
    if (!this.setSelectedAgent(this.context.settingsAgentSelection.state.selectedId ?? "")) {
      return;
    }
    this.invalidateRequests();
    this.setState("data", null);
    this.dataClient = null;
    this.refreshPolicy.resetPayload();
    // probeEpochs stays: per-card counters must remain monotonic across agent
    // switches, or an in-flight probe from the old agent can reuse an epoch
    // and clobber a newer probe's state (A->B->A ABA race).
    this.requestUpdate();
    this.ensureInitialData();
  }

  private refresh(reason: ModelProviderRefreshReason): Promise<void> {
    if (!this.state.selectedAgentId) {
      return Promise.resolve();
    }
    const client = this.gateway.client;
    if (!this.gateway.connected || !client) {
      this.refreshPolicy.markLoadDeferred();
      return Promise.resolve();
    }
    return this.core.refresh(client, this.state.selectedAgentId, reason);
  }

  private setBusy = (key: string, value: boolean) =>
    this.setState("busy", updateRecordEntry(this.state.busy, key, value ? true : null));

  private setMessage = (key: string, message: ModelProviderRowMessage | null) =>
    this.setState("messages", updateRecordEntry(this.state.messages, key, message));

  private closeKeyEditor() {
    this.setState("keyEditorProvider", null);
    this.setState("keyDraft", "");
  }

  private async mutateApiKey(
    provider: string,
    configKey: string,
    apiKey: string | null,
    action: "edit" | "add" = "edit",
  ) {
    const client = this.gateway.client;
    const key = action === "add" ? "add" : `key:${provider}`;
    if (!client || !this.canMutate() || this.state.busy[key] || apiKey === "") {
      return;
    }
    const clientEpoch = this.gateway.epoch;
    const agentEpoch = this.agentEpoch;
    const isCurrent = () =>
      this.gateway.isCurrent({ client, epoch: clientEpoch }) && this.agentEpoch === agentEpoch;
    this.profileActions.clearProbe(provider);
    const result = await runModelProviderApiKeyMutation(
      {
        runtimeConfig: this.context.runtimeConfig,
        isCurrentClient: isCurrent,
        isCurrentAgent: isCurrent,
        canMutate: () => this.canMutate(),
        refreshProviders: async () => {
          const previous = this.state.data;
          await this.refresh("replacement");
          if (isCurrent() && this.state.data?.error) {
            const warning = this.state.data.error;
            this.setState("data", previous);
            return warning;
          }
          return this.state.data?.error ?? this.state.data?.catalogError ?? null;
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
        agentId: this.state.selectedAgentId,
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
      if (this.state.addProviderId === provider && this.state.addProviderKey.trim() === apiKey) {
        this.setState("addProviderOpen", Boolean(result.warning));
        if (!result.warning) {
          this.setState("addProviderId", "");
        }
        this.setState("addProviderKey", "");
      }
    } else if (this.state.keyEditorProvider === provider && this.state.keyDraft.trim() === apiKey) {
      this.closeKeyEditor();
    }
  }

  private async requestLogout(pending: ModelProviderPendingLogout) {
    if (
      this.logoutConfirmation ||
      !this.canMutate() ||
      this.state.busy[`logout:${pending.cardId}`]
    ) {
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

  private async saveDefaults() {
    const defaults = this.state.defaultsDraft;
    if (!defaults) {
      return;
    }
    const client = this.context.gateway.snapshot.client;
    let mutation: Promise<void> | undefined;
    // Global defaults remain editable when the configured roster is empty.
    if (
      client &&
      !modelProviderConfigMutationBlockedReason(this.context) &&
      !modelProviderConfigBusy(this.context) &&
      !this.state.busy.defaults
    ) {
      const clientEpoch = this.gateway.epoch;
      const agentEpoch = this.agentEpoch;
      mutation = runModelProviderConfigMutation(
        {
          runtimeConfig: this.context.runtimeConfig,
          isCurrentClient: () => this.gateway.isCurrent({ client, epoch: clientEpoch }),
          isCurrentAgent: () => this.agentEpoch === agentEpoch,
          setBusy: (busy) => this.setBusy("defaults", busy),
          setMessage: (message) => this.setMessage("defaults", message),
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
    if (this.state.defaultsDraft === defaults) {
      this.setState("defaultsDraft", null);
    }
  }

  viewProps() {
    const gatewaySnapshot = this.context.gateway.snapshot;
    const operatorAuth = gatewaySnapshot.hello?.auth;
    const data = this.state.data ?? EMPTY_MODEL_PROVIDERS_DATA;
    const configObject = currentConfigObject(this.context.runtimeConfig.state);
    const catalog = modelCatalog.readAgentModelCatalog(
      gatewaySnapshot.client,
      this.state.selectedAgentId,
    );
    const { configuredDefaults, cards, noSelectableAgents, rosterError, agentLabel, values } =
      buildModelProviderPresentation({
        configObject,
        behavior: readModelBehaviorConfig(
          asConfigRecord(asConfigRecord(configObject?.agents)?.defaults),
        ),
        catalog,
        data,
        agentsState: this.context.agents.state,
        agentId: this.state.selectedAgentId,
        defaultsDraft: this.state.defaultsDraft,
      });
    const stageDefaults = (patch: Partial<DefaultsDraft>) => {
      this.setState("defaultsDraft", {
        ...(this.state.defaultsDraft ?? configuredDefaults),
        ...patch,
      });
      this.setMessage("defaults", null);
      void this.saveDefaults();
    };
    const advertised = isGatewayMethodAdvertised(gatewaySnapshot, "models.probe");
    const usageAvailable = isGatewayMethodAdvertised(gatewaySnapshot, "codex.accountUsage");
    const login = this.login.pageActions;
    const props: ModelProvidersViewProps = {
      installedAgents: undefined,
      providerQuery: this.state.providerQuery,
      onProviderQueryChange: (value) => this.setState("providerQuery", value),
      onConnectProvider: () => void this.login.open(),
      usageClient: !this.mutationBlockedReason() && usageAvailable ? gatewaySnapshot.client : null,
      usageAgentId: this.state.selectedAgentId,
      connected: gatewaySnapshot.phase === "connected",
      loading:
        gatewaySnapshot.phase === "connected" &&
        this.state.data === null &&
        !rosterError &&
        !noSelectableAgents,
      refreshing: this.core.loading,
      error: rosterError ?? (noSelectableAgents ? t("agents.noAgents") : data.error),
      providerUsageFailed: data.providerUsage?.ok === false,
      supplementalLoading: this.loaderPending || this.supplemental.loading,
      updatedAt: data.updatedAt,
      credentialAgentLabel: agentLabel,
      cards: noSelectableAgents ? [] : this.installedAgents.filterProviders(cards),
      ...values,
      catalogDiscovering: this.core.catalogLoading || Boolean(catalog?.pendingProviders?.length),
      catalogDiscoveryError: this.core.catalogLoading
        ? null
        : (this.core.catalogError ?? data.catalogError),
      configBusy: modelProviderConfigBusy(this.context),
      canViewProfiles:
        gatewaySnapshot.phase === "connected" &&
        operatorAuth?.scopes !== undefined &&
        hasOperatorAdminAccess(operatorAuth),
      mutationBlockedReason: this.mutationBlockedReason(),
      defaultsMutationBlockedReason: modelProviderConfigMutationBlockedReason(this.context),
      providerUsageStalled: this.refreshPolicy.incompleteUsageExhausted,
      probeAvailable: advertised !== false,
      busy: this.state.busy,
      messages: this.state.messages,
      probeResults: this.state.probeResults,
      keyEditorProvider: this.state.keyEditorProvider,
      keyDraft: this.state.keyDraft,
      profileOrders: this.state.profileOrders,
      addProviderOpen: this.state.addProviderOpen,
      addProviderId: this.state.addProviderId,
      addProviderKey: this.state.addProviderKey,
      onRefresh: () =>
        void (rosterError
          ? this.context.agents.refreshList()
          : Promise.all([
              this.context.runtimeConfig.refresh({ background: true }),
              this.refresh("forced"),
            ])),
      onOpenKeyEditor: (provider) => {
        this.setState("keyEditorProvider", provider);
        this.setState("keyDraft", "");
        this.setMessage(provider, null);
      },
      onCloseKeyEditor: () => this.closeKeyEditor(),
      onKeyDraftChange: (value) => this.setState("keyDraft", value),
      onSaveKey: (provider, configKey) =>
        void this.mutateApiKey(provider, configKey, this.state.keyDraft.trim()),
      onRemoveKey: (provider, configKey) => void this.mutateApiKey(provider, configKey, null),
      onProbe: (cardId, providers) => void this.profileActions.probe(cardId, providers),
      onRequestLogout: (pending) => void this.requestLogout(pending),
      onProfileOrderChange: (cardId, provider, profileIds) =>
        this.profileActions.setOrder(cardId, provider, profileIds),
      onAddProviderToggle: () => {
        this.setState("addProviderOpen", !this.state.addProviderOpen);
        this.setState("addProviderKey", "");
        this.setMessage("add", null);
      },
      onAddProviderKeyChange: (value) => this.setState("addProviderKey", value),
      onAddProvider: () => {
        const provider = this.state.addProviderId;
        if (provider) {
          void this.mutateApiKey(provider, provider, this.state.addProviderKey.trim(), "add");
        }
      },
      ...modelDefaultsActions(() => this.state.defaultsDraft ?? configuredDefaults, stageDefaults),
      onCatalogRetry: () => this.retryCatalog(),
      ...this.login.providerActions,
    };
    return {
      props,
      cards,
      installedAgentsAvailable: this.installedAgents.available(),
      scope: {
        agentLabel,
        onConnect: login.onConnect,
        connectDisabled: login.connectDisabled || this.discovery.busy || this.state.addProviderOpen,
      },
      loginMessage: this.state.messages.connection ?? login.loginMessage,
      discovery: {
        agentLabel,
        credentialChoices:
          data.authStatus?.providerCapabilities?.flatMap(
            (provider) => provider.loginOptions?.map((option) => option.id) ?? [],
          ) ?? [],
      },
    };
  }
}
