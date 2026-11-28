import { parseProviderModelRef } from "@openclaw/model-catalog-core/model-catalog-refs";
import { splitTrailingAuthProfile } from "../agents/model-ref-profile.js";
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
  refreshSavedCandidates?: () => Promise<SetupInferenceCandidate[]>;
  config: OpenClawConfig;
  workspace: string;
  runtime: RuntimeEnv;
  prompter: WizardPrompter;
  activate: ActivateSetupInference;
}): Promise<string[] | null> {
  const { detection } = params;
  const candidatesByKind = new Map(detection.candidates.map((entry) => [entry.kind, entry]));
  const savedRetryKinds = new Set<SetupInferenceCandidate["kind"]>();
  const { promptAuthChoiceGrouped } = await import("./auth-choice-prompt.js");
  while (true) {
    const candidates = Array.from(candidatesByKind.values());
    const detectedOptions = candidates.map((candidate) => ({
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
            hint: candidates.map((candidate) => candidate.label).join(", "),
            methodMessage: t("wizard.guided.detectedGroupPrompt"),
            options: detectedOptions,
          },
        ]
      : [];
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
      candidate = candidates.find((item) => item.kind === kind);
      if (!candidate) {
        continue;
      }
    }

    const presentedOption = [
      ...detection.manualProviders,
      ...detection.authOptions,
      ...(detection.prepareOptions ?? []),
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
    let modelRef = candidate?.modelRef;
    if (candidate && !candidate.modelTarget && savedRetryKinds.has(candidate.kind)) {
      const ref = parseProviderModelRef(splitTrailingAuthProfile(candidate.modelRef).model);
      if (ref) {
        // Keep the chosen provider and saved sign-in fixed. The activation owner
        // verifies this exact model before it can become the default.
        const modelId = await params.prompter.text({
          message: t("wizard.guided.savedSignInModel", { provider: ref.provider }),
          initialValue: ref.model,
          validate: (value) => {
            if (!value.trim()) {
              return t("wizard.customProvider.modelIdRequired");
            }
            if (splitTrailingAuthProfile(ref.provider + "/" + value.trim()).profile) {
              return t("wizard.guided.savedSignInModelNoProfile");
            }
            return undefined;
          },
        });
        modelRef = ref.provider + "/" + modelId.trim();
      }
    }
    const result = await withConsoleSubsystemsSuppressed(() =>
      params.activate({
        kind: candidate?.kind ?? "provider-auth",
        ...(modelTarget ? { modelTarget } : {}),
        ...(candidate ? { modelRef } : { authChoice: choice }),
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
    if (candidate?.kind.startsWith("saved-auth:")) {
      savedRetryKinds.add(candidate.kind);
    } else if (!candidate && params.refreshSavedCandidates) {
      // Manual auth can save a sign-in before verification fails. Add that
      // inventory without repeating discovery or automatically trying a model.
      const saved = await params.refreshSavedCandidates();
      for (const entry of saved) {
        candidatesByKind.set(entry.kind, entry);
        savedRetryKinds.add(entry.kind);
      }
    }
    if (candidate?.kind === "existing-model") {
      await params.prompter.note(
        t("wizard.guided.existingModelKept"),
        t("wizard.guided.aiAccessTitle"),
      );
    }
  }
}
