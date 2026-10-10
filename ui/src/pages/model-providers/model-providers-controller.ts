/* eslint-disable max-lines -- The page retains one synchronous mutation and connection owner; JSX lives in model-providers-page.tsx. */
import { asNullableRecord as asConfigRecord } from "@openclaw/normalization-core/record-coerce";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { ModelsProbeResult } from "../../api/types.ts";
import type { ApplicationContext } from "../../app/context.ts";
import { hasOperatorAdminAccess } from "../../app/operator-access.ts";
import { showConfirmDialog } from "../../components/confirm-dialog.ts";
import { t } from "../../i18n/index.ts";
import { listSelectableAgents, normalizeAgentLabel } from "../../lib/agents/display.ts";
import { currentConfigObject } from "../../lib/config/config-state-model.ts";
import { isGatewayMethodAdvertised } from "../../lib/gateway-methods.ts";
import { canonicalModelAuthProviderId } from "../../lib/model-auth.ts";
import * as modelCatalog from "../../lib/model-catalog-store.ts";
import { normalizeAgentId } from "../../lib/sessions/session-key.ts";
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
  buildModelProviderCards,
  resolveDefaultModelPresentation,
  buildUnconfiguredProviderOptions,
  readModelProviderConfig,
  type DefaultsDraft,
  type ModelProviderPendingLogout,
} from "./data.ts";
import { ModelProviderDiscoveryController } from "./discovery-controller.tsx";
import { InstalledAgentsController } from "./installed-agents.tsx";
import { EMPTY_MODEL_PROVIDERS_DATA, type ModelProvidersData } from "./load.ts";
import { ModelProviderLoginController } from "./login-controller.tsx";
import { ModelPageController } from "./page-controller.ts";
import { ModelProviderProfileActionsController } from "./profile-actions-controller.ts";
import { updateRecordEntry } from "./record-state.ts";
import type { ModelProvidersRouteData } from "./route.ts";
import { ModelProviderSupplementalLoader } from "./supplemental-load.ts";
import type { ModelProvidersViewProps } from "./view.tsx";
export class ModelProvidersController extends ModelPageController {
  private readonly mutationBlockedReason = (): string | null =>
    modelProviderConfigMutationBlockedReason(this.context) ??
    (this.selectedAgentId ? null : t("agents.noAgents"));
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

  private dataValue: ModelProvidersData | null = null;
  get data() {
    return this.dataValue;
  }
  set data(value: typeof this.dataValue) {
    if (Object.is(this.dataValue, value)) {
      return;
    }
    this.dataValue = value;
    this.requestUpdate();
  }
  private busyValue: Record<string, boolean> = {};
  get busy() {
    return this.busyValue;
  }
  set busy(value: typeof this.busyValue) {
    if (Object.is(this.busyValue, value)) {
      return;
    }
    this.busyValue = value;
    this.requestUpdate();
  }
  private messagesValue: Record<string, ModelProviderRowMessage> = {};
  get messages() {
    return this.messagesValue;
  }
  set messages(value: typeof this.messagesValue) {
    if (Object.is(this.messagesValue, value)) {
      return;
    }
    this.messagesValue = value;
    this.requestUpdate();
  }
  private probeResultsValue: Record<string, ModelsProbeResult> = {};
  get probeResults() {
    return this.probeResultsValue;
  }
  set probeResults(value: typeof this.probeResultsValue) {
    if (Object.is(this.probeResultsValue, value)) {
      return;
    }
    this.probeResultsValue = value;
    this.requestUpdate();
  }
  private keyEditorProviderValue: string | null = null;
  get keyEditorProvider() {
    return this.keyEditorProviderValue;
  }
  set keyEditorProvider(value: typeof this.keyEditorProviderValue) {
    if (Object.is(this.keyEditorProviderValue, value)) {
      return;
    }
    this.keyEditorProviderValue = value;
    this.requestUpdate();
  }
  private keyDraftValue = "";
  get keyDraft() {
    return this.keyDraftValue;
  }
  set keyDraft(value: typeof this.keyDraftValue) {
    if (Object.is(this.keyDraftValue, value)) {
      return;
    }
    this.keyDraftValue = value;
    this.requestUpdate();
  }
  private logoutConfirmation: AbortController | null = null;
  private profileOrdersValue: Record<string, string[]> = {};
  get profileOrders() {
    return this.profileOrdersValue;
  }
  set profileOrders(value: typeof this.profileOrdersValue) {
    if (Object.is(this.profileOrdersValue, value)) {
      return;
    }
    this.profileOrdersValue = value;
    this.requestUpdate();
  }
  private providerQueryValue = "";
  get providerQuery() {
    return this.providerQueryValue;
  }
  set providerQuery(value: typeof this.providerQueryValue) {
    if (Object.is(this.providerQueryValue, value)) {
      return;
    }
    this.providerQueryValue = value;
    this.requestUpdate();
  }
  private pendingConnection = false;
  private addProviderOpenValue = false;
  get addProviderOpen() {
    return this.addProviderOpenValue;
  }
  set addProviderOpen(value: typeof this.addProviderOpenValue) {
    if (Object.is(this.addProviderOpenValue, value)) {
      return;
    }
    this.addProviderOpenValue = value;
    this.requestUpdate();
  }
  private addProviderIdValue = "";
  get addProviderId() {
    return this.addProviderIdValue;
  }
  set addProviderId(value: typeof this.addProviderIdValue) {
    if (Object.is(this.addProviderIdValue, value)) {
      return;
    }
    this.addProviderIdValue = value;
    this.requestUpdate();
  }
  private addProviderKeyValue = "";
  get addProviderKey() {
    return this.addProviderKeyValue;
  }
  set addProviderKey(value: typeof this.addProviderKeyValue) {
    if (Object.is(this.addProviderKeyValue, value)) {
      return;
    }
    this.addProviderKeyValue = value;
    this.requestUpdate();
  }
  private defaultsDraftValue: DefaultsDraft | null = null;
  get defaultsDraft() {
    return this.defaultsDraftValue;
  }
  set defaultsDraft(value: typeof this.defaultsDraftValue) {
    if (Object.is(this.defaultsDraftValue, value)) {
      return;
    }
    this.defaultsDraftValue = value;
    this.requestUpdate();
  }
  private selectedAgentIdValue = "";
  get selectedAgentId() {
    return this.selectedAgentIdValue;
  }
  set selectedAgentId(value: typeof this.selectedAgentIdValue) {
    if (Object.is(this.selectedAgentIdValue, value)) {
      return;
    }
    this.selectedAgentIdValue = value;
    this.requestUpdate();
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
        this.data !== null && this.core.catalogGeneration !== this.coreCatalogGeneration;
      if (!preserveCatalogDiagnostics) {
        this.core.resetCatalog();
      }
      this.supplemental.adoptCoreData(client, data, { preserveCatalogDiagnostics });
    },
    onCatalogComplete: (result) => {
      if (this.data) {
        this.data = {
          ...this.data,
          providerOutcomes: result.providerOutcomes ?? [],
          catalogError: null,
        };
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
    getData: () => this.data,
    getDataClient: () => this.dataClient,
    setData: (data) => (this.data = data),
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
    getAgentId: () => this.selectedAgentId,
    getClient: () => this.context.gateway.snapshot.client,
    getClientEpoch: () => this.gateway.epoch,
    getData: () => this.data,
    getOrders: () => this.profileOrders,
    setData: (data) => (this.data = data),
    setOrders: (orders) => (this.profileOrders = orders),
    clearMessage: (cardId) => this.setMessage(cardId, null),
    canMutate: () => this.canMutate(),
    cancelRefresh: () => this.core.invalidate(),
    refresh: () => this.refresh("forced"),
    isCurrentClient: (client, epoch) => this.gateway.isCurrent({ client, epoch }),
    isBusy: (key) => Boolean(this.busy[key]),
    setBusy: (key, value) => this.setBusy(key, value),
    setProbeResult: (cardId, result) =>
      (this.probeResults = updateRecordEntry(this.probeResults, cardId, result)),
    setProbeError: (cardId, error) => this.setMessage(cardId, { kind: "error", text: error }),
    getConfig: () => this.context.runtimeConfig,
  });
  readonly discovery = new ModelProviderDiscoveryController(this, {
    canOpen: () => this.canMutate(),
    getOwner: () => ({
      client: this.gateway.client,
      epoch: this.gateway.epoch,
      agentEpoch: this.agentEpoch,
      agentId: this.context.settingsAgentSelection.state.selectedId,
      selectionIntentRevision: this.context.settingsAgentSelection.intentRevision,
      selectionPending:
        this.context.settingsAgentSelection.state.selectedId === null &&
        this.context.agents.state.agentsList === null,
    }),
    isCurrent: (owner) =>
      Boolean(
        this.isConnected &&
        owner.client &&
        this.gateway.isCurrent({ client: owner.client, epoch: owner.epoch }) &&
        this.agentEpoch === owner.agentEpoch,
      ),
    onClose: () => void this.refresh("replacement"),
    onError: (error) =>
      this.setMessage("connection", { kind: "error", text: modelProviderErrorMessage(error) }),
  });
  readonly login = new ModelProviderLoginController(this, {
    getScope: () => ({
      context: this.context,
      agentId: this.selectedAgentId,
      authStatus: this.data?.authStatus ?? null,
    }),
    canStart: () => this.canMutate(),
    onDiscover: () => {
      this.setMessage("connection", null);
      void this.discovery.open();
    },
    onApiKey: (provider) => {
      this.addProviderId = provider;
      this.addProviderKey = "";
      this.addProviderOpen = true;
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
        this.providerQuery = canonicalModelAuthProviderId(data.provider ?? "");
      }
      this.core.invalidate();
      this.routeDataObserved = true;
      this.setSelectedAgent(this.context.settingsAgentSelection.state.selectedId ?? "");
      if (
        (data.agentId ?? "") === this.selectedAgentId &&
        data.selectionIntentRevision === this.context.settingsAgentSelection.intentRevision &&
        this.gateway.isRouteDataCurrent(data)
      ) {
        this.supplemental.adoptCoreData(data.client, data.data);
      } else {
        this.data = null;
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
    if (this.pendingConnection && this.data && this.canMutate() && !this.core.loading) {
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
      !this.selectedAgentId ||
      this.core.loading ||
      (this.data !== null && this.data.updatedAt !== null && client === this.dataClient)
    ) {
      return;
    }
    void this.refresh("replacement");
  }

  retryCatalog() {
    const { client, epoch } = this.gateway;
    const agentId = this.selectedAgentId;
    const agentEpoch = this.agentEpoch;
    if (!this.gateway.connected || !client || !agentId) {
      return;
    }
    void this.core.discoverCatalog(
      client,
      agentId,
      () =>
        this.gateway.isCurrent({ client, epoch }) &&
        this.selectedAgentId === agentId &&
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
      this.data = null;
      this.dataClient = null;
    }
    this.refreshPolicy.resetPayload();
    this.discovery.cancelLoading();
    this.installedAgents.reset(options);
    this.resetAgentScopeState();
    this.profileActions.resetProbes();
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
    if (!this.setSelectedAgent(this.context.settingsAgentSelection.state.selectedId ?? "")) {
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

  private setBusy = (key: string, value: boolean) =>
    (this.busy = updateRecordEntry(this.busy, key, value ? true : null));

  private setMessage = (key: string, message: ModelProviderRowMessage | null) =>
    (this.messages = updateRecordEntry(this.messages, key, message));

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
    this.profileActions.clearProbe(provider);
    const result = await runModelProviderApiKeyMutation(
      {
        runtimeConfig: this.context.runtimeConfig,
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

  private async saveDefaults() {
    const defaults = this.defaultsDraft;
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
      !this.busy.defaults
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
    if (this.defaultsDraft === defaults) {
      this.defaultsDraft = null;
    }
  }

  viewProps() {
    const gatewaySnapshot = this.context.gateway.snapshot;
    const operatorAuth = gatewaySnapshot.hello?.auth;
    const agentsState = this.context.agents.state;
    const agents = agentsState.agentsList?.agents ?? [];
    const noSelectableAgents =
      agentsState.agentsList !== null && listSelectableAgents(agents).length === 0;
    const rosterError = agentsState.agentsList ? null : agentsState.agentsError;
    const selected = agents.find((agent) => normalizeAgentId(agent.id) === this.selectedAgentId);
    const data = this.data ?? EMPTY_MODEL_PROVIDERS_DATA;
    const configObject = currentConfigObject(this.context.runtimeConfig.state);
    const config = readModelProviderConfig(configObject);
    const catalog = modelCatalog.readAgentModelCatalog(
      gatewaySnapshot.client,
      this.selectedAgentId,
    );
    const configuredDefaults = {
      ...config.defaults,
      ...readModelBehaviorConfig(asConfigRecord(asConfigRecord(configObject?.agents)?.defaults)),
    };
    const { defaults, configuredModels } = resolveDefaultModelPresentation(
      catalog,
      configuredDefaults,
      this.defaultsDraft,
    );
    const stageDefaults = (patch: Partial<DefaultsDraft>) => {
      this.defaultsDraft = { ...(this.defaultsDraft ?? configuredDefaults), ...patch };
      this.setMessage("defaults", null);
      void this.saveDefaults();
    };
    const cards = buildModelProviderCards({
      ...data,
      models: catalog?.models ?? null,
      providerOutcomes: catalog.hasSnapshot
        ? (catalog.providerOutcomes ?? [])
        : data.providerOutcomes,
      pendingProviders: catalog?.pendingProviders,
      providerUsage: data.providerUsage?.ok ? data.providerUsage.value : null,
      configProviders: config.providers,
    });
    const configuredProviderIds = new Set([
      ...config.providers.map(({ key }) => key),
      ...(data.authStatus?.providers
        .filter((provider) => Boolean(provider.apiKey) || provider.profiles.length > 0)
        .map((provider) => provider.provider) ?? []),
    ]);
    const advertised = isGatewayMethodAdvertised(gatewaySnapshot, "models.probe");
    const usageAvailable = isGatewayMethodAdvertised(gatewaySnapshot, "codex.accountUsage");
    const login = this.login.pageActions;
    const props: ModelProvidersViewProps = {
      installedAgents: undefined,
      providerQuery: this.providerQuery,
      onProviderQueryChange: (value) => (this.providerQuery = value),
      onConnectProvider: () => void this.login.open(),
      usageClient: !this.mutationBlockedReason() && usageAvailable ? gatewaySnapshot.client : null,
      usageAgentId: this.selectedAgentId,
      connected: gatewaySnapshot.phase === "connected",
      loading:
        gatewaySnapshot.phase === "connected" &&
        this.data === null &&
        !rosterError &&
        !noSelectableAgents,
      refreshing: this.core.loading,
      error: rosterError ?? (noSelectableAgents ? t("agents.noAgents") : data.error),
      providerUsageFailed: data.providerUsage?.ok === false,
      supplementalLoading: this.loaderPending || this.supplemental.loading,
      updatedAt: data.updatedAt,
      credentialAgentLabel: selected ? normalizeAgentLabel(selected) : this.selectedAgentId,
      cards: noSelectableAgents ? [] : this.installedAgents.filterProviders(cards),
      configuredModels,
      decisionModels: catalog?.decisionModels ?? [],
      defaultModels: defaults,
      authStatus: data.authStatus,
      automaticUtilityModel: catalog?.defaultModels?.automaticUtilityModel,
      utilityRuntime: catalog?.defaultModels?.utilityRuntime,
      thinkingLevel: defaults.thinkingLevel,
      thinkingOverridden: defaults.thinkingOverridden,
      fastMode: defaults.fastMode,
      fastModeOverridden: defaults.fastModeOverridden,
      catalogDiscovering: this.core.catalogLoading || Boolean(catalog?.pendingProviders?.length),
      catalogDiscoveryError: this.core.catalogLoading
        ? null
        : (this.core.catalogError ?? data.catalogError),
      configBusy: modelProviderConfigBusy(this.context),
      unconfiguredProviders: buildUnconfiguredProviderOptions(
        data.authStatus?.providerCapabilities,
        configuredProviderIds,
      ),
      canViewProfiles:
        gatewaySnapshot.phase === "connected" &&
        operatorAuth?.scopes !== undefined &&
        hasOperatorAdminAccess(operatorAuth),
      mutationBlockedReason: this.mutationBlockedReason(),
      defaultsMutationBlockedReason: modelProviderConfigMutationBlockedReason(this.context),
      providerUsageStalled: this.refreshPolicy.incompleteUsageExhausted,
      probeAvailable: advertised !== false,
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
        void (rosterError
          ? this.context.agents.refreshList()
          : Promise.all([
              this.context.runtimeConfig.refresh({ background: true }),
              this.refresh("forced"),
            ])),
      onOpenKeyEditor: (provider) => {
        this.keyEditorProvider = provider;
        this.keyDraft = "";
        this.setMessage(provider, null);
      },
      onCloseKeyEditor: () => this.closeKeyEditor(),
      onKeyDraftChange: (value) => (this.keyDraft = value),
      onSaveKey: (provider, configKey) =>
        void this.mutateApiKey(provider, configKey, this.keyDraft.trim()),
      onRemoveKey: (provider, configKey) => void this.mutateApiKey(provider, configKey, null),
      onProbe: (cardId, providers) => void this.profileActions.probe(cardId, providers),
      onRequestLogout: (pending) => void this.requestLogout(pending),
      onProfileOrderChange: (cardId, provider, profileIds) =>
        this.profileActions.setOrder(cardId, provider, profileIds),
      onAddProviderToggle: () => {
        this.addProviderOpen = !this.addProviderOpen;
        this.addProviderKey = "";
        this.setMessage("add", null);
      },
      onAddProviderKeyChange: (value) => (this.addProviderKey = value),
      onAddProvider: () => {
        const provider = this.addProviderId;
        if (provider) {
          void this.mutateApiKey(provider, provider, this.addProviderKey.trim(), "add");
        }
      },
      ...modelDefaultsActions(() => this.defaultsDraft ?? configuredDefaults, stageDefaults),
      onCatalogRetry: () => this.retryCatalog(),
      ...this.login.providerActions,
    };
    return {
      props,
      cards,
      installedAgentsAvailable: this.installedAgents.available(),
      scope: {
        agentLabel: selected ? normalizeAgentLabel(selected) : this.selectedAgentId,
        onConnect: login.onConnect,
        connectDisabled: login.connectDisabled || this.discovery.busy || this.addProviderOpen,
      },
      loginMessage: this.messages.connection ?? login.loginMessage,
      discovery: {
        agentLabel: selected ? normalizeAgentLabel(selected) : this.selectedAgentId,
        credentialChoices:
          data.authStatus?.providerCapabilities?.flatMap(
            (provider) => provider.loginOptions?.map((option) => option.id) ?? [],
          ) ?? [],
      },
    };
  }
}
