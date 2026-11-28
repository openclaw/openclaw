import { createEffect, createSignal, latest, onSettled } from "solid-js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type {
  SystemAgentSetupActivateParams,
  SystemAgentSetupDetectResult,
} from "../../api/types.ts";
import type { ApplicationContext } from "../../app/context.ts";
import { hasOperatorAdminAccess } from "../../app/operator-access.ts";
import { isGatewayMethodAdvertised } from "../../lib/gateway-methods.ts";
import { i18nRevision, t } from "../../lib/reactive/i18n.ts";
import { observeState } from "../../lib/reactive/observe-state.ts";
import {
  captureModelSetupConnection,
  modelSetupAgentSelection,
  modelSetupOwnerChanges,
  reconcileModelSetupConnection,
  FirstRunSetup,
  type ModelSetupRouteData,
} from "./first-run-setup.ts";
import { completeModelSetupWizard } from "./model-setup-completion.ts";
import { createModelSetupIconLoader } from "./model-setup-icon-loader.tsx";
import { createModelSetupSaving } from "./model-setup-saving.ts";
import { formatModelSetupError } from "./model-setup-task-result.ts";
import { candidateActivation, type ModelSetupPrepareOption } from "./prepare-options.ts";
import { manualProviderActivation } from "./provider-picker.tsx";
import type { ModelSetupDetection } from "./rpc.ts";
import { createModelSetupDetectRequest, createModelSetupVerifyRequest } from "./rpc.ts";
import {
  activationTargetId,
  createModelSetupState,
  updateModelSetupWizardDraft,
  type ModelSetupActivationState,
} from "./state.ts";
import { ModelSetupWizardRunner, type ModelSetupWizardCompletion } from "./wizard-runner.ts";

export type ModelSetupPageProps = {
  routeData?: ModelSetupRouteData;
  /** First-run setup opens local discovery on request; discovery alone is always open. */
  discoveryOpen?: boolean;
  agentLabel?: string;
  credentialChoices?: readonly string[];
  onClose?: () => void;
  /** The first-run activation became unresolved or settled; other entry points wait for it. */
  onActivationUnresolved?: (unresolved: boolean) => void;
};

export function createModelSetup(
  props: ModelSetupPageProps & { host: HTMLElement },
  context: ApplicationContext,
) {
  // Leaving setup retires its owner even while a saving action holds the displayed frame.
  const routeData = () => latest(() => props.routeData);
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
    state.activationState.phase === "testing" ||
    state.verifyState.phase === "checking" ||
    wizardMutationActive ||
    (state.wizardState.phase !== "idle" &&
      state.wizardState.phase !== "error" &&
      state.wizardState.phase !== "cancelled");

  function agentSelection(currentRoute = routeData()) {
    return modelSetupAgentSelection(context, currentRoute?.firstRun === true);
  }

  let observedConnection: ReturnType<typeof captureModelSetupConnection> | null = null;
  let pendingPrepareOption: ModelSetupPrepareOption | null = null;
  let wizardMutationGeneration = 0;
  let wizardMutationActive = false;
  let wizardReturnFocus: HTMLElement | null = null;
  let feedback: HTMLElement | undefined;
  let wizardDialog: import("../../components/modal-dialog.tsx").OpenClawModalDialog | undefined;
  const readConnection = () => {
    projection.revision();
    return observedConnection;
  };
  const wizardSaving = createModelSetupSaving(readConnection);
  const firstRun = new FirstRunSetup({
    context: () => context,
    routeData,
    pageState: () => state.pageState,
    activationState: () => state.activationState,
    actionsDisabled: () => actionsDisabled() || state.detectionRequest !== null,
    canUseSetup,
    canVerify,
    verify: verifyConnection,
    setVerifyState: (next) => (state.verifyState = next),
    setActivationState: (next) => (state.activationState = next),
    setRefreshWarning: (warning) => (state.setupRefreshWarning = warning),
    resumeWizard: (recovery, observer) => {
      wizard.restore(recovery, observer);
      void runWizardMutation(() => wizard.resume());
    },
    closeWizard,
    notify,
  });
  const iconLoader = createModelSetupIconLoader(
    () => context,
    () => state.pageState,
    (urls) => (state.iconUrls = urls),
  );
  const wizard = new ModelSetupWizardRunner({
    getClient: () => context.gateway.snapshot.client,
    getAgentId: () => agentSelection().state.selectedId,
    onChange: (next) => {
      // Show the next server step while the admitted write still reconciles config.
      wizardSaving.retire();
      if (next.phase !== "starting" && next.phase !== "done") {
        state.activationState = { phase: "idle" };
      }
      state.wizardState = next;
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

  const ownsDetection = (outcome: {
    token: object;
    client: GatewayBrowserClient;
    hello: unknown;
    agentId: string | null;
  }) =>
    state.detectionRequest === outcome.token &&
    context.gateway.snapshot.client === outcome.client &&
    context.gateway.snapshot.hello === outcome.hello &&
    agentSelection().state.selectedId === outcome.agentId;
  const runDetection = createModelSetupDetectRequest({
    getHello: () => context.gateway.snapshot.hello,
    onOptions: (outcome) => {
      // Known choices become usable now; discovery still owns readiness and
      // first-run recovery, so the ready connection waits for its result.
      if (ownsDetection(outcome) && state.pageState.phase !== "ready" && !firstRun.awaitsRecovery) {
        state.pageState = { phase: "ready", result: outcome.value };
      }
    },
    onComplete: (outcome): boolean => {
      if (!ownsDetection(outcome)) {
        return false;
      }
      state.detectionRequest = null;
      if ("error" in outcome) {
        if (state.pageState.phase !== "ready") {
          firstRun.setReadyConnection(null);
          state.pageState = { phase: "detect-error" };
        }
        return true;
      }
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
      return true;
    },
  });

  const runVerification = createModelSetupVerifyRequest();

  const [detectionIdentity, setDetectionRequest] = createSignal<ModelSetupDetection>();

  let feedbackState: ModelSetupActivationState | undefined;
  let reportedUnresolved = false;

  function afterRender() {
    if (!connected) {
      return;
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
    if (firstRun.unresolved !== reportedUnresolved) {
      reportedUnresolved = firstRun.unresolved;
      props.onActivationUnresolved?.(reportedUnresolved);
    }
  }

  function synchronizeGateway(currentRoute: ModelSetupPageProps["routeData"]): void {
    if (!connected || !currentRoute) {
      return;
    }
    const snapshot = context.gateway.snapshot;
    const previous = observedConnection;
    const observation = reconcileModelSetupConnection(
      previous,
      captureModelSetupConnection(context, currentRoute.firstRun, previous?.recoveryScope),
    );
    if (observation.kind === "unchanged") {
      return;
    }
    const connection = observation.connection;
    observedConnection = connection;
    // A pending agent roster keeps its prior connection fields; read the live phase.
    const suspendedNotice =
      snapshot.phase !== "connected" && state.wizardMode === "auth"
        ? t("modelSetup.wizard.gatewayReconnecting")
        : undefined;
    if (observation.kind === "pending") {
      retireWizardMutation();
      if (!wizard.hasAdmittedSession) {
        state.pageState = { phase: "loading" };
        setDetectionRequest(undefined);
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
      firstRun.routeChanged(currentRoute.firstRun);
    } else {
      firstRun.connectionChanged(connection);
    }
    state.detectionRequest = null;
    setDetectionRequest(undefined);
    retireWizardMutation();
    void runDetection([null, null, null]);
    state.activationState = { phase: "idle" };
    resetVerify();
    iconLoader.reset();
    pendingPrepareOption = null;
    void wizard.cancel();
    state.pageState = { phase: "loading" };
    if (canUseSetup(connection.client, currentRoute)) {
      void detect(currentRoute);
    }
  }

  function canUseSetup(
    client: GatewayBrowserClient | null,
    currentRoute = routeData(),
  ): client is GatewayBrowserClient {
    const snapshot = context.gateway.snapshot;
    return Boolean(
      client &&
      (currentRoute?.firstRun === true || agentSelection(currentRoute).state.selectedId !== null) &&
      snapshot.phase === "connected" &&
      hasOperatorAdminAccess(snapshot.hello?.auth ?? null) &&
      isGatewayMethodAdvertised(snapshot, "openclaw.setup.detect") === true,
    );
  }

  async function detect(currentRoute = routeData()): Promise<SystemAgentSetupDetectResult | null> {
    const client = context.gateway.snapshot.client;
    if (!canUseSetup(client, currentRoute)) {
      return null;
    }
    resetVerify();
    // Only a cold load replaces the content. Same-owner rescans keep forms and
    // focus mounted; a changed connection clears them in synchronizeGateway.
    const cold = state.pageState.phase !== "ready";
    if (cold) {
      state.pageState = { phase: "loading" };
    }
    // Setup actions may run during discovery. A refresh they request replaces
    // the older scan, whose result could predate their change.
    const token = {};
    state.detectionRequest = token;
    const completion = runDetection([
      client,
      agentSelection(currentRoute).state.selectedId,
      token,
      cold,
    ]);
    setDetectionRequest({ completion });
    const outcome = await completion;
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
    return actionsDisabled() || firstRun.unresolved;
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
    await runWizardMutation(() => wizard.activate(params, targetId));
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

  function retireWizardMutation(): void {
    wizardSaving.retire();
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
      (wizardMutationActive && !settling) ||
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
      const pending = context.runtimeConfig.runExternalMutation(
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
      await wizardSaving.present(pending, () => generation === wizardMutationGeneration);
      const mutation = await pending;
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
        wizardSaving.retire();
        const prepareOption = pendingPrepareOption;
        pendingPrepareOption = null;
        await completeModelSetupWizard(
          { state, firstRun, wizard, detect, activate },
          completion,
          prepareOption,
        );
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
      const pending = wizard.requestCancellation();
      await wizardSaving.present(pending, () => generation === wizardMutationGeneration);
      const outcome = await pending;
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
      onFeedback: (element: HTMLDivElement) => {
        feedback = element;
      },
      onWizardDialog: (element: NonNullable<typeof wizardDialog>) => {
        wizardDialog = element;
      },
      detecting: state.detectionRequest !== null,
      detectionIdentity,
      // Outside first run, setup is the Models page's local discovery dialog.
      embedded: routeData()?.firstRun !== true,
      discoveryOpen: routeData()?.firstRun !== true || props.discoveryOpen === true,
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
      wizard:
        state.wizardState.phase === "step" && wizardMutationActive
          ? { ...state.wizardState, busy: true }
          : state.wizardState,
      wizardMode: state.wizardMode,
      wizardValue: state.wizardDraft.value,
      canAdmin,
      canVerify: canVerify(snapshot.client),
      canPrepare:
        canUseSetup(snapshot.client) &&
        isGatewayMethodAdvertised(snapshot, "openclaw.setup.prepare.start") === true,
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
      firstRun: routeData()?.firstRun === true,
      iconUrls: state.iconUrls,
      onDetect: () => {
        if (!state.detectionRequest && firstRun.retryDetection()) {
          void detect();
        }
      },
      onActivateCandidate: (candidate: SystemAgentSetupDetectResult["candidates"][number]): void =>
        void activate(
          candidateActivation(candidate),
          activationTargetId(candidate.kind, candidate.modelRef),
        ),
      onStartAuth: (option: NonNullable<SystemAgentSetupDetectResult["authOptions"]>[number]) => {
        wizard.prepareSignIn(option.kind, option.label, option.brandId);
        pendingPrepareOption = null;
        state.wizardMode = "auth";
        void runWizardMutation(() =>
          wizard.start(option.id, "openclaw.setup.auth.start", {}, option.modelTarget),
        );
      },
      onStartPrepare: (option: ModelSetupPrepareOption) => {
        pendingPrepareOption = option;
        state.wizardMode = "prepare";
        void runWizardMutation(() => wizard.start(option.id, "openclaw.setup.prepare.start"));
      },
      onManualProviderChange: selectManualProvider,
      onManualApiKeyChange: (apiKey: string) => {
        state.manualApiKey = apiKey;
        state.manualError = null;
      },
      onManualConnect: connectManual,
      onMoreSignInToggle: (open: boolean) => {
        state.moreSignInOpen = open;
      },
      onIconError: iconLoader.invalidate,
      onOpenChat: () =>
        routeData()?.firstRun === true ? firstRun.continueSetup() : props.onClose?.(),
      onOpenSetupAssistant: () => firstRun.continueSetup("utility"),
      onSuccessClose: () => {
        if (routeData()?.firstRun === true) {
          state.activationState = { phase: "idle" };
          void detect();
        }
        props.onClose?.();
      },
      onWizardValueChange: (value: unknown) => {
        state.wizardDraft = { ...state.wizardDraft, value };
      },
      onWizardAnswer: (value: unknown, includeValue?: boolean): void =>
        void runWizardMutation(() => wizard.answer(value, includeValue)),
      onWizardCancel: (): void => void cancelWizard(),
      onWizardClose: closeWizard,
    };
  };
  const synchronizeCurrentGateway = () => {
    synchronizeGateway(routeData());
    notify();
  };
  createEffect(
    () => {
      const currentRoute = routeData();
      return [
        currentRoute ? { firstRun: currentRoute.firstRun } : undefined,
        agentSelection(currentRoute),
      ] as const;
    },
    ([currentRoute, selection]) => {
      // Selection receipts retire wizard ownership before another setup action can run.
      const stop = selection.subscribe(synchronizeCurrentGateway);
      synchronizeGateway(currentRoute);
      notify();
      return stop;
    },
  );
  onSettled(() => {
    const stopAfterRender = projection.subscribe(() => onSettled(afterRender));
    connected = true;
    // Connection authority changes synchronously suspend or retire the admitted wizard.
    const stopGateway = context.gateway.subscribe(synchronizeCurrentGateway);
    // Receipt-clear events retire restored wizard work before another activation can start.
    const stopFirstRun = firstRun.subscribe(notify);
    synchronizeCurrentGateway();
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
    wizardSaving: wizardSaving.saving,
    revision: projection.revision,
  };
}
