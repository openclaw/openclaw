import { DEFAULT_GATEWAY_REQUEST_TIMEOUT_MS } from "@openclaw/gateway-client/browser";
import type { ChatAccountSelection, UserModelAccount } from "@openclaw/gateway-protocol";
import type {
  FastMode,
  GatewayAgentRow,
  ModelCatalogEntry,
  ModelCatalogResult,
} from "../../api/types.ts";
import type { ApplicationContext } from "../../app/context.ts";
import { hasOperatorWriteAccess } from "../../app/operator-access.ts";
import { t } from "../../i18n/index.ts";
import { registerModelControlsEnglish } from "../../i18n/locales/en-model-controls.ts";
import { buildQualifiedChatModelValue } from "../../lib/chat/model-ref.ts";
import {
  isChatFastModeProviderSupported,
  chatModelUnavailableMessage,
  normalizeChatFastModeInput,
} from "../../lib/chat/model-select-state.ts";
import { normalizeThinkingOptionValue } from "../../lib/chat/thinking.ts";
import {
  invalidateModelCatalogCache,
  type ModelCatalogReadScope,
} from "../../lib/model-catalog-cache.ts";
import {
  loadModelCatalog,
  peekModelCatalog,
  resolveModelCatalogState,
  subscribeModelCatalogChanges,
} from "../../lib/model-catalog-store.ts";
import { normalizeAgentId } from "../../lib/sessions/session-key.ts";
import { renderChatModelAccountControl } from "../chat/components/chat-model-account-control.ts";
import {
  renderChatModelControls,
  type ChatModelCatalogState,
} from "../chat/components/chat-model-controls.ts";
import { CatalogTargetDiscovery } from "./catalog-target.ts";
import type { DraftCloudProfile } from "./discovery.ts";
import {
  reconcileDraftModelSelection,
  resolveDraftDevicePlacementUnsupportedReason,
  resolveDraftCloudRuntimeUnsupportedReason,
  resolveDraftAgentRuntime,
  resolveDraftContextWindowTarget,
  resolveDraftModelTarget,
  resolveDraftModelUnavailableReason,
  resolveDraftThinkingDefaults,
  resolveDraftThinkingTarget,
} from "./model-target.ts";
import type { NewSessionPreference } from "./preferences.ts";

registerModelControlsEnglish();

type NewSessionMetadataClient = NonNullable<ApplicationContext["gateway"]["snapshot"]["client"]>;
type NewSessionMetadataState = ChatModelCatalogState & {
  catalog: ModelCatalogEntry[];
  accountSelection?: ChatAccountSelection;
  displayOnly?: boolean;
};
type NewSessionMetadataLoadOptions = {
  agent?: GatewayAgentRow;
  preference?: NewSessionPreference | null;
  initialModel?: string;
};

export class NewSessionModelControl {
  private selectionGeneration = 0;
  private initialModel: string | undefined;
  private agentId = "";
  private metadataState: NewSessionMetadataState = {
    catalog: [],
    hasSnapshot: false,
    status: "idle",
  };
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
  selected = "";
  agentRuntime: string | undefined;
  contextWindow = "";
  thinkingLevel = "";
  fastMode: FastMode | undefined;

  constructor(
    private readonly notify: () => void,
    private readonly onSelectionChange: (selection: {
      model: string;
      agentRuntime?: string;
      thinkingLevel: string;
    }) => void = () => undefined,
    private readonly onCatalogTargetSelect: (catalogId: string) => void = () => undefined,
  ) {
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
          () => {
            if (!this.ownsMetadata(client, scope)) {
              this.restoringPreference = false;
              this.draftAccount = undefined;
              this.clearMetadataSubscription();
              this.updateMetadataState({ catalog: [], hasSnapshot: false, status: "offline" });
              return;
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

  private updateMetadataState(next: NewSessionMetadataState) {
    this.metadataState = next;
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
      this.restorePreference();
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
          !this.draftAccount &&
          this.pendingSelectionGeneration === this.selectionGeneration &&
          (this.pendingPreference?.model || this.pendingPreference?.thinkingLevel)
        ) {
          this.selected = this.pendingPreference.model ?? "";
          this.agentRuntime = this.pendingPreference.agentRuntime;
          this.thinkingLevel = this.pendingPreference.thinkingLevel ?? "";
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
      return;
    }
    this.draftAccount = undefined;
    this.clearMetadataSubscription();
    this.metadataState = { catalog: [], hasSnapshot: false, status: "idle" };
  }

  private retryPickerCatalogs() {
    const client = this.metadataClient;
    const scope = this.metadataScope;
    if (!this.metadataRequest && client && scope) {
      void this.startMetadataRequest(client, scope);
    }
    this.catalogTargets.retry(client, this.agentId);
  }

  private resetSelection(model = "") {
    this.selected = model;
    this.agentRuntime = undefined;
    this.contextWindow = "";
    this.thinkingLevel = "";
    this.fastMode = undefined;
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
      this.agentId = "";
      this.metadataClient = undefined;
      this.resetSelection();
      this.initialModel = undefined;
      this.updateMetadataState({
        catalog: [],
        hasSnapshot: false,
        status: "idle",
      });
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
    options: NewSessionMetadataLoadOptions = {},
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
      }
      this.agentId = normalizedAgentId;
      this.metadataClient = undefined;
      this.metadataState = {
        catalog: [],
        hasSnapshot: false,
        status: "idle",
      };
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
      this.resetSelection(initialModel);
      this.selectionGeneration += 1;
      this.initialModel = initialModel;
    }
    const selectionGeneration = this.selectionGeneration;
    const scope = {
      agentId: normalizedAgentId,
      ...(this.draftAccount ? { authProfileId: this.draftAccount.authProfileId } : {}),
    };
    const previousScope = this.metadataScope;
    const boundScope = this.bindMetadataSubscription(client, scope);
    const rebound = boundScope !== previousScope;
    // URL intent seeds this draft once; saved preferences and catalog refreshes cannot replace it.
    this.pendingPreference = this.initialModel ? undefined : options.preference;
    this.pendingAgent = options.agent;
    this.pendingSelectionGeneration = selectionGeneration;
    this.restoringPreference = Boolean(
      !this.draftAccount &&
      (this.pendingPreference?.model || this.pendingPreference?.thinkingLevel),
    );
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

  modelUnavailableReason(agent: GatewayAgentRow | undefined) {
    return this.metadataState.hasSnapshot && this.metadataState.status !== "offline"
      ? resolveDraftModelUnavailableReason({
          model: this.effectiveModel || agent?.model?.primary,
          catalog: this.catalog,
          agentRuntime: this.agentRuntime,
        })
      : undefined;
  }

  modelSelectionBlockedReason(agent: GatewayAgentRow | undefined): string | undefined {
    if (
      this.agentRuntime &&
      this.metadataState.hasSnapshot &&
      !resolveDraftModelTarget(this.effectiveModel, undefined, this.catalog, this.agentRuntime)
        ?.entry
    ) {
      return t("chat.modelControls.modelsUnavailable");
    }
    if (this.draftAccount) {
      if (this.metadataState.status === "error") {
        return t("chat.modelControls.modelsUnavailable");
      }
      if (this.metadataRequest || !this.metadataState.hasSnapshot) {
        return t("chat.modelControls.loadingModels");
      }
      if (!this.accountSelectionReady()) {
        return (
          chatModelUnavailableMessage(this.modelUnavailableReason(agent)) ??
          t("chat.modelControls.modelsUnavailable")
        );
      }
    }
    return chatModelUnavailableMessage(this.modelUnavailableReason(agent));
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
    const target = resolveDraftModelTarget(
      this.draftAccount.model,
      undefined,
      this.catalog,
      this.agentRuntime,
    );
    return target?.entry?.available === true && target.provider === this.draftAccount.provider;
  }

  private restorePreference() {
    const preference = this.pendingPreference;
    if (!preference) {
      return;
    }
    const selection = reconcileDraftModelSelection({
      model: preference.model ?? "",
      agentRuntime: preference.agentRuntime,
      thinkingLevel: preference.thinkingLevel ?? "",
      agent: this.pendingAgent,
      defaults: this.pendingContext?.sessions.state.result?.defaults,
      catalog: this.catalog,
    });
    this.selected = selection.model;
    this.agentRuntime = selection.agentRuntime;
    this.thinkingLevel = selection.thinkingLevel;
    if (selection.repaired) {
      this.onSelectionChange({
        model: selection.model,
        ...(preference.agentRuntime ? { agentRuntime: this.agentRuntime ?? "" } : {}),
        thinkingLevel: selection.thinkingLevel,
      });
    }
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
    const agentDefaultModel = options.agent?.model?.primary;
    const defaultTarget = resolveDraftModelTarget(
      agentDefaultModel ?? sourceResult?.defaults.model,
      agentDefaultModel ? undefined : sourceResult?.defaults.modelProvider,
      this.catalog,
    );
    const selectedTarget = resolveDraftModelTarget(
      this.effectiveModel,
      undefined,
      this.catalog,
      this.agentRuntime,
    );
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
    const thinkingDefaults = resolveDraftThinkingDefaults(
      defaultTarget,
      options.agent,
      sourceResult?.defaults,
      this.catalog,
    );
    return renderChatModelControls({
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
      agentDefaultModel,
      connected: snapshot?.phase === "connected",
      gatewayAvailable: Boolean(snapshot?.client),
      loading: false,
      modelCatalog: this.catalog,
      modelCatalogState: {
        // The model catalog and agents.list hydrate independently. Do not expose a
        // ready catalog until the selected agent can supply its concrete defaults.
        hasSnapshot: agentDefaultsAvailable && this.metadataState.hasSnapshot,
        refreshFailed: this.metadataState.refreshFailed,
        pendingProviders: this.metadataState.pendingProviders,
        status:
          !agentDefaultsAvailable && this.metadataState.status !== "error"
            ? "loading"
            : this.metadataState.status,
      },
      contextWindowTarget: resolveDraftContextWindowTarget(
        selectedTarget?.entry ?? defaultTarget?.entry,
        this.contextWindow,
      ),
      fastModeTarget: {
        agentRuntime: selectedTarget?.entry?.agentRuntime ?? defaultTarget?.entry?.agentRuntime,
        model: selectedTarget?.model ?? defaultTarget?.model,
        modelProvider: selectedTarget?.provider ?? defaultTarget?.provider ?? undefined,
        fastMode: this.fastMode,
        effectiveFastMode:
          this.fastMode ?? (selectedTarget?.entry ?? defaultTarget?.entry)?.effectiveFastMode,
      },
      modelOverrides: { [sessionKey]: this.effectiveModel || null },
      modelPickerTargetGroups: this.catalogTargets.groups(),
      modelSwitching: false,
      sending: options.sending,
      sessionKey,
      selectedSession: undefined,
      selectedAgentRuntime: this.agentRuntime,
      sessionsResult: agentDefaultsAvailable ? sourceResult : null,
      stream: null,
      thinkingDefaults,
      thinkingSession: resolveDraftThinkingTarget(selectedTarget, undefined, this),
      onModelSelect: (value, _sessionKey, agentRuntime) => {
        this.selectionGeneration += 1;
        this.restoringPreference = false;
        const selection = reconcileDraftModelSelection({
          model: value,
          agentRuntime: agentRuntime ?? undefined,
          thinkingLevel: this.thinkingLevel,
          agent: options.agent,
          defaults: options.context?.sessions.state.result?.defaults,
          catalog: this.catalog,
        });
        if (
          selection.model === this.effectiveModel &&
          selection.agentRuntime === this.agentRuntime &&
          normalizeThinkingOptionValue(selection.thinkingLevel) ===
            normalizeThinkingOptionValue(this.thinkingLevel)
        ) {
          return;
        }
        this.metadataState.displayOnly = false;
        this.selected = selection.model;
        const runtimeChanged = this.agentRuntime !== selection.agentRuntime;
        this.agentRuntime = selection.agentRuntime;
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
        this.thinkingLevel = selection.thinkingLevel;
        this.fastMode = isChatFastModeProviderSupported(target?.provider)
          ? this.fastMode
          : undefined;
        this.onSelectionChange({
          model: selection.model,
          ...(runtimeChanged || this.agentRuntime ? { agentRuntime: this.agentRuntime ?? "" } : {}),
          thinkingLevel: this.thinkingLevel,
        });
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
        this.onSelectionChange({
          model: this.selected,
          ...(this.agentRuntime ? { agentRuntime: this.agentRuntime } : {}),
          thinkingLevel: this.thinkingLevel,
        });
      },
      onFastModeSelect: (value) => {
        this.selectionGeneration += 1;
        this.restoringPreference = false;
        this.fastMode = normalizeChatFastModeInput(value);
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
