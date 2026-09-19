import { consume } from "@lit/context";
import type { PropertyValues } from "lit";
import { property, state } from "lit/decorators.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type {
  SystemAgentSetupActivateParams,
  SystemAgentSetupActivateResult,
  SystemAgentSetupDetectResult,
} from "../../api/types.ts";
import { applicationContext, type ApplicationContext } from "../../app/context.ts";
import { hasOperatorAdminAccess } from "../../app/operator-access.ts";
import { t } from "../../i18n/index.ts";
import { isGatewayMethodAdvertised } from "../../lib/gateway-methods.ts";
import { readSessionDefaults } from "../../lib/sessions/session-key.ts";
import { OpenClawLightDomElement } from "../../lit/openclaw-element.ts";
import { SubscriptionsController } from "../../lit/subscriptions-controller.ts";
import { ModelProviderLoginController } from "../model-providers/login-controller.ts";
import {
  captureModelSetupConnection,
  modelSetupAgentSelection,
  reconcileModelSetupConnection,
  FirstRunSetup,
  type ModelSetupRouteData,
} from "./first-run-setup.ts";
import { ModelSetupIconLoader } from "./model-setup-icon-loader.ts";
import { createModelSetupDetectionTask, formatModelSetupError } from "./model-setup-task-result.ts";
import {
  findPreparedModelCandidate,
  type ModelSetupPrepareOption,
  preparedModelActivation,
} from "./prepare-options.ts";
import { focusManualProviderInput, manualProviderActivation } from "./provider-picker.ts";
import { createModelSetupVerifyTask, detectModelSetup } from "./rpc.ts";
import {
  activationTargetId,
  preparedModelPageState,
  updateModelSetupWizardDraft,
  mapActivationResult,
  type ModelSetupActivationState,
  type ModelSetupPageState,
  type ModelSetupVerifyState,
  type ModelSetupWizardState,
  type ModelSetupWizardDraft,
} from "./state.ts";
import { renderModelSetup, revealModelSetupFeedback } from "./view.ts";
import { ModelSetupWizardRunner, type ModelSetupWizardCompletion } from "./wizard-runner.ts";

export type { ModelSetupRouteData } from "./first-run-setup.ts";
export { resumeFirstRunActivation } from "./first-run-activation-receipt.ts";

export class ModelSetupPage extends OpenClawLightDomElement {
  private readonly actionsDisabled = (): boolean =>
    this.login.busy ||
    this.activationState.phase === "testing" ||
    this.verifyState.phase === "checking" ||
    this.wizardMutationActive ||
    (this.wizardState.phase !== "idle" &&
      this.wizardState.phase !== "error" &&
      this.wizardState.phase !== "cancelled");

  @consume({ context: applicationContext, subscribe: true })
  private context!: ApplicationContext;

  @property({ attribute: false }) routeData: ModelSetupRouteData | undefined;
  @property({ type: Boolean }) embedded = false;
  @property() agentLabel = "";
  @property({ attribute: false }) credentialChoices: readonly string[] = [];
  @property({ attribute: false }) onClose: (() => void) | undefined;
  @property({ attribute: false }) onConnectChoice: ((authChoice?: string) => void) | undefined;

  @state() private pageState: ModelSetupPageState = { phase: "loading" };
  @state() private activationState: ModelSetupActivationState = { phase: "idle" };
  @state() private verifyState: ModelSetupVerifyState = { phase: "idle" };
  @state() private wizardState: ModelSetupWizardState = { phase: "idle" };
  @state() private wizardMode: "auth" | "prepare" | "activate" = "auth";
  @state() private wizardDraft: ModelSetupWizardDraft = { stepId: null, value: undefined };
  @state() private manualProviderId = "";
  @state() private manualApiKey = "";
  @state() private manualError: string | null = null;
  @state() private moreSignInOpen = false;
  @state() private nativeSessionCatalogsEnabled = false;
  @state() private iconUrls: Record<string, string> = {};
  @state() private setupRefreshWarning: string | null = null;
  @state() private detectionError: string | null = null;
  @state() private detectionRequest: object | null = null;
  @state() private cancellationNotice: string | null = null;

  private get agentSelection() {
    return modelSetupAgentSelection(this.context, this.routeData?.firstRun === true);
  }

  private observedConnection: ReturnType<typeof captureModelSetupConnection> | null = null;
  private pendingPrepareOption: ModelSetupPrepareOption | null = null;
  private wizardMutationGeneration = 0;
  private wizardMutationActive = false;
  private wizardReturnFocus: HTMLElement | null = null;
  private readonly firstRun = new FirstRunSetup({
    context: () => this.context,
    routeData: () => this.routeData,
    pageState: () => this.pageState,
    activationState: () => this.activationState,
    actionsDisabled: () => this.actionsDisabled() || this.detectionRequest !== null,
    canUseSetup: (client) => this.canUseSetup(client),
    canVerify: (client) => this.canVerify(client),
    verify: (modelTarget) => this.verifyConnection(modelTarget).then(() => this.verifyTask.value),
    setVerifyState: (next) => (this.verifyState = next),
    setActivationState: (next) => (this.activationState = next),
    setRefreshWarning: (warning) => (this.setupRefreshWarning = warning),
  });
  private readonly iconLoader = new ModelSetupIconLoader(
    () => this.context,
    () => this.pageState,
    (urls) => (this.iconUrls = urls),
  );
  private readonly login = new ModelProviderLoginController(this, {
    getScope: () => ({ context: this.context, agentId: this.agentSelection.state.selectedId }),
    canStart: () =>
      this.canUseSetup(this.context.gateway.snapshot.client) &&
      !this.firstRun.unresolved &&
      !this.actionsDisabled(),
    canContinue: () =>
      this.canUseSetup(this.context.gateway.snapshot.client) && !this.firstRun.unresolved,
    refresh: () => this.detect(),
  });
  private readonly subscriptions = new SubscriptionsController(this)
    .watch(
      () => this.context?.gateway,
      (gateway, notify) => gateway.subscribe(notify),
      (gateway) => this.synchronizeGateway(gateway.snapshot),
    )
    .watch(
      () => this.context && this.agentSelection,
      (selection, notify) => selection.subscribe(notify),
      () => this.synchronizeGateway(this.context.gateway.snapshot),
    )
    .watch(
      () => this.firstRun,
      (firstRun, notify) => firstRun.subscribe(notify),
    );
  private readonly wizard = new ModelSetupWizardRunner({
    getClient: () => this.context?.gateway.snapshot.client ?? null,
    getAgentId: () => this.agentSelection.state.selectedId ?? null,
    onChange: (next) => {
      if (next.phase !== "starting" && next.phase !== "done") {
        this.activationState = { phase: "idle" };
      }
      this.wizardState =
        next.phase === "step" && this.wizardMutationActive ? { ...next, busy: true } : next;
      this.wizardDraft = updateModelSetupWizardDraft(this.wizardDraft, next);
      if (next.phase === "idle") {
        this.cancellationNotice = null;
      }
    },
    onStart: (method, intent) => {
      if (method === "openclaw.setup.prepare.start") {
        return undefined;
      }
      const activation = this.firstRun.beginActivation(intent ?? { kind: "provider-auth" });
      return (result) => {
        this.firstRun.recordActivation(activation, result);
        this.requestUpdate();
        return () => this.firstRun.ownsActivation(activation);
      };
    },
    onBackgroundCompletion: (completion) =>
      this.runWizardMutation(() => Promise.resolve(completion), true),
    requestFailedMessage: () => t("modelSetup.errors.requestFailed"),
    cancelledMessage: () => t("modelSetup.wizard.cancelled"),
    sessionExpiredMessage: () => t("modelSetup.wizard.sessionExpired"),
  });

  private readonly detectTask = createModelSetupDetectionTask(
    this,
    () => this.context.gateway.snapshot.hello,
    detectModelSetup,
    (outcome) => {
      if (
        this.detectionRequest !== outcome.token ||
        this.context.gateway.snapshot.client !== outcome.client ||
        this.context.gateway.snapshot.hello !== outcome.hello ||
        this.agentSelection.state.selectedId !== outcome.agentId
      ) {
        return;
      }
      this.detectionRequest = null;
      if ("error" in outcome) {
        const message = formatModelSetupError(outcome.error);
        if (this.pageState.phase === "ready") {
          this.detectionError = message;
        } else {
          this.firstRun.setReadyConnection(null);
          this.pageState = { phase: "detect-error", message };
        }
        return;
      }
      this.detectionError = null;
      this.firstRun.setReadyConnection({
        client: outcome.client,
        hello: outcome.hello,
        agentId: outcome.agentId,
      });
      this.pageState = { phase: "ready", result: outcome.value };
      if (
        !outcome.value.manualProviders.some((provider) => provider.id === this.manualProviderId)
      ) {
        this.manualProviderId = "";
      }
    },
  );

  private readonly verifyTask = createModelSetupVerifyTask(this);

  override disconnectedCallback() {
    this.firstRun.dispose();
    this.resetActivity();
    this.observedConnection = null;
    this.subscriptions.clear();
    super.disconnectedCallback();
  }

  override willUpdate() {
    this.synchronizeGateway(this.context.gateway.snapshot);
  }

  override updated(changed: PropertyValues) {
    // Do not rearm setup work when Lit finishes queued updates after detachment.
    if (!this.isConnected) {
      return;
    }
    if (changed.has("activationState") && this.activationState.phase !== "idle") {
      revealModelSetupFeedback(this.renderRoot);
    }
    if (this.wizardState.phase !== "idle") {
      this.querySelector("openclaw-modal-dialog")?.setReturnFocusTarget(this.wizardReturnFocus);
    }
    this.iconLoader.reconcile();
    this.firstRun.start();
  }

  private synchronizeGateway(snapshot: ApplicationContext["gateway"]["snapshot"]): void {
    const routeData = this.routeData;
    if (!this.isConnected || !routeData) {
      return;
    }
    const previous = this.observedConnection;
    const observation = reconcileModelSetupConnection(
      previous,
      captureModelSetupConnection(this.context, routeData.firstRun, previous?.recoveryScope),
    );
    if (observation.kind === "unchanged") {
      return;
    }
    const connection = observation.connection;
    this.observedConnection = connection;
    if (observation.kind === "pending") {
      if (!this.wizard.hasAdmittedSession) {
        this.pageState = { phase: "loading" };
      }
      this.wizard.suspend();
      return;
    }
    const authenticatedOwnerLost =
      previous &&
      (!connection.recoveryScope || connection.recoveryScope !== previous.recoveryScope);
    const ownerChanged =
      previous &&
      (connection.agentId !== previous.agentId ||
        connection.selectionIntentRevision !== previous.selectionIntentRevision ||
        connection.firstRun !== previous.firstRun ||
        connection.connectionRevision !== previous.connectionRevision ||
        authenticatedOwnerLost);
    const setupAuthorityLost =
      connection.connected && !hasOperatorAdminAccess(snapshot.hello?.auth ?? null);
    if (authenticatedOwnerLost || setupAuthorityLost) {
      // A changed identity or reduced authority cannot cancel the old wizard.
      // Retire local handles and expose the existing access/recovery state.
      this.wizard.close({ retireOwner: true });
    }
    if (ownerChanged) {
      this.nativeSessionCatalogsEnabled = false;
      this.manualProviderId = "";
      this.manualApiKey = "";
      this.manualError = null;
    }
    const sameWizardOwner = previous && Boolean(connection.recoveryScope) && !ownerChanged;
    if (sameWizardOwner && this.wizard.hasAdmittedSession) {
      this.wizardMutationGeneration += 1;
      this.wizardMutationActive = false;
      this.wizard.suspend();
      if (this.canUseSetup(connection.client)) {
        this.firstRun.reconnectActivation(connection);
        void this.runWizardMutation(() => this.wizard.resume());
      }
      return;
    }
    // The router refreshes cached loader objects during the same visit. Only
    // a mode change or mounted/connection lifecycle can retire setup ownership.
    if (connection.firstRun !== previous?.firstRun) {
      this.firstRun.routeChanged();
    } else {
      this.firstRun.connectionChanged(connection);
    }
    this.resetActivity();
    this.pageState = { phase: "loading" };
    if (this.canUseSetup(connection.client)) {
      void this.detect();
    }
  }

  private resetActivity(): void {
    this.login.reset();
    this.detectionRequest = null;
    this.detectionError = null;
    this.wizardMutationGeneration += 1;
    this.wizardMutationActive = false;
    void this.detectTask.run([null, null, null]);
    this.activationState = { phase: "idle" };
    this.resetVerify();
    this.iconLoader.reset();
    this.pendingPrepareOption = null;
    void this.wizard.cancel();
  }

  private canUseSetup(client: GatewayBrowserClient | null): client is GatewayBrowserClient {
    const snapshot = this.context.gateway.snapshot;
    return Boolean(
      client &&
      (this.routeData?.firstRun === true || this.agentSelection.state.selectedId !== null) &&
      snapshot.phase === "connected" &&
      hasOperatorAdminAccess(snapshot.hello?.auth ?? null) &&
      isGatewayMethodAdvertised(snapshot, "openclaw.setup.detect") === true,
    );
  }

  private async detect(): Promise<SystemAgentSetupDetectResult | null> {
    const client = this.context.gateway.snapshot.client;
    if (!this.canUseSetup(client) || this.detectionRequest) {
      return null;
    }
    this.resetVerify();
    this.detectionError = null;
    // Only a cold load replaces the content. Same-owner rescans keep forms and
    // focus mounted; a changed connection clears them in synchronizeGateway.
    if (this.pageState.phase !== "ready") {
      this.pageState = { phase: "loading" };
    }
    const token = {};
    this.detectionRequest = token;
    await this.detectTask.run([client, this.agentSelection.state.selectedId, token]);
    const outcome = this.detectTask.value;
    return outcome?.token === token && "value" in outcome ? outcome.value : null;
  }

  private canVerify(client: GatewayBrowserClient | null): client is GatewayBrowserClient {
    const snapshot = this.context.gateway.snapshot;
    return (
      this.canUseSetup(client) &&
      isGatewayMethodAdvertised(snapshot, "openclaw.setup.verify") === true
    );
  }

  private resetVerify(): void {
    this.verifyState = { phase: "idle" };
    void this.verifyTask.run([null, null, undefined]);
  }

  private async verifyConnection(modelTarget?: "utility"): Promise<void> {
    const client = this.context.gateway.snapshot.client;
    if (!this.canVerify(client) || this.actionsDisabled() || this.detectionRequest) {
      return;
    }
    this.verifyState = { phase: "checking" };
    await this.verifyTask.run([client, this.agentSelection.state.selectedId, modelTarget]);
  }

  private async activate(params: SystemAgentSetupActivateParams, targetId: string): Promise<void> {
    const client = this.context.gateway.snapshot.client;
    if (
      !this.canUseSetup(client) ||
      this.actionsDisabled() ||
      this.detectionRequest ||
      this.firstRun.unresolved
    ) {
      return;
    }
    this.manualError = null;
    this.activationState = { phase: "testing", targetId };
    this.pendingPrepareOption = null;
    this.wizardMode = "activate";
    await this.runWizardMutation(() =>
      this.wizard.activate({ ...params, ...this.nativeSessionCatalogPreference() }, targetId),
    );
  }

  private nativeSessionCatalogPreference(): { nativeSessionCatalogsEnabled?: boolean } {
    return this.pageState.phase === "ready" &&
      this.pageState.result.nativeSessionCatalogPreferenceRequired === true
      ? { nativeSessionCatalogsEnabled: this.nativeSessionCatalogsEnabled }
      : {};
  }

  private finishActivation(
    result: SystemAgentSetupActivateResult,
    targetId: string,
    refreshError: string | null,
  ): void {
    this.activationState = mapActivationResult({
      result,
      targetId,
      fallbackError: t("modelSetup.errors.activationFailed"),
      restartWarning: t("labsPage.restartRequired"),
      refreshWarning: refreshError,
    });
    if (this.activationState.phase === "success") {
      this.manualApiKey = "";
    }
    this.firstRun.finishActivation(result, targetId, refreshError);
  }

  private connectManual(): void {
    const activation = manualProviderActivation(
      this.pageState.phase === "ready" ? this.pageState.result.manualProviders : [],
      this.manualProviderId,
      this.manualApiKey,
    );
    if (!activation) {
      this.manualError = t("modelSetup.manual.required");
      return;
    }
    void this.activate(activation, `manual:${this.manualProviderId}`);
  }

  private selectManualProvider(providerId: string): void {
    if (providerId !== this.manualProviderId) {
      this.manualApiKey = "";
    }
    this.manualProviderId = providerId;
    this.manualError = null;
  }

  private async handleWizardDone({
    startMethod,
    preparedModelRef,
    activationTargetId: targetId,
    modelActivation,
    isCurrent,
  }: ModelSetupWizardCompletion): Promise<void> {
    const prepareOption =
      startMethod === "openclaw.setup.prepare.start" ? this.pendingPrepareOption : null;
    const nativeSessionCatalogPreference = this.nativeSessionCatalogPreference();
    this.pendingPrepareOption = null;
    if (prepareOption && preparedModelRef) {
      const candidate = preparedModelActivation(prepareOption, preparedModelRef);
      this.wizard.close();
      void this.activate(
        { ...candidate, ...nativeSessionCatalogPreference },
        activationTargetId(candidate.kind, preparedModelRef),
      );
      return;
    }
    if (startMethod !== "openclaw.setup.prepare.start") {
      if (isCurrent?.() === false) {
        this.wizard.close();
        return;
      }
      if (!modelActivation) {
        this.wizard.fail(
          t(
            startMethod === "openclaw.setup.activate.start"
              ? "modelSetup.errors.activationFailed"
              : "modelSetup.wizard.notComplete",
          ),
        );
        return;
      }
      this.wizard.close();
      this.finishActivation(
        { ok: true, ...modelActivation },
        targetId ?? "provider-auth",
        this.setupRefreshWarning,
      );
      return;
    }
    const result = await this.detect();
    if (!result) {
      this.wizard.fail(t("modelSetup.errors.requestFailed"));
      return;
    }
    if (prepareOption) {
      this.pageState = preparedModelPageState(result, prepareOption.modelTarget);
      const candidate = findPreparedModelCandidate(result, prepareOption.id);
      if (!candidate) {
        this.wizard.fail(
          t("modelSetup.prepare.providerNotReady", { provider: prepareOption.label }),
        );
        return;
      }
      this.wizard.close();
      void this.activate(
        {
          kind: candidate.kind,
          modelRef: candidate.modelRef,
          ...(candidate.modelTarget ? { modelTarget: candidate.modelTarget } : {}),
          ...nativeSessionCatalogPreference,
        },
        activationTargetId(candidate.kind, candidate.modelRef),
      );
      return;
    }
    this.wizard.close();
  }

  private closeWizard(): void {
    this.wizardMutationGeneration += 1;
    this.wizardMutationActive = false;
    this.pendingPrepareOption = null;
    this.wizard.close();
  }

  private async runWizardMutation(
    task: () => Promise<ModelSetupWizardCompletion | null>,
    settling = false,
  ): Promise<void> {
    const client = this.context.gateway.snapshot.client;
    if (
      ((this.wizardMutationActive || this.detectionRequest !== null) && !settling) ||
      !this.canUseSetup(client) ||
      (this.wizard.state.phase === "idle" && this.firstRun.unresolved)
    ) {
      return;
    }
    if (this.wizard.state.phase === "idle") {
      // Disabling the initiating control can blur it before the modal opens.
      const active = this.ownerDocument.activeElement;
      this.wizardReturnFocus =
        active instanceof HTMLElement && this.contains(active) ? active : null;
    }
    const generation = ++this.wizardMutationGeneration;
    this.wizardMutationActive = true;
    this.requestUpdate();
    try {
      const mutation = await this.context.runtimeConfig.runExternalMutation(
        async (mutationClient) => {
          if (mutationClient !== client) {
            throw new Error("Connection changed before model setup continued.");
          }
          return await task();
        },
        {
          canDispatch: () =>
            generation === this.wizardMutationGeneration &&
            this.context.gateway.snapshot.client === client &&
            this.canUseSetup(client),
          dispatchError: t("modelSetup.errors.requestFailed"),
        },
      );
      if (generation !== this.wizardMutationGeneration) {
        if (mutation.ok && !mutation.refresh.ok && this.isConnected) {
          this.setupRefreshWarning = mutation.refresh.error;
        }
        if (this.isConnected && this.canUseSetup(this.context.gateway.snapshot.client)) {
          void this.detect();
        }
        return;
      }
      if (!mutation.ok) {
        this.wizard.fail(mutation.error);
        return;
      }
      this.setupRefreshWarning = mutation.refresh.ok ? null : mutation.refresh.error;
      const completion = mutation.value;
      if (completion) {
        // The coordinated wizard action has settled; follow-up activation owns
        // its own mutation lane and must not be blocked by the prior busy flag.
        this.wizardMutationActive = false;
        await this.handleWizardDone(completion);
      } else if (this.wizardState.phase === "step" && this.wizardState.busy) {
        this.wizardState = { ...this.wizardState, busy: false };
      }
    } catch (error) {
      if (generation === this.wizardMutationGeneration) {
        this.wizard.fail(formatModelSetupError(error));
      }
    } finally {
      if (generation === this.wizardMutationGeneration) {
        this.wizardMutationActive = false;
        this.requestUpdate();
      }
    }
  }

  private async cancelWizard(): Promise<void> {
    const generation = this.wizardMutationGeneration;
    this.cancellationNotice = null;
    try {
      const outcome = await this.wizard.requestCancellation();
      if (generation !== this.wizardMutationGeneration) {
        return;
      }
      if (outcome === "running") {
        this.cancellationNotice = t("modelSetup.wizard.finishingStep");
        return;
      }
      if (outcome !== "cancelled") {
        return;
      }
      this.wizardMutationGeneration += 1;
      this.wizardMutationActive = false;
      this.pendingPrepareOption = null;
      this.activationState = { phase: "idle" };
    } catch (error) {
      if (
        generation === this.wizardMutationGeneration &&
        (this.wizardState.phase === "starting" || this.wizardState.phase === "step")
      ) {
        this.cancellationNotice = t("modelSetup.wizard.cancelFailed", {
          error: formatModelSetupError(error),
        });
      }
    }
  }

  override render() {
    const snapshot = this.context.gateway.snapshot;
    const canAdmin = hasOperatorAdminAccess(snapshot.hello?.auth ?? null);
    const gatewayTooOld =
      snapshot.phase === "connected" &&
      isGatewayMethodAdvertised(snapshot, "openclaw.setup.detect") !== true;
    return renderModelSetup({
      detecting: this.detectionRequest !== null,
      detectionError: this.detectionError,
      embedded: this.embedded,
      agentLabel: this.agentLabel,
      credentialChoices: this.credentialChoices,
      onClose: this.onClose,
      onDiscoveryShown: () => {
        if (this.wizardState.phase === "idle") {
          this.wizardReturnFocus?.focus({ preventScroll: true });
          this.wizardReturnFocus = null;
        }
      },
      onConnectChoice: this.onConnectChoice,
      page: this.firstRun.visiblePageState(
        this.verifyState.phase === "ok" && this.verifyState.modelTarget !== "utility",
      ),
      activation: this.activationState,
      verify: this.verifyState,
      connection: this.embedded ? undefined : this.login.pageActions,
      wizard: this.wizardState,
      wizardMode: this.wizardMode,
      wizardValue: this.wizardDraft.value,
      canAdmin,
      canVerify: this.canVerify(snapshot.client),
      canPrepare:
        this.canUseSetup(snapshot.client) &&
        isGatewayMethodAdvertised(snapshot, "openclaw.setup.prepare.start") === true,
      modelConfigured: readSessionDefaults(snapshot)?.modelConfigured === true,
      gatewayTooOld,
      refreshWarning: this.setupRefreshWarning,
      cancellationNotice: this.cancellationNotice,
      activationUnresolved: this.firstRun.unresolved,
      onUseCurrentModel: this.firstRun.canUseCurrentModel
        ? () => void this.firstRun.useCurrentModel()
        : undefined,
      actionsDisabled: this.actionsDisabled(),
      manualProviderId: this.manualProviderId,
      manualApiKey: this.manualApiKey,
      manualError: this.manualError,
      moreSignInOpen: this.moreSignInOpen,
      nativeSessionCatalogsEnabled: this.nativeSessionCatalogsEnabled,
      onNativeSessionCatalogsChange: (enabled) => (this.nativeSessionCatalogsEnabled = enabled),
      firstRun: this.routeData?.firstRun === true,
      iconUrls: this.iconUrls,
      onDetect: () => {
        if (!this.detectionRequest && this.firstRun.retryDetection()) {
          void this.detect();
        }
      },
      onVerify: () => void this.firstRun.verify(),
      onActivateCandidate: ({ kind, modelRef, modelTarget }) =>
        void this.activate(
          { kind, modelRef, ...(modelTarget ? { modelTarget } : {}) },
          activationTargetId(kind, modelRef),
        ),
      onStartAuth: (option) => {
        this.wizard.prepareSignIn(option.kind, option.label);
        this.pendingPrepareOption = null;
        this.wizardMode = "auth";
        void this.runWizardMutation(() =>
          this.wizard.start(
            option.id,
            "openclaw.setup.auth.start",
            this.nativeSessionCatalogPreference(),
            option.modelTarget,
          ),
        );
      },
      onStartPrepare: (option: ModelSetupPrepareOption) => {
        this.pendingPrepareOption = option;
        this.wizardMode = "prepare";
        void this.runWizardMutation(() =>
          this.wizard.start(option.id, "openclaw.setup.prepare.start"),
        );
      },
      onManualProviderChange: (providerId) => this.selectManualProvider(providerId),
      onUseManualProvider: (providerId) => {
        this.selectManualProvider(providerId);
        void focusManualProviderInput(this);
      },
      onManualApiKeyChange: (apiKey) => {
        this.manualApiKey = apiKey;
        this.manualError = null;
      },
      onManualConnect: () => this.connectManual(),
      onMoreSignInToggle: (open) => (this.moreSignInOpen = open),
      onIconError: (iconUrl) => this.iconLoader.invalidate(iconUrl),
      onOpenChat: () => (this.embedded ? this.onClose?.() : this.firstRun.continueSetup()),
      onOpenSetupAssistant: () => this.firstRun.continueSetup("utility"),
      onSuccessClose: () => {
        if (this.embedded) {
          this.onClose?.();
          return;
        }
        this.activationState = { phase: "idle" };
        void this.detect();
      },
      onWizardValueChange: (value) => (this.wizardDraft = { ...this.wizardDraft, value }),
      onWizardAnswer: (value, includeValue) =>
        void this.runWizardMutation(() => this.wizard.answer(value, includeValue)),
      onWizardCancel: () => void this.cancelWizard(),
      onWizardClose: () => this.closeWizard(),
    });
  }
}

if (!customElements.get("openclaw-model-setup-page")) {
  customElements.define("openclaw-model-setup-page", ModelSetupPage);
}
