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
import { buildModelProviderCards, type ModelProviderCard } from "./data.ts";
import { createLoginSavingPresentation } from "./login-presentation.ts";
import { buildLoginProviders, resolveLoginSelection } from "./login-providers.ts";
import { createModelProviderStartChat } from "./login-start-chat.ts";
import "../../styles/model-providers.css";
registerEnglishCatalog(registerSettingsEnglish);

type LoginOptions = {
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
};

export function createModelProviderLogin(options: LoginOptions) {
  let publish: (() => void) | undefined;
  const notify = () => publish?.();
  const [query, setQuery] = createSignal("");
  const [providerSelection, setProvider] = createSignal("");
  let currentPicker: {
    providers?: string[];
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
  let loginMode: "auth" | "activate" | "access" = "auth";
  let authProviderId: string | undefined;
  let completionModel: ModelCatalogEntry | undefined;
  let verifiedModelRef: string | undefined;

  const wizard = createWizardLogin({
    getClient: () => options.getScope().context.gateway.snapshot.client,
    getAgentId: () => options.getScope().agentId,
    onClose: () => reset(),
    onPresentationChange: () => presentationReady?.(),
    onAnswer: (value, includeValue) => void run(() => runner.answer(value, includeValue)),
    onBackgroundCompletion: (completion) => run(() => Promise.resolve(completion), true),
    requestFailedMessage: () => t("modelProviders.requestFailed"),
    sessionExpiredMessage: () => t("modelProviders.login.sessionExpired"),
  });
  const runner = wizard.runner;
  const completionCatalog = new ModelCatalogReader(notify, {
    onResult: (catalog) => {
      const available = (model: ModelCatalogEntry) =>
        canonicalModelAuthProviderId(model.provider) === authProviderId &&
        model.available === true &&
        model.manualSelectionAllowed !== false;
      const selected = completionModel;
      completionModel = selected
        ? (catalog.models.find(
            (model) => model.provider === selected.provider && model.id === selected.id,
          ) ?? selected)
        : (catalog.models.find((model) => available(model) && model.recommended === true) ??
          catalog.models.find(
            (model) => available(model) && `${model.provider}/${model.id}` === verifiedModelRef,
          ));
      notify();
    },
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
    loginMode = "activate";
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
  ) {
    return buildLoginProviders({
      providers,
      authStatus,
      allowQuickApiKey: Boolean(options.onApiKey),
      manualProviders:
        allowSetup && options.onManualProvider ? options.getManualProviders?.() : undefined,
    });
  }

  function connectProvider(models: ModelCatalogEntry[]): Promise<void> {
    return open(undefined, {
      allowSetup: !models.some((model) => model.available !== false),
    });
  }

  async function open(
    providers?: string[],
    { allowSetup = Boolean(options.onManualProvider) }: { allowSetup?: boolean } = {},
  ): Promise<void> {
    if (!options.canStart() || busy()) {
      return;
    }
    const scope = options.getScope();
    const { client } = scope.context.gateway.snapshot;
    if (!client || !scope.agentId) {
      return;
    }
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
        const available = loginProviders(providers, authStatus, allowSetup);
        const provider = providers && available.length === 1 ? available[0] : undefined;
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
    loginMode = "auth";
    authProviderId = undefined;
    completionModel = undefined;
    verifiedModelRef = undefined;
    completionCatalog.clear();
    // Cleanup addresses the original connection and wizard only. Late replies
    // cannot publish credentials or errors into another agent's view.
    wizard.reset();
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
  onSettled(() => () => {
    presentation.dispose();
    publish = undefined;
    generation += 1;
    chat.reset();
    inventoryRequest?.controller.abort();
    inventoryRequest?.result.resolve(null);
    completionCatalog.clear();
  });

  function doneAction() {
    view.read();
    return completionModel
      ? {
          label: t("modelProviders.login.startChat", { model: completionModel.name }),
          disabled: presentation.chatSaving() || chat.busy,
          onClick: () => void startChat(),
        }
      : undefined;
  }

  function pickerView(authStatus?: ModelAuthStatusResult | null) {
    view.read();
    const picker = currentPicker;
    if (!picker) {
      return null;
    }
    const canSelect = () => currentPicker === picker && Boolean(authStatus) && picker.isCurrent();
    const groups = authStatus
      ? loginProviders(picker.providers, authStatus, picker.allowSetup)
      : [];
    const provider = groups.find((group) => group.id === providerSelection());
    const accounts =
      provider && authStatus
        ? buildModelProviderCards({
            authStatus,
            models: null,
            providerUsage: null,
          }).filter((card) =>
            provider.authProviders.some((owner) => card.id === canonicalModelAuthProviderId(owner)),
          )
        : [];
    const docsUrl =
      provider?.choices.find((choice) => choice.docsUrl)?.docsUrl ??
      "https://docs.openclaw.ai/concepts/model-providers";
    const missing = selection().missing;
    const recovery =
      missing && accounts.some((card) => card.id === missing.provider) ? missing : null;
    const search = query().trim().toLocaleLowerCase();
    const matches = groups.filter((group) =>
      [
        group.id,
        group.label,
        ...(group.apiKeyProvider ? [t("modelProviders.status.apiKey")] : []),
        ...group.choices.flatMap((choice) => [choice.label, choice.hint ?? ""]),
      ].some((text) => text.toLocaleLowerCase().includes(search)),
    );

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
      showDiscover: !picker.providers && Boolean(options.onDiscover),
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
        if (!canSelect()) {
          return;
        }
        setProvider(providerId);
        focusPicker = "method";
        notify();
        onSettled(focusPickerTarget);
      },
      onChoice: (selected: (typeof groups)[number]["choices"][number]) => {
        if (!canSelect()) {
          return;
        }
        if (selected.kind === "setup-secret") {
          reset();
          options.onManualProvider?.(selected.id);
          return;
        }
        authProviderId = canonicalModelAuthProviderId(selected.authProvider);
        currentPicker = null;
        const selectingModel = picker.allowSetup && selected.requiresSetup;
        loginMode = selectingModel ? "activate" : selected.requiresSetup ? "access" : "auth";
        refreshWarning = null;
        runner.prepareSignIn(selected.kind, selected.label);
        void run(() =>
          runner.start(
            selected.id,
            "models.authLogin",
            selectingModel ? { selectModel: true } : {},
          ),
        );
      },
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
        setProvider("");
        focusPicker = "search";
        notify();
        onSettled(focusPickerTarget);
      },
    };
  }

  function showVerifiedStarter(completion: ModelSetupWizardCompletion): void {
    const modelRef = completion.modelActivation?.modelRef;
    if (!modelRef) {
      return;
    }
    const { context, agentId } = options.getScope();
    const catalog = readAgentModelCatalog(context.gateway.snapshot.client, agentId);
    const slash = modelRef.indexOf("/");
    const provider = modelRef.slice(0, slash);
    const id = modelRef.slice(slash + 1);
    const known = catalog.models.find((model) => model.provider === provider && model.id === id);
    verifiedModelRef = modelRef;
    const recommended =
      !catalog.retired &&
      catalog.models.find(
        (model) =>
          canonicalModelAuthProviderId(model.provider) === authProviderId &&
          model.available === true &&
          model.manualSelectionAllowed !== false &&
          model.recommended === true,
      );
    const name = completion.modelActivation?.modelName ?? known?.name;
    completionModel = recommended
      ? { provider: recommended.provider, id: recommended.id, name: recommended.name }
      : name
        ? { provider, id, name }
        : undefined;
    notify();
  }

  async function complete(completion: ModelSetupWizardCompletion): Promise<void> {
    const { context, agentId } = options.getScope();
    const client = context.gateway.snapshot.client;
    const currentGeneration = generation;
    const providerId = authProviderId;
    const activating = loginMode === "activate";
    if (activating && !completion.modelActivation) {
      runner.fail(t("modelSetup.errors.activationFailed"));
      return;
    }
    verifiedModelRef = completion.modelActivation?.modelRef;
    const label = runner.state.authLabel;
    if (activating && !authProviderId) {
      runner.close();
    }
    message = {
      kind: "success",
      text: activating
        ? t("modelProviders.login.activated")
        : [
            label,
            t(
              loginMode === "access"
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
      const current = wizard.viewProps({
        mode: loginMode === "access" ? "auth" : loginMode,
        busy: mutationActive,
        refreshWarning,
        doneMessage: runner.state.authLabel
          ? t("modelSetup.providerConnected", { provider: runner.state.authLabel })
          : t("modelSetup.wizard.connected"),
        doneDescription: completionModel
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
    synchronizePresentation: presentation.synchronize,
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
    connectProvider,
    open,
    invalidateInventory,
    reset,
  };
}

export type ModelProviderLogin = ReturnType<typeof createModelProviderLogin>;
