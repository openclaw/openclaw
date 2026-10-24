import {
  action,
  createMemo,
  createOptimistic,
  createSignal,
  Errored,
  onSettled,
  Show,
} from "solid-js";
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
  onPresentationChange?: () => void;
  onBackgroundCompletion?: (completion: ModelSetupWizardCompletion) => Promise<void>;
}) {
  const [state, setState] = createSignal<ModelSetupWizardState>({ phase: "idle" });
  const [draft, setValue] = createSignal<unknown>();
  const [cancelling, setCancelling] = createOptimistic(false);
  const [cancellationAttempt, setCancellationAttempt] =
    createSignal<Promise<"cancelled" | "running" | void>>();
  const cancellationOutcome = createMemo(() => cancellationAttempt(), { loadingValue: undefined });
  let stepId: string | null = null;
  let generation = 0;
  let cancellation: number | undefined;
  let retireCancellation: (() => void) | undefined;
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
        retireCancellation?.();
        retireCancellation = undefined;
        setCancellationAttempt(undefined);
      }
      if (next.phase === "step" && next.step.id !== stepId) {
        setValue(() => initialWizardValue(next.step));
      } else if (next.phase !== "step") {
        setValue(undefined);
      }
      stepId = next.phase === "step" ? next.step.id : null;
      setState(next);
      if (next.phase === "starting" || next.phase === "step") {
        options.onPresentationChange?.();
      }
    },
    cancelledMessage: () => t("modelSetup.wizard.cancelled"),
    gatewayNotRespondingMessage: () => t("modelSetup.wizard.gatewayNotResponding"),
  });
  onSettled(() => () => {
    // Cancellation still retires the session, but teardown cannot publish UI state.
    disposed = true;
    generation += 1;
    cancellation = undefined;
    retireCancellation?.();
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
      cancellationFeedback,
      value: draft(),
      onValueChange: (value) => {
        setValue(() => value);
      },
      onAnswer:
        options.onAnswer ?? ((value, includeValue) => void runner.answer(value, includeValue)),
      onCancel: cancel,
      onClose: options.onClose,
    };
  }

  const presentCancellation = action(function* (
    pending: ReturnType<ModelSetupWizardRunner["requestCancellation"]>,
    retired: Promise<void>,
  ) {
    setCancelling(true);
    const outcome: Awaited<typeof pending> | void = yield Promise.race([pending, retired]);
    return outcome;
  });

  function cancel(): void {
    if (cancellation !== undefined || runner.state.phase === "done") {
      return;
    }
    const currentGeneration = generation;
    cancellation = currentGeneration;
    const lifetime = Promise.withResolvers<void>();
    retireCancellation = lifetime.resolve;
    const pending = runner
      .requestCancellation()
      .then((outcome) => {
        if (currentGeneration === generation && outcome === "cancelled") {
          options.onClose();
        }
        return outcome;
      })
      .finally(() => {
        if (currentGeneration === generation) {
          cancellation = undefined;
          retireCancellation = undefined;
        }
      });
    const result = presentCancellation(pending, lifetime.promise);
    void setCancellationAttempt(result);
    // Retired dialogs still consume the admitted action's rejection.
    void result.catch(() => {});
  }

  function CancellationFeedback() {
    return (
      <Show when={!cancelling()}>
        <Errored
          fallback={(error) => (
            <div class="callout warning" role="alert">
              {t("modelSetup.wizard.cancelFailed", {
                error: formatUiError(error(), options.requestFailedMessage()),
              })}
            </div>
          )}
        >
          <Show when={cancellationOutcome() === "running"}>
            <div class="callout warning" role="alert">
              {options.finishingMessage?.() ?? t("modelProviders.login.finishing")}
            </div>
          </Show>
        </Errored>
      </Show>
    );
  }
  const cancellationFeedback = <CancellationFeedback />;
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
