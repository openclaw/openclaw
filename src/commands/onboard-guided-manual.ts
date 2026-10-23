import type { OpenClawConfig } from "../config/types.openclaw.js";
import { withConsoleSubsystemsSuppressed } from "../logging/console.js";
import type { RuntimeEnv } from "../runtime.js";
import type {
  SetupInferenceCandidate,
  SetupInferenceDetection,
  SetupInferenceFailureStatus,
} from "../system-agent/setup-inference.js";
import { t } from "../wizard/i18n/index.js";
import type { WizardPrompter } from "../wizard/prompts.js";
import type { AuthChoiceGroup } from "./auth-choice-options.static.js";

type ActivateSetupInference =
  typeof import("../system-agent/setup-inference.js").activateSetupInference;

const SETUP_FAILURE_REASON_KEYS: Record<SetupInferenceFailureStatus, string> = {
  auth: "wizard.guided.failureAuth",
  rate_limit: "wizard.guided.failureRateLimit",
  billing: "wizard.guided.failureBilling",
  timeout: "wizard.guided.failureTimeout",
  format: "wizard.guided.failureFormat",
  unavailable: "wizard.guided.failureUnavailable",
  unknown: "wizard.guided.failureUnknown",
};

export async function runManualStage(params: {
  detection: SetupInferenceDetection;
  config: OpenClawConfig;
  workspace: string;
  runtime: RuntimeEnv;
  prompter: WizardPrompter;
  activate: ActivateSetupInference;
}): Promise<string[] | null> {
  const detectedOptions = params.detection.candidates.map((candidate) => ({
    value: `candidate:${candidate.kind}`,
    label: t("wizard.guided.tryCandidate", {
      label: candidate.label,
      detail: candidate.detail,
    }),
  }));
  const additionalGroups: AuthChoiceGroup[] = detectedOptions.length
    ? [
        {
          value: "detected-ai",
          label: t("wizard.guided.detectedGroupLabel"),
          hint: params.detection.candidates.map((candidate) => candidate.label).join(", "),
          methodMessage: t("wizard.guided.detectedGroupPrompt"),
          options: detectedOptions,
        },
      ]
    : [];
  const { promptAuthChoiceGrouped } = await import("./auth-choice-prompt.js");
  while (true) {
    const choice = await promptAuthChoiceGrouped({
      prompter: params.prompter,
      includeSkip: true,
      assistantVisibleOnly: false,
      additionalGroups,
      config: params.config,
      workspaceDir: params.workspace,
    });

    if (choice === "skip") {
      return null;
    }
    let candidate: SetupInferenceCandidate | undefined;
    if (choice.startsWith("candidate:")) {
      const kind = choice.slice("candidate:".length);
      candidate = params.detection.candidates.find((item) => item.kind === kind);
      if (!candidate) {
        continue;
      }
    }

    const presentedOption = [
      ...params.detection.manualProviders,
      ...params.detection.authOptions,
      ...(params.detection.prepareOptions ?? []),
    ].find((option) => option.id === choice);
    const modelTarget = candidate
      ? candidate.modelTarget
      : presentedOption
        ? presentedOption.modelTarget
        : (await import("../flows/provider-flow.js"))
            .resolveProviderSetupFlowContributions({
              config: params.config,
              workspaceDir: params.workspace,
            })
            .find((entry) => entry.option.value === choice)?.option.modelTarget;
    const result = await withConsoleSubsystemsSuppressed(() =>
      params.activate({
        kind: candidate?.kind ?? "provider-auth",
        ...(modelTarget ? { modelTarget } : {}),
        ...(candidate ? { modelRef: candidate.modelRef } : { authChoice: choice }),
        workspace: params.workspace,
        surface: "cli",
        runtime: params.runtime,
        prompter: params.prompter,
      }),
    );
    if (result.ok) {
      return [
        ...result.lines,
        t("wizard.guided.repliedIn", { seconds: (result.latencyMs / 1000).toFixed(1) }),
      ];
    }
    await params.prompter.note(
      t("wizard.guided.testFailure", {
        label: candidate?.label ?? choice,
        reason: t(SETUP_FAILURE_REASON_KEYS[result.status]),
        detail: result.error,
      }),
      t("wizard.guided.aiAccessTitle"),
    );
    if (candidate?.kind === "existing-model") {
      await params.prompter.note(
        t("wizard.guided.existingModelKept"),
        t("wizard.guided.aiAccessTitle"),
      );
    }
  }
}
