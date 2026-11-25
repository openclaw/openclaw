import {
  resolveAgentConfig,
  resolveAgentDir,
  resolveAgentWorkspaceDir,
  tryResolveAmbientOwnerAgentId,
} from "../agents/agent-scope.js";
import { loadAuthProfileStoreWithoutExternalProfilesAsync } from "../agents/auth-profiles/store-runtime.js";
import { hasSyntheticLocalProviderAuthConfig } from "../agents/model-auth-provider-config.js";
import { resolveModelRuntimePolicy } from "../agents/model-runtime-policy.js";
import { isConfiguredKeyAuthSource } from "../agents/provider-model-auth-source-plan.js";
import { prepareAgentRuntimeAuth } from "../agents/runtime-plan/prepare-auth.js";
import { resolveSessionRuntimeOverrideForProvider } from "../agents/session-runtime-compat.js";
import { resolveMergedModelProviderConfig } from "../config/model-provider-config.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { tryResolveCronJobEffectiveAgentId } from "../cron/agent-id.js";
import {
  inspectCronInferenceAccount,
  prepareCronInferenceDiagnosticSession,
} from "../cron/inference-diagnostics.js";
import { resolveCronModelSelection } from "../cron/isolated-agent/model-selection.js";
import type { CronStoredJob } from "../cron/types.js";
import { resolveProviderAuthProfileId } from "../plugins/provider-runtime.js";

/** Adapt live config reads to the cron service's cancellable diagnostic callback. */
export function createCronInferenceMigrationDiagnostic(readConfig: () => OpenClawConfig) {
  return (job: CronStoredJob, signal?: AbortSignal) =>
    describeCronInferenceMigration(readConfig(), job, signal);
}

/** Startup inspects existing owner facts; Doctor remains the sole migration writer. */
async function describeCronInferenceMigration(
  config: OpenClawConfig,
  job: CronStoredJob,
  signal?: AbortSignal,
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
    signal?.throwIfAborted();
    const agentId = tryResolveCronJobEffectiveAgentId(job, tryResolveAmbientOwnerAgentId(config));
    if (!agentId) {
      return undefined;
    }
    const session = await prepareCronInferenceDiagnosticSession({
      cfg: config,
      agentId,
      job,
      signal,
    });
    if (session.initialSessionEntry?.modelSelectionLocked) {
      // The owning native runtime's locked model is outside host account diagnostics.
      return undefined;
    }
    signal?.throwIfAborted();
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
    signal?.throwIfAborted();
    if (!selection.ok) {
      throw new Error(selection.error);
    }
    const cfg = selection.cfgWithAgentDefaults;
    const account = await inspectCronInferenceAccount({
      cfg,
      agentId,
      agentDir: selection.owner.agentDir,
      job,
      provider: selection.provider,
      model: selection.model,
      configuredProfileId: selection.configuredProfileId,
      session,
      signal,
    });
    signal?.throwIfAborted();
    if (account.cliExecution) {
      return account.warning ? `cron: ${account.warning}` : undefined;
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
    // Codex also runs host-managed stored accounts, which the scheduled account guard refuses
    // when unbound; Doctor adopts them the same way.
    if (
      (runtime && runtime !== "openclaw" && runtime !== "auto" && runtime !== "codex") ||
      hasSyntheticLocalProviderAuthConfig({
        cfg,
        provider: selection.provider,
        route: resolveMergedModelProviderConfig(cfg, selection.provider),
      })
    ) {
      return undefined;
    }
    const preference = account.preference;
    const explicitProfileId = preference?.source === "user" ? preference.profileId : undefined;
    signal?.throwIfAborted();
    const authProfileStore =
      account.store ??
      (await loadAuthProfileStoreWithoutExternalProfilesAsync(selection.owner.agentDir));
    signal?.throwIfAborted();
    const [attempt] = prepareAgentRuntimeAuth({
      ...(runtime === "codex"
        ? { harnessId: runtime, harnessRuntime: runtime, harnessAuthBootstrap: "harness" as const }
        : {}),
      config: cfg,
      agentId,
      provider: selection.provider,
      modelId: selection.model,
      agentDir: selection.owner.agentDir,
      workspaceDir: selection.owner.workspaceDir,
      authProfileStore,
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
    const source = attempt?.plan.credentialSource;
    // Native or credentialless Codex login has no stored account to record.
    if (isConfiguredKeyAuthSource(source) || (runtime === "codex" && source?.kind !== "profile")) {
      return undefined;
    }
    return "cron: automation has no recorded inference account; run openclaw doctor --fix before its next scheduled run to migrate a clear stored account or see the explicit adoption needed. This is an account check, not a requirement to pin its model.";
  } catch {
    if (signal?.aborted) {
      return undefined;
    }
    // A diagnostic cannot turn an unresolved model/agent into a Gateway startup refusal.
    return "cron: legacy inference account readiness could not be determined; inspect it with openclaw doctor --lint before the next scheduled run.";
  }
}
