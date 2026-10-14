import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type {
  SystemAgentSetupActivateParams,
  SystemAgentSetupActivateResult,
  SystemAgentSetupDetectResult,
} from "../../api/types.ts";
import type { ApplicationContext } from "../../app/context.ts";
import { hasOperatorAdminAccess } from "../../app/operator-access.ts";
import { t } from "../../i18n/index.ts";
import { isGatewayMethodAdvertised } from "../../lib/gateway-methods.ts";
import { readSessionDefaults } from "../../lib/sessions/session-key.ts";
import { SubscriptionsController } from "../../lit/subscriptions-controller.ts";
import { ModelProviderLoginController } from "../model-providers/login-controller.ts";
import { ModelPageController } from "../model-providers/page-controller.ts";
import {
  captureModelSetupConnection,
  modelSetupAgentSelection,
  modelSetupOwnerChanges,
  reconcileModelSetupConnection,
  FirstRunSetup,
  type ModelSetupRouteData,
} from "./first-run-setup.ts";
import { createModelSetupIconLoader } from "./model-setup-icon-loader.tsx";
import { formatModelSetupError } from "./model-setup-task-result.ts";
import { NativeModelSetup } from "./native-model-setup.tsx";
import {
  candidateActivation,
  findPreparedModelCandidate,
  type ModelSetupPrepareOption,
  preparedModelActivation,
} from "./prepare-options.ts";
import { manualProviderActivation, revealManualProvider } from "./provider-picker.tsx";
import { createModelSetupDetectRequest, createModelSetupVerifyRequest } from "./rpc.ts";
import {
  activationTargetId,
  createModelSetupState,
  preparedModelPageState,
  updateModelSetupWizardDraft,
  mapActivationResult,
  type ModelSetupActivationState,
} from "./state.ts";
import { revealModelSetupFeedback, type ModelSetupViewProps } from "./view.tsx";
import { ModelSetupWizardRunner, type ModelSetupWizardCompletion } from "./wizard-runner.ts";

export class ModelSetupController extends ModelPageController {
  private readonly actionsDisabled = (): boolean =>
    this.login.busy ||
    this.nativeModels.saving ||
    this.state.activationState.phase === "testing" ||
    this.state.verifyState.phase === "checking" ||
    this.wizardMutationActive ||
    (this.state.wizardState.phase !== "idle" &&
      this.state.wizardState.phase !== "error" &&
      this.state.wizardState.phase !== "cancelled");

  context: ApplicationContext;

  routeData: ModelSetupRouteData | undefined;
  embedded = false;
  agentLabel = "";
  credentialChoices: readonly string[] = [];
  onClose: (() => void) | undefined;

  private readonly state = createModelSetupState();

  private setState<K extends keyof typeof this.state>(key: K, value: (typeof this.state)[K]) {
    if (!Object.is(this.state[key], value)) {
      this.state[key] = value;
      this.requestUpdate();
    }
  }

  private get agentSelection() {
    return modelSetupAgentSelection(this.context, this.routeData?.firstRun === true);
  }

  private observedConnection: ReturnType<typeof captureModelSetupConnection> | null = null;
  private pendingPrepareOption: ModelSetupPrepareOption | null = null;
  private manualProviderRevealPending = false;
  private wizardMutationGeneration = 0;
  private wizardMutationActive = false;
  private wizardReturnFocus: HTMLElement | null = null;
  private readonly firstRun = new FirstRunSetup({
    context: () => this.context,
    routeData: () => this.routeData,
    pageState: () => this.state.pageState,
    activationState: () => this.state.activationState,
    actionsDisabled: () => this.actionsDisabled() || this.state.detectionRequest !== null,
    canUseSetup: (client) => this.canUseSetup(client),
    canVerify: (client) => this.canVerify(client),
    verify: (modelTarget) => this.verifyConnection(modelTarget),
    setVerifyState: (next) => this.setState("verifyState", next),
    setActivationState: (next) => this.setState("activationState", next),
    setRefreshWarning: (warning) => this.setState("setupRefreshWarning", warning),
    resumeWizard: (recovery, observer) => {
      this.wizard.restore(recovery, observer);
      void this.runWizardMutation(() => this.wizard.resume());
    },
    closeWizard: () => this.closeWizard(),
    notify: () => this.requestUpdate(),
  });
  private readonly nativeModels = new NativeModelSetup(this, {
    getContext: () => this.context,
    getConnection: () => this.observedConnection,
    canUseSetup: (client) => this.canUseSetup(client),
    blocked: () => this.activationBlocked,
    onSelected: () => (this.embedded ? this.onClose?.() : this.context.navigate("chat")),
  });
  private readonly iconLoader = createModelSetupIconLoader(
    () => this.context,
    () => this.state.pageState,
    (urls) => this.setState("iconUrls", urls),
  );
  readonly login = new ModelProviderLoginController(this, {
    getScope: () => ({ context: this.context, agentId: this.agentSelection.state.selectedId }),
    getManualProviders: () =>
      this.state.pageState.phase === "ready" ? this.state.pageState.result.manualProviders : [],
    onManualProvider: (authChoice) => {
      this.manualProviderRevealPending = true;
      this.selectManualProvider(authChoice);
    },
    canStart: () =>
      this.canUseSetup(this.context.gateway.snapshot.client) &&
      !this.firstRun.unresolved &&
      !this.actionsDisabled(),
    canContinue: () =>
      this.canUseSetup(this.context.gateway.snapshot.client) && !this.firstRun.unresolved,
    refresh: () => this.detect(),
  });
  private readonly subscriptions = new SubscriptionsController(this)
    .watchStore(
      () => this.context?.gateway,
      (gateway) => this.synchronizeGateway(gateway.snapshot),
    )
    .watchStore(
      () => this.context && this.agentSelection,
      () => this.synchronizeGateway(this.context.gateway.snapshot),
    )
    .watchStore(() => this.firstRun);
  private readonly wizard = new ModelSetupWizardRunner({
    getClient: () => this.context?.gateway.snapshot.client ?? null,
    getAgentId: () => this.agentSelection.state.selectedId ?? null,
    onChange: (next) => {
      if (next.phase !== "starting" && next.phase !== "done") {
        this.setState("activationState", { phase: "idle" });
      }
      this.setState(
        "wizardState",
        next.phase === "step" && this.wizardMutationActive ? { ...next, busy: true } : next,
      );
      this.setState("wizardDraft", updateModelSetupWizardDraft(this.state.wizardDraft, next));
      if (next.phase === "idle") {
        this.setState("cancellationNotice", null);
      }
    },
    onStart: (method, intent) =>
      method === "openclaw.setup.prepare.start"
        ? undefined
        : this.firstRun.observeActivation(
            this.firstRun.beginActivation(intent ?? { kind: "provider-auth" }),
          ),
    onBackgroundCompletion: (completion) =>
      this.runWizardMutation(() => Promise.resolve(completion), true),
    onSessionMissing: () => {
      this.firstRun.wizardMissing();
      void this.detect();
    },
    requestFailedMessage: () => t("modelSetup.errors.requestFailed"),
    cancelledMessage: () => t("modelSetup.wizard.cancelled"),
    sessionExpiredMessage: () => t("modelSetup.wizard.sessionExpired"),
    gatewayNotRespondingMessage: () => t("modelSetup.wizard.gatewayNotResponding"),
  });

  private readonly runDetection = createModelSetupDetectRequest(this, {
    getHello: () => this.context.gateway.snapshot.hello,
    onComplete: (outcome) => {
      if (
        this.state.detectionRequest !== outcome.token ||
        this.context.gateway.snapshot.client !== outcome.client ||
        this.context.gateway.snapshot.hello !== outcome.hello ||
        this.agentSelection.state.selectedId !== outcome.agentId
      ) {
        return;
      }
      this.setState("detectionRequest", null);
      if ("error" in outcome) {
        const message = formatModelSetupError(outcome.error);
        if (this.state.pageState.phase === "ready") {
          this.setState("detectionError", message);
        } else {
          this.firstRun.setReadyConnection(null);
          this.setState("pageState", { phase: "detect-error", message });
        }
        return;
      }
      this.setState("detectionError", null);
      this.firstRun.setReadyConnection({
        client: outcome.client,
        hello: outcome.hello,
        agentId: outcome.agentId,
      });
      this.setState("pageState", { phase: "ready", result: outcome.value });
      this.firstRun.reconcileMissingWizard(outcome.value);
      if (
        !outcome.value.manualProviders.some(
          (provider) => provider.id === this.state.manualProviderId,
        )
      ) {
        this.setState("manualProviderId", "");
      }
    },
  });

  private readonly runVerification = createModelSetupVerifyRequest(this);

  constructor(element: HTMLElement, context: ApplicationContext, notify: () => void) {
    super(element, notify);
    this.context = context;
  }

  override disconnect() {
    this.firstRun.dispose();
    this.resetActivity();
    this.observedConnection = null;
    this.nativeModels.reset();
    this.subscriptions.clear();
    super.disconnect();
  }

  override beforeUpdate() {
    super.beforeUpdate();
    this.synchronizeGateway(this.context.gateway.snapshot);
  }

  private feedbackState: ModelSetupActivationState | undefined;

  override afterUpdate() {
    super.afterUpdate();
    // Do not rearm setup work when Lit finishes queued updates after detachment.
    if (!this.isConnected) {
      return;
    }
    if (this.manualProviderRevealPending) {
      this.manualProviderRevealPending = false;
      revealManualProvider(this.renderRoot);
    }
    if (
      this.feedbackState !== this.state.activationState &&
      this.state.activationState.phase !== "idle"
    ) {
      revealModelSetupFeedback(this.renderRoot);
      this.feedbackState = this.state.activationState;
    }
    if (this.state.wizardState.phase !== "idle") {
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
    this.nativeModels.reset();
    // A pending agent roster keeps its prior connection fields; read the live phase.
    const suspendedNotice =
      snapshot.phase !== "connected" && this.state.wizardMode === "auth"
        ? t("modelSetup.wizard.gatewayReconnecting")
        : undefined;
    if (observation.kind === "pending") {
      if (!this.wizard.hasAdmittedSession) {
        this.setState("pageState", { phase: "loading" });
      }
      this.wizard.suspend(suspendedNotice);
      return;
    }
    const { authenticatedOwnerLost, ownerChanged } = modelSetupOwnerChanges(previous, connection);
    const setupAuthorityLost =
      connection.connected && !hasOperatorAdminAccess(snapshot.hello?.auth ?? null);
    if (authenticatedOwnerLost || setupAuthorityLost) {
      // A changed identity or reduced authority cannot cancel the old wizard.
      // Retire local handles and expose the existing access/recovery state.
      this.wizard.close({ retireOwner: true });
    }
    if (ownerChanged) {
      this.setState("nativeSessionCatalogsEnabled", false);
      this.setState("manualProviderId", "");
      this.setState("manualApiKey", "");
      this.setState("manualError", null);
    }
    const sameWizardOwner = previous && Boolean(connection.recoveryScope) && !ownerChanged;
    if (sameWizardOwner && this.wizard.hasAdmittedSession) {
      this.retireWizardMutation();
      this.wizard.suspend(suspendedNotice);
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
    this.setState("pageState", { phase: "loading" });
    if (this.canUseSetup(connection.client)) {
      void this.detect();
    }
  }

  private resetActivity(): void {
    this.manualProviderRevealPending = false;
    this.login.reset();
    this.setState("detectionRequest", null);
    this.setState("detectionError", null);
    this.retireWizardMutation();
    void this.runDetection([null, null, null]);
    this.setState("activationState", { phase: "idle" });
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
    if (!this.canUseSetup(client) || this.state.detectionRequest) {
      return null;
    }
    this.resetVerify();
    this.setState("detectionError", null);
    // Only a cold load replaces the content. Same-owner rescans keep forms and
    // focus mounted; a changed connection clears them in synchronizeGateway.
    if (this.state.pageState.phase !== "ready") {
      this.setState("pageState", { phase: "loading" });
    }
    const token = {};
    this.setState("detectionRequest", token);
    const outcome = await this.runDetection([client, this.agentSelection.state.selectedId, token]);
    return outcome?.token === token && "value" in outcome ? outcome.value : null;
  }

  private canVerify(client: GatewayBrowserClient | null): client is GatewayBrowserClient {
    return (
      this.canUseSetup(client) &&
      isGatewayMethodAdvertised(this.context.gateway.snapshot, "openclaw.setup.verify") === true
    );
  }

  private resetVerify(): void {
    this.setState("verifyState", { phase: "idle" });
    void this.runVerification([null, null, undefined]);
  }

  private async verifyConnection(modelTarget?: "utility") {
    const client = this.context.gateway.snapshot.client;
    if (!this.canVerify(client) || this.actionsDisabled() || this.state.detectionRequest) {
      return undefined;
    }
    this.setState("verifyState", { phase: "checking" });
    return this.runVerification([client, this.agentSelection.state.selectedId, modelTarget]);
  }

  private get activationBlocked(): boolean {
    return (
      this.actionsDisabled() || this.state.detectionRequest !== null || this.firstRun.unresolved
    );
  }

  private async activate(params: SystemAgentSetupActivateParams, targetId: string): Promise<void> {
    const client = this.context.gateway.snapshot.client;
    if (!this.canUseSetup(client) || this.activationBlocked) {
      return;
    }
    this.setState("manualError", null);
    this.setState("activationState", { phase: "testing", targetId });
    this.pendingPrepareOption = null;
    this.setState("wizardMode", "activate");
    await this.runWizardMutation(() =>
      this.wizard.activate({ ...params, ...this.nativeSessionCatalogPreference() }, targetId),
    );
  }

  private nativeSessionCatalogPreference(): { nativeSessionCatalogsEnabled?: boolean } {
    return this.state.pageState.phase === "ready" &&
      this.state.pageState.result.nativeSessionCatalogPreferenceRequired === true
      ? { nativeSessionCatalogsEnabled: this.state.nativeSessionCatalogsEnabled }
      : {};
  }

  private connectManual(): void {
    const activation = manualProviderActivation(
      this.state.pageState.phase === "ready" ? this.state.pageState.result.manualProviders : [],
      this.state.manualProviderId,
      this.state.manualApiKey,
    );
    if (!activation) {
      this.setState("manualError", t("modelSetup.manual.required"));
      return;
    }
    void this.activate(activation, `manual:${this.state.manualProviderId}`);
  }

  private selectManualProvider(providerId: string): void {
    if (providerId !== this.state.manualProviderId) {
      this.setState("manualApiKey", "");
    }
    this.setState("manualProviderId", providerId);
    this.setState("manualError", null);
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
      const result: SystemAgentSetupActivateResult = { ok: true, ...modelActivation };
      const activationTarget = targetId ?? "provider-auth";
      this.setState(
        "activationState",
        mapActivationResult({
          result,
          targetId: activationTarget,
          fallbackError: t("modelSetup.errors.activationFailed"),
          restartWarning: t("labsPage.restartRequired"),
          refreshWarning: this.state.setupRefreshWarning,
        }),
      );
      if (this.state.activationState.phase === "success") {
        this.setState("manualApiKey", "");
      }
      this.firstRun.finishActivation(result, activationTarget, this.state.setupRefreshWarning);
      return;
    }
    let activation: ReturnType<typeof candidateActivation> | undefined;
    if (prepareOption && preparedModelRef) {
      activation = preparedModelActivation(prepareOption, preparedModelRef);
    } else {
      const result = await this.detect();
      if (!result) {
        this.wizard.fail(t("modelSetup.errors.requestFailed"));
        return;
      }
      if (prepareOption) {
        this.setState("pageState", preparedModelPageState(result, prepareOption.modelTarget));
        const candidate = findPreparedModelCandidate(result, prepareOption.id);
        if (!candidate) {
          this.wizard.fail(
            t("modelSetup.prepare.providerNotReady", { provider: prepareOption.label }),
          );
          return;
        }
        activation = candidateActivation(candidate);
      }
    }
    this.wizard.close();
    if (activation) {
      void this.activate(
        { ...activation, ...nativeSessionCatalogPreference },
        activationTargetId(activation.kind, activation.modelRef),
      );
    }
  }

  private retireWizardMutation(): void {
    this.wizardMutationGeneration += 1;
    this.wizardMutationActive = false;
  }

  private closeWizard(): void {
    this.retireWizardMutation();
    this.pendingPrepareOption = null;
    this.wizard.close();
  }

  private async runWizardMutation(
    task: () => Promise<ModelSetupWizardCompletion | null>,
    settling = false,
  ): Promise<void> {
    const client = this.context.gateway.snapshot.client;
    if (
      ((this.wizardMutationActive || this.state.detectionRequest !== null) && !settling) ||
      !this.canUseSetup(client) ||
      (this.wizard.state.phase === "idle" && this.firstRun.unresolved)
    ) {
      return;
    }
    if (this.wizard.state.phase === "idle") {
      // Disabling the initiating control can blur it before the modal opens.
      const active = this.renderRoot.ownerDocument.activeElement;
      this.wizardReturnFocus =
        active instanceof HTMLElement && this.renderRoot.contains(active) ? active : null;
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
          this.setState("setupRefreshWarning", mutation.refresh.error);
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
      this.setState("setupRefreshWarning", mutation.refresh.ok ? null : mutation.refresh.error);
      const completion = mutation.value;
      if (completion) {
        // The coordinated wizard action has settled; follow-up activation owns
        // its own mutation lane and must not be blocked by the prior busy flag.
        this.wizardMutationActive = false;
        await this.handleWizardDone(completion);
      } else if (this.state.wizardState.phase === "step" && this.state.wizardState.busy) {
        this.setState("wizardState", { ...this.state.wizardState, busy: false });
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
    this.setState("cancellationNotice", null);
    try {
      const outcome = await this.wizard.requestCancellation();
      if (generation !== this.wizardMutationGeneration) {
        return;
      }
      if (outcome === "running") {
        this.setState("cancellationNotice", t("modelSetup.wizard.finishingStep"));
        return;
      }
      if (outcome !== "cancelled") {
        return;
      }
      this.retireWizardMutation();
      this.pendingPrepareOption = null;
      this.setState("activationState", { phase: "idle" });
    } catch (error) {
      if (
        generation === this.wizardMutationGeneration &&
        (this.state.wizardState.phase === "starting" || this.state.wizardState.phase === "step")
      ) {
        this.setState(
          "cancellationNotice",
          t("modelSetup.wizard.cancelFailed", {
            error: formatModelSetupError(error),
          }),
        );
      }
    }
  }

  viewProps(): ModelSetupViewProps {
    const snapshot = this.context.gateway.snapshot;
    const canAdmin = hasOperatorAdminAccess(snapshot.hello?.auth ?? null);
    const gatewayTooOld =
      snapshot.phase === "connected" &&
      isGatewayMethodAdvertised(snapshot, "openclaw.setup.detect") !== true;
    return {
      detecting: this.state.detectionRequest !== null,
      detectionError: this.state.detectionError,
      embedded: this.embedded,
      agentLabel: this.agentLabel,
      credentialChoices: this.credentialChoices,
      onClose: this.onClose,
      onDiscoveryShown: () => {
        if (this.state.wizardState.phase === "idle") {
          this.wizardReturnFocus?.focus({ preventScroll: true });
          this.wizardReturnFocus = null;
        }
      },
      page: this.firstRun.visiblePageState(
        this.state.verifyState.phase === "ok" && this.state.verifyState.modelTarget !== "utility",
      ),
      activation: this.state.activationState,
      verify: this.state.verifyState,
      connection: this.embedded ? undefined : this.login.pageActions,
      wizard: this.state.wizardState,
      wizardMode: this.state.wizardMode,
      wizardValue: this.state.wizardDraft.value,
      canAdmin,
      canVerify: this.canVerify(snapshot.client),
      canPrepare:
        this.canUseSetup(snapshot.client) &&
        isGatewayMethodAdvertised(snapshot, "openclaw.setup.prepare.start") === true,
      modelConfigured: readSessionDefaults(snapshot)?.modelConfigured === true,
      gatewayTooOld,
      refreshWarning: this.state.setupRefreshWarning,
      cancellationNotice: this.state.cancellationNotice,
      activationUnresolved: this.firstRun.unresolved,
      onUseCurrentModel: this.firstRun.canUseCurrentModel
        ? () => void this.firstRun.useCurrentModel()
        : undefined,
      actionsDisabled: this.actionsDisabled(),
      manualProviderId: this.state.manualProviderId,
      manualApiKey: this.state.manualApiKey,
      manualError: this.state.manualError,
      moreSignInOpen: this.state.moreSignInOpen,
      nativeSessionCatalogsEnabled: this.state.nativeSessionCatalogsEnabled,
      nativeModels: this.nativeModels,
      onNativeSessionCatalogsChange: (enabled) =>
        this.setState("nativeSessionCatalogsEnabled", enabled),
      firstRun: this.routeData?.firstRun === true,
      iconUrls: this.state.iconUrls,
      onDetect: () => {
        if (!this.state.detectionRequest && this.firstRun.retryDetection()) {
          void this.detect();
        }
      },
      onVerify: () => void this.firstRun.verify(),
      onActivateCandidate: (candidate) =>
        void this.activate(
          candidateActivation(candidate),
          activationTargetId(candidate.kind, candidate.modelRef),
        ),
      onStartAuth: (option) => {
        this.wizard.prepareSignIn(option.kind, option.label);
        this.pendingPrepareOption = null;
        this.setState("wizardMode", "auth");
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
        this.setState("wizardMode", "prepare");
        void this.runWizardMutation(() =>
          this.wizard.start(option.id, "openclaw.setup.prepare.start"),
        );
      },
      onManualProviderChange: (providerId) => this.selectManualProvider(providerId),
      onManualApiKeyChange: (apiKey) => {
        this.setState("manualApiKey", apiKey);
        this.setState("manualError", null);
      },
      onManualConnect: () => this.connectManual(),
      onMoreSignInToggle: (open) => this.setState("moreSignInOpen", open),
      onIconError: (iconUrl) => this.iconLoader.invalidate(iconUrl),
      onOpenChat: () => (this.embedded ? this.onClose?.() : this.firstRun.continueSetup()),
      onOpenSetupAssistant: () => this.firstRun.continueSetup("utility"),
      onSuccessClose: () => {
        if (this.embedded) {
          this.onClose?.();
          return;
        }
        this.setState("activationState", { phase: "idle" });
        void this.detect();
      },
      onWizardValueChange: (value) =>
        this.setState("wizardDraft", { ...this.state.wizardDraft, value }),
      onWizardAnswer: (value, includeValue) =>
        void this.runWizardMutation(() => this.wizard.answer(value, includeValue)),
      onWizardCancel: () => void this.cancelWizard(),
      onWizardClose: () => this.closeWizard(),
    };
  }
}
