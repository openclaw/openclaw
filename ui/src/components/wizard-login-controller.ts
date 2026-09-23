import { html, type ReactiveControllerHost } from "lit";
import type { GatewayBrowserClient } from "../api/gateway.ts";
import { t } from "../i18n/index.ts";
import { registerSettingsEnglish } from "../i18n/locales/en-settings.ts";
import { formatUiError } from "../lib/format-error.ts";
import { initialWizardValue } from "../pages/model-setup/state.ts";
import {
  ModelSetupWizardRunner,
  type ModelSetupWizardCompletion,
} from "../pages/model-setup/wizard-runner.ts";
import { renderModelSetupWizard } from "../pages/model-setup/wizard-view.ts";
import "../styles/model-setup.css";
registerSettingsEnglish();

export class WizardLoginController {
  readonly runner: ModelSetupWizardRunner;
  cancelling = false;
  private value: unknown;
  private stepId: string | null = null;
  private generation = 0;
  private cancellationNotice: string | null = null;

  constructor(
    private readonly host: ReactiveControllerHost,
    private readonly options: {
      getClient: () => GatewayBrowserClient | null;
      getAgentId: () => string | null;
      onClose: () => void;
      requestFailedMessage: () => string;
      sessionExpiredMessage: () => string;
      onAnswer?: (value: unknown, includeValue?: boolean) => void;
      onBackgroundCompletion?: (completion: ModelSetupWizardCompletion) => Promise<void>;
    },
  ) {
    this.runner = new ModelSetupWizardRunner({
      ...options,
      onChange: (next) => {
        if (next.phase === "starting") {
          this.generation += 1;
        }
        if (next.phase !== "step") {
          this.cancelling = false;
          this.cancellationNotice = null;
        }
        if (next.phase === "step" && next.step.id !== this.stepId) {
          this.value = initialWizardValue(next.step);
        } else if (next.phase !== "step") {
          this.value = undefined;
        }
        this.stepId = next.phase === "step" ? next.step.id : null;
        host.requestUpdate();
      },
      cancelledMessage: () => t("modelSetup.wizard.cancelled"),
    });
  }

  reset(): void {
    this.generation += 1;
    this.cancelling = false;
    this.cancellationNotice = null;
    void this.runner.cancel();
  }

  render(options: { busy?: boolean; refreshWarning?: string | null; doneMessage?: string } = {}) {
    const state = this.runner.state;
    return html`<div @modal-cancel=${(event: Event) => event.preventDefault()}>
      ${renderModelSetupWizard({
        mode: "auth",
        state:
          state.phase === "step" ? { ...state, busy: state.busy || Boolean(options.busy) } : state,
        refreshWarning: options.refreshWarning ?? null,
        doneMessage: options.doneMessage,
        cancellationNotice: this.cancellationNotice,
        value: this.value,
        onValueChange: (value) => {
          this.value = value;
          this.host.requestUpdate();
        },
        onAnswer:
          this.options.onAnswer ??
          ((value, includeValue) => void this.runner.answer(value, includeValue)),
        onCancel: () => void this.cancel(),
        onClose: this.options.onClose,
      })}
    </div>`;
  }

  private async cancel(): Promise<void> {
    if (this.cancelling || this.runner.state.phase === "done") {
      return;
    }
    const generation = this.generation;
    this.cancelling = true;
    this.cancellationNotice = null;
    try {
      const result = await this.runner.requestCancellation();
      if (generation !== this.generation) {
        return;
      }
      if (result === "running") {
        this.cancellationNotice = t("modelProviders.login.finishing");
      } else if (result === "cancelled") {
        this.options.onClose();
      }
    } catch (error) {
      if (generation === this.generation) {
        this.cancellationNotice = t("modelSetup.wizard.cancelFailed", {
          error: formatUiError(error, this.options.requestFailedMessage()),
        });
      }
    } finally {
      if (generation === this.generation) {
        this.cancelling = false;
        this.host.requestUpdate();
      }
    }
  }
}
