import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import { html, nothing, type ReactiveController, type ReactiveControllerHost } from "lit";
import { createRef, ref } from "lit/directives/ref.js";
import { splitTrailingAuthProfile } from "../../../../src/agents/model-ref-profile.js";
import type { ModelAuthStatusResult } from "../../api/types.ts";
import type { ApplicationContext } from "../../app/context.ts";
import { renderProviderBrandIcon } from "../../components/provider-icon.ts";
import { WizardLoginController } from "../../components/wizard-login-controller.ts";
import { t } from "../../i18n/index.ts";
import { registerSettingsEnglish } from "../../i18n/locales/en-settings.ts";
import { resolveAgentConfig, resolveModelPrimary } from "../../lib/agents/display.ts";
import { currentConfigObject } from "../../lib/config/config-state-model.ts";
import { buildExternalLinkRel, EXTERNAL_LINK_TARGET } from "../../lib/external-link.ts";
import { formatUiError } from "../../lib/format-error.ts";
import { invalidateModelAuthStatusRequests } from "../../lib/model-auth-request-state.ts";
import { canonicalModelAuthProviderId, loadModelAuthStatus } from "../../lib/model-auth.ts";
import type {
  ModelSetupWizardRunner,
  ModelSetupWizardCompletion,
} from "../model-setup/wizard-runner.ts";
import type { ModelProviderRowMessage } from "./config-mutation.ts";
import { buildModelProviderCards, type ModelProviderCard } from "./data.ts";
import { buildProviderLoginGroups } from "./login-providers.ts";
import { renderProviderAccountSummary } from "./profiles-view.ts";
registerSettingsEnglish();

const MODEL_SETUP_COMMAND = "openclaw configure --section model";

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
  private readonly methodChoices = createRef<HTMLElement>();
  private focusPicker: "search" | "method" | null = null;
  private generation = 0;
  private mutationActive = false;
  private refreshWarning: string | null = null;
  private message: ModelProviderRowMessage | undefined;
  private mode: "auth" | "activate" = "auth";
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

  renderRecovery() {
    const selection = this.missingSelection();
    const providers = this.options
      .getScope()
      .authStatus?.providerCapabilities?.filter(
        (capability) => canonicalModelAuthProviderId(capability.provider) === selection?.provider,
      )
      .map((capability) => capability.provider);
    return selection
      ? html`<div class="callout warning" role="status" data-models-account-recovery>
          <p>${t("modelProviders.login.missingSelection", { model: selection.model })}</p>
          <button
            class="btn"
            data-models-recover-account
            ?disabled=${!this.options.canStart() || this.busy}
            @click=${() => void this.open(providers)}
          >
            ${t("modelProviders.login.chooseAccount")}
          </button>
        </div>`
      : nothing;
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
    return buildProviderLoginGroups({
      capabilities: authStatus?.providerCapabilities,
      providers,
      includeApiKey: Boolean(this.options.onApiKey),
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
    const choices = this.methodChoices.value;
    const target =
      this.focusPicker === "search"
        ? this.searchInput.value
        : (choices?.querySelector<HTMLElement>("button, summary") ?? choices);
    this.focusPicker = null;
    target?.focus({ preventScroll: true });
  }

  render() {
    const picker = this.picker;
    if (picker) {
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
              provider.authProviders.some(
                (owner) => card.id === canonicalModelAuthProviderId(owner),
              ),
            )
          : [];
      const docsUrl =
        [...(provider?.choices ?? []), ...(provider?.setupChoices ?? [])].find(
          (choice) => choice.docsUrl,
        )?.docsUrl ?? "https://docs.openclaw.ai/concepts/model-providers";
      const missing = this.missingSelection();
      const recovery =
        missing && accounts.some((card) => card.id === missing.provider) ? missing : null;
      const query = picker.query.trim().toLocaleLowerCase();
      const matches = groups.filter((group) =>
        [
          group.id,
          group.label,
          ...(group.apiKeyProvider ? [t("modelProviders.status.apiKey")] : []),
          ...[...group.choices, ...group.setupChoices].flatMap((choice) => [
            choice.label,
            choice.hint ?? "",
          ]),
        ].some((text) => text.toLocaleLowerCase().includes(query)),
      );
      return html`
        <openclaw-modal-dialog
          label=${provider?.label ?? t("modelProviders.login.title")}
          @modal-cancel=${() => this.reset()}
        >
          <div class="model-setup-wizard model-provider-login">
            <div class="model-setup-wizard__header">
              <h2 class="model-provider-login__provider">
                ${provider ? html`${renderProviderBrandIcon(provider.id)} ${provider.label}` : t("modelProviders.login.title")}
              </h2>
            </div>
            <div class="model-setup-wizard__body">
              <p>
                ${
                  recovery
                    ? t("modelProviders.login.useAccountDescription", { model: recovery.model })
                    : t("modelProviders.login.description")
                }
              </p>
              ${
                picker.phase === "loading"
                  ? html`<div role="status">${t("common.loading")}</div>`
                  : picker.phase === "error"
                    ? html`<div role="alert">${picker.message}</div>`
                    : provider
                      ? html`
                          ${
                            picker.phase === "ready" && picker.authStatus.unavailable
                              ? html`<p role="status">${picker.authStatus.unavailable.message}</p>`
                              : renderProviderAccountSummary(
                                  accounts,
                                  recovery
                                    ? {
                                        authProvider: recovery.authProvider,
                                        disabled: !picker.isCurrent() || !this.options.canStart(),
                                        onUse: (profileId) => {
                                          if (this.picker === picker && picker.isCurrent()) {
                                            void this.activateSavedProfile(
                                              profileId,
                                              recovery.model,
                                            );
                                          }
                                        },
                                      }
                                    : undefined,
                                )
                          }
                          <section class="model-provider-login__methods" ${ref(this.methodChoices)}>
                            <h3>${t("modelProviders.login.connectAccount")}</h3>
                            <div data-models-login-choice>
                              ${provider.choices.map(
                                (selected) => html`
                                  <button
                                    type="button"
                                    class="btn model-provider-login__option"
                                    ?disabled=${picker.phase !== "ready" || !picker.isCurrent()}
                                    @click=${() => {
                                      if (!canSelect()) {
                                        return;
                                      }
                                      this.picker = null;
                                      this.mode = "auth";
                                      this.refreshWarning = null;
                                      this.runner.prepareSignIn(selected.kind, selected.label);
                                      void this.run(() =>
                                        this.runner.start(selected.id, "models.authLogin"),
                                      );
                                    }}
                                  >
                                    <span class="model-provider-login__copy">
                                      <strong>${selected.label}</strong>
                                      ${selected.hint ? html`<span>${selected.hint}</span>` : nothing}
                                    </span>
                                  </button>
                                `,
                              )}
                            </div>
                            ${provider.setupChoices.map(
                              (option) => html`
                                <details data-models-login-setup=${option.id}>
                                  <summary>${option.label}</summary>
                                  ${option.hint ? html`<p>${option.hint}</p>` : nothing}
                                  <p>
                                    ${t("modelProviders.login.gatewaySetupHint", { provider: provider.label })}
                                  </p>
                                  <code>${MODEL_SETUP_COMMAND}</code>
                                </details>
                              `,
                            )}
                            ${
                              provider.apiKeyProvider
                                ? html`
                                    <button
                                      type="button"
                                      class="btn model-provider-login__option"
                                      data-models-login-api-key
                                      ?disabled=${picker.phase !== "ready" || !picker.isCurrent()}
                                      @click=${() => {
                                        if (!canSelect() || !provider.apiKeyProvider) {
                                          return;
                                        }
                                        this.reset();
                                        this.options.onApiKey?.(provider.apiKeyProvider);
                                      }}
                                    >
                                      <span class="model-provider-login__copy">
                                        <strong>${t("modelProviders.status.apiKey")}</strong>
                                        <span>${t("modelProviders.login.apiKeyHint")}</span>
                                      </span>
                                    </button>
                                  `
                                : nothing
                            }
                            <a
                              class="learn-more-link"
                              href=${docsUrl}
                              target=${EXTERNAL_LINK_TARGET}
                              rel=${buildExternalLinkRel()}
                              >${t("modelProviders.login.compareMethods")}</a
                            >
                          </section>
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
                                      if (!canSelect()) {
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
                                          ...group.setupChoices.map((choice) => choice.label),
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
                          if (!canSelect()) {
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
    return this.wizard.render({
      mode: this.mode,
      busy: this.mutationActive,
      refreshWarning: this.refreshWarning,
    });
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
