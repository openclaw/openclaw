import { createMemo } from "solid-js";
import type { GatewayBrowserClient } from "../api/gateway.ts";
import { registerSettingsEnglish } from "../i18n/locales/en-settings.ts";
import { formatUiError } from "../lib/format-error.ts";
import { t } from "../lib/reactive/i18n.ts";
import { initialWizardValue } from "../pages/model-setup/state.ts";
import {
  ModelSetupWizardRunner,
  type ModelSetupWizardCompletion,
} from "../pages/model-setup/wizard-runner.ts";
import { ModelSetupWizard, type WizardViewProps } from "../pages/model-setup/wizard-view-solid.tsx";
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
    private readonly host: { requestUpdate(): void },
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
      gatewayNotRespondingMessage: () => t("modelSetup.wizard.gatewayNotResponding"),
    });
  }

  reset(): void {
    this.generation += 1;
    this.cancelling = false;
    this.cancellationNotice = null;
    void this.runner.cancel();
  }

  viewProps(
    options: {
      mode?: "auth" | "activate";
      busy?: boolean;
      refreshWarning?: string | null;
      doneMessage?: string;
      doneDescription?: string;
      doneAction?: WizardViewProps["doneAction"];
    } = {},
  ): WizardViewProps {
    const state = this.runner.state;
    return {
      mode: options.mode ?? "auth",
      state:
        state.phase === "step" ? { ...state, busy: state.busy || Boolean(options.busy) } : state,
      refreshWarning: options.refreshWarning ?? null,
      doneMessage: options.doneMessage,
      doneDescription: options.doneDescription,
      doneAction: options.doneAction,
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
    };
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

export function WizardLogin(props: {
  controller: WizardLoginController;
  revision: () => number;
  options?: Parameters<WizardLoginController["viewProps"]>[0];
}) {
  const view = createMemo(() => {
    props.revision();
    return props.controller.viewProps(props.options);
  });
  return (
    <div onModal-cancel={(event: Event) => event.preventDefault()}>
      <ModelSetupWizard {...view()} />
    </div>
  );
}
