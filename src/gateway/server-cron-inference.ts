import {
  resolveAgentConfig,
  resolveAgentDir,
  resolveAgentWorkspaceDir,
  tryResolveAmbientOwnerAgentId,
} from "../agents/agent-scope.js";
import { resolveSessionAuthProfilePreference } from "../agents/auth-profiles/selection-preference.js";
import { loadAuthProfileStoreWithoutExternalProfilesAsync } from "../agents/auth-profiles/store-runtime.js";
import { hasSyntheticLocalProviderAuthConfig } from "../agents/model-auth-provider-config.js";
import { resolveModelRuntimePolicy } from "../agents/model-runtime-policy.js";
import { isConfiguredKeyAuthSource } from "../agents/provider-model-auth-source-plan.js";
import { prepareAgentRuntimeAuth } from "../agents/runtime-plan/prepare-auth.js";
import { resolveSessionRuntimeOverrideForProvider } from "../agents/session-runtime-compat.js";
import { resolveMergedModelProviderConfig } from "../config/model-provider-config.js";
import { resolveSessionAuthProfileOverrideSource } from "../config/sessions/auth-profile-override-provenance.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { tryResolveCronJobEffectiveAgentId } from "../cron/agent-id.js";
import {
  inspectCronCliInferenceAccount,
  prepareCronInferenceDiagnosticSession,
} from "../cron/inference-diagnostics.js";
import { resolveCronModelSelection } from "../cron/isolated-agent/model-selection.js";
import type { CronStoredJob } from "../cron/types.js";
import { resolveProviderAuthProfileId } from "../plugins/provider-runtime.js";

/** Startup inspects existing owner facts; Doctor remains the sole migration writer. */
export async function describeCronInferenceMigration(
  config: OpenClawConfig,
  job: CronStoredJob,
): Promise<string | undefined> {
  if (
    job.payload.kind !== "agentTurn" ||
    job.sessionTarget === "main" ||
    job.inferenceBinding ||
    job.runtimeAuthority ||
    job.runtimeAuthorityRecoveryRequired
  ) {
    return undefined;
  }
  try {
    const agentId = tryResolveCronJobEffectiveAgentId(job, tryResolveAmbientOwnerAgentId(config));
    if (!agentId) {
      return undefined;
    }
    const session = await prepareCronInferenceDiagnosticSession({ cfg: config, agentId, job });
    if (session.initialSessionEntry?.modelSelectionLocked) {
      throw new Error("Native runtime owns the session model");
    }
    const selection = await resolveCronModelSelection({
      cfg: config,
      agentId,
      agentDir: resolveAgentDir(config, agentId),
      workspaceDir: resolveAgentWorkspaceDir(config, agentId),
      agentConfigOverride: resolveAgentConfig(config, agentId),
      sessionEntry: session.sessionEntry,
      payloadModel: job.payload.model,
      isGmailHook: job.payload.externalContentSource === "gmail",
    });
    if (!selection.ok) {
      throw new Error(selection.error);
    }
    const cfg = selection.cfgWithAgentDefaults;
    const cli = await inspectCronCliInferenceAccount({
      cfg,
      agentId,
      agentDir: selection.owner.agentDir,
      job,
      provider: selection.provider,
      model: selection.model,
      configuredProfileId: selection.configuredProfileId,
      session,
    });
    if (cli) {
      return cli.warning ? `cron: ${cli.warning}` : undefined;
    }
    const runtime =
      resolveSessionRuntimeOverrideForProvider({
        cfg,
        provider: selection.provider,
        entry: session.sessionEntry,
      }) ??
      resolveModelRuntimePolicy({
        config: cfg,
        agentId,
        provider: selection.provider,
        modelId: selection.model,
      }).policy?.id;
    if (
      (runtime && runtime !== "openclaw" && runtime !== "auto") ||
      hasSyntheticLocalProviderAuthConfig({
        cfg,
        provider: selection.provider,
        route: resolveMergedModelProviderConfig(cfg, selection.provider),
      })
    ) {
      return undefined;
    }
    const preference = resolveSessionAuthProfilePreference({
      cfg,
      agentId,
      provider: selection.provider,
      modelId: selection.model,
      configuredProfileId: selection.configuredProfileId,
      sessionProfileId: session.sessionEntry.authProfileOverride,
      sessionProfileSource: resolveSessionAuthProfileOverrideSource(session.sessionEntry),
    });
    const explicitProfileId = preference?.source === "user" ? preference.profileId : undefined;
    const [attempt] = prepareAgentRuntimeAuth({
      config: cfg,
      agentId,
      provider: selection.provider,
      modelId: selection.model,
      agentDir: selection.owner.agentDir,
      workspaceDir: selection.owner.workspaceDir,
      authProfileStore: await loadAuthProfileStoreWithoutExternalProfilesAsync(
        selection.owner.agentDir,
      ),
      sessionAuthProfileId: preference?.profileId,
      sessionAuthProfileSource: preference?.source,
      ...(explicitProfileId
        ? { requiredAuthProfileId: explicitProfileId, allowAuthProfileFallback: false }
        : {}),
      resolveProviderPreferredProfileId: (context) =>
        resolveProviderAuthProfileId({
          provider: selection.provider,
          config: cfg,
          workspaceDir: selection.owner.workspaceDir,
          env: process.env,
          context,
        }),
    }).attempts;
    if (isConfiguredKeyAuthSource(attempt?.plan.credentialSource)) {
      return undefined;
    }
    return "cron: automation has no recorded inference account; run openclaw doctor --fix before its next scheduled run to migrate a clear stored account or see the explicit adoption needed. This is an account check, not a requirement to pin its model.";
  } catch {
    // A diagnostic cannot turn an unresolved model/agent into a Gateway startup refusal.
    return "cron: legacy inference account readiness could not be determined; inspect it with openclaw doctor --lint before the next scheduled run.";
  }
}
