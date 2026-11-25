import { createSignal, onSettled } from "solid-js";
import type {
  ModelAuthStatusResult,
  ModelCatalogEntry,
  SystemAgentSetupDetectResult,
} from "../../api/types.ts";
import type { ApplicationContext } from "../../app/context.ts";
import { createWizardLogin } from "../../components/wizard-login-controller.tsx";
import { registerSettingsEnglish } from "../../i18n/locales/en-settings.ts";
import { currentConfigObject } from "../../lib/config/config-state-model.ts";
import { formatUiError } from "../../lib/format-error.ts";
import { invalidateModelAuthStatusRequests } from "../../lib/model-auth-request-state.ts";
import { canonicalModelAuthProviderId, loadModelAuthStatus } from "../../lib/model-auth.ts";
import { ModelCatalogReader } from "../../lib/model-catalog-reader.ts";
import { readAgentModelCatalog } from "../../lib/model-catalog-store.ts";
import { registerEnglishCatalog, t } from "../../lib/reactive/i18n.ts";
import { projectSource } from "../../lib/reactive/projection.ts";
import type { ModelSetupWizardCompletion } from "../model-setup/wizard-runner.ts";
import type { ModelProviderRowMessage } from "./config-mutation.ts";
import type { ModelProviderCard } from "./data.ts";
import { createProviderModelSelection, verifiedStarterModel } from "./login-completion-models.ts";
import { createLoginSavingPresentation } from "./login-presentation.ts";
import {
  buildLoginProviders,
  directEntry,
  filterLoginProviders,
  providerAccounts,
  resolveLoginSelection,
  type LoginChoice,
  type LoginProvider,
} from "./login-providers.ts";
import { createLoginSignIn } from "./login-sign-in.ts";
import { createModelProviderStartChat } from "./login-start-chat.ts";
import "../../styles/model-providers.css";
registerEnglishCatalog(registerSettingsEnglish);

export function createModelProviderLogin(options: {
  getScope: () => {
    context: ApplicationContext;
    agentId: string | null;
    connectionEpoch: number;
    authStatus?: ModelAuthStatusResult | null;
  };
  canStart: () => boolean;
  canContinue: () => boolean;
  refresh: (providerId?: string) => Promise<unknown>;
  onDiscover?: () => void;
  onApiKey?: (provider: string) => void;
  getManualProviders?: () => SystemAgentSetupDetectResult["manualProviders"];
  onManualProvider?: (authChoice: string) => void;
}) {
  let publish: (() => void) | undefined;
  const notify = () => publish?.();
  const [query, setQuery] = createSignal("");
  const [providerSelection, setProvider] = createSignal("");
  let currentPicker: {
    providers?: string[];
    pluginId?: string;
    allowSetup: boolean;
    isCurrent: () => boolean;
    inventory: { value: ModelAuthStatusResult | Promise<ModelAuthStatusResult | null> };
  } | null = null;
  let inventoryRequest:
    | {
        controller: AbortController;
        result: ReturnType<typeof Promise.withResolvers<ModelAuthStatusResult | null>>;
      }
    | undefined;
  let searchInput: HTMLInputElement | undefined;
  let methodChoices: HTMLDivElement | undefined;
  let apiKeyChoice: HTMLButtonElement | undefined;
  let focusPicker: "search" | "method" | null = null;
  let generation = 0;
  let mutationActive = false;
  let presentationReady: (() => void) | undefined;
  let refreshWarning: string | null = null;
  let message: ModelProviderRowMessage | undefined;
  let completionModel: ModelCatalogEntry | undefined;
  let verifiedModelRef: string | undefined;

  const wizard = createWizardLogin({
    getClient: () => options.getScope().context.gateway.snapshot.client,
    getAgentId: () => options.getScope().agentId,
    onClose: () => reset(),
    onPresentationChange: () => presentationReady?.(),
    onAnswer: (value, includeValue) => void run(() => runner.answer(value, includeValue)),
    onBackgroundCompletion: (completion) => run(() => Promise.resolve(completion), true),
    onStart: (method, intent) => signIn.onStart(method, intent),
    readLostSession: (error) => signIn.readLostSession(error),
    requestFailedMessage: () => t("modelProviders.requestFailed"),
    sessionExpiredMessage: () => t("modelProviders.login.sessionExpired"),
    recovery: {
      onRetry: () => signIn.restart(),
      onOpenSettings: () => {
        reset();
        options.getScope().context.navigate("connection");
      },
    },
  });
  const runner = wizard.runner;
  const signIn = createLoginSignIn(options, {
    runner,
    run,
    reset,
    synchronizePresentation: () => presentation.synchronize(),
    allowSetup: () => Boolean(options.onManualProvider) || !selection().modelRef,
    loginProviders,
  });
  const modelSelection = createProviderModelSelection({
    canChoose: () => !chat.busy && runner.state.phase === "done" && options.canContinue(),
    getModel: () => completionModel,
    setModel: (model) => (completionModel = model),
    notify,
  });
  const completionCatalog = new ModelCatalogReader(notify, {
    onResult: (catalog) =>
      modelSelection.updateCatalog(
        catalog.models,
        signIn.authProviderId,
        signIn.mode === "activate",
        verifiedModelRef,
      ),
  });
  const view = projectSource(null, {
    read: () => null,
    subscribe: (_, listener) => {
      publish = listener;
      return () => (publish = undefined);
    },
    equality: "revision",
  });

  const presentation = createLoginSavingPresentation({
    observe: () => view.read(),
    getScope: options.getScope,
    notify,
  });
  const chat = createModelProviderStartChat({
    getScope: options.getScope,
    getGeneration: () => generation,
    getModel: () => completionModel,
    canStart: options.canContinue,
    onCreated: reset,
    onError: (error) => {
      refreshWarning = error;
      notify();
    },
    notify,
  });

  function busy(): boolean {
    view.read();
    wizard.state();
    return (
      currentPicker !== null || mutationActive || wizard.cancelling || runner.state.phase !== "idle"
    );
  }

  function selection() {
    const { context, agentId, authStatus } = options.getScope();
    return resolveLoginSelection(
      currentConfigObject(context.runtimeConfig.state),
      agentId,
      authStatus,
    );
  }

  function recoveryView() {
    view.read();
    const missing = selection().missing;
    const providers = options
      .getScope()
      .authStatus?.providerCapabilities?.filter(
        (capability) => canonicalModelAuthProviderId(capability.provider) === missing?.provider,
      )
      .map((capability) => capability.provider);
    return missing
      ? {
          model: missing.model,
          disabled: !options.canStart() || busy(),
          onChoose: () => void open(providers),
        }
      : null;
  }

  async function activateSavedProfile(profileId: string, modelRef: string): Promise<void> {
    const previousModel = selection().modelRef;
    if (!options.canStart() || mutationActive || selection().missing?.model !== modelRef) {
      return;
    }
    // Keep the unavailable pin until the existing activation owner verifies and
    // commits the explicit replacement; clearing it could select another account.
    currentPicker = null;
    signIn.mode = "activate";
    message = undefined;
    refreshWarning = null;
    const kind = `saved-auth:${encodeURIComponent(profileId)}` as const;
    await run(() => {
      // Config writes may settle while activation waits for the mutation owner.
      // Do not restore a selection that changed after the operator clicked Use.
      if (selection().modelRef !== previousModel) {
        throw new Error(t("modelProviders.login.selectionChanged"));
      }
      return runner.activate({ kind, modelRef }, profileId);
    });
  }

  function loginProviders(
    providers?: string[],
    authStatus = options.getScope().authStatus,
    allowSetup = false,
    pluginId?: string,
  ) {
    return buildLoginProviders({
      providers,
      pluginId,
      authStatus,
      allowQuickApiKey: Boolean(options.onApiKey),
      manualProviders:
        allowSetup && options.onManualProvider ? options.getManualProviders?.() : undefined,
    });
  }

  /** Opens the picker, optionally selecting a provider's methods. */
  async function open(
    providers?: string[],
    { pluginId, select }: { pluginId?: string; select?: string } = {},
  ): Promise<void> {
    if (!options.canStart() || busy()) {
      return;
    }
    const scope = options.getScope();
    const { client } = scope.context.gateway.snapshot;
    if (!client || !scope.agentId) {
      return;
    }
    // Setup always chooses a model; elsewhere a sign-in only chooses one for an
    // agent without a configured primary, never replacing the operator's choice.
    const allowSetup = !pluginId && (Boolean(options.onManualProvider) || !selection().modelRef);
    const currentGeneration = ++generation;
    const request = {
      controller: new AbortController(),
      result: Promise.withResolvers<ModelAuthStatusResult | null>(),
    };
    inventoryRequest = request;
    // Cancellation can retire a rejected receipt before Solid observes it.
    void request.result.promise.catch(() => {});
    const isCurrent = () => {
      const current = options.getScope();
      return (
        currentGeneration === generation &&
        current.context.gateway.snapshot.client === client &&
        current.agentId === scope.agentId &&
        options.canContinue()
      );
    };
    const picker = {
      providers,
      pluginId,
      isCurrent,
      allowSetup,
      inventory: { value: scope.authStatus ?? request.result.promise },
    };
    setQuery("");
    setProvider("");
    currentPicker = picker;
    focusPicker = null;
    message = undefined;
    notify();
    try {
      const authStatus =
        scope.authStatus ??
        (await loadModelAuthStatus(client, {
          agentId: scope.agentId,
          signal: request.controller.signal,
        }));
      if (inventoryRequest === request && isCurrent()) {
        const available = loginProviders(providers, authStatus, allowSetup, pluginId);
        const only =
          (providers || pluginId) && available.length === 1 ? available[0]?.id : undefined;
        const provider = available.find((group) => group.id === (select ?? only));
        setProvider(provider?.id ?? "");
        // An awaited inventory mounts the modal before its inputs exist.
        if (!scope.authStatus) {
          focusPicker = provider ? "method" : "search";
        }
        request.result.resolve(authStatus);
      }
    } catch (error) {
      if (inventoryRequest === request && isCurrent()) {
        request.result.reject(error);
      }
    } finally {
      if (inventoryRequest === request && currentGeneration === generation) {
        inventoryRequest = undefined;
        if (!isCurrent()) {
          currentPicker = null;
          request.result.resolve(null);
        }
        notify();
        onSettled(focusPickerTarget);
      }
    }
  }

  function invalidateInventory(): void {
    inventoryRequest?.controller.abort();
    inventoryRequest?.result.reject(new Error(t("modelProviders.requestFailed")));
    inventoryRequest = undefined;
  }

  function reset(): void {
    // Release presentation before publishing replacement scope or dialog state.
    presentation.reset();
    generation += 1;
    chat.reset();
    inventoryRequest?.controller.abort();
    // An ignored transport abort must not keep the retired read unresolved.
    inventoryRequest?.result.resolve(null);
    inventoryRequest = undefined;
    currentPicker = null;
    focusPicker = null;
    searchInput = undefined;
    methodChoices = undefined;
    apiKeyChoice = undefined;
    mutationActive = false;
    presentationReady = undefined;
    refreshWarning = null;
    message = undefined;
    modelSelection.clear();
    completionModel = undefined;
    verifiedModelRef = undefined;
    completionCatalog.clear();
    // Cleanup addresses the original connection and wizard only. Late replies
    // cannot publish credentials or errors into another agent's view.
    wizard.reset();
    signIn.forget();
    notify();
  }

  function focusPickerTarget() {
    if (focusPicker && currentPicker) {
      // The method group contains only current choice buttons; quick-key-only groups use the fallback.
      const target =
        focusPicker === "search" ? searchInput : (methodChoices?.firstElementChild ?? apiKeyChoice);
      if (target instanceof HTMLElement) {
        focusPicker = null;
        target.focus({ preventScroll: true });
      }
    }
  }
  onSettled(() => {
    // A suspended or recorded sign-in continues once config admits it again.
    const stopConfig = options.getScope().context.runtimeConfig.subscribe(signIn.synchronize);
    return () => {
      stopConfig();
      presentation.dispose();
      publish = undefined;
      generation += 1;
      chat.reset();
      inventoryRequest?.controller.abort();
      inventoryRequest?.result.resolve(null);
      completionCatalog.clear();
    };
  });

  function doneAction() {
    view.read();
    return (
      modelSelection.action() ??
      (completionModel
        ? {
            label: t("modelProviders.login.startChat", { model: completionModel.name }),
            disabled: presentation.chatSaving() || chat.busy,
            onClick: () => void startChat(),
          }
        : undefined)
    );
  }

  function pickerView(authStatus?: ModelAuthStatusResult | null) {
    view.read();
    const picker = currentPicker;
    if (!picker || wizard.state().phase !== "idle") {
      return null;
    }
    const canSelect = () => currentPicker === picker && Boolean(authStatus) && picker.isCurrent();
    const groups = authStatus
      ? loginProviders(picker.providers, authStatus, picker.allowSetup, picker.pluginId)
      : [];
    const provider = groups.find((group) => group.id === providerSelection());
    const accounts = provider ? providerAccounts(provider, authStatus) : [];
    const docsUrl =
      provider?.choices.find((choice) => choice.docsUrl)?.docsUrl ??
      "https://docs.openclaw.ai/concepts/model-providers";
    const missing = selection().missing;
    const recovery =
      missing && accounts.some((card) => card.id === missing.provider) ? missing : null;
    const matches = filterLoginProviders(groups, query());

    return {
      inventory: picker.inventory,
      unavailable: authStatus?.unavailable,
      query: query(),
      provider,
      accounts,
      recovery,
      docsUrl,
      matches,
      disabled: !authStatus || !picker.isCurrent(),
      canStart: options.canStart(),
      showDiscover: !picker.providers && !picker.pluginId && Boolean(options.onDiscover),
      // Back returns to the dialog's own catalog, so it shows only when the dialog opened there.
      showBack: !picker.providers,
      discoverDisabled: !picker.isCurrent(),
      description: recovery
        ? t("modelProviders.login.useAccountDescription", { model: recovery.model })
        : picker.allowSetup
          ? t("modelProviders.login.setupDescription")
          : provider?.choices.some((choice) => choice.requiresSetup)
            ? t("modelProviders.login.nativeDescription")
            : t("modelProviders.login.description"),
      onClose: () => reset(),
      onQuery: (value: string) => {
        setQuery(value);
      },
      onProvider: (providerId: string) => {
        const selected = groups.find((group) => group.id === providerId);
        // In the picker only a lone key skips ahead; a sign-in method keeps its method step.
        if (!canSelect() || !selected || (selected.apiKeyProvider && enter(selected, authStatus))) {
          return;
        }
        setProvider(providerId);
        focusPicker = "method";
        notify();
        onSettled(focusPickerTarget);
      },
      onChoice: (selected: LoginChoice) => canSelect() && startChoice(selected, picker.allowSetup),
      onApiKey: () => {
        if (!canSelect() || !provider?.apiKeyProvider) {
          return;
        }
        reset();
        options.onApiKey?.(provider.apiKeyProvider);
      },
      onUseProfile: (profileId: string) => {
        if (recovery && currentPicker === picker && picker.isCurrent()) {
          void activateSavedProfile(profileId, recovery.model);
        }
      },
      onDiscover: () => {
        if (currentPicker !== picker || !picker.isCurrent()) {
          return;
        }
        reset();
        options.onDiscover?.();
      },
      onBack: () => {
        if (!canSelect()) {
          return;
        }
        picker.providers = undefined;
        picker.pluginId = undefined;
        setProvider("");
        focusPicker = "search";
        notify();
        onSettled(focusPickerTarget);
      },
    };
  }

  /** Starts one sign-in method; the picker, if any, closes as the wizard takes over. */
  function startChoice(selected: LoginChoice, allowSetup: boolean): void {
    if (selected.kind === "setup-secret") {
      reset();
      options.onManualProvider?.(selected.id);
      return;
    }
    currentPicker = null;
    refreshWarning = null;
    signIn.choose(selected, allowSetup);
  }

  /** Starts a provider's only way in; false when it has a method step. */
  function enter(
    group: LoginProvider,
    authStatus = options.getScope().authStatus,
    allowSetup = Boolean(options.onManualProvider) || !selection().modelRef,
  ): boolean {
    const entry = directEntry(group, authStatus);
    if (entry && "choice" in entry) {
      startChoice(entry.choice, allowSetup);
    } else if (entry) {
      reset();
      options.onApiKey?.(entry.apiKeyProvider);
    }
    return entry !== null;
  }

  function showVerifiedStarter(completion: ModelSetupWizardCompletion): void {
    const modelRef = completion.modelActivation?.modelRef;
    if (!modelRef) {
      return;
    }
    const { context, agentId } = options.getScope();
    verifiedModelRef = modelRef;
    completionModel = verifiedStarterModel(
      readAgentModelCatalog(context.gateway.snapshot.client, agentId),
      modelRef,
      signIn.authProviderId,
      completion.modelActivation?.modelName,
    );
    notify();
  }

  async function complete(completion: ModelSetupWizardCompletion): Promise<void> {
    const { context, agentId } = options.getScope();
    const client = context.gateway.snapshot.client;
    const currentGeneration = generation;
    const providerId = signIn.authProviderId;
    const activating = signIn.mode === "activate";
    if (activating && !completion.modelActivation) {
      runner.fail(t("modelSetup.errors.activationFailed"));
      return;
    }
    verifiedModelRef = completion.modelActivation?.modelRef;
    const label = runner.state.authLabel;
    if (activating && !signIn.authProviderId) {
      runner.close();
    }
    message = {
      kind: "success",
      text: activating
        ? t("modelProviders.login.activated")
        : [
            label,
            t(
              signIn.mode === "access"
                ? "modelProviders.login.nativeDone"
                : "modelProviders.login.done",
            ),
          ]
            .filter(Boolean)
            .join(": "),
      warning:
        [
          completion.modelActivation?.gatewayRestartRequired ? t("labsPage.restartRequired") : null,
          refreshWarning,
        ]
          .filter(Boolean)
          .join("\n") || undefined,
    };
    notify();
    try {
      await options.refresh(providerId);
    } catch (error) {
      if (currentGeneration === generation) {
        refreshWarning = formatUiError(error, t("modelProviders.requestFailed"));
        notify();
      }
    }
    if (currentGeneration !== generation || context.gateway.snapshot.client !== client) {
      return;
    }
    if (client && agentId && providerId) {
      completionCatalog.bind(context.gateway, { agentId });
      void completionCatalog.read();
    }
  }

  async function startChat(): Promise<void> {
    presentation.synchronize();
    const retired = presentation.retired();
    const admitted = chat.start();
    if (!admitted) {
      return;
    }
    void presentation.run("chat", admitted.completion, retired, admitted.isCurrent, (error) => {
      refreshWarning = formatUiError(error, t("modelProviders.requestFailed"));
      notify();
    });
    return admitted.completion;
  }

  async function run(
    task: () => Promise<ModelSetupWizardCompletion | null>,
    settling = false,
  ): Promise<void> {
    const client = options.getScope().context.gateway.snapshot.client;
    if (!client || (mutationActive && !settling) || !options.canContinue()) {
      return;
    }
    presentation.synchronize();
    const retired = presentation.retired();
    const { connectionEpoch, agentId } = options.getScope();
    const currentGeneration = ++generation;
    mutationActive = true;
    notify();
    const isCurrent = () =>
      currentGeneration === generation &&
      options.getScope().context.gateway.snapshot.client === client &&
      options.getScope().connectionEpoch === connectionEpoch &&
      options.getScope().agentId === agentId;
    const checkpoint = Promise.withResolvers<void>();
    presentationReady = checkpoint.resolve;
    const operation = settleRun();
    // The runner owns continued work once its starting/step state is visible.
    // Release the presentation hold while it awaits the next wizard response.
    void presentation.run(
      "wizard",
      operation,
      Promise.race([retired, checkpoint.promise]),
      isCurrent,
      (error) => {
        runner.fail(formatUiError(error, t("modelProviders.requestFailed")));
      },
    );
    return operation;

    async function settleRun(): Promise<void> {
      try {
        const mutation = await options.getScope().context.runtimeConfig.runExternalMutation(
          async (mutationClient) => {
            if (mutationClient !== client) {
              throw new Error(t("modelProviders.requestFailed"));
            }
            const completion = await task();
            if (completion) {
              invalidateModelAuthStatusRequests(mutationClient);
              if (
                currentGeneration === generation &&
                options.getScope().context.gateway.snapshot.client === mutationClient &&
                completion.isCurrent?.() !== false
              ) {
                showVerifiedStarter(completion);
              }
            }
            return completion;
          },
          {
            canDispatch: () =>
              currentGeneration === generation &&
              options.getScope().context.gateway.snapshot.client === client &&
              options.canContinue(),
            dispatchError: t("modelProviders.requestFailed"),
          },
        );
        if (currentGeneration !== generation) {
          return;
        }
        if (!mutation.ok) {
          runner.fail(mutation.error);
          return;
        }
        refreshWarning = mutation.refresh.ok ? null : mutation.refresh.error;
        if (mutation.value && mutation.value.isCurrent?.() !== false) {
          await complete(mutation.value);
        }
      } catch (error) {
        if (currentGeneration === generation) {
          runner.fail(formatUiError(error, t("modelProviders.requestFailed")));
        }
      } finally {
        if (presentationReady === checkpoint.resolve) {
          presentationReady = undefined;
        }
        if (currentGeneration === generation) {
          mutationActive = false;
          notify();
        }
      }
    }
  }

  return {
    get busy() {
      return busy();
    },
    get providerActions() {
      view.read();
      return {
        canMutate: options.canStart(),
        loginBusy: busy(),
        onConnect: (card: ModelProviderCard) => open([card.id, ...card.credentialProviderIds]),
        canConnect: (card: ModelProviderCard) =>
          loginProviders([card.id, ...card.credentialProviderIds]).length > 0,
      };
    },
    get pageActions() {
      view.read();
      return {
        onConnect: () => open(),
        connectDisabled: !options.canStart() || busy(),
        loginMessage: message,
      };
    },
    get wizardViewProps() {
      view.read();
      const connectedLabel = signIn.authProviderLabel ?? runner.state.authLabel;
      const current = wizard.viewProps({
        mode: signIn.mode === "access" ? "auth" : signIn.mode,
        busy: mutationActive,
        refreshWarning,
        doneMessage: connectedLabel
          ? t("modelSetup.providerConnected", { provider: connectedLabel })
          : t("modelSetup.wizard.connected"),
        doneDescription:
          completionModel && !modelSelection.choosing
            ? t("modelProviders.login.modelReady", { model: completionModel.name })
            : undefined,
      });
      return {
        ...current,
        // Config admission can precede the runner's committed presentation.
        admissionPending: mutationActive && current.state.phase === "idle",
      };
    },
    saving: presentation.wizardSaving,
    doneAction,
    completionModelPicker: () => {
      view.read();
      return modelSelection.picker();
    },
    synchronize: signIn.synchronize,
    recoveryView,
    pickerView,
    setSearchInput(element: HTMLInputElement) {
      searchInput = element;
    },
    setMethodChoices(element: HTMLDivElement) {
      methodChoices = element;
    },
    setApiKeyChoice(element: HTMLButtonElement) {
      apiKeyChoice = element;
    },
    open,
    enter,
    invalidateInventory,
    reset: () => (signIn.active ? signIn.synchronize() : reset()),
  };
}

export type ModelProviderLogin = ReturnType<typeof createModelProviderLogin>;
