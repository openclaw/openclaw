import { isDeepStrictEqual } from "node:util";
// Setup inference verification owns the shared verify/repair loop used by onboarding imports.
import { resolveAmbientOwnerAgentId } from "../agents/agent-scope-config.js";
import {
  resolveAgentDir,
  resolveAgentEffectiveModelPrimary,
  setAgentEffectiveModelPrimary,
} from "../agents/agent-scope.js";
import { withSetupCredentialAccess } from "../agents/auth-profiles/setup-access.js";
import { loadAuthProfileStoreWithoutExternalProfiles } from "../agents/auth-profiles/store-runtime.js";
import type { AuthProfileCredential } from "../agents/auth-profiles/types.js";
import { splitTrailingAuthProfile } from "../agents/model-ref-profile.js";
import { resolveDefaultModelForAgent } from "../agents/model-selection-config.js";
import { resolveOnboardingSetupTarget } from "../commands/onboard-agent-target.js";
import type { OnboardOptions } from "../commands/onboard-types.js";
import { readConfigFileSnapshot } from "../config/config.js";
import { migratePersistedImplicitMainRoster } from "../config/legacy.roster.js";
import { applyMergePatch, createMergePatch } from "../config/merge-patch.js";
import type { ConfigFileSnapshot, OpenClawConfig } from "../config/types.openclaw.js";
import { withConsoleSubsystemsSuppressed } from "../logging/console.js";
import type { RuntimeEnv } from "../runtime.js";
import {
  resolveSystemAgentConfiguredRouteFromConfig,
  projectInferenceRoute,
  sameDefaultInferenceRoute,
} from "../system-agent/inference-route.js";
import {
  activateSavedSetupCredential,
  isSetupCredentialReplacement,
} from "../system-agent/setup-inference-credentials.js";
import { revalidateStableSetupInferenceOwner } from "../system-agent/setup-inference-turn.js";
import type { SystemAgentVerifiedInferenceBinding } from "../system-agent/verified-inference.js";
import { t } from "./i18n/index.js";
import type { WizardPrompter } from "./prompts.js";
import { runSetupModelAuthStep, type SetupModelAuthCandidate } from "./setup.model-auth.js";

export async function completeSetupModelAuth(params: {
  config: OpenClawConfig;
  baseConfig: OpenClawConfig;
  stagedCandidate?: SetupModelAuthCandidate;
  opts: OnboardOptions;
  prompter: WizardPrompter;
  runtime: RuntimeEnv;
  usedImportFlow: boolean;
  keepExistingModelConfig: boolean;
  importedInferenceVerified: boolean;
  writeConfig: (
    config: OpenClawConfig,
    verifiedSnapshot?: ConfigFileSnapshot,
  ) => Promise<OpenClawConfig>;
}): Promise<{ config: OpenClawConfig; verified: boolean; persisted: boolean }> {
  const { stagedCandidate, opts, baseConfig } = params;
  const replacementTarget = resolveOnboardingSetupTarget(baseConfig);
  const replacesCredential =
    stagedCandidate?.authProfiles.some(({ credential }) =>
      isSetupCredentialReplacement({
        provider: credential.provider,
        baseConfig,
        agentDir: replacementTarget.agentDir,
      }),
    ) === true;
  // The keep-model choice predates auth setup, distinguishing an imported route
  // from one selected normally after the import.
  if (
    replacesCredential ||
    (opts.nonInteractive !== true &&
      !params.importedInferenceVerified &&
      resolveAgentEffectiveModelPrimary(
        params.config,
        resolveAmbientOwnerAgentId(params.config),
      ) !== undefined &&
      ((params.usedImportFlow && params.keepExistingModelConfig) || opts.authChoice !== "skip"))
  ) {
    const verificationTarget = resolveOnboardingSetupTarget(params.config);
    const verification = await offerLiveModelVerification({
      config: params.config,
      baseConfig,
      ...(stagedCandidate
        ? { initialCandidate: { ...stagedCandidate, config: params.config } }
        : {}),
      opts,
      prompter: params.prompter,
      runtime: params.runtime,
      workspaceDir: verificationTarget.workspaceDir,
      writeConfig: params.writeConfig,
      required: params.usedImportFlow && params.keepExistingModelConfig,
    });
    let config = verification.config;
    if (!verification.verified && verification.attempted && stagedCandidate) {
      // Keep gateway/roster decisions while removing the unverified model/auth delta.
      const inversePatch = createMergePatch(stagedCandidate.config, baseConfig);
      // SAFETY: The inverse patch comes from typed configs and restores their model/auth fields.
      config = applyMergePatch(config, inversePatch) as OpenClawConfig;
    } else if (!verification.verified && stagedCandidate) {
      // Declining an optional probe still saves the user's first sign-in.
      await stagedCandidate.persistAuthProfiles();
    }
    return { config, verified: verification.verified, persisted: verification.persisted };
  }
  await stagedCandidate?.persistAuthProfiles();
  return { config: params.config, verified: false, persisted: false };
}

export async function offerLiveModelVerification(params: {
  config: OpenClawConfig;
  baseConfig?: OpenClawConfig;
  initialCandidate?: SetupModelAuthCandidate;
  opts: OnboardOptions;
  prompter: WizardPrompter;
  runtime: RuntimeEnv;
  workspaceDir: string;
  agentDir?: string;
  stateDir?: string;
  writeConfig: (
    config: OpenClawConfig,
    verifiedSnapshot?: ConfigFileSnapshot,
  ) => Promise<OpenClawConfig>;
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
  const agentDir =
    params.agentDir ?? resolveAgentDir(params.config, resolveAmbientOwnerAgentId(params.config));
  const replacesCredential = params.initialCandidate?.authProfiles.some(({ credential }) =>
    isSetupCredentialReplacement({
      provider: credential.provider,
      baseConfig: params.baseConfig ?? params.config,
      agentDir,
    }),
  );
  let required =
    params.required ||
    (params.initialCandidate !== undefined &&
      requiresCandidateVerification(params.initialCandidate.config));
  if (!required && !replacesCredential) {
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
  let savedProfile: { profileId: string; credential: AuthProfileCredential } | undefined;
  let verifiedBinding: SystemAgentVerifiedInferenceBinding | undefined;
  let verifiedSnapshot: ConfigFileSnapshot | undefined;
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
          modelRef,
          config: candidate.config,
          baseConfig: params.baseConfig ?? params.config,
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
      const profileId = splitTrailingAuthProfile(
        resolveAgentEffectiveModelPrimary(config, agentId) ?? "",
      ).profile;
      const credential = profileId
        ? loadAuthProfileStoreWithoutExternalProfiles(agentDir).profiles[profileId]
        : undefined;
      savedProfile = profileId && credential ? { profileId, credential } : undefined;
      verifiedBinding = undefined;
      verifiedSnapshot = savedProfile?.credential.setup?.replacement
        ? await readConfigFileSnapshot()
        : undefined;
      const runVerification = () =>
        withConsoleSubsystemsSuppressed(() =>
          inference.verifySetupInferenceConfig({
            config,
            agentId,
            runtime: params.runtime,
            ...(savedProfile?.credential.setup?.replacement
              ? {
                  onVerifiedExecution: (binding: SystemAgentVerifiedInferenceBinding) => {
                    verifiedBinding = binding;
                  },
                }
              : {}),
            ...(params.agentDir ? { agentDir: params.agentDir } : {}),
          }),
        );
      result = profileId
        ? await withSetupCredentialAccess({ profileId, agentDir }, runVerification)
        : await runVerification();
      if (result.ok && profileId) {
        const verifiedCredential =
          loadAuthProfileStoreWithoutExternalProfiles(agentDir).profiles[profileId];
        savedProfile = verifiedCredential
          ? { profileId, credential: verifiedCredential }
          : undefined;
      }
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
      if (
        savedProfile?.credential.setup?.replacement &&
        (params.opts.nonInteractive ||
          !(await params.prompter.confirm({
            message: "Connection verified. Activate this saved sign-in?",
            initialValue: false,
          })))
      ) {
        await params.prompter.note(
          "Saved but inactive. Your current connection is unchanged. Choose the saved sign-in in Model Setup to activate it.",
        );
        return { config: params.config, attempted: true, persisted: false, verified: false };
      }
      const binding = verifiedBinding;
      const revalidateCredential = async (config: OpenClawConfig) => {
        if (!savedProfile?.credential.setup?.replacement || !binding) {
          return;
        }
        await withSetupCredentialAccess(
          { profileId: savedProfile.profileId, agentDir },
          async () => {
            const route = await resolveSystemAgentConfiguredRouteFromConfig(config);
            if (!route) {
              throw new Error(
                "The verified connection is no longer available. Test the saved sign-in again.",
              );
            }
            await revalidateStableSetupInferenceOwner({
              route: { ...route, agentDir },
              auth:
                binding.auth.proofKind === "runtime-owner"
                  ? {
                      ...binding.auth,
                      authFingerprint: undefined,
                      runtimeOwnerFingerprint: binding.auth.authFingerprint,
                    }
                  : binding.auth,
              stagedOwnerPluginArtifacts: binding,
              deps: {},
            });
          },
        );
      };
      if (savedProfile?.credential.setup?.replacement) {
        if (
          !binding ||
          !isDeepStrictEqual(
            (await readConfigFileSnapshot()).sourceConfig,
            verifiedSnapshot?.sourceConfig,
          )
        ) {
          throw new Error(
            "Connection settings changed or verification is incomplete. The saved sign-in is inactive; test it again.",
          );
        }
        await revalidateCredential(candidate.config);
      }
      const verifiedRoute = savedProfile?.credential.setup?.replacement
        ? await projectInferenceRoute(candidate.config)
        : undefined;
      const config = await params.writeConfig(candidate.config, verifiedSnapshot);
      if (savedProfile?.credential.setup?.replacement && verifiedRoute) {
        if (!sameDefaultInferenceRoute(await projectInferenceRoute(config), verifiedRoute)) {
          throw new Error(
            "Settings were saved, but the connection changed. The sign-in remains inactive; test it again.",
          );
        }
        await revalidateCredential(config);
        await activateSavedSetupCredential({ ...savedProfile, agentDir });
      } else if (savedProfile?.credential.setup) {
        await activateSavedSetupCredential({ ...savedProfile, agentDir });
      }
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
