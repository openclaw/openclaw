import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import { splitTrailingAuthProfile } from "../../../../src/agents/model-ref-profile.js";
import type { ModelAuthStatusResult, SystemAgentSetupDetectResult } from "../../api/types.ts";
import type { ApplicationContext } from "../../app/context.ts";
import { WizardLoginController } from "../../components/wizard-login-controller.ts";
import { registerSettingsEnglish } from "../../i18n/locales/en-settings.ts";
import { resolveAgentConfig, resolveModelPrimary } from "../../lib/agents/display.ts";
import { currentConfigObject } from "../../lib/config/config-state-model.ts";
import { formatUiError } from "../../lib/format-error.ts";
import { invalidateModelAuthStatusRequests } from "../../lib/model-auth-request-state.ts";
import { canonicalModelAuthProviderId, loadModelAuthStatus } from "../../lib/model-auth.ts";
import { t } from "../../lib/reactive/i18n.ts";
import type {
  ModelSetupWizardRunner,
  ModelSetupWizardCompletion,
} from "../model-setup/wizard-runner.ts";
import type { ModelProviderRowMessage } from "./config-mutation.ts";
import { buildModelProviderCards, type ModelProviderCard } from "./data.ts";
import { buildLoginProviders } from "./login-providers.ts";
import type { ControllerHost } from "./page-controller.ts";
import "../../styles/model-providers.css";
registerSettingsEnglish();

type LoginControllerOptions = {
  getScope: () => {
    context: ApplicationContext;
    agentId: string | null;
    authStatus?: ModelAuthStatusResult | null;
  };
  canStart: () => boolean;
  canContinue: () => boolean;
  refresh: () => Promise<unknown>;
  onDiscover?: () => void;
  onApiKey?: (provider: string) => void;
  getManualProviders?: () => SystemAgentSetupDetectResult["manualProviders"];
  onManualProvider?: (authChoice: string) => void;
};

export class ModelProviderLoginController {
  private picker:
    | ({
        providers?: string[];
        providerId: string;
        query: string;
        isCurrent: () => boolean;
      } & (
        | { phase: "loading" }
        | { phase: "ready"; authStatus: ModelAuthStatusResult }
        | { phase: "error"; message: string }
      ))
    | null = null;
  private inventoryRequest: AbortController | undefined;
  private searchInput: HTMLInputElement | undefined;
  private methodChoices: HTMLElement | undefined;
  private focusPicker: "search" | "method" | null = null;
  private generation = 0;
  private mutationActive = false;
  private refreshWarning: string | null = null;
  private message: ModelProviderRowMessage | undefined;
  private mode: "auth" | "activate" = "auth";
  private readonly runner: ModelSetupWizardRunner;
  private readonly wizard: WizardLoginController;

  constructor(
    private readonly host: ControllerHost,
    private readonly options: LoginControllerOptions,
  ) {
    host.addController(this);
    this.wizard = new WizardLoginController(host, {
      getClient: () => options.getScope().context.gateway.snapshot.client,
      getAgentId: () => options.getScope().agentId,
      onClose: () => this.reset(),
      onAnswer: (value, includeValue) =>
        void this.run(() => this.runner.answer(value, includeValue)),
      onBackgroundCompletion: (completion) => this.run(() => Promise.resolve(completion), true),
      requestFailedMessage: () => t("modelProviders.requestFailed"),
      sessionExpiredMessage: () => t("modelProviders.login.sessionExpired"),
    });
    this.runner = this.wizard.runner;
  }

  get busy(): boolean {
    return (
      this.picker !== null ||
      this.mutationActive ||
      this.wizard.cancelling ||
      this.runner.state.phase !== "idle"
    );
  }

  get providerActions() {
    return {
      canMutate: this.options.canStart(),
      loginBusy: this.busy,
      onConnect: (card: ModelProviderCard) => this.open([card.id, ...card.credentialProviderIds]),
      canConnect: (card: ModelProviderCard) =>
        this.loginProviders([card.id, ...card.credentialProviderIds]).length > 0,
    };
  }

  get pageActions() {
    return {
      onConnect: () => this.open(),
      connectDisabled: !this.options.canStart() || this.busy,
      loginMessage: this.message,
    };
  }

  private selectedModel() {
    const { context, agentId } = this.options.getScope();
    const { entry, defaults } = resolveAgentConfig(
      currentConfigObject(context.runtimeConfig.state),
      agentId ?? "",
    );
    return resolveModelPrimary(entry?.model) ?? resolveModelPrimary(defaults?.model);
  }

  private missingSelection() {
    const modelRef = this.selectedModel();
    const { authStatus } = this.options.getScope();
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

  recoveryView() {
    const selection = this.missingSelection();
    const providers = this.options
      .getScope()
      .authStatus?.providerCapabilities?.filter(
        (capability) => canonicalModelAuthProviderId(capability.provider) === selection?.provider,
      )
      .map((capability) => capability.provider);
    return selection
      ? {
          model: selection.model,
          disabled: !this.options.canStart() || this.busy,
          onChoose: () => void this.open(providers),
        }
      : null;
  }

  private async activateSavedProfile(profileId: string, modelRef: string): Promise<void> {
    const selectedModel = this.selectedModel();
    if (
      !this.options.canStart() ||
      this.mutationActive ||
      this.missingSelection()?.model !== modelRef
    ) {
      return;
    }
    // Keep the unavailable pin until the existing activation owner verifies and
    // commits the explicit replacement; clearing it could select another account.
    this.picker = null;
    this.mode = "activate";
    this.message = undefined;
    this.refreshWarning = null;
    const kind = `saved-auth:${encodeURIComponent(profileId)}` as const;
    await this.run(() => {
      // Config writes may settle while activation waits for the mutation owner.
      // Do not restore a selection that changed after the operator clicked Use.
      if (this.selectedModel() !== selectedModel) {
        throw new Error(t("modelProviders.login.selectionChanged"));
      }
      return this.runner.activate({ kind, modelRef }, profileId);
    });
  }

  private loginProviders(providers?: string[], authStatus = this.options.getScope().authStatus) {
    return buildLoginProviders({
      providers,
      authStatus,
      allowQuickApiKey: Boolean(this.options.onApiKey),
      manualProviders: this.options.onManualProvider
        ? this.options.getManualProviders?.()
        : undefined,
    });
  }

  async open(providers?: string[], authChoice?: string): Promise<void> {
    if (!this.options.canStart() || this.busy) {
      return;
    }
    const scope = this.options.getScope();
    const { client, hello } = scope.context.gateway.snapshot;
    if (!client || !scope.agentId) {
      return;
    }
    const generation = ++this.generation;
    const controller = new AbortController();
    this.inventoryRequest = controller;
    const isCurrent = () => {
      const current = this.options.getScope();
      return (
        generation === this.generation &&
        current.context.gateway.snapshot.client === client &&
        current.context.gateway.snapshot.hello === hello &&
        current.agentId === scope.agentId &&
        this.options.canContinue()
      );
    };
    const picker = { providers, providerId: "", query: "", isCurrent };
    this.picker = { ...picker, phase: "loading" };
    this.focusPicker = null;
    this.message = undefined;
    this.host.requestUpdate();
    try {
      const authStatus =
        scope.authStatus ??
        (await loadModelAuthStatus(client, {
          agentId: scope.agentId,
          signal: controller.signal,
        }));
      if (isCurrent()) {
        const available = this.loginProviders(providers, authStatus);
        const provider = authChoice
          ? available.find((group) => group.choices.some((option) => option.id === authChoice))
          : providers && available.length === 1
            ? available[0]
            : undefined;
        this.picker = {
          ...picker,
          phase: "ready",
          authStatus,
          providerId: provider?.id ?? "",
        };
        // An awaited inventory mounts the modal before its inputs exist.
        if (!scope.authStatus) {
          this.focusPicker = provider ? "method" : "search";
        }
      }
    } catch (error) {
      if (isCurrent()) {
        this.picker = {
          ...picker,
          phase: "error",
          message: formatUiError(error, t("modelProviders.requestFailed")),
        };
      }
    } finally {
      if (generation === this.generation) {
        this.inventoryRequest = undefined;
        if (!isCurrent()) {
          this.picker = null;
        }
        this.host.requestUpdate();
      }
    }
  }

  reset(): void {
    this.generation += 1;
    this.inventoryRequest?.abort();
    this.inventoryRequest = undefined;
    this.picker = null;
    this.focusPicker = null;
    this.mutationActive = false;
    this.refreshWarning = null;
    this.message = undefined;
    this.mode = "auth";
    // Cleanup addresses the original connection and wizard only. Late replies
    // cannot publish credentials or errors into another agent's view.
    this.wizard.reset();
  }

  hostDisconnected(): void {
    this.reset();
  }

  hostUpdated(): void {
    if (!this.focusPicker || !this.picker) {
      return;
    }
    const choices = this.methodChoices;
    const target =
      this.focusPicker === "search"
        ? this.searchInput
        : (choices?.querySelector<HTMLElement>("button") ?? choices);
    this.focusPicker = null;
    target?.focus({ preventScroll: true });
  }

  setSearchInput(element: HTMLInputElement): void {
    this.searchInput = element;
  }

  setMethodChoices(element: HTMLElement): void {
    this.methodChoices = element;
  }

  get wizardViewProps() {
    return this.wizard.viewProps({
      mode: this.mode,
      busy: this.mutationActive,
      refreshWarning: this.refreshWarning,
    });
  }

  pickerView() {
    const picker = this.picker;
    if (!picker) {
      return null;
    }
    const canSelect = () =>
      this.picker === picker && picker.phase === "ready" && picker.isCurrent();
    const groups =
      picker.phase === "ready" ? this.loginProviders(picker.providers, picker.authStatus) : [];
    const provider = groups.find((group) => group.id === picker.providerId);
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
    const missing = this.missingSelection();
    const recovery =
      missing && accounts.some((card) => card.id === missing.provider) ? missing : null;
    const query = picker.query.trim().toLocaleLowerCase();
    const matches = groups.filter((group) =>
      [
        group.id,
        group.label,
        ...(group.apiKeyProvider ? [t("modelProviders.status.apiKey")] : []),
        ...group.choices.flatMap((choice) => [choice.label, choice.hint ?? ""]),
      ].some((text) => text.toLocaleLowerCase().includes(query)),
    );

    return {
      phase: picker.phase,
      error: picker.phase === "error" ? picker.message : undefined,
      unavailable: picker.phase === "ready" ? picker.authStatus.unavailable : undefined,
      query: picker.query,
      provider,
      accounts,
      recovery,
      docsUrl,
      matches,
      disabled: picker.phase !== "ready" || !picker.isCurrent(),
      canStart: this.options.canStart(),
      showDiscover: !picker.providers && Boolean(this.options.onDiscover),
      discoverDisabled: !picker.isCurrent(),
      description: recovery
        ? t("modelProviders.login.useAccountDescription", { model: recovery.model })
        : this.options.onManualProvider
          ? t("modelProviders.login.setupDescription")
          : t("modelProviders.login.description"),
      onClose: () => this.reset(),
      onQuery: (value: string) => {
        picker.query = value;
        this.host.requestUpdate();
      },
      onProvider: (providerId: string) => {
        if (!canSelect()) {
          return;
        }
        picker.providerId = providerId;
        this.focusPicker = "method";
        this.host.requestUpdate();
      },
      onChoice: (selected: (typeof groups)[number]["choices"][number]) => {
        if (!canSelect()) {
          return;
        }
        if (selected.kind === "setup-secret") {
          this.reset();
          this.options.onManualProvider?.(selected.id);
          return;
        }
        this.picker = null;
        this.mode = "auth";
        this.refreshWarning = null;
        this.runner.prepareSignIn(selected.kind, selected.label);
        void this.run(() => this.runner.start(selected.id, "models.authLogin"));
      },
      onApiKey: () => {
        if (!canSelect() || !provider?.apiKeyProvider) {
          return;
        }
        this.reset();
        this.options.onApiKey?.(provider.apiKeyProvider);
      },
      onUseProfile: (profileId: string) => {
        if (recovery && this.picker === picker && picker.isCurrent()) {
          void this.activateSavedProfile(profileId, recovery.model);
        }
      },
      onDiscover: () => {
        if (this.picker !== picker || !picker.isCurrent()) {
          return;
        }
        this.reset();
        this.options.onDiscover?.();
      },
      onBack: () => {
        if (!canSelect()) {
          return;
        }
        picker.providers = undefined;
        picker.providerId = "";
        this.focusPicker = "search";
        this.host.requestUpdate();
      },
    };
  }

  private async complete(completion: ModelSetupWizardCompletion): Promise<void> {
    const activating = completion.startMethod === "openclaw.setup.activate.start";
    if (activating && !completion.modelActivation) {
      this.runner.fail(t("modelSetup.errors.activationFailed"));
      return;
    }
    const label = this.runner.state.authLabel;
    this.runner.close();
    this.message = {
      kind: "success",
      text: activating
        ? t("modelProviders.login.activated")
        : [label, t("modelProviders.login.done")].filter(Boolean).join(": "),
      warning:
        [
          completion.modelActivation?.gatewayRestartRequired ? t("labsPage.restartRequired") : null,
          this.refreshWarning,
        ]
          .filter(Boolean)
          .join("\n") || undefined,
    };
    this.host.requestUpdate();
    await this.options.refresh();
  }

  private async run(
    task: () => Promise<ModelSetupWizardCompletion | null>,
    settling = false,
  ): Promise<void> {
    const client = this.options.getScope().context.gateway.snapshot.client;
    if (!client || (this.mutationActive && !settling) || !this.options.canContinue()) {
      return;
    }
    const generation = ++this.generation;
    this.mutationActive = true;
    this.host.requestUpdate();
    try {
      const mutation = await this.options.getScope().context.runtimeConfig.runExternalMutation(
        async (mutationClient) => {
          if (mutationClient !== client) {
            throw new Error(t("modelProviders.requestFailed"));
          }
          const completion = await task();
          if (completion) {
            invalidateModelAuthStatusRequests(mutationClient);
          }
          return completion;
        },
        {
          canDispatch: () =>
            generation === this.generation &&
            this.options.getScope().context.gateway.snapshot.client === client &&
            this.options.canContinue(),
          dispatchError: t("modelProviders.requestFailed"),
        },
      );
      if (generation !== this.generation) {
        return;
      }
      if (!mutation.ok) {
        this.runner.fail(mutation.error);
        return;
      }
      this.refreshWarning = mutation.refresh.ok ? null : mutation.refresh.error;
      if (mutation.value && mutation.value.isCurrent?.() !== false) {
        await this.complete(mutation.value);
      }
    } catch (error) {
      if (generation === this.generation) {
        this.runner.fail(formatUiError(error, t("modelProviders.requestFailed")));
      }
    } finally {
      if (generation === this.generation) {
        this.mutationActive = false;
        this.host.requestUpdate();
      }
    }
  }
}
