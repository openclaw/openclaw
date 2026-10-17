import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import { createSignal, onCleanup, onSettled } from "solid-js";
import { splitTrailingAuthProfile } from "../../../../src/agents/model-ref-profile.js";
import type {
  ModelAuthStatusResult,
  ModelCatalogEntry,
  SystemAgentSetupDetectResult,
} from "../../api/types.ts";
import type { ApplicationContext } from "../../app/context.ts";
import { createWizardLogin } from "../../components/wizard-login-controller.tsx";
import { registerSettingsEnglish } from "../../i18n/locales/en-settings.ts";
import { resolveAgentConfig, resolveModelPrimary } from "../../lib/agents/display.ts";
import { currentConfigObject } from "../../lib/config/config-state-model.ts";
import { formatUiError } from "../../lib/format-error.ts";
import { invalidateModelAuthStatusRequests } from "../../lib/model-auth-request-state.ts";
import { canonicalModelAuthProviderId, loadModelAuthStatus } from "../../lib/model-auth.ts";
import { ModelCatalogReader } from "../../lib/model-catalog-reader.ts";
import { readAgentModelCatalog } from "../../lib/model-catalog-store.ts";
import { registerEnglishCatalog, t } from "../../lib/reactive/i18n.ts";
import { projectSource } from "../../lib/reactive/projection.ts";
import { openPreferredApplicationSession } from "../../lib/sessions/route-navigation.ts";
import type { ModelSetupWizardCompletion } from "../model-setup/wizard-runner.ts";
import type { ModelProviderRowMessage } from "./config-mutation.ts";
import { buildModelProviderCards, type ModelProviderCard } from "./data.ts";
import { buildLoginProviders } from "./login-providers.ts";
import "../../styles/model-providers.css";
registerEnglishCatalog(registerSettingsEnglish);

type LoginOptions = {
  getScope: () => {
    context: ApplicationContext;
    agentId: string | null;
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
  const listeners = new Set<() => void>();
  const notify = () => listeners.forEach((listener) => listener());
  const [query, setQuery] = createSignal("");
  const [providerSelection, setProvider] = createSignal("");
  let currentPicker:
    | ({
        providers?: string[];
        allowSetup: boolean;
        isCurrent: () => boolean;
      } & (
        | { phase: "loading" }
        | { phase: "ready"; authStatus: ModelAuthStatusResult }
        | { phase: "error"; message: string }
      ))
    | null = null;
  let inventoryRequest: AbortController | undefined;
  let startChatRequest: AbortController | undefined;
  let searchInput: HTMLInputElement | undefined;
  let methodChoice: HTMLButtonElement | undefined;
  let focusPicker: "search" | "method" | null = null;
  let generation = 0;
  let mutationActive = false;
  let refreshWarning: string | null = null;
  let message: ModelProviderRowMessage | undefined;
  let loginMode: "auth" | "activate" | "access" = "auth";
  let authProviderId: string | undefined;
  let completionModel: ModelCatalogEntry | undefined;
  let verifiedModelRef: string | undefined;
  let startingChat = false;

  const wizard = createWizardLogin({
    getClient: () => options.getScope().context.gateway.snapshot.client,
    getAgentId: () => options.getScope().agentId,
    onClose: () => reset(),
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
    read: () => ({
      picker: currentPicker,
      mutationActive,
      refreshWarning,
      message,
      loginMode,
      completionModel,
      startingChat,
    }),
    subscribe: (_, listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    equality: "revision",
  });

  function busy(): boolean {
    view.read();
    wizard.state();
    return (
      currentPicker !== null || mutationActive || wizard.cancelling || runner.state.phase !== "idle"
    );
  }

  function providerActions() {
    view.read();
    return {
      canMutate: options.canStart(),
      loginBusy: busy(),
      onConnect: (card: ModelProviderCard) => open([card.id, ...card.credentialProviderIds]),
      canConnect: (card: ModelProviderCard) =>
        loginProviders([card.id, ...card.credentialProviderIds]).length > 0,
    };
  }

  function pageActions() {
    view.read();
    return {
      onConnect: () => open(),
      connectDisabled: !options.canStart() || busy(),
      loginMessage: message,
    };
  }

  function selectedModel() {
    const { context, agentId } = options.getScope();
    const { entry, defaults } = resolveAgentConfig(
      currentConfigObject(context.runtimeConfig.state),
      agentId ?? "",
    );
    return resolveModelPrimary(entry?.model) ?? resolveModelPrimary(defaults?.model);
  }

  function missingSelection() {
    const modelRef = selectedModel();
    const { authStatus } = options.getScope();
    if (!modelRef || !authStatus?.ts || authStatus.unavailable) {
      return null;
    }
    const { model, profile } = splitTrailingAuthProfile(modelRef);
    const slash = model.indexOf("/");
    if (
      !profile ||
      slash < 1 ||
      authStatus.providers.some((provider) =>
        provider.profiles.some((candidate) => candidate.profileId === profile),
      )
    ) {
      return null;
    }
    const modelProvider = normalizeProviderId(model.slice(0, slash));
    const authProvider =
      authStatus.providers.find(
        (provider) => normalizeProviderId(provider.provider) === modelProvider,
      )?.authProvider ?? modelProvider;
    return { model, provider: canonicalModelAuthProviderId(modelProvider), authProvider };
  }

  function recoveryView() {
    view.read();
    const selection = missingSelection();
    const providers = options
      .getScope()
      .authStatus?.providerCapabilities?.filter(
        (capability) => canonicalModelAuthProviderId(capability.provider) === selection?.provider,
      )
      .map((capability) => capability.provider);
    return selection
      ? {
          model: selection.model,
          disabled: !options.canStart() || busy(),
          onChoose: () => void open(providers),
        }
      : null;
  }

  async function activateSavedProfile(profileId: string, modelRef: string): Promise<void> {
    const previousModel = selectedModel();
    if (!options.canStart() || mutationActive || missingSelection()?.model !== modelRef) {
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
      if (selectedModel() !== previousModel) {
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
    const { client, hello } = scope.context.gateway.snapshot;
    if (!client || !scope.agentId) {
      return;
    }
    const currentGeneration = ++generation;
    const controller = new AbortController();
    inventoryRequest = controller;
    const isCurrent = () => {
      const current = options.getScope();
      return (
        currentGeneration === generation &&
        current.context.gateway.snapshot.client === client &&
        current.context.gateway.snapshot.hello === hello &&
        current.agentId === scope.agentId &&
        options.canContinue()
      );
    };
    const picker = { providers, isCurrent, allowSetup };
    setQuery("");
    setProvider("");
    currentPicker = { ...picker, phase: "loading" };
    focusPicker = null;
    message = undefined;
    notify();
    try {
      const authStatus =
        scope.authStatus ??
        (await loadModelAuthStatus(client, {
          agentId: scope.agentId,
          signal: controller.signal,
        }));
      if (isCurrent()) {
        const available = loginProviders(providers, authStatus, allowSetup);
        const provider = providers && available.length === 1 ? available[0] : undefined;
        currentPicker = {
          ...picker,
          phase: "ready",
          authStatus,
        };
        setProvider(provider?.id ?? "");
        // An awaited inventory mounts the modal before its inputs exist.
        if (!scope.authStatus) {
          focusPicker = provider ? "method" : "search";
        }
      }
    } catch (error) {
      if (isCurrent()) {
        currentPicker = {
          ...picker,
          phase: "error",
          message: formatUiError(error, t("modelProviders.requestFailed")),
        };
      }
    } finally {
      if (currentGeneration === generation) {
        inventoryRequest = undefined;
        if (!isCurrent()) {
          currentPicker = null;
        }
        notify();
        onSettled(focusPickerTarget);
      }
    }
  }

  function reset(): void {
    generation += 1;
    startChatRequest?.abort();
    startChatRequest = undefined;
    inventoryRequest?.abort();
    inventoryRequest = undefined;
    currentPicker = null;
    focusPicker = null;
    searchInput = undefined;
    methodChoice = undefined;
    mutationActive = false;
    refreshWarning = null;
    message = undefined;
    loginMode = "auth";
    authProviderId = undefined;
    completionModel = undefined;
    verifiedModelRef = undefined;
    startingChat = false;
    completionCatalog.clear();
    // Cleanup addresses the original connection and wizard only. Late replies
    // cannot publish credentials or errors into another agent's view.
    wizard.reset();
    notify();
  }

  function focusPickerTarget() {
    if (focusPicker && currentPicker) {
      const target = focusPicker === "search" ? searchInput : methodChoice;
      if (target) {
        focusPicker = null;
        target.focus({ preventScroll: true });
      }
    }
  }
  onCleanup(() => {
    listeners.clear();
    generation += 1;
    startChatRequest?.abort();
    inventoryRequest?.abort();
    completionCatalog.clear();
  });

  function setSearchInput(element: HTMLInputElement): void {
    searchInput = element;
  }

  function setMethodChoice(element: HTMLButtonElement): void {
    methodChoice = element;
    focusPickerTarget();
  }

  function wizardViewProps() {
    view.read();
    return wizard.viewProps({
      mode: loginMode === "access" ? "auth" : loginMode,
      busy: mutationActive,
      refreshWarning,
      doneMessage: runner.state.authLabel
        ? t("modelSetup.providerConnected", { provider: runner.state.authLabel })
        : t("modelSetup.wizard.connected"),
      doneDescription: completionModel
        ? t("modelProviders.login.modelReady", { model: completionModel.name })
        : undefined,
      doneAction: completionModel
        ? {
            label: t("modelProviders.login.startChat", { model: completionModel.name }),
            disabled: startingChat,
            onClick: () => void startChat(),
          }
        : undefined,
    });
  }

  function pickerView() {
    view.read();
    const picker = currentPicker;
    if (!picker) {
      return null;
    }
    const canSelect = () =>
      currentPicker === picker && picker.phase === "ready" && picker.isCurrent();
    const groups =
      picker.phase === "ready"
        ? loginProviders(picker.providers, picker.authStatus, picker.allowSetup)
        : [];
    const provider = groups.find((group) => group.id === providerSelection());
    const accounts =
      provider && picker.phase === "ready"
        ? buildModelProviderCards({
            authStatus: picker.authStatus,
            models: null,
            providerUsage: null,
            costByProvider: null,
          }).filter((card) =>
            provider.authProviders.some((owner) => card.id === canonicalModelAuthProviderId(owner)),
          )
        : [];
    const docsUrl =
      provider?.choices.find((choice) => choice.docsUrl)?.docsUrl ??
      "https://docs.openclaw.ai/concepts/model-providers";
    const missing = missingSelection();
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
      phase: picker.phase,
      error: picker.phase === "error" ? picker.message : undefined,
      unavailable: picker.phase === "ready" ? picker.authStatus.unavailable : undefined,
      query: query(),
      provider,
      accounts,
      recovery,
      docsUrl,
      matches,
      disabled: picker.phase !== "ready" || !picker.isCurrent(),
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
        methodChoice = undefined;
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
    const model = completionModel;
    const { context, agentId } = options.getScope();
    if (!model || !agentId || startingChat || !options.canContinue()) {
      return;
    }
    const currentGeneration = generation;
    const client = context.gateway.snapshot.client;
    const request = new AbortController();
    startChatRequest = request;
    startingChat = true;
    notify();
    try {
      const key = await context.sessions.create(
        {
          agentId,
          model: `${model.provider}/${model.id}`,
          ...(model.agentRuntime ? { agentRuntime: model.agentRuntime.id } : {}),
        },
        { signal: request.signal },
      );
      if (currentGeneration !== generation || context.gateway.snapshot.client !== client) {
        return;
      }
      if (key) {
        reset();
        openPreferredApplicationSession(context, key, agentId);
      } else {
        refreshWarning = context.sessions.state.error ?? t("modelProviders.requestFailed");
      }
    } catch (error) {
      if (currentGeneration === generation) {
        refreshWarning = formatUiError(error, t("modelProviders.requestFailed"));
      }
    } finally {
      if (startChatRequest === request) {
        startChatRequest = undefined;
      }
      if (currentGeneration === generation) {
        startingChat = false;
        notify();
      }
    }
  }

  async function run(
    task: () => Promise<ModelSetupWizardCompletion | null>,
    settling = false,
  ): Promise<void> {
    const client = options.getScope().context.gateway.snapshot.client;
    if (!client || (mutationActive && !settling) || !options.canContinue()) {
      return;
    }
    const currentGeneration = ++generation;
    mutationActive = true;
    notify();
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
      if (currentGeneration === generation) {
        mutationActive = false;
        notify();
      }
    }
  }
  return {
    get busy() {
      return busy();
    },
    get providerActions() {
      return providerActions();
    },
    get pageActions() {
      return pageActions();
    },
    get wizardViewProps() {
      return wizardViewProps();
    },
    recoveryView,
    pickerView,
    setSearchInput,
    setMethodChoice,
    connectProvider,
    open,
    reset,
  };
}

export type ModelProviderLogin = ReturnType<typeof createModelProviderLogin>;
