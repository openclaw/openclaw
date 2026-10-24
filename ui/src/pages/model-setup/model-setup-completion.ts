import type {
  SystemAgentSetupActivateParams,
  SystemAgentSetupActivateResult,
  SystemAgentSetupDetectResult,
} from "../../api/types.ts";
import { t } from "../../lib/reactive/i18n.ts";
import type { FirstRunSetup } from "./first-run-setup.ts";
import {
  candidateActivation,
  findPreparedModelCandidate,
  preparedModelActivation,
  type ModelSetupPrepareOption,
} from "./prepare-options.ts";
import {
  activationTargetId,
  mapActivationResult,
  preparedModelPageState,
  type ModelSetupState,
} from "./state.ts";
import type { ModelSetupWizardCompletion, ModelSetupWizardRunner } from "./wizard-runner.ts";

type ModelSetupCompletionOwner = {
  state: ModelSetupState;
  firstRun: FirstRunSetup;
  wizard: ModelSetupWizardRunner;
  detect: () => Promise<SystemAgentSetupDetectResult | null>;
  activate: (params: SystemAgentSetupActivateParams, targetId: string) => Promise<void>;
};

export async function completeModelSetupWizard(
  owner: ModelSetupCompletionOwner,
  {
    startMethod,
    preparedModelRef,
    activationTargetId: targetId,
    modelActivation,
    isCurrent,
  }: ModelSetupWizardCompletion,
  pendingPrepareOption: ModelSetupPrepareOption | null,
  catalogPreference: { nativeSessionCatalogsEnabled?: boolean },
): Promise<void> {
  const { state, firstRun, wizard, detect, activate } = owner;
  const prepareOption =
    startMethod === "openclaw.setup.prepare.start" ? pendingPrepareOption : null;
  if (startMethod !== "openclaw.setup.prepare.start") {
    if (isCurrent?.() === false) {
      wizard.close();
      return;
    }
    if (!modelActivation) {
      wizard.fail(
        t(
          startMethod === "openclaw.setup.activate.start"
            ? "modelSetup.errors.activationFailed"
            : "modelSetup.wizard.notComplete",
        ),
      );
      return;
    }
    wizard.close();
    const result: SystemAgentSetupActivateResult = { ok: true, ...modelActivation };
    const activationTarget = targetId ?? "provider-auth";
    state.activationState = mapActivationResult({
      result,
      targetId: activationTarget,
      fallbackError: t("modelSetup.errors.activationFailed"),
      restartWarning: t("labsPage.restartRequired"),
      refreshWarning: state.setupRefreshWarning,
    });
    if (state.activationState.phase === "success") {
      state.manualApiKey = "";
    }
    firstRun.finishActivation(result, activationTarget, state.setupRefreshWarning);
    return;
  }
  let activation: ReturnType<typeof candidateActivation> | undefined;
  if (prepareOption && preparedModelRef) {
    activation = preparedModelActivation(prepareOption, preparedModelRef);
  } else {
    const result = await detect();
    if (!result) {
      wizard.fail(t("modelSetup.errors.requestFailed"));
      return;
    }
    if (prepareOption) {
      state.pageState = preparedModelPageState(result, prepareOption.modelTarget);
      const candidate = findPreparedModelCandidate(result, prepareOption.id);
      if (!candidate) {
        wizard.fail(t("modelSetup.prepare.providerNotReady", { provider: prepareOption.label }));
        return;
      }
      activation = candidateActivation(candidate);
    }
  }
  wizard.close();
  if (activation) {
    void activate(
      { ...activation, ...catalogPreference },
      activationTargetId(activation.kind, activation.modelRef),
    );
  }
}
