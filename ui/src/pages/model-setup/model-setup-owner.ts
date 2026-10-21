import { createEffect, onSettled } from "solid-js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type {
  SystemAgentSetupActivateParams,
  SystemAgentSetupActivateResult,
  SystemAgentSetupDetectResult,
} from "../../api/types.ts";
import type { ApplicationContext } from "../../app/context.ts";
import { hasOperatorAdminAccess } from "../../app/operator-access.ts";
import { isGatewayMethodAdvertised } from "../../lib/gateway-methods.ts";
import { i18nRevision, t } from "../../lib/reactive/i18n.ts";
import { observeState } from "../../lib/reactive/observe-state.ts";
import { readSessionDefaults } from "../../lib/sessions/session-key.ts";
import { createModelProviderLogin } from "../model-providers/login-controller.ts";
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
import { createNativeModelSetup } from "./native-model-setup.tsx";
import {
  candidateActivation,
  findPreparedModelCandidate,
  type ModelSetupPrepareOption,
  preparedModelActivation,
} from "./prepare-options.ts";
import { manualProviderActivation } from "./provider-picker.tsx";
import { createModelSetupDetectRequest, createModelSetupVerifyRequest } from "./rpc.ts";
import {
  activationTargetId,
  createModelSetupState,
  preparedModelPageState,
  updateModelSetupWizardDraft,
  mapActivationResult,
  type ModelSetupActivationState,
} from "./state.ts";
import { ModelSetupWizardRunner, type ModelSetupWizardCompletion } from "./wizard-runner.ts";

export type ModelSetupPageProps = {
  routeData?: ModelSetupRouteData;
  embedded?: boolean;
  agentLabel?: string;
  credentialChoices?: readonly string[];
  onClose?: () => void;
};

export function createModelSetup(
  props: ModelSetupPageProps & { host: HTMLElement },
  context: ApplicationContext,
) {
  const projection = observeState(createModelSetupState());
  const state = projection.state;
  let connected = false;
  let disposed = false;
  const notify = () => {
    if (!disposed) {
      projection.invalidate();
    }
  };
  const actionsDisabled = (): boolean =>
    login.busy ||
    nativeModels.saving ||
    state.activationState.phase === "testing" ||
    state.verifyState.phase === "checking" ||
    wizardMutationActive ||
    (state.wizardState.phase !== "idle" &&
      state.wizardState.phase !== "error" &&
      state.wizardState.phase !== "cancelled");

  function agentSelection() {
    return modelSetupAgentSelection(context, props.routeData?.firstRun === true);
  }

  let observedConnection: ReturnType<typeof captureModelSetupConnection> | null = null;
  let pendingPrepareOption: ModelSetupPrepareOption | null = null;
  let manualProviderRevealPending = false;
  let wizardMutationGeneration = 0;
  let wizardMutationActive = false;
  let wizardReturnFocus: HTMLElement | null = null;
  let manualInput: HTMLInputElement | undefined;
  let feedback: HTMLElement | undefined;
  let wizardDialog: import("../../components/modal-dialog.ts").OpenClawModalDialog | undefined;
  const firstRun = new FirstRunSetup({
    context: () => context,
    routeData: () => props.routeData,
    pageState: () => state.pageState,
    activationState: () => state.activationState,
    actionsDisabled: () => actionsDisabled() || state.detectionRequest !== null,
    canUseSetup: (client) => canUseSetup(client),
    canVerify: (client) => canVerify(client),
    verify: (modelTarget) => verifyConnection(modelTarget),
    setVerifyState: (next) => (state.verifyState = next),
    setActivationState: (next) => (state.activationState = next),
    setRefreshWarning: (warning) => (state.setupRefreshWarning = warning),
    resumeWizard: (recovery, observer) => {
      wizard.restore(recovery, observer);
      void runWizardMutation(() => wizard.resume());
    },
    closeWizard: () => closeWizard(),
    notify: () => notify(),
  });
  const nativeModels = createNativeModelSetup({
    getContext: () => context,
    getConnection: () => observedConnection,
    canUseSetup: (client) => canUseSetup(client),
    blocked: () => {
      projection.read();
      return activationBlocked();
    },
    onSelected: () => (props.embedded ? props.onClose?.() : context.navigate("chat")),
  });
  const iconLoader = createModelSetupIconLoader(
    () => context,
    () => state.pageState,
    (urls) => (state.iconUrls = urls),
  );
  const login = createModelProviderLogin({
    getScope: () => ({ context, agentId: agentSelection().state.selectedId }),
    getManualProviders: () =>
      state.pageState.phase === "ready" ? state.pageState.result.manualProviders : [],
    onManualProvider: (authChoice) => {
      manualProviderRevealPending = true;
      selectManualProvider(authChoice);
    },
    canStart: () =>
      canUseSetup(context.gateway.snapshot.client) && !firstRun.unresolved && !actionsDisabled(),
    canContinue: () => canUseSetup(context.gateway.snapshot.client) && !firstRun.unresolved,
    refresh: () => detect(),
  });
  const wizard = new ModelSetupWizardRunner({
    getClient: () => context?.gateway.snapshot.client ?? null,
    getAgentId: () => agentSelection().state.selectedId ?? null,
    onChange: (next) => {
      if (next.phase !== "starting" && next.phase !== "done") {
        state.activationState = { phase: "idle" };
      }
      state.wizardState =
        next.phase === "step" && wizardMutationActive ? { ...next, busy: true } : next;
      state.wizardDraft = updateModelSetupWizardDraft(state.wizardDraft, next);
      if (next.phase === "idle") {
        state.cancellationNotice = null;
      }
    },
    onStart: (method, intent) =>
      method === "openclaw.setup.prepare.start"
        ? undefined
        : firstRun.observeActivation(firstRun.beginActivation(intent ?? { kind: "provider-auth" })),
    onBackgroundCompletion: (completion) =>
      runWizardMutation(() => Promise.resolve(completion), true),
    onSessionMissing: () => {
      firstRun.wizardMissing();
      void detect();
    },
    requestFailedMessage: () => t("modelSetup.errors.requestFailed"),
    cancelledMessage: () => t("modelSetup.wizard.cancelled"),
    sessionExpiredMessage: () => t("modelSetup.wizard.sessionExpired"),
    gatewayNotRespondingMessage: () => t("modelSetup.wizard.gatewayNotResponding"),
  });

  const runDetection = createModelSetupDetectRequest({
    getHello: () => context.gateway.snapshot.hello,
    onComplete: (outcome) => {
      if (
        state.detectionRequest !== outcome.token ||
        context.gateway.snapshot.client !== outcome.client ||
        context.gateway.snapshot.hello !== outcome.hello ||
        agentSelection().state.selectedId !== outcome.agentId
      ) {
        return;
      }
      state.detectionRequest = null;
      if ("error" in outcome) {
        const message = formatModelSetupError(outcome.error);
        if (state.pageState.phase === "ready") {
          state.detectionError = message;
        } else {
          firstRun.setReadyConnection(null);
          state.pageState = { phase: "detect-error", message };
        }
        return;
      }
      state.detectionError = null;
      firstRun.setReadyConnection({
        client: outcome.client,
        hello: outcome.hello,
        agentId: outcome.agentId,
      });
      state.pageState = { phase: "ready", result: outcome.value };
      firstRun.reconcileMissingWizard(outcome.value);
      if (
        !outcome.value.manualProviders.some((provider) => provider.id === state.manualProviderId)
      ) {
        state.manualProviderId = "";
      }
    },
  });

  const runVerification = createModelSetupVerifyRequest();

  let feedbackState: ModelSetupActivationState | undefined;

  function afterRender() {
    if (!connected) {
      return;
    }
    if (manualProviderRevealPending) {
      manualProviderRevealPending = false;
      wizardDialog?.setReturnFocusTarget(manualInput ?? null);
      manualInput?.scrollIntoView?.({ block: "nearest", behavior: "auto" });
      manualInput?.focus({ preventScroll: true });
    }
    if (feedbackState !== state.activationState && state.activationState.phase !== "idle") {
      feedback?.scrollIntoView?.({ block: "nearest", behavior: "auto" });
      feedbackState = state.activationState;
    }
    if (state.wizardState.phase !== "idle") {
      wizardDialog?.setReturnFocusTarget(wizardReturnFocus);
    }
    iconLoader.reconcile();
    firstRun.start();
  }

  function synchronizeGateway(snapshot: ApplicationContext["gateway"]["snapshot"]): void {
    const routeData = props.routeData;
    if (!connected || !routeData) {
      return;
    }
    const previous = observedConnection;
    const observation = reconcileModelSetupConnection(
      previous,
      captureModelSetupConnection(context, routeData.firstRun, previous?.recoveryScope),
    );
    if (observation.kind === "unchanged") {
      return;
    }
    const connection = observation.connection;
    observedConnection = connection;
    nativeModels.reset();
    // A pending agent roster keeps its prior connection fields; read the live phase.
    const suspendedNotice =
      snapshot.phase !== "connected" && state.wizardMode === "auth"
        ? t("modelSetup.wizard.gatewayReconnecting")
        : undefined;
    if (observation.kind === "pending") {
      if (!wizard.hasAdmittedSession) {
        state.pageState = { phase: "loading" };
      }
      wizard.suspend(suspendedNotice);
      return;
    }
    const { authenticatedOwnerLost, ownerChanged } = modelSetupOwnerChanges(previous, connection);
    const setupAuthorityLost =
      connection.connected && !hasOperatorAdminAccess(snapshot.hello?.auth ?? null);
    if (authenticatedOwnerLost || setupAuthorityLost) {
      // A changed identity or reduced authority cannot cancel the old wizard.
      // Retire local handles and expose the existing access/recovery state.
      wizard.close({ retireOwner: true });
    }
    if (ownerChanged) {
      state.nativeSessionCatalogsEnabled = false;
      state.manualProviderId = "";
      state.manualApiKey = "";
      state.manualError = null;
    }
    const sameWizardOwner = previous && Boolean(connection.recoveryScope) && !ownerChanged;
    if (sameWizardOwner && wizard.hasAdmittedSession) {
      retireWizardMutation();
      wizard.suspend(suspendedNotice);
      if (canUseSetup(connection.client)) {
        firstRun.reconnectActivation(connection);
        void runWizardMutation(() => wizard.resume());
      }
      return;
    }
    // The router refreshes cached loader objects during the same visit. Only
    // a mode change or mounted/connection lifecycle can retire setup ownership.
    if (connection.firstRun !== previous?.firstRun) {
      firstRun.routeChanged();
    } else {
      firstRun.connectionChanged(connection);
    }
    resetActivity();
    state.pageState = { phase: "loading" };
    if (canUseSetup(connection.client)) {
      void detect();
    }
  }

  function resetActivity(): void {
    manualProviderRevealPending = false;
    login.reset();
    state.detectionRequest = null;
    state.detectionError = null;
    retireWizardMutation();
    void runDetection([null, null, null]);
    state.activationState = { phase: "idle" };
    resetVerify();
    iconLoader.reset();
    pendingPrepareOption = null;
    void wizard.cancel();
  }

  function canUseSetup(client: GatewayBrowserClient | null): client is GatewayBrowserClient {
    const snapshot = context.gateway.snapshot;
    return Boolean(
      client &&
      (props.routeData?.firstRun === true || agentSelection().state.selectedId !== null) &&
      snapshot.phase === "connected" &&
      hasOperatorAdminAccess(snapshot.hello?.auth ?? null) &&
      isGatewayMethodAdvertised(snapshot, "openclaw.setup.detect") === true,
    );
  }

  async function detect(): Promise<SystemAgentSetupDetectResult | null> {
    const client = context.gateway.snapshot.client;
    if (!canUseSetup(client) || state.detectionRequest) {
      return null;
    }
    resetVerify();
    state.detectionError = null;
    // Only a cold load replaces the content. Same-owner rescans keep forms and
    // focus mounted; a changed connection clears them in synchronizeGateway.
    if (state.pageState.phase !== "ready") {
      state.pageState = { phase: "loading" };
    }
    const token = {};
    state.detectionRequest = token;
    const outcome = await runDetection([client, agentSelection().state.selectedId, token]);
    return outcome?.token === token && "value" in outcome ? outcome.value : null;
  }

  function canVerify(client: GatewayBrowserClient | null): client is GatewayBrowserClient {
    return (
      canUseSetup(client) &&
      isGatewayMethodAdvertised(context.gateway.snapshot, "openclaw.setup.verify") === true
    );
  }

  function resetVerify(): void {
    state.verifyState = { phase: "idle" };
    void runVerification([null, null, undefined]);
  }

  async function verifyConnection(modelTarget?: "utility") {
    const client = context.gateway.snapshot.client;
    if (!canVerify(client) || actionsDisabled() || state.detectionRequest) {
      return undefined;
    }
    state.verifyState = { phase: "checking" };
    return runVerification([client, agentSelection().state.selectedId, modelTarget]);
  }

  function activationBlocked(): boolean {
    return actionsDisabled() || state.detectionRequest !== null || firstRun.unresolved;
  }

  async function activate(params: SystemAgentSetupActivateParams, targetId: string): Promise<void> {
    const client = context.gateway.snapshot.client;
    if (!canUseSetup(client) || activationBlocked()) {
      return;
    }
    state.manualError = null;
    state.activationState = { phase: "testing", targetId };
    pendingPrepareOption = null;
    state.wizardMode = "activate";
    await runWizardMutation(() =>
      wizard.activate({ ...params, ...nativeSessionCatalogPreference() }, targetId),
    );
  }

  function nativeSessionCatalogPreference(): { nativeSessionCatalogsEnabled?: boolean } {
    return state.pageState.phase === "ready" &&
      state.pageState.result.nativeSessionCatalogPreferenceRequired === true
      ? { nativeSessionCatalogsEnabled: state.nativeSessionCatalogsEnabled }
      : {};
  }

  function connectManual(): void {
    const activation = manualProviderActivation(
      state.pageState.phase === "ready" ? state.pageState.result.manualProviders : [],
      state.manualProviderId,
      state.manualApiKey,
    );
    if (!activation) {
      state.manualError = t("modelSetup.manual.required");
      return;
    }
    void activate(activation, `manual:${state.manualProviderId}`);
  }

  function selectManualProvider(providerId: string): void {
    if (providerId !== state.manualProviderId) {
      state.manualApiKey = "";
    }
    state.manualProviderId = providerId;
    state.manualError = null;
  }

  async function handleWizardDone({
    startMethod,
    preparedModelRef,
    activationTargetId: targetId,
    modelActivation,
    isCurrent,
  }: ModelSetupWizardCompletion): Promise<void> {
    const prepareOption =
      startMethod === "openclaw.setup.prepare.start" ? pendingPrepareOption : null;
    const catalogPreference = nativeSessionCatalogPreference();
    pendingPrepareOption = null;
    if (startMethod !== "openclaw.setup.prepare.start") {
      if (isCurrent?.() === false) {
        wizard.close();
        return;
      }
      if (!modelActivation) {
        wizard.fail(
          t(
            startMethod === "openclaw.setup.activate.start"
              ? "modelSetup.errors.activationFailed"
              : "modelSetup.wizard.notComplete",
          ),
        );
        return;
      }
      wizard.close();
      const result: SystemAgentSetupActivateResult = { ok: true, ...modelActivation };
      const activationTarget = targetId ?? "provider-auth";
      state.activationState = mapActivationResult({
        result,
        targetId: activationTarget,
        fallbackError: t("modelSetup.errors.activationFailed"),
        restartWarning: t("labsPage.restartRequired"),
        refreshWarning: state.setupRefreshWarning,
      });
      if (state.activationState.phase === "success") {
        state.manualApiKey = "";
      }
      firstRun.finishActivation(result, activationTarget, state.setupRefreshWarning);
      return;
    }
    let activation: ReturnType<typeof candidateActivation> | undefined;
    if (prepareOption && preparedModelRef) {
      activation = preparedModelActivation(prepareOption, preparedModelRef);
    } else {
      const result = await detect();
      if (!result) {
        wizard.fail(t("modelSetup.errors.requestFailed"));
        return;
      }
      if (prepareOption) {
        state.pageState = preparedModelPageState(result, prepareOption.modelTarget);
        const candidate = findPreparedModelCandidate(result, prepareOption.id);
        if (!candidate) {
          wizard.fail(t("modelSetup.prepare.providerNotReady", { provider: prepareOption.label }));
          return;
        }
        activation = candidateActivation(candidate);
      }
    }
    wizard.close();
    if (activation) {
      void activate(
        { ...activation, ...catalogPreference },
        activationTargetId(activation.kind, activation.modelRef),
      );
    }
  }

  function retireWizardMutation(): void {
    wizardMutationGeneration += 1;
    wizardMutationActive = false;
  }

  function closeWizard(): void {
    retireWizardMutation();
    pendingPrepareOption = null;
    wizard.close();
  }

  async function runWizardMutation(
    task: () => Promise<ModelSetupWizardCompletion | null>,
    settling = false,
  ): Promise<void> {
    const client = context.gateway.snapshot.client;
    if (
      ((wizardMutationActive || state.detectionRequest !== null) && !settling) ||
      !canUseSetup(client) ||
      (wizard.state.phase === "idle" && firstRun.unresolved)
    ) {
      return;
    }
    if (wizard.state.phase === "idle") {
      // Disabling the initiating control can blur it before the modal opens.
      const active = props.host.ownerDocument.activeElement;
      wizardReturnFocus =
        active instanceof HTMLElement && props.host.contains(active) ? active : null;
    }
    const generation = ++wizardMutationGeneration;
    wizardMutationActive = true;
    notify();
    try {
      const mutation = await context.runtimeConfig.runExternalMutation(
        async (mutationClient) => {
          if (mutationClient !== client) {
            throw new Error("Connection changed before model setup continued.");
          }
          return await task();
        },
        {
          canDispatch: () =>
            generation === wizardMutationGeneration &&
            context.gateway.snapshot.client === client &&
            canUseSetup(client),
          dispatchError: t("modelSetup.errors.requestFailed"),
        },
      );
      if (generation !== wizardMutationGeneration) {
        if (mutation.ok && !mutation.refresh.ok && connected) {
          state.setupRefreshWarning = mutation.refresh.error;
        }
        if (connected && canUseSetup(context.gateway.snapshot.client)) {
          void detect();
        }
        return;
      }
      if (!mutation.ok) {
        wizard.fail(mutation.error);
        return;
      }
      state.setupRefreshWarning = mutation.refresh.ok ? null : mutation.refresh.error;
      const completion = mutation.value;
      if (completion) {
        // The coordinated wizard action has settled; follow-up activation owns
        // its own mutation lane and must not be blocked by the prior busy flag.
        wizardMutationActive = false;
        await handleWizardDone(completion);
      } else if (state.wizardState.phase === "step" && state.wizardState.busy) {
        state.wizardState = { ...state.wizardState, busy: false };
      }
    } catch (error) {
      if (generation === wizardMutationGeneration) {
        wizard.fail(formatModelSetupError(error));
      }
    } finally {
      if (generation === wizardMutationGeneration) {
        wizardMutationActive = false;
        notify();
      }
    }
  }

  async function cancelWizard(): Promise<void> {
    const generation = wizardMutationGeneration;
    state.cancellationNotice = null;
    try {
      const outcome = await wizard.requestCancellation();
      if (generation !== wizardMutationGeneration) {
        return;
      }
      if (outcome === "running") {
        state.cancellationNotice = t("modelSetup.wizard.finishingStep");
        return;
      }
      if (outcome !== "cancelled") {
        return;
      }
      retireWizardMutation();
      pendingPrepareOption = null;
      state.activationState = { phase: "idle" };
    } catch (error) {
      if (
        generation === wizardMutationGeneration &&
        (state.wizardState.phase === "starting" || state.wizardState.phase === "step")
      ) {
        state.cancellationNotice = t("modelSetup.wizard.cancelFailed", {
          error: formatModelSetupError(error),
        });
      }
    }
  }

  const view = () => {
    i18nRevision();
    projection.read();
    const snapshot = context.gateway.snapshot;
    const canAdmin = hasOperatorAdminAccess(snapshot.hello?.auth ?? null);
    const gatewayTooOld =
      snapshot.phase === "connected" &&
      isGatewayMethodAdvertised(snapshot, "openclaw.setup.detect") !== true;
    return {
      onManualInput: (element: HTMLInputElement) => {
        manualInput = element;
      },
      onFeedback: (element: HTMLDivElement) => {
        feedback = element;
      },
      onWizardDialog: (element: import("../../components/modal-dialog.ts").OpenClawModalDialog) => {
        wizardDialog = element;
      },
      detecting: state.detectionRequest !== null,
      detectionError: state.detectionError,
      embedded: props.embedded ?? false,
      agentLabel: props.agentLabel ?? "",
      credentialChoices: props.credentialChoices ?? [],
      onClose: props.onClose,
      onDiscoveryShown: () => {
        if (state.wizardState.phase === "idle") {
          wizardReturnFocus?.focus({ preventScroll: true });
          wizardReturnFocus = null;
        }
      },
      page: firstRun.visiblePageState(
        state.verifyState.phase === "ok" && state.verifyState.modelTarget !== "utility",
      ),
      activation: state.activationState,
      verify: state.verifyState,
      connection: props.embedded ? undefined : login.pageActions,
      wizard: state.wizardState,
      wizardMode: state.wizardMode,
      wizardValue: state.wizardDraft.value,
      canAdmin,
      canVerify: canVerify(snapshot.client),
      canPrepare:
        canUseSetup(snapshot.client) &&
        isGatewayMethodAdvertised(snapshot, "openclaw.setup.prepare.start") === true,
      modelConfigured: readSessionDefaults(snapshot)?.modelConfigured === true,
      gatewayTooOld,
      refreshWarning: state.setupRefreshWarning,
      cancellationNotice: state.cancellationNotice,
      activationUnresolved: firstRun.unresolved,
      onUseCurrentModel: firstRun.canUseCurrentModel
        ? (): void => void firstRun.useCurrentModel()
        : undefined,
      actionsDisabled: actionsDisabled(),
      manualProviderId: state.manualProviderId,
      manualApiKey: state.manualApiKey,
      manualError: state.manualError,
      moreSignInOpen: state.moreSignInOpen,
      nativeSessionCatalogsEnabled: state.nativeSessionCatalogsEnabled,
      nativeModels,
      onNativeSessionCatalogsChange: (enabled: boolean) => {
        state.nativeSessionCatalogsEnabled = enabled;
      },
      firstRun: props.routeData?.firstRun === true,
      iconUrls: state.iconUrls,
      onDetect: () => {
        if (!state.detectionRequest && firstRun.retryDetection()) {
          void detect();
        }
      },
      onVerify: (): void => void firstRun.verify(),
      onActivateCandidate: (candidate: SystemAgentSetupDetectResult["candidates"][number]): void =>
        void activate(
          candidateActivation(candidate),
          activationTargetId(candidate.kind, candidate.modelRef),
        ),
      onStartAuth: (option: NonNullable<SystemAgentSetupDetectResult["authOptions"]>[number]) => {
        wizard.prepareSignIn(option.kind, option.label);
        pendingPrepareOption = null;
        state.wizardMode = "auth";
        void runWizardMutation(() =>
          wizard.start(
            option.id,
            "openclaw.setup.auth.start",
            nativeSessionCatalogPreference(),
            option.modelTarget,
          ),
        );
      },
      onStartPrepare: (option: ModelSetupPrepareOption) => {
        pendingPrepareOption = option;
        state.wizardMode = "prepare";
        void runWizardMutation(() => wizard.start(option.id, "openclaw.setup.prepare.start"));
      },
      onManualProviderChange: (providerId: string) => selectManualProvider(providerId),
      onManualApiKeyChange: (apiKey: string) => {
        state.manualApiKey = apiKey;
        state.manualError = null;
      },
      onManualConnect: () => connectManual(),
      onMoreSignInToggle: (open: boolean) => {
        state.moreSignInOpen = open;
      },
      onIconError: (iconUrl: string) => iconLoader.invalidate(iconUrl),
      onOpenChat: () => (props.embedded ? props.onClose?.() : firstRun.continueSetup()),
      onOpenSetupAssistant: () => firstRun.continueSetup("utility"),
      onSuccessClose: () => {
        if (props.embedded) {
          props.onClose?.();
          return;
        }
        state.activationState = { phase: "idle" };
        void detect();
      },
      onWizardValueChange: (value: unknown) => {
        state.wizardDraft = { ...state.wizardDraft, value };
      },
      onWizardAnswer: (value: unknown, includeValue?: boolean): void =>
        void runWizardMutation(() => wizard.answer(value, includeValue)),
      onWizardCancel: (): void => void cancelWizard(),
      onWizardClose: () => closeWizard(),
    };
  };
  createEffect(
    () => [props.routeData, agentSelection()],
    ([, selection]) => {
      // Selection receipts retire wizard ownership before another setup action can run.
      const stop = selection.subscribe(() => {
        synchronizeGateway(context.gateway.snapshot);
        notify();
      });
      synchronizeGateway(context.gateway.snapshot);
      notify();
      return stop;
    },
  );
  onSettled(() => {
    const stopAfterRender = projection.subscribe(() => onSettled(afterRender));
    connected = true;
    // Connection authority changes synchronously suspend or retire the admitted wizard.
    const stopGateway = context.gateway.subscribe(() => {
      synchronizeGateway(context.gateway.snapshot);
      notify();
    });
    // Receipt-clear events retire restored wizard work before another activation can start.
    const stopFirstRun = firstRun.subscribe(notify);
    synchronizeGateway(context.gateway.snapshot);
    notify();
    return () => {
      disposed = true;
      stopAfterRender();
      connected = false;
      stopGateway();
      stopFirstRun();
      firstRun.dispose();
      retireWizardMutation();
      iconLoader.reset();
      void wizard.cancel();
    };
  });
  return {
    view,
    login,
    revision: projection.revision,
  };
}
