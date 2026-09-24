import { DEFAULT_GATEWAY_REQUEST_TIMEOUT_MS } from "@openclaw/gateway-client/browser";
import type { UserModelAccount } from "@openclaw/gateway-protocol";
import type { GatewayAgentRow, ModelCatalogEntry, ModelCatalogResult } from "../../api/types.ts";
import type { ApplicationContext } from "../../app/context.ts";
import { hasOperatorWriteAccess } from "../../app/operator-access.ts";
import type { DurableDraftModelSelection } from "../../lib/chat/composer-draft-store.runtime.ts";
import { buildQualifiedChatModelValue } from "../../lib/chat/model-ref.ts";
import { normalizeChatFastModeInput } from "../../lib/chat/model-select-state.ts";
import { normalizeThinkingOptionValue } from "../../lib/chat/thinking.ts";
import {
  hasUnrestrictedModelCatalogSnapshot,
  invalidateModelCatalogCache,
  isModelCatalogRetired,
  type ModelCatalogReadScope,
} from "../../lib/model-catalog-cache.ts";
import {
  loadModelCatalog,
  peekModelCatalog,
  resolveModelCatalogState,
  subscribeModelCatalogChanges,
} from "../../lib/model-catalog-store.ts";
import { normalizeAgentId } from "../../lib/sessions/session-key.ts";
import { requiresChatModelSetup } from "../chat/chat-model-setup.ts";
import { renderChatModelAccountControl } from "../chat/components/chat-model-account-control.ts";
import { renderChatModelControls } from "../chat/components/chat-model-controls.ts";
import { CatalogTargetDiscovery } from "./catalog-target.ts";
import type { DraftCloudProfile } from "./discovery.ts";
import {
  NewSessionModelSelection,
  type ModelSelectionChange,
  type NewSessionModelLoadOptions,
} from "./model-selection.ts";
import {
  reconcileDraftModelSelection,
  createEmptyDraftModelMetadata,
  isDraftAccountModelAvailable,
  resolveDraftDevicePlacementUnsupportedReason,
  resolveDraftCloudRuntimeUnsupportedReason,
  resolveDraftAgentRuntime,
  resolveDraftModelControls,
  resolveDraftModelTarget,
  resolveDraftModelUnavailableReason,
  resolveDraftModelSelectionBlockedReason,
  type NewSessionModelMetadata,
} from "./model-target.ts";
import { hasNewSessionModelPreference, type NewSessionPreference } from "./preferences.ts";

type NewSessionMetadataClient = NonNullable<ApplicationContext["gateway"]["snapshot"]["client"]>;

export class NewSessionModelControl extends NewSessionModelSelection {
  private selectionGeneration = 0;
  private initialModel: string | undefined;
  private initialModelPending = false;
  private agentId = "";
  private metadataState = createEmptyDraftModelMetadata();
  private metadataRequest: AbortController | undefined;
  private metadataClient: NewSessionMetadataClient | undefined;
  private metadataScope: ModelCatalogReadScope | undefined;
  private metadataIdentityId: string | undefined;
  private metadataGateway: ApplicationContext["gateway"] | undefined;
  private metadataHello: ApplicationContext["gateway"]["snapshot"]["hello"] | undefined;
  private metadataUnsubscribe: (() => void) | undefined;
  private draftAccount:
    | (Pick<UserModelAccount, "authProfileId" | "provider"> & { model: string })
    | undefined;
  private restoringPreference = false;
  private pendingPreference: NewSessionPreference | null | undefined;
  private pendingAgent: GatewayAgentRow | undefined;
  private pendingContext: ApplicationContext | undefined;
  private pendingSelectionGeneration = 0;
  private readonly catalogTargets: CatalogTargetDiscovery;

  constructor(
    private readonly notify: () => void,
    onSelectionChange: ModelSelectionChange = () => undefined,
    private readonly onCatalogTargetSelect: (catalogId: string) => void = () => undefined,
  ) {
    super(onSelectionChange);
    this.catalogTargets = new CatalogTargetDiscovery(notify);
  }

  private get catalog(): ModelCatalogEntry[] {
    return this.metadataState.catalog;
  }

  private get effectiveModel(): string {
    return this.draftAccount?.model ?? this.selected;
  }

  private clearMetadataSubscription() {
    this.metadataRequest?.abort();
    this.metadataRequest = undefined;
    this.metadataUnsubscribe?.();
    this.metadataUnsubscribe = undefined;
    this.metadataScope = undefined;
    this.metadataGateway = undefined;
  }

  private ownsMetadata(client: NewSessionMetadataClient, scope: ModelCatalogReadScope): boolean {
    const snapshot = this.pendingContext?.gateway.snapshot;
    return (
      this.metadataClient === client &&
      this.metadataGateway === this.pendingContext?.gateway &&
      this.metadataScope === scope &&
      snapshot?.phase === "connected" &&
      snapshot.client === client &&
      snapshot.hello === this.metadataHello &&
      snapshot.selfUser?.id === this.metadataIdentityId
    );
  }

  private bindMetadataSubscription(client: NewSessionMetadataClient, scope: ModelCatalogReadScope) {
    if (
      this.metadataScope &&
      this.metadataClient === client &&
      this.metadataGateway === this.pendingContext?.gateway &&
      this.metadataScope.agentId === scope.agentId &&
      this.metadataScope.authProfileId === scope.authProfileId &&
      this.metadataUnsubscribe
    ) {
      return this.metadataScope;
    }
    this.clearMetadataSubscription();
    this.metadataClient = client;
    this.metadataScope = scope;
    const gateway = this.pendingContext?.gateway;
    this.metadataGateway = gateway;
    this.metadataUnsubscribe = gateway
      ? subscribeModelCatalogChanges(
          gateway,
          (invalidation) => {
            if (!this.ownsMetadata(client, scope)) {
              this.restoringPreference = false;
              this.draftAccount = undefined;
              this.clearMetadataSubscription();
              this.updateMetadataState({ catalog: [], hasSnapshot: false, status: "offline" });
              return;
            }
            if (invalidation === "clear") {
              this.updateMetadataState({
                catalog: [],
                hasSnapshot: false,
                retired: true,
                status: "loading",
              });
            }
            void this.startMetadataRequest(client, scope);
          },
          scope,
        )
      : undefined;
    return scope;
  }

  loadCatalogTargets(context: ApplicationContext | undefined, agentId: string, enabled: boolean) {
    this.catalogTargets.load(context, agentId, enabled);
  }

  private updateMetadataState(next: NewSessionModelMetadata) {
    this.metadataState = {
      ...next,
      initialized:
        !next.retired &&
        next.status !== "offline" &&
        (next.hasSnapshot || hasUnrestrictedModelCatalogSnapshot(this.metadataClient)),
    };
    this.notify();
  }

  private assignMetadataCatalog(result: ModelCatalogResult, displayOnly = false) {
    this.metadataState = {
      ...this.metadataState,
      catalog: result.models,
      displayOnly,
      ...resolveModelCatalogState(result),
    };
  }

  private publishMetadataCatalog(result: ModelCatalogResult) {
    this.assignMetadataCatalog(result);
    this.metadataState.accountSelection = result.accountSelection;
    if (!this.draftAccount && this.pendingSelectionGeneration === this.selectionGeneration) {
      if (this.initialModelPending && !result.modelSelectionPolicy?.restricted) {
        this.resetSelection(this.initialModel);
      } else {
        this.restorePreference();
      }
    }
    this.initialModelPending = false;
    if (!this.draftAccount && result.modelSelectionPolicy?.restricted && this.selected) {
      const selection = reconcileDraftModelSelection({
        model: this.selected,
        agentRuntime: this.agentRuntime,
        thinkingLevel: this.thinkingLevel,
        fastMode: this.fastMode,
        modelSelectionPolicy: result.modelSelectionPolicy,
        catalog: result.models,
      });
      this.applyModelSelection(selection);
    }
    this.restoringPreference = false;
    this.notify();
  }

  private startMetadataRequest(client: NewSessionMetadataClient, scope: ModelCatalogReadScope) {
    this.metadataRequest?.abort();
    const cached = peekModelCatalog(client, scope);
    if (cached) {
      this.metadataRequest = undefined;
      this.publishMetadataCatalog(cached);
      return Promise.resolve(cached);
    }
    const controller = new AbortController();
    this.metadataRequest = controller;
    const ownsRequest = () =>
      this.metadataRequest === controller && this.ownsMetadata(client, scope);
    if (isModelCatalogRetired(client, scope)) {
      this.metadataState = { catalog: [], hasSnapshot: false, retired: true, status: "loading" };
    }
    const previousStatus = this.metadataState.status;
    const retained = peekModelCatalog(client, scope, { allowStale: true });
    if (retained && !this.metadataState.hasSnapshot) {
      this.assignMetadataCatalog(retained, true);
    }
    this.updateMetadataState({
      ...this.metadataState,
      status: this.metadataState.hasSnapshot
        ? previousStatus === "error"
          ? "error"
          : "ready"
        : "loading",
    });
    return loadModelCatalog(client, {
      ...scope,
      signal: controller.signal,
      timeoutMs: DEFAULT_GATEWAY_REQUEST_TIMEOUT_MS,
    }).then(
      (result) => {
        if (!ownsRequest()) {
          return undefined;
        }
        this.metadataRequest = undefined;
        this.publishMetadataCatalog(result);
        return result;
      },
      () => {
        if (!ownsRequest()) {
          return undefined;
        }
        this.metadataRequest = undefined;
        if (
          !this.metadataState.retired &&
          !this.metadataState.modelSelectionPolicy?.restricted &&
          !this.draftAccount &&
          this.pendingSelectionGeneration === this.selectionGeneration
        ) {
          if (this.initialModelPending) {
            this.resetSelection(this.initialModel);
            this.initialModelPending = false;
          } else if (this.pendingPreference) {
            this.selected = this.pendingPreference.model ?? "";
            this.agentRuntime = this.pendingPreference.agentRuntime;
            this.thinkingLevel = this.pendingPreference.thinkingLevel ?? "";
            this.fastMode = this.pendingPreference.fastMode;
          }
        }
        this.restoringPreference = false;
        this.updateMetadataState({ ...this.metadataState, status: "error" });
        return undefined;
      },
    );
  }

  private selectDraftAccount(account: UserModelAccount, model: string): Promise<boolean> {
    const client = this.metadataClient;
    if (!client || !model) {
      return Promise.resolve(false);
    }
    this.selectionGeneration += 1;
    this.restoringPreference = false;
    this.draftAccount = { authProfileId: account.authProfileId, provider: account.provider, model };
    const requestedScope = { agentId: this.agentId, authProfileId: account.authProfileId };
    this.metadataState = {
      catalog: [],
      accountSelection: this.metadataState.accountSelection,
      hasSnapshot: false,
      status: "loading",
    };
    const scope = this.bindMetadataSubscription(client, requestedScope);
    return this.startMetadataRequest(client, scope).then(
      (result) => Boolean(result) && this.ownsMetadata(client, scope),
    );
  }

  private clearDraftAccount() {
    if (!this.draftAccount) {
      return false;
    }
    this.draftAccount = undefined;
    this.clearMetadataSubscription();
    this.metadataState = createEmptyDraftModelMetadata();
    return true;
  }

  private retryPickerCatalogs() {
    const client = this.metadataClient;
    const scope = this.metadataScope;
    if (!this.metadataRequest && client && scope) {
      void this.startMetadataRequest(client, scope);
    }
    this.catalogTargets.retry(client, this.agentId);
  }

  invalidate(resetSelection = false) {
    if (!resetSelection && this.metadataClient) {
      invalidateModelCatalogCache(this.metadataClient, this.metadataScope);
    }
    this.clearDraftAccount();
    this.clearMetadataSubscription();
    this.catalogTargets.clear();
    this.restoringPreference = false;
    if (resetSelection) {
      this.pendingDraftSelection = undefined;
      this.agentId = "";
      this.metadataClient = undefined;
      this.resetSelection();
      this.initialModel = undefined;
      this.initialModelPending = false;
      this.updateMetadataState(createEmptyDraftModelMetadata());
      return;
    }
    this.updateMetadataState({
      ...this.metadataState,
      status: this.metadataState.hasSnapshot ? this.metadataState.status : "idle",
    });
  }

  reset() {
    this.invalidate(true);
  }

  load(
    context: ApplicationContext | undefined,
    agentId: string,
    enabled: boolean,
    options: NewSessionModelLoadOptions = {},
  ) {
    const snapshot = context?.gateway.snapshot;
    const client = snapshot?.client;
    const normalizedAgentId = agentId.trim() ? normalizeAgentId(agentId) : "";
    this.pendingContext = context;
    if (
      this.agentId !== normalizedAgentId ||
      (this.metadataClient && this.metadataClient !== client) ||
      (this.metadataGateway && this.metadataGateway !== context?.gateway) ||
      this.metadataIdentityId !== snapshot?.selfUser?.id ||
      (this.metadataHello && this.metadataHello !== snapshot?.hello)
    ) {
      // Model preferences belong to the agent; an explicit account belongs to this connection.
      // Neither its availability nor an in-flight preview can cross an identity change.
      this.draftAccount = undefined;
      this.clearMetadataSubscription();
      if (this.agentId !== normalizedAgentId) {
        this.resetSelection();
        this.initialModel = undefined;
        this.initialModelPending = false;
      }
      this.agentId = normalizedAgentId;
      this.metadataClient = undefined;
      this.metadataState = createEmptyDraftModelMetadata();
    }
    this.metadataIdentityId = snapshot?.selfUser?.id;
    this.metadataHello = snapshot?.hello;
    if (!context || snapshot?.phase !== "connected" || !client || !normalizedAgentId || !enabled) {
      this.clearDraftAccount();
      this.clearMetadataSubscription();
      this.metadataClient = undefined;
      this.restoringPreference = false;
      if (context && snapshot?.phase !== "connected") {
        this.metadataState = {
          catalog: [],
          hasSnapshot: false,
          status: "offline",
        };
      }
      this.notify();
      return;
    }
    const initialModel = options.initialModel;
    if (initialModel && initialModel !== this.initialModel) {
      this.resetSelection();
      this.selectionGeneration += 1;
      this.initialModel = initialModel;
      this.initialModelPending = true;
    }
    const selectionGeneration = this.selectionGeneration;
    const scope = {
      agentId: normalizedAgentId,
      ...(this.draftAccount ? { authProfileId: this.draftAccount.authProfileId } : {}),
    };
    const previousScope = this.metadataScope;
    const boundScope = this.bindMetadataSubscription(client, scope);
    const rebound = boundScope !== previousScope;
    this.pendingPreference = this.preferenceForDraft(options.preference, {
      policy: context.config?.current.newSessionModelDefaults,
      initialModel: this.initialModel,
      initialModelPending: this.initialModelPending,
    });
    this.pendingAgent = options.agent;
    this.pendingSelectionGeneration = selectionGeneration;
    this.applyPendingDraftSelection();
    this.restoringPreference =
      !this.draftAccount && hasNewSessionModelPreference(this.pendingPreference);
    if (this.metadataRequest) {
      this.notify();
      return;
    }
    // Render passes do not retry a failed read; publication events and picker opens do.
    if (!rebound && this.metadataState.status !== "idle") {
      if (
        this.metadataState.status === "ready" &&
        this.metadataState.hasSnapshot &&
        !this.draftAccount &&
        this.pendingSelectionGeneration === this.selectionGeneration
      ) {
        this.restorePreference();
      }
      this.restoringPreference = false;
      return;
    }
    void this.startMetadataRequest(client, boundScope);
  }

  isRestoringPreference(): boolean {
    return this.restoringPreference;
  }

  requiresModelSetup(
    state: Omit<
      Parameters<typeof requiresChatModelSetup>[0],
      "modelSelectionPolicy" | "catalogRetired" | "catalogInitialized"
    >,
  ): boolean {
    return requiresChatModelSetup({
      ...state,
      modelSelectionPolicy: this.metadataState.modelSelectionPolicy,
      catalogInitialized: this.metadataState.hasSnapshot && !this.metadataState.retired,
    });
  }

  modelUnavailableReason(agent: GatewayAgentRow | undefined) {
    return resolveDraftModelUnavailableReason({
      model: this.effectiveModel,
      agentRuntime: this.agentRuntime,
      metadata: this.metadataState,
      agent,
    });
  }

  modelSelectionBlockedReason(agent: GatewayAgentRow | undefined): string | undefined {
    return resolveDraftModelSelectionBlockedReason({
      model: this.effectiveModel,
      agentRuntime: this.agentRuntime,
      metadata: this.metadataState,
      agent,
      initialModelPending: this.initialModelPending,
      accountSelected: Boolean(this.draftAccount),
      accountReady: this.accountSelectionReady(),
      metadataPending: Boolean(this.metadataRequest),
    });
  }

  modelForSubmission(): string {
    // Scope inspection also reads this intent while the submit gate waits for its preview.
    // The account suffix never enters the plain model preferences.
    return this.draftAccount
      ? `${this.draftAccount.model}@${this.draftAccount.authProfileId}`
      : this.selected;
  }

  accountSelectionReady(): boolean {
    if (!this.draftAccount) {
      return true;
    }
    const selection = this.metadataState.accountSelection;
    if (
      !this.metadataClient ||
      !this.metadataScope ||
      !this.ownsMetadata(this.metadataClient, this.metadataScope) ||
      this.metadataRequest ||
      this.metadataState.status !== "ready" ||
      selection?.kind !== "personal" ||
      selection.authProfileId !== this.draftAccount.authProfileId
    ) {
      return false;
    }
    return isDraftAccountModelAvailable(this.draftAccount, this.catalog, this.agentRuntime);
  }

  private restorePreference() {
    const policy = this.metadataState.modelSelectionPolicy;
    this.restoreModelPreference(
      this.pendingPreference,
      {
        agent: this.pendingAgent,
        defaults: this.pendingContext?.sessions.state.result?.defaults,
        modelSelectionPolicy: policy,
        catalog: this.catalog,
      },
      !this.initialModelPending &&
        !policy?.restricted &&
        this.pendingContext?.config?.current.newSessionModelDefaults !== "configured" &&
        this.pendingContext?.config?.current.newSessionModelDefaults !== null,
    );
  }

  restoreDraftSelection(selection: DurableDraftModelSelection | undefined) {
    this.pendingDraftSelection = selection;
    if (!selection) {
      this.retireDraftSelection(true);
    }
    this.applyPendingDraftSelection();
  }

  retireDraftSelection(restoredOnly = false) {
    if (!this.retireModelSelection(restoredOnly)) {
      return;
    }
    this.pendingSelectionGeneration = ++this.selectionGeneration;
    this.pendingPreference = { fastMode: this.fastMode };
    // Account previews are draft-local, not the user’s persistent account preference.
    if (!restoredOnly && this.clearDraftAccount()) {
      this.load(this.pendingContext, this.agentId, true, { agent: this.pendingAgent });
    }
    this.notify();
  }

  private applyPendingDraftSelection() {
    const selection = this.takeDraftSelection(
      this.agentId,
      this.pendingContext?.config?.current.newSessionModelDefaults === "configured",
      this.pendingPreference?.fastMode,
    );
    if (!selection) {
      return;
    }
    // The durable scope includes URL intent. A later choice in that same draft wins on reload.
    this.selectionGeneration += 1;
    this.initialModelPending = false;
    this.pendingPreference = selection;
    this.pendingSelectionGeneration = this.selectionGeneration;
    if (this.metadataState.status === "ready") {
      this.restorePreference();
    }
    this.notify();
  }

  resolveAgentRuntime(
    options: {
      agent?: GatewayAgentRow;
      context: ApplicationContext | undefined;
    } = { agent: this.pendingAgent, context: this.pendingContext },
  ) {
    return resolveDraftAgentRuntime({
      model: this.effectiveModel,
      agentRuntime: this.agentRuntime,
      agent: options.agent,
      defaults: options.context?.sessions.state.result?.defaults,
      catalog: this.metadataState.displayOnly ? [] : this.catalog,
      modelSelectionPolicy: this.metadataState.modelSelectionPolicy,
      retired: this.metadataState.retired,
    });
  }

  devicePlacementUnsupportedReason(): string | undefined {
    return resolveDraftDevicePlacementUnsupportedReason(this.resolveAgentRuntime());
  }

  // Worker-turn runtimes rank automatic placement by free worker slots;
  // remote-exec runtimes select by eligible device order and must not be
  // described as least-busy. Unresolved (auto/default) runtimes fall back to
  // the worker-turn description, matching the server's default policy.
  autoPlacementSelectionMode(): "least-busy" | "eligible-order" {
    const runtime = this.resolveAgentRuntime();
    return runtime?.cloudPlacementExecutionMode === "remote-exec" ? "eligible-order" : "least-busy";
  }

  cloudRuntimeUnsupportedReason(profile?: DraftCloudProfile): string | undefined {
    return resolveDraftCloudRuntimeUnsupportedReason(this.resolveAgentRuntime(), profile);
  }

  render(options: {
    agent?: GatewayAgentRow;
    agentId: string;
    context: ApplicationContext | undefined;
    sending: boolean;
  }) {
    const snapshot = options.context?.gateway.snapshot;
    const sessionKey = `new-session:${normalizeAgentId(options.agentId)}`;
    const sourceResult = options.context?.sessions.state.result ?? null;
    const agentDefaultsAvailable = options.agent !== undefined;
    const { defaultTarget, ...modelControls } = resolveDraftModelControls({
      model: this.effectiveModel,
      selection: this,
      metadata: this.metadataState,
      agent: options.agent,
      defaults: sourceResult?.defaults,
    });
    const client = snapshot?.client;
    const scope = this.metadataScope;
    const accountSelection = this.metadataState.accountSelection;
    const ownsSelection = () =>
      Boolean(
        client &&
        scope &&
        this.ownsMetadata(client, scope) &&
        this.metadataState.accountSelection === accountSelection,
      );
    return renderChatModelControls({
      ...modelControls,
      renderAccountSection: (model) =>
        renderChatModelAccountControl({
          owner: this,
          client,
          selection: ownsSelection() && snapshot?.selfUser ? accountSelection : undefined,
          model,
          disabled:
            options.sending || !model || !hasOperatorWriteAccess(snapshot?.hello?.auth ?? null),
          ownsSelection,
          onSelect: (account) =>
            ownsSelection() ? this.selectDraftAccount(account, model) : Promise.resolve(false),
          onAutomatic: this.draftAccount
            ? () => {
                if (ownsSelection()) {
                  this.selectionGeneration += 1;
                  this.clearDraftAccount();
                  this.load(options.context, options.agentId, true, { agent: options.agent });
                }
              }
            : undefined,
          onManage: () => options.context?.navigate("profile"),
          onRequestUpdate: this.notify,
        }),
      activeRunId: null,
      connected: snapshot?.phase === "connected",
      gatewayAvailable: Boolean(snapshot?.client),
      loading: false,
      modelCatalog: this.catalog,
      modelOverrides: { [sessionKey]: this.effectiveModel || null },
      modelPickerTargetGroups: this.catalogTargets.groups(),
      modelSwitching: false,
      sending: options.sending,
      sessionKey,
      selectedSession: undefined,
      selectedAgentRuntime: this.agentRuntime,
      sessionsResult: agentDefaultsAvailable ? sourceResult : null,
      stream: null,
      onModelSelect: (value, _sessionKey, agentRuntime) => {
        this.selectionGeneration += 1;
        this.initialModelPending = false;
        this.restoringPreference = false;
        const selection = reconcileDraftModelSelection({
          model: value,
          agentRuntime: agentRuntime ?? undefined,
          thinkingLevel: this.thinkingLevel,
          fastMode: this.fastMode,
          agent: options.agent,
          defaults: options.context?.sessions.state.result?.defaults,
          modelSelectionPolicy: this.metadataState.modelSelectionPolicy,
          catalog: this.catalog,
        });
        if (
          selection.model === this.effectiveModel &&
          selection.agentRuntime === this.agentRuntime &&
          selection.fastMode === this.fastMode &&
          normalizeThinkingOptionValue(selection.thinkingLevel) ===
            normalizeThinkingOptionValue(this.thinkingLevel)
        ) {
          return;
        }
        this.metadataState.displayOnly = false;
        const runtimeChanged = this.agentRuntime !== selection.agentRuntime;
        this.applyModelSelection(selection);
        this.markExplicitSelection();
        const target =
          resolveDraftModelTarget(selection.model, undefined, this.catalog, this.agentRuntime) ??
          defaultTarget;
        if (this.draftAccount && this.draftAccount.provider !== target?.provider) {
          this.clearDraftAccount();
          this.load(options.context, options.agentId, true, { agent: options.agent });
        } else if (this.draftAccount && target) {
          this.draftAccount = {
            ...this.draftAccount,
            model: buildQualifiedChatModelValue(target.model, target.provider),
          };
        }
        this.contextWindow = "";
        this.persistSelection(runtimeChanged ? (this.agentRuntime ?? "") : undefined);
        this.onDraftSelectionChange?.();
      },
      onModelPickerTargetSelect: (groupId, catalogId) => {
        if (groupId === "cliAgents") {
          this.onCatalogTargetSelect(catalogId);
        }
      },
      onModelPickerTargetRetry: (groupId) => {
        if (groupId === "cliAgents") {
          this.catalogTargets.retry(this.metadataClient, this.agentId);
        }
      },
      onThinkingSelect: (value) => {
        this.selectionGeneration += 1;
        this.restoringPreference = false;
        this.thinkingLevel = value;
        this.markExplicitSelection();
        this.persistSelection();
        this.onDraftSelectionChange?.();
      },
      onFastModeSelect: (value) => {
        this.selectionGeneration += 1;
        this.restoringPreference = false;
        this.fastModeSelected = true;
        this.fastMode = normalizeChatFastModeInput(value);
        this.persistSelection();
        this.notify();
      },
      onContextWindowSelect: (value) => {
        this.selectionGeneration += 1;
        this.restoringPreference = false;
        this.contextWindow = value;
        this.notify();
      },
      onModelSetup: () => options.context?.navigate("model-setup"),
      onModelPickerOpen: () => this.retryPickerCatalogs(),
      onRequestUpdate: this.notify,
    });
  }
}
