import { html, nothing, type ReactiveController, type ReactiveControllerHost } from "lit";
import { createRef, ref } from "lit/directives/ref.js";
import type { ModelAuthStatusResult, ProviderLoginOption } from "../../api/types.ts";
import type { ApplicationContext } from "../../app/context.ts";
import type { DecisionModelEntry } from "../../components/decision-model-picker.ts";
import { providerDisplayLabel, renderProviderBrandIcon } from "../../components/provider-icon.ts";
import { WizardLoginController } from "../../components/wizard-login-controller.ts";
import { renderWizardSingleChoice } from "../../components/wizard-step-controls.ts";
import { t } from "../../i18n/index.ts";
import { registerSettingsEnglish } from "../../i18n/locales/en-settings.ts";
import { formatUiError } from "../../lib/format-error.ts";
import { invalidateModelAuthStatusRequests } from "../../lib/model-auth-request-state.ts";
import { loadModelAuthStatus } from "../../lib/model-auth.ts";
import type {
  ModelSetupWizardRunner,
  ModelSetupWizardCompletion,
} from "../model-setup/wizard-runner.ts";
import type { ModelProviderRowMessage } from "./config-mutation.ts";
import type { ModelProviderCard } from "./data.ts";
registerSettingsEnglish();

type LoginControllerOptions = {
  getScope: () => {
    context: ApplicationContext;
    agentId: string | null;
    authStatus?: ModelAuthStatusResult | null;
    decisionModels?: readonly DecisionModelEntry[];
  };
  canStart: () => boolean;
  canContinue: () => boolean;
  refresh: () => Promise<unknown>;
  onDiscover?: () => void;
  onApiKey?: (provider: string) => void;
  onDecisionSetup?: (model: DecisionModelEntry) => void;
};

type LoginProvider = {
  id: string;
  label: string;
  choices: ProviderLoginOption[];
  apiKeyProvider?: string;
  decisionModel?: DecisionModelEntry;
};

export class ModelProviderLoginController implements ReactiveController {
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
  private readonly searchInput = createRef<HTMLInputElement>();
  private readonly methodChoices = createRef<HTMLDivElement>();
  private focusPicker: "search" | "method" | null = null;
  private generation = 0;
  private mutationActive = false;
  private refreshWarning: string | null = null;
  private message: ModelProviderRowMessage | undefined;
  private readonly runner: ModelSetupWizardRunner;
  private readonly wizard: WizardLoginController;

  constructor(
    private readonly host: ReactiveControllerHost,
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
      selectedAgentId: this.options.getScope().agentId,
      onConnect: () => this.open(),
      connectDisabled: !this.options.canStart() || this.busy,
      login: this.render(),
      loginMessage: this.message,
    };
  }

  private loginProviders(
    providers?: string[],
    authStatus = this.options.getScope().authStatus,
  ): LoginProvider[] {
    const groups = new Map<string, LoginProvider>();
    const choices = new Set<string>();
    for (const capability of authStatus?.providerCapabilities ?? []) {
      if (providers && !providers.includes(capability.provider)) {
        continue;
      }
      for (const option of capability.loginOptions ?? []) {
        if (choices.has(option.id)) {
          continue;
        }
        choices.add(option.id);
        let group = groups.get(option.brandId);
        if (!group) {
          group = { id: option.brandId, label: "", choices: [] };
          groups.set(group.id, group);
        }
        group.label ||= option.groupLabel?.trim() ?? "";
        group.choices.push(option);
      }
      // Quick-key support is independent of wizard choices. Keep the exact
      // capability owner for the key form even when its login brand is an alias.
      if (capability.quickApiKeySetup && this.options.onApiKey) {
        const brands = capability.loginOptions?.length
          ? capability.loginOptions.map((option) => option.brandId)
          : [capability.provider];
        for (const id of new Set(brands)) {
          const group = groups.get(id) ?? { id, label: "", choices: [] };
          groups.set(id, { ...group, apiKeyProvider: group.apiKeyProvider ?? capability.provider });
        }
      }
    }
    if (this.options.onDecisionSetup) {
      for (const model of this.options.getScope().decisionModels ?? []) {
        if (!model.setup || (providers && !providers.includes(model.provider))) {
          continue;
        }
        const group: LoginProvider = groups.get(model.provider) ?? {
          id: model.provider,
          label: model.setup.label,
          choices: [],
        };
        group.decisionModel ??= model;
        groups.set(model.provider, group);
      }
    }
    for (const group of groups.values()) {
      group.label ||= providerDisplayLabel(group.id);
      group.choices.sort(
        (a, b) =>
          Number(b.featured) - Number(a.featured) ||
          a.label.localeCompare(b.label) ||
          a.id.localeCompare(b.id),
      );
    }
    return [...groups.values()].toSorted(
      (a, b) => a.label.localeCompare(b.label) || a.id.localeCompare(b.id),
    );
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
    this.picker = { phase: "loading", providers, providerId: "", query: "", isCurrent };
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
        if (provider?.decisionModel && !provider.choices.length && !provider.apiKeyProvider) {
          this.reset();
          this.options.onDecisionSetup?.(provider.decisionModel);
          return;
        }
        if (provider?.apiKeyProvider && !provider.choices.length && !provider.decisionModel) {
          this.reset();
          this.options.onApiKey?.(provider.apiKeyProvider);
          return;
        }
        this.picker = {
          phase: "ready",
          providers,
          authStatus,
          providerId: provider?.id ?? "",
          query: "",
          isCurrent,
        };
        // An awaited inventory mounts the modal before its inputs exist.
        if (!scope.authStatus) {
          this.focusPicker = provider ? "method" : "search";
        }
      }
    } catch (error) {
      if (isCurrent()) {
        this.picker = {
          phase: "error",
          isCurrent,
          providers,
          providerId: "",
          query: "",
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
    const choices = this.methodChoices.value;
    const target =
      this.focusPicker === "search"
        ? this.searchInput.value
        : (choices?.querySelector<HTMLElement>("button") ?? choices);
    this.focusPicker = null;
    target?.focus({ preventScroll: true });
  }

  render() {
    const picker = this.picker;
    if (picker) {
      const groups =
        picker.phase === "ready" ? this.loginProviders(picker.providers, picker.authStatus) : [];
      const provider = groups.find((group) => group.id === picker.providerId);
      const query = picker.query.trim().toLocaleLowerCase();
      const matches = groups.filter((group) =>
        [
          group.id,
          group.label,
          ...(group.apiKeyProvider ? [t("modelProviders.status.apiKey")] : []),
          ...group.choices.flatMap((choice) => [choice.label, choice.hint ?? ""]),
        ].some((text) => text.toLocaleLowerCase().includes(query)),
      );
      return html`
        <openclaw-modal-dialog
          label=${t("modelProviders.login.title")}
          @modal-cancel=${() => this.reset()}
        >
          <div class="model-setup-wizard model-provider-login">
            <div class="model-setup-wizard__header">
              <h2>${t("modelProviders.login.title")}</h2>
            </div>
            <div class="model-setup-wizard__body">
              <p>${t("modelProviders.login.description")}</p>
              ${
                picker.phase === "loading"
                  ? html`<div role="status">${t("common.loading")}</div>`
                  : picker.phase === "error"
                    ? html`<div role="alert">${picker.message}</div>`
                    : provider
                      ? html`
                          <h3 class="model-provider-login__provider">
                            ${renderProviderBrandIcon(provider.id)} ${provider.label}
                          </h3>
                          <div data-models-login-choice tabindex="-1" ${ref(this.methodChoices)}>
                            ${renderWizardSingleChoice({
                              label: t("modelProviders.login.method"),
                              options: provider.choices.map((option) => ({
                                value: option.id,
                                label: option.label,
                                hint: option.hint,
                              })),
                              busy: picker.phase !== "ready" || !picker.isCurrent(),
                              onAnswer: (value) => {
                                const selected = provider.choices.find(
                                  (option) => option.id === value,
                                );
                                if (
                                  this.picker !== picker ||
                                  !selected ||
                                  picker.phase !== "ready" ||
                                  !picker.isCurrent()
                                ) {
                                  return;
                                }
                                this.picker = null;
                                this.refreshWarning = null;
                                this.runner.prepareSignIn(selected.kind, selected.label);
                                void this.run(() =>
                                  this.runner.start(selected.id, "models.authLogin"),
                                );
                              },
                            })}
                          </div>
                          ${
                            provider.decisionModel
                              ? html`<button
                                  class="btn"
                                  data-models-login-decision
                                  ?disabled=${picker.phase !== "ready" || !picker.isCurrent()}
                                  @click=${() => {
                                    if (
                                      this.picker !== picker ||
                                      !picker.isCurrent() ||
                                      !provider.decisionModel
                                    ) {
                                      return;
                                    }
                                    this.reset();
                                    this.options.onDecisionSetup?.(provider.decisionModel);
                                  }}
                                >
                                  ${t("modelProviders.decisionSetup.entry")}
                                </button>`
                              : nothing
                          }
                          ${
                            provider.apiKeyProvider
                              ? html`
                                  <button
                                    type="button"
                                    class="btn"
                                    data-models-login-api-key
                                    ?disabled=${picker.phase !== "ready" || !picker.isCurrent()}
                                    @click=${() => {
                                      if (
                                        this.picker !== picker ||
                                        !provider.apiKeyProvider ||
                                        picker.phase !== "ready" ||
                                        !picker.isCurrent()
                                      ) {
                                        return;
                                      }
                                      this.reset();
                                      this.options.onApiKey?.(provider.apiKeyProvider);
                                    }}
                                  >
                                    ${t("modelProviders.apiKey.set")}
                                  </button>
                                `
                              : nothing
                          }
                        `
                      : html`
                          <label class="field">
                            <span>${t("modelProviders.search")}</span>
                            <input
                              type="search"
                              data-models-login-search
                              autofocus
                              autocomplete="off"
                              ${ref(this.searchInput)}
                              .value=${picker.query}
                              @input=${(event: Event) => {
                                // SAFETY: This handler is attached directly to the search input.
                                picker.query = (event.currentTarget as HTMLInputElement).value;
                                this.host.requestUpdate();
                              }}
                            />
                          </label>
                          <ul
                            class="model-provider-login__providers"
                            aria-label=${t("modelSetup.manual.provider")}
                          >
                            ${matches.map(
                              (group) => html`
                                <li>
                                  <button
                                    type="button"
                                    class="btn model-provider-login__option"
                                    data-models-login-provider=${group.id}
                                    ?disabled=${picker.phase !== "ready" || !picker.isCurrent()}
                                    @click=${() => {
                                      if (
                                        this.picker !== picker ||
                                        picker.phase !== "ready" ||
                                        !picker.isCurrent()
                                      ) {
                                        return;
                                      }
                                      if (
                                        group.decisionModel &&
                                        !group.choices.length &&
                                        !group.apiKeyProvider
                                      ) {
                                        this.reset();
                                        this.options.onDecisionSetup?.(group.decisionModel);
                                        return;
                                      }
                                      if (
                                        group.apiKeyProvider &&
                                        !group.choices.length &&
                                        !group.decisionModel
                                      ) {
                                        this.reset();
                                        this.options.onApiKey?.(group.apiKeyProvider);
                                        return;
                                      }
                                      picker.providerId = group.id;
                                      this.focusPicker = "method";
                                      this.host.requestUpdate();
                                    }}
                                  >
                                    ${renderProviderBrandIcon(group.id)}
                                    <span class="model-provider-login__copy">
                                      <strong>${group.label}</strong>
                                      <span>
                                        ${[
                                          ...group.choices.map((choice) => choice.label),
                                          ...(group.decisionModel
                                            ? [t("chat.modelControls.decisionLabel")]
                                            : []),
                                          ...(group.apiKeyProvider
                                            ? [t("modelProviders.status.apiKey")]
                                            : []),
                                        ].join(" · ")}
                                      </span>
                                    </span>
                                  </button>
                                </li>
                              `,
                            )}
                          </ul>
                          ${
                            matches.length
                              ? nothing
                              : html`
                                  <p class="muted" role="status">
                                    ${t(query ? "modelProviders.noMatches" : "modelProviders.login.noProviders")}
                                  </p>
                                `
                          }
                        `
              }
            </div>
            <div class="model-setup-wizard__footer">
              ${
                provider
                  ? html`
                      <button
                        class="btn model-provider-login__secondary"
                        data-models-login-back
                        @click=${() => {
                          if (
                            this.picker !== picker ||
                            picker.phase !== "ready" ||
                            !picker.isCurrent()
                          ) {
                            return;
                          }
                          picker.providers = undefined;
                          picker.providerId = "";
                          this.focusPicker = "search";
                          this.host.requestUpdate();
                        }}
                      >
                        ${t("common.back")}
                      </button>
                    `
                  : !picker.providers && this.options.onDiscover
                    ? html`
                        <button
                          class="btn model-provider-login__secondary"
                          data-models-login-discover
                          ?disabled=${!picker.isCurrent()}
                          @click=${() => {
                            if (this.picker !== picker || !picker.isCurrent()) {
                              return;
                            }
                            this.reset();
                            this.options.onDiscover?.();
                          }}
                        >
                          ${t("modelProviders.login.discover")}
                        </button>
                      `
                    : nothing
              }
              <button class="btn" @click=${() => this.reset()}>${t("common.cancel")}</button>
            </div>
          </div>
        </openclaw-modal-dialog>
      `;
    }
    return this.wizard.render({ busy: this.mutationActive, refreshWarning: this.refreshWarning });
  }

  private async complete(): Promise<void> {
    const label = this.runner.state.authLabel;
    this.runner.close();
    this.message = {
      kind: "success",
      text: [label, t("modelProviders.login.done")].filter(Boolean).join(": "),
      ...(this.refreshWarning ? { warning: this.refreshWarning } : {}),
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
        await this.complete();
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
