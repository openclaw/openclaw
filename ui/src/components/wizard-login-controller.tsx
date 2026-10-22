import { createMemo, createSignal, onSettled } from "solid-js";
import type { GatewayBrowserClient } from "../api/gateway.ts";
import { registerModelSetupEnglish } from "../i18n/locales/en-model-setup.ts";
import { registerSettingsEnglish } from "../i18n/locales/en-settings.ts";
import { formatUiError } from "../lib/format-error.ts";
import { registerEnglishCatalog, t } from "../lib/reactive/i18n.ts";
import { initialWizardValue, type ModelSetupWizardState } from "../pages/model-setup/state.ts";
import {
  ModelSetupWizardRunner,
  type ModelSetupWizardCompletion,
} from "../pages/model-setup/wizard-runner.ts";
import { ModelSetupWizard, type WizardViewProps } from "../pages/model-setup/wizard-view-solid.tsx";
import "../styles/model-setup.css";

registerModelSetupEnglish();
registerEnglishCatalog(registerSettingsEnglish);

export function createWizardLogin(options: {
  getClient: () => GatewayBrowserClient | null;
  getAgentId: () => string | null;
  onClose: () => void;
  requestFailedMessage: () => string;
  sessionExpiredMessage: () => string;
  finishingMessage?: () => string;
  onAnswer?: (value: unknown, includeValue?: boolean) => void;
  onBackgroundCompletion?: (completion: ModelSetupWizardCompletion) => Promise<void>;
}) {
  const [state, setState] = createSignal<ModelSetupWizardState>({ phase: "idle" });
  const [draft, setValue] = createSignal<unknown>();
  const [cancelling, setCancelling] = createSignal(false);
  const [cancellationNotice, setCancellationNotice] = createSignal<string | null>(null);
  let stepId: string | null = null;
  let generation = 0;
  let cancellation: number | undefined;
  let disposed = false;
  const runner = new ModelSetupWizardRunner({
    ...options,
    onChange: (next) => {
      if (disposed) {
        return;
      }
      if (next.phase === "starting") {
        generation += 1;
      }
      if (next.phase !== "step") {
        cancellation = undefined;
        setCancelling(false);
        setCancellationNotice(null);
      }
      if (next.phase === "step" && next.step.id !== stepId) {
        setValue(() => initialWizardValue(next.step));
      } else if (next.phase !== "step") {
        setValue(undefined);
      }
      stepId = next.phase === "step" ? next.step.id : null;
      setState(next);
    },
    cancelledMessage: () => t("modelSetup.wizard.cancelled"),
    gatewayNotRespondingMessage: () => t("modelSetup.wizard.gatewayNotResponding"),
  });
  onSettled(() => () => {
    // Cancellation still retires the session, but teardown cannot publish UI state.
    disposed = true;
    generation += 1;
    cancellation = undefined;
    void runner.cancel();
  });

  function reset(): void {
    generation += 1;
    cancellation = undefined;
    void runner.cancel();
  }

  function viewProps(
    viewOptions: {
      mode?: "auth" | "prepare" | "activate";
      busy?: boolean;
      refreshWarning?: string | null;
      doneMessage?: string;
      doneDescription?: string;
      doneAction?: WizardViewProps["doneAction"];
    } = {},
  ): WizardViewProps {
    const current = state();
    return {
      mode: viewOptions.mode ?? "auth",
      state:
        current.phase === "step"
          ? { ...current, busy: current.busy || Boolean(viewOptions.busy) }
          : current,
      refreshWarning: viewOptions.refreshWarning ?? null,
      doneMessage: viewOptions.doneMessage,
      doneDescription: viewOptions.doneDescription,
      doneAction: viewOptions.doneAction,
      cancellationNotice: cancellationNotice(),
      value: draft(),
      onValueChange: (value) => {
        setValue(() => value);
      },
      onAnswer:
        options.onAnswer ?? ((value, includeValue) => void runner.answer(value, includeValue)),
      onCancel: () => void cancel(),
      onClose: options.onClose,
    };
  }

  async function cancel(): Promise<void> {
    if (cancellation !== undefined || runner.state.phase === "done") {
      return;
    }
    const currentGeneration = generation;
    cancellation = currentGeneration;
    setCancelling(true);
    setCancellationNotice(null);
    try {
      const result = await runner.requestCancellation();
      if (currentGeneration !== generation) {
        return;
      }
      if (result === "running") {
        setCancellationNotice(options.finishingMessage?.() ?? t("modelProviders.login.finishing"));
      } else if (result === "cancelled") {
        options.onClose();
      }
    } catch (error) {
      if (currentGeneration === generation) {
        setCancellationNotice(
          t("modelSetup.wizard.cancelFailed", {
            error: formatUiError(error, options.requestFailedMessage()),
          }),
        );
      }
    } finally {
      if (currentGeneration === generation) {
        cancellation = undefined;
        setCancelling(false);
      }
    }
  }
  return {
    runner,
    state: () => {
      state();
      return runner.state;
    },
    get cancelling() {
      cancelling();
      return cancellation !== undefined;
    },
    reset,
    viewProps,
  };
}

export type WizardLoginState = ReturnType<typeof createWizardLogin>;

export function WizardLogin(props: {
  controller: WizardLoginState;
  busy?: boolean;
  options?: Parameters<WizardLoginState["viewProps"]>[0];
}) {
  const view = createMemo(() => props.controller.viewProps(props.options));
  return (
    <div onModal-cancel={(event: Event) => event.preventDefault()}>
      <ModelSetupWizard {...view()} busy={props.busy} />
    </div>
  );
}
