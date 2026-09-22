import { html, type ReactiveController, type ReactiveControllerHost } from "lit";
import type { ModelAuthStatusResult, ProviderLoginOption } from "../../api/types.ts";
import type { ApplicationContext } from "../../app/context.ts";
import { renderWizardSingleChoice } from "../../components/wizard-step-controls.ts";
import { t } from "../../i18n/index.ts";
import { registerSettingsEnglish } from "../../i18n/locales/en-settings.ts";
import { formatUiError } from "../../lib/format-error.ts";
import { invalidateModelAuthStatusRequests } from "../../lib/model-auth-request-state.ts";
import { loadModelAuthStatus } from "../../lib/model-auth.ts";
import "../../styles/model-setup.css";
import { initialWizardValue, type ModelSetupWizardState } from "../model-setup/state.ts";
import {
  ModelSetupWizardRunner,
  type ModelSetupWizardCompletion,
} from "../model-setup/wizard-runner.ts";
import { renderModelSetupWizard } from "../model-setup/wizard-view.ts";
import type { ModelProviderRowMessage } from "./config-mutation.ts";
import type { ModelProviderCard } from "./data.ts";
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
};

export class ModelProviderLoginController implements ReactiveController {
  private picker:
    | { phase: "loading" }
    | { phase: "ready"; choices: ProviderLoginOption[]; isCurrent: () => boolean }
    | { phase: "error"; message: string }
    | null = null;
  private inventoryRequest: AbortController | undefined;
  private state: ModelSetupWizardState = { phase: "idle" };
  private value: unknown;
  private generation = 0;
  private mutationActive = false;
  private cancellationPending = false;
  private cancellationNotice: string | null = null;
  private refreshWarning: string | null = null;
  private message: ModelProviderRowMessage | undefined;
  private readonly runner: ModelSetupWizardRunner;

  constructor(
    private readonly host: ReactiveControllerHost,
    private readonly options: LoginControllerOptions,
  ) {
    host.addController(this);
    this.runner = new ModelSetupWizardRunner({
      getClient: () => options.getScope().context.gateway.snapshot.client,
      getAgentId: () => options.getScope().agentId,
      onChange: (next) => {
        const previousStep = this.state.phase === "step" ? this.state.step.id : null;
        this.state = next;
        if (next.phase === "step" && next.step.id !== previousStep) {
          this.value = initialWizardValue(next.step);
        } else if (next.phase !== "step") {
          this.value = undefined;
        }
        this.host.requestUpdate();
      },
      onBackgroundCompletion: (completion) => this.run(() => Promise.resolve(completion), true),
      requestFailedMessage: () => t("modelProviders.requestFailed"),
      cancelledMessage: () => t("modelSetup.wizard.cancelled"),
      sessionExpiredMessage: () => t("modelProviders.login.sessionExpired"),
    });
  }

  get busy(): boolean {
    return (
      this.picker !== null ||
      this.mutationActive ||
      this.cancellationPending ||
      this.state.phase !== "idle"
    );
  }

  get providerActions() {
    return {
      canMutate: this.options.canStart(),
      loginBusy: this.busy,
      onConnect: (card: ModelProviderCard) => this.open([card.id, ...card.credentialProviderIds]),
      canConnect: (card: ModelProviderCard) =>
        this.loginOptions([card.id, ...card.credentialProviderIds]).length > 0,
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

  private loginOptions(
    providers?: string[],
    authStatus = this.options.getScope().authStatus,
  ): ProviderLoginOption[] {
    const choices = new Map<string, ProviderLoginOption>();
    for (const capability of authStatus?.providerCapabilities ?? []) {
      if (providers && !providers.includes(capability.provider)) {
        continue;
      }
      for (const option of capability.loginOptions ?? []) {
        choices.set(option.id, option);
      }
    }
    return [...choices.values()].toSorted((a, b) => Number(b.featured) - Number(a.featured));
  }

  async open(providers?: string[]): Promise<void> {
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
    this.picker = { phase: "loading" };
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
        this.picker = {
          phase: "ready",
          choices: this.loginOptions(providers, authStatus),
          isCurrent,
        };
      }
    } catch (error) {
      if (isCurrent()) {
        this.picker = {
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
    this.mutationActive = false;
    this.cancellationPending = false;
    this.cancellationNotice = null;
    this.refreshWarning = null;
    this.message = undefined;
    // Cleanup addresses the original connection and wizard only. Late replies
    // cannot publish credentials or errors into another agent's view.
    void this.runner.cancel();
  }

  hostDisconnected(): void {
    this.reset();
  }

  render() {
    const picker = this.picker;
    if (picker) {
      const choices = picker.phase === "ready" ? picker.choices : [];
      return html`
        <openclaw-modal-dialog
          label=${t("modelProviders.login.title")}
          @modal-cancel=${() => this.reset()}
        >
          <div class="model-setup-wizard">
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
                    : choices.length === 0
                      ? html`<div role="status">${t("modelProviders.login.noOptions")}</div>`
                      : renderWizardSingleChoice({
                          label: t("modelSetup.manual.provider"),
                          options: choices.map((option) => ({
                            value: option.id,
                            label: option.label,
                            hint: option.hint,
                          })),
                          busy: !this.options.canContinue(),
                          onAnswer: (value) => {
                            const selected = choices.find((option) => option.id === value);
                            if (!selected || picker.phase !== "ready" || !picker.isCurrent()) {
                              return;
                            }
                            this.picker = null;
                            this.cancellationNotice = null;
                            this.refreshWarning = null;
                            this.runner.prepareSignIn(selected.kind, selected.label);
                            void this.run(() => this.runner.start(selected.id, "models.authLogin"));
                          },
                        })
              }
            </div>
            <div class="model-setup-wizard__footer">
              <button class="btn" @click=${() => this.reset()}>${t("common.cancel")}</button>
            </div>
          </div>
        </openclaw-modal-dialog>
      `;
    }
    // The Gateway can refuse cancellation during credential persistence. Keep
    // the modal open until its reply, including dismissal by Escape/backdrop.
    return html`<div @modal-cancel=${(event: Event) => event.preventDefault()}>
      ${renderModelSetupWizard({
        mode: "auth",
        state:
          this.state.phase === "step"
            ? { ...this.state, busy: this.state.busy || this.mutationActive }
            : this.state,
        refreshWarning: this.refreshWarning,
        cancellationNotice: this.cancellationNotice,
        value: this.value,
        onValueChange: (value) => {
          this.value = value;
          this.host.requestUpdate();
        },
        onAnswer: (value, includeValue) =>
          void this.run(() => this.runner.answer(value, includeValue)),
        onCancel: () => void this.cancel(),
        onClose: () => this.reset(),
      })}
    </div>`;
  }

  private async cancel(): Promise<void> {
    if (this.cancellationPending || this.state.phase === "done") {
      return;
    }
    const generation = this.generation;
    this.cancellationPending = true;
    this.cancellationNotice = null;
    try {
      const result = await this.runner.requestCancellation();
      if (generation !== this.generation) {
        return;
      }
      if (result === "running") {
        this.cancellationNotice = t("modelProviders.login.finishing");
      } else if (result === "cancelled") {
        this.reset();
      }
    } catch (error) {
      if (generation === this.generation) {
        this.cancellationNotice = t("modelSetup.wizard.cancelFailed", {
          error: formatUiError(error, t("modelProviders.requestFailed")),
        });
      }
    } finally {
      if (generation === this.generation) {
        this.cancellationPending = false;
        this.host.requestUpdate();
      }
    }
  }

  private async complete(): Promise<void> {
    const label = this.state.authLabel;
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
