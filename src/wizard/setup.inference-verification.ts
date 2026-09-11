// Setup inference verification owns the shared verify/repair loop used by onboarding imports.
import { resolveAmbientOwnerAgentId } from "../agents/agent-scope-config.js";
import { resolveAgentDir, setAgentEffectiveModelPrimary } from "../agents/agent-scope.js";
import { resolveDefaultModelForAgent } from "../agents/model-selection-config.js";
import type { OnboardOptions } from "../commands/onboard-types.js";
import { migratePersistedImplicitMainRoster } from "../config/legacy.roster.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { withConsoleSubsystemsSuppressed } from "../logging/console.js";
import type { RuntimeEnv } from "../runtime.js";
import { t } from "./i18n/index.js";
import type { WizardPrompter } from "./prompts.js";
import { runSetupModelAuthStep, type SetupModelAuthCandidate } from "./setup.model-auth.js";

export async function offerLiveModelVerification(params: {
  config: OpenClawConfig;
  initialCandidate?: SetupModelAuthCandidate;
  opts: OnboardOptions;
  prompter: WizardPrompter;
  runtime: RuntimeEnv;
  workspaceDir: string;
  agentDir?: string;
  stateDir?: string;
  writeConfig: (config: OpenClawConfig) => Promise<OpenClawConfig>;
  required?: boolean;
}): Promise<{
  config: OpenClawConfig;
  attempted: boolean;
  persisted: boolean;
  verified: boolean;
  modelRef?: string;
}> {
  const requiresCandidateVerification = (config: OpenClawConfig) => {
    const provider = resolveDefaultModelForAgent({ cfg: config }).provider;
    return (
      params.opts.nonInteractive !== true &&
      config.models?.providers?.[provider]?.localService !== undefined
    );
  };
  let required =
    params.required ||
    (params.initialCandidate !== undefined &&
      requiresCandidateVerification(params.initialCandidate.config));
  if (!required) {
    const shouldTest = await params.prompter.confirm({
      message: t("wizard.setup.testAiAccess"),
      initialValue: true,
    });
    if (!shouldTest) {
      return { config: params.config, attempted: false, persisted: false, verified: false };
    }
  }
  const inference = await import("../system-agent/setup-inference.js");
  let shouldPersistCandidate = params.initialCandidate !== undefined;
  const verify = async (candidate: SetupModelAuthCandidate) => {
    const progress = params.prompter.progress(t("wizard.setup.testAiProgress"));
    let result: Awaited<ReturnType<typeof inference.verifySetupInferenceConfig>>;
    try {
      // SAFETY: Canonical roster migration preserves typed config; this runtime view is never persisted.
      let config = migratePersistedImplicitMainRoster(candidate.config).config as OpenClawConfig;
      const agentId = resolveAmbientOwnerAgentId(config);
      if (candidate.authProfiles.length > 0) {
        const { saveSetupCredential, selectSetupCredential } =
          await import("../system-agent/setup-inference-credentials.js");
        const { projectSetupInferenceConfig } =
          await import("../system-agent/setup-model-selection.js");
        const model = resolveDefaultModelForAgent({ cfg: config, agentId });
        const modelRef = `${model.provider}/${model.model}`;
        const profile = selectSetupCredential(candidate.authProfiles, modelRef, config);
        if (!profile) {
          throw new Error(`The selected provider did not return credentials for ${modelRef}.`);
        }
        const saved = await saveSetupCredential({
          profile,
          config: candidate.config,
          agentDir: params.agentDir ?? resolveAgentDir(config, agentId),
          persistAuthProfiles: candidate.persistAuthProfiles,
        });
        candidate.config = projectSetupInferenceConfig({
          base: saved.config,
          prepared: saved.config,
          modelRef,
          agentId,
          profileId: saved.profile.profileId,
          credential: saved.profile.credential,
        });
        setAgentEffectiveModelPrimary(
          candidate.config,
          agentId,
          `${modelRef}@${saved.profile.profileId}`,
        );
        candidate.authProfiles = [];
        // SAFETY: Canonical roster migration preserves this typed config; this view is not persisted.
        config = migratePersistedImplicitMainRoster(candidate.config).config as OpenClawConfig;
      }
      result = await withConsoleSubsystemsSuppressed(() =>
        inference.verifySetupInferenceConfig({
          config,
          agentId,
          runtime: params.runtime,
          ...(params.agentDir ? { agentDir: params.agentDir } : {}),
        }),
      );
    } finally {
      progress.stop();
    }
    if (result.ok) {
      await params.prompter.note(
        t("wizard.setup.testAiSuccess", { seconds: (result.latencyMs / 1000).toFixed(1) }),
        t("wizard.setup.testAiTitle"),
      );
    } else {
      await params.prompter.note(
        t("wizard.setup.testAiFailure", { reason: result.error }),
        t("wizard.setup.testAiTitle"),
      );
    }
    return result;
  };

  let candidate: SetupModelAuthCandidate =
    params.initialCandidate ??
    ({
      config: params.config,
      authProfiles: [],
      persistAuthProfiles: async () => {},
    } satisfies SetupModelAuthCandidate);
  while (true) {
    const result = await verify(candidate);
    if (result.ok) {
      if (!shouldPersistCandidate) {
        return {
          config: params.config,
          attempted: true,
          persisted: false,
          verified: true,
          modelRef: result.modelRef,
        };
      }
      const config = await params.writeConfig(candidate.config);
      return {
        config,
        attempted: true,
        persisted: true,
        verified: true,
        modelRef: result.modelRef,
      };
    }
    if (params.opts.nonInteractive) {
      return { config: params.config, attempted: true, persisted: false, verified: false };
    }
    if (
      !required &&
      (await params.prompter.select({
        message: t("wizard.setup.testAiFailureChoice"),
        options: [
          { value: "fix", label: t("wizard.setup.testAiFix") },
          { value: "continue", label: t("wizard.setup.testAiContinue") },
        ],
      })) === "continue"
    ) {
      return { config: params.config, attempted: true, persisted: false, verified: false };
    }

    candidate = await runSetupModelAuthStep({
      config: params.config,
      stagedCandidate: candidate,
      opts: { ...params.opts, authChoice: undefined },
      prompter: params.prompter,
      runtime: params.runtime,
      ...(params.agentDir ? { agentDir: params.agentDir } : {}),
      ...(params.stateDir ? { stateDir: params.stateDir } : {}),
    });
    shouldPersistCandidate = true;
    required ||= requiresCandidateVerification(candidate.config);
  }
}
