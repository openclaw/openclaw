import { html, nothing, type ReactiveController, type ReactiveControllerHost } from "lit";
import type { ProviderLoginOption } from "../../api/types.ts";
import type { ApplicationContext } from "../../app/context.ts";
import { t } from "../../i18n/index.ts";
import { formatUiError } from "../../lib/format-error.ts";
import "../../styles/model-setup.css";
import { initialWizardValue, type ModelSetupWizardState } from "../model-setup/state.ts";
import {
  ModelSetupWizardRunner,
  type ModelSetupWizardCompletion,
} from "../model-setup/wizard-runner.ts";
import { renderModelSetupWizard } from "../model-setup/wizard-view.ts";
import type { ModelProviderRowMessage } from "./config-mutation.ts";
import type { ModelProviderCard } from "./data.ts";
import type { ModelProvidersData } from "./load.ts";

type LoginControllerOptions = {
  getScope: () => { context: ApplicationContext; agentId: string; data: ModelProvidersData | null };
  canStart: () => boolean;
  canContinue: () => boolean;
  refresh: () => Promise<void>;
};

export class ModelProviderLoginController implements ReactiveController {
  private picker: { providers?: string[]; choice: string } | null = null;
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
      connectDisabled: !this.options.canStart() || this.busy || this.loginOptions().length === 0,
      login: this.render(),
      loginMessage: this.message,
    };
  }

  private loginOptions(providers?: string[]): ProviderLoginOption[] {
    const choices = new Map<string, ProviderLoginOption>();
    for (const capability of this.options.getScope().data?.authStatus?.providerCapabilities ?? []) {
      if (providers && !providers.includes(capability.provider)) {
        continue;
      }
      for (const option of capability.loginOptions ?? []) {
        choices.set(option.id, option);
      }
    }
    return [...choices.values()].toSorted((a, b) => Number(b.featured) - Number(a.featured));
  }

  open(providers?: string[]): void {
    if (!this.options.canStart() || this.busy || !this.loginOptions(providers).length) {
      return;
    }
    this.picker = { providers, choice: "" };
    this.message = undefined;
    this.host.requestUpdate();
  }

  reset(): void {
    this.generation += 1;
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
      const choices = this.loginOptions(picker.providers);
      const selected = choices.find((option) => option.id === picker.choice);
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
              <label class="field">
                <span>${t("modelSetup.manual.provider")}</span>
                <select
                  class="settings-select"
                  data-models-login-choice
                  .value=${picker.choice}
                  @change=${(event: Event) => {
                    // SAFETY: This change handler is attached directly to the select element.
                    picker.choice = (event.currentTarget as HTMLSelectElement).value;
                    this.host.requestUpdate();
                  }}
                >
                  <option value="">${t("modelSetup.manual.selectProvider")}</option>
                  ${choices.map(
                    (option) => html`
                      <option value=${option.id}>
                        ${option.groupLabel ? `${option.groupLabel} · ` : ""}${option.label}
                      </option>
                    `,
                  )}
                </select>
              </label>
              ${selected?.hint ? html`<p class="muted">${selected.hint}</p>` : nothing}
            </div>
            <div class="model-setup-wizard__footer">
              <button class="btn" @click=${() => this.reset()}>${t("common.cancel")}</button>
              <button
                class="btn primary"
                data-models-login-start
                ?disabled=${!selected || !this.options.canStart()}
                @click=${() => {
                  if (!selected || !this.options.canStart()) {
                    return;
                  }
                  this.picker = null;
                  this.cancellationNotice = null;
                  this.refreshWarning = null;
                  void this.run(() => this.runner.start(selected.id, "models.authLogin"));
                }}
              >
                ${t("modelProviders.login.action")}
              </button>
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

  private async run(task: () => Promise<ModelSetupWizardCompletion | null>): Promise<void> {
    const client = this.options.getScope().context.gateway.snapshot.client;
    if (!client || this.mutationActive || !this.options.canContinue()) {
      return;
    }
    const generation = this.generation;
    this.mutationActive = true;
    this.host.requestUpdate();
    try {
      const mutation = await this.options.getScope().context.runtimeConfig.runExternalMutation(
        async (mutationClient) => {
          if (mutationClient !== client) {
            throw new Error(t("modelProviders.requestFailed"));
          }
          return task();
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
      if (mutation.value) {
        this.runner.close();
        this.message = {
          kind: "success",
          text: t("modelProviders.login.done"),
          ...(this.refreshWarning ? { warning: this.refreshWarning } : {}),
        };
        await this.options.refresh();
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
