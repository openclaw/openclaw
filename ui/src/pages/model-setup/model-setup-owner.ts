import { createEffect, onCleanup, onSettled, untrack } from "solid-js";
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
import { projectOwner } from "../../lib/reactive/projection.ts";
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
import type { ModelSetupViewProps } from "./view.tsx";
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
  const listeners = new Set<() => void>();
  let connected = false;
  let disposed = false;
  const notify = () => {
    if (!disposed) {
      for (const listener of listeners) {
        listener();
      }
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

  const state = createModelSetupState();

  function setState<K extends keyof typeof state>(key: K, value: (typeof state)[K]) {
    if (!Object.is(state[key], value)) {
      state[key] = value;
      notify();
    }
  }

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
    setVerifyState: (next) => setState("verifyState", next),
    setActivationState: (next) => setState("activationState", next),
    setRefreshWarning: (warning) => setState("setupRefreshWarning", warning),
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
    (urls) => setState("iconUrls", urls),
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
        setState("activationState", { phase: "idle" });
      }
      setState(
        "wizardState",
        next.phase === "step" && wizardMutationActive ? { ...next, busy: true } : next,
      );
      setState("wizardDraft", updateModelSetupWizardDraft(state.wizardDraft, next));
      if (next.phase === "idle") {
        setState("cancellationNotice", null);
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
      setState("detectionRequest", null);
      if ("error" in outcome) {
        const message = formatModelSetupError(outcome.error);
        if (state.pageState.phase === "ready") {
          setState("detectionError", message);
        } else {
          firstRun.setReadyConnection(null);
          setState("pageState", { phase: "detect-error", message });
        }
        return;
      }
      setState("detectionError", null);
      firstRun.setReadyConnection({
        client: outcome.client,
        hello: outcome.hello,
        agentId: outcome.agentId,
      });
      setState("pageState", { phase: "ready", result: outcome.value });
      firstRun.reconcileMissingWizard(outcome.value);
      if (
        !outcome.value.manualProviders.some((provider) => provider.id === state.manualProviderId)
      ) {
        setState("manualProviderId", "");
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
        setState("pageState", { phase: "loading" });
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
      setState("nativeSessionCatalogsEnabled", false);
      setState("manualProviderId", "");
      setState("manualApiKey", "");
      setState("manualError", null);
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
    setState("pageState", { phase: "loading" });
    if (canUseSetup(connection.client)) {
      void detect();
    }
  }

  function resetActivity(): void {
    manualProviderRevealPending = false;
    login.reset();
    setState("detectionRequest", null);
    setState("detectionError", null);
    retireWizardMutation();
    void runDetection([null, null, null]);
    setState("activationState", { phase: "idle" });
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
    setState("detectionError", null);
    // Only a cold load replaces the content. Same-owner rescans keep forms and
    // focus mounted; a changed connection clears them in synchronizeGateway.
    if (state.pageState.phase !== "ready") {
      setState("pageState", { phase: "loading" });
    }
    const token = {};
    setState("detectionRequest", token);
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
    setState("verifyState", { phase: "idle" });
    void runVerification([null, null, undefined]);
  }

  async function verifyConnection(modelTarget?: "utility") {
    const client = context.gateway.snapshot.client;
    if (!canVerify(client) || actionsDisabled() || state.detectionRequest) {
      return undefined;
    }
    setState("verifyState", { phase: "checking" });
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
    setState("manualError", null);
    setState("activationState", { phase: "testing", targetId });
    pendingPrepareOption = null;
    setState("wizardMode", "activate");
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
      setState("manualError", t("modelSetup.manual.required"));
      return;
    }
    void activate(activation, `manual:${state.manualProviderId}`);
  }

  function selectManualProvider(providerId: string): void {
    if (providerId !== state.manualProviderId) {
      setState("manualApiKey", "");
    }
    setState("manualProviderId", providerId);
    setState("manualError", null);
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
      setState(
        "activationState",
        mapActivationResult({
          result,
          targetId: activationTarget,
          fallbackError: t("modelSetup.errors.activationFailed"),
          restartWarning: t("labsPage.restartRequired"),
          refreshWarning: state.setupRefreshWarning,
        }),
      );
      if (state.activationState.phase === "success") {
        setState("manualApiKey", "");
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
        setState("pageState", preparedModelPageState(result, prepareOption.modelTarget));
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
          setState("setupRefreshWarning", mutation.refresh.error);
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
      setState("setupRefreshWarning", mutation.refresh.ok ? null : mutation.refresh.error);
      const completion = mutation.value;
      if (completion) {
        // The coordinated wizard action has settled; follow-up activation owns
        // its own mutation lane and must not be blocked by the prior busy flag.
        wizardMutationActive = false;
        await handleWizardDone(completion);
      } else if (state.wizardState.phase === "step" && state.wizardState.busy) {
        setState("wizardState", { ...state.wizardState, busy: false });
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
    setState("cancellationNotice", null);
    try {
      const outcome = await wizard.requestCancellation();
      if (generation !== wizardMutationGeneration) {
        return;
      }
      if (outcome === "running") {
        setState("cancellationNotice", t("modelSetup.wizard.finishingStep"));
        return;
      }
      if (outcome !== "cancelled") {
        return;
      }
      retireWizardMutation();
      pendingPrepareOption = null;
      setState("activationState", { phase: "idle" });
    } catch (error) {
      if (
        generation === wizardMutationGeneration &&
        (state.wizardState.phase === "starting" || state.wizardState.phase === "step")
      ) {
        setState(
          "cancellationNotice",
          t("modelSetup.wizard.cancelFailed", {
            error: formatModelSetupError(error),
          }),
        );
      }
    }
  }

  function viewProps(): ModelSetupViewProps {
    const snapshot = context.gateway.snapshot;
    const canAdmin = hasOperatorAdminAccess(snapshot.hello?.auth ?? null);
    const gatewayTooOld =
      snapshot.phase === "connected" &&
      isGatewayMethodAdvertised(snapshot, "openclaw.setup.detect") !== true;
    return {
      onManualInput: (element) => {
        manualInput = element;
      },
      onFeedback: (element) => {
        feedback = element;
      },
      onWizardDialog: (element) => {
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
        ? () => void firstRun.useCurrentModel()
        : undefined,
      actionsDisabled: actionsDisabled(),
      manualProviderId: state.manualProviderId,
      manualApiKey: state.manualApiKey,
      manualError: state.manualError,
      moreSignInOpen: state.moreSignInOpen,
      nativeSessionCatalogsEnabled: state.nativeSessionCatalogsEnabled,
      nativeModels,
      onNativeSessionCatalogsChange: (enabled) => setState("nativeSessionCatalogsEnabled", enabled),
      firstRun: props.routeData?.firstRun === true,
      iconUrls: state.iconUrls,
      onDetect: () => {
        if (!state.detectionRequest && firstRun.retryDetection()) {
          void detect();
        }
      },
      onVerify: () => void firstRun.verify(),
      onActivateCandidate: (candidate) =>
        void activate(
          candidateActivation(candidate),
          activationTargetId(candidate.kind, candidate.modelRef),
        ),
      onStartAuth: (option) => {
        wizard.prepareSignIn(option.kind, option.label);
        pendingPrepareOption = null;
        setState("wizardMode", "auth");
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
        setState("wizardMode", "prepare");
        void runWizardMutation(() => wizard.start(option.id, "openclaw.setup.prepare.start"));
      },
      onManualProviderChange: (providerId) => selectManualProvider(providerId),
      onManualApiKeyChange: (apiKey) => {
        setState("manualApiKey", apiKey);
        setState("manualError", null);
      },
      onManualConnect: () => connectManual(),
      onMoreSignInToggle: (open) => setState("moreSignInOpen", open),
      onIconError: (iconUrl) => iconLoader.invalidate(iconUrl),
      onOpenChat: () => (props.embedded ? props.onClose?.() : firstRun.continueSetup()),
      onOpenSetupAssistant: () => firstRun.continueSetup("utility"),
      onSuccessClose: () => {
        if (props.embedded) {
          props.onClose?.();
          return;
        }
        setState("activationState", { phase: "idle" });
        void detect();
      },
      onWizardValueChange: (value) => setState("wizardDraft", { ...state.wizardDraft, value }),
      onWizardAnswer: (value, includeValue) =>
        void runWizardMutation(() => wizard.answer(value, includeValue)),
      onWizardCancel: () => void cancelWizard(),
      onWizardClose: () => closeWizard(),
    };
  }

  const projection = projectOwner(
    {
      subscribe(listener: () => void) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    },
    () => state,
  );
  const view = () => {
    i18nRevision();
    projection.read();
    return viewProps();
  };
  createEffect(
    () => [props.routeData, agentSelection()],
    ([, selection]) => {
      return untrack(() => {
        // Selection receipts retire wizard ownership before another setup action can run.
        const stop = selection.subscribe(() => {
          synchronizeGateway(context.gateway.snapshot);
          notify();
        });
        synchronizeGateway(context.gateway.snapshot);
        notify();
        return stop;
      });
    },
  );
  // DOM settlement starts imperative first-run work; view() owns its dependencies.
  createEffect(view, () => untrack(afterRender));
  onSettled(() => {
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
      stopGateway();
      stopFirstRun();
    };
  });
  onCleanup(() => {
    disposed = true;
    connected = false;
    firstRun.dispose();
    retireWizardMutation();
    iconLoader.reset();
    void wizard.cancel();
  });
  return {
    view,
    login,
    revision: projection.revision,
  };
}
