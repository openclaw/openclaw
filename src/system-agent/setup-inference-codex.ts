import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { resolveAuthProfileOrder } from "../agents/auth-profiles/order.js";
import { loadAuthProfileStoreWithoutExternalProfiles } from "../agents/auth-profiles/store-runtime.js";
import { readCodexCliActiveApiKey } from "../agents/cli-credentials.js";
import { isProviderAuthError } from "../agents/model-auth-runtime-shared.js";
import { resolveApiKeyForProviderCore } from "../agents/model-auth.js";
import { registerSecretValueForRedaction } from "../logging/secret-redaction-registry.js";
import { normalizePluginTargetConfig } from "../plugins/config-state.js";
import { enablePluginWithCapabilityConsent } from "../plugins/enable.js";
import { stripPendingPluginInstallRecords } from "../plugins/install-record-commit.js";
import { withPluginLifecycleLease } from "../plugins/plugin-lifecycle-lease.js";
import { resolveManifestProviderAuthChoices } from "../plugins/provider-auth-choices.js";
import { createPluginCapabilityConsentPrompter } from "../wizard/plugin-capability-consent.js";
import { createQuickstartNotePrompter } from "./setup-apply.js";
import { listSetupInferenceAuthOptions } from "./setup-inference-auth-options.js";
import {
  SetupInferenceActivationIndeterminateError,
  throwIfSetupInferenceCancelled,
  type StageContext,
  type StagedCandidate,
  type StageFailure,
} from "./setup-inference-core.js";
import { saveSetupCredential, stageProviderAuthCandidate } from "./setup-inference-credentials.js";

export async function stageCodexCandidate(
  ctx: StageContext,
  modelRef: string,
): Promise<StagedCandidate | StageFailure> {
  return await withPluginLifecycleLease({ signal: ctx.params.signal }, async () => {
    const enabled = await enablePluginWithCapabilityConsent(
      normalizePluginTargetConfig(stripPendingPluginInstallRecords(ctx.cfg), "codex"),
      "codex",
      {
        workspaceDir: ctx.workspace,
        beforePersistentEffect: ctx.beforePersistentEffect,
        onCapabilityConsent: ctx.params.prompter
          ? createPluginCapabilityConsentPrompter(ctx.params.prompter)
          : undefined,
      },
    );
    if (!enabled.enabled) {
      return { error: `Could not enable the Codex runtime plugin: ${enabled.reason}.` };
    }
    const ensureCodex =
      ctx.deps.ensureCodexRuntimePlugin ??
      (await import("../commands/codex-runtime-plugin-install.js"))
        .ensureCodexRuntimePluginForModelSelection;
    const ensured = await ensureCodex({
      cfg: enabled.config,
      model: modelRef,
      agentId: ctx.routeAgentId,
      prompter: ctx.params.prompter ?? createQuickstartNotePrompter(ctx.params.runtime),
      runtime: ctx.params.runtime,
      workspaceDir: ctx.workspace,
      beforePersistentEffect: ctx.beforePersistentEffect,
    });
    if (!ensured.ok) {
      return { error: ensured.message };
    }
    const install = ensured.cfg.plugins?.installs?.codex;
    if (install?.source === "npm" && install.installPath) {
      const markRetained =
        ctx.deps.markRetainedManagedNpmInstall ??
        (await import("../plugins/managed-npm-retention.js")).markRetainedManagedNpmInstall;
      if (
        !(await markRetained({
          packageDir: install.installPath,
          pluginId: "codex",
          reason: "openclaw-inference-activation-not-committed",
        }))
      ) {
        throw new SetupInferenceActivationIndeterminateError(
          "Could not retain the installed Codex package. Restart the Gateway before retrying setup.",
        );
      }
    }
    const config = normalizePluginTargetConfig(ensured.cfg, "codex");
    const entry = config.plugins?.entries?.codex;
    const pluginConfig = entry?.config ?? {};
    const appServer = isRecord(pluginConfig.appServer) ? pluginConfig.appServer : {};
    if (typeof appServer.transport === "string" && appServer.transport !== "stdio") {
      return {
        error:
          "Codex setup needs a local stdio app-server. Finish sign-in on the remote app-server host or remove the transport override before retrying.",
      };
    }
    const candidate = {
      modelRef,
      agentRuntimeId: "codex",
      pendingPluginInstalls: config.plugins?.installs,
      config,
    };
    if (appServer.homeScope === "user") {
      return candidate;
    }
    const store = loadAuthProfileStoreWithoutExternalProfiles(ctx.agentDir);
    const existingProfileId = resolveAuthProfileOrder({
      cfg: config,
      store,
      provider: "openai",
      forModel: modelRef.slice("openai/".length),
    })[0];
    if (existingProfileId) {
      return { ...candidate, authProfileId: existingProfileId };
    }
    // The normal auth owner checks configured/env keys without native discovery or refresh.
    try {
      const auth = await (ctx.deps.resolveApiKeyForProvider ?? resolveApiKeyForProviderCore)({
        cfg: config,
        store,
        provider: "openai",
        agentDir: ctx.agentDir,
        workspaceDir: ctx.workspace,
        allowAuthProfileFallback: false,
        skipSetupProviderFallback: true,
        secretSentinels: true,
      });
      throwIfSetupInferenceCancelled(ctx.params);
      if (auth.apiKey) {
        return { ...candidate, authProfileId: auth.profileId };
      }
    } catch (error) {
      if (!isProviderAuthError(error, "missing-provider-auth")) {
        throw error;
      }
    }
    throwIfSetupInferenceCancelled(ctx.params);
    const credential = (ctx.deps.readCodexCliActiveApiKey ?? readCodexCliActiveApiKey)({
      allowKeychainPrompt: true,
    });
    if (!credential) {
      const choices = (
        ctx.deps.resolveManifestProviderAuthChoices ?? resolveManifestProviderAuthChoices
      )({
        config,
        workspaceDir: ctx.workspace,
        includeUntrustedWorkspacePlugins: false,
        includeWorkspacePlugins: false,
      });
      const options = listSetupInferenceAuthOptions(choices).filter(
        (choice) =>
          choice.brandId === "openai" && (choice.kind === "oauth" || choice.kind === "device-code"),
      );
      const choice = options.find((option) => option.id === ctx.params.authChoice) ?? options[0];
      if (!choice) {
        return {
          error:
            "OpenAI sign-in is unavailable. Connect OpenAI in Model Setup, then retry Codex setup.",
        };
      }
      const authContext: StageContext = {
        ...ctx,
        cfg: config,
        params: { ...ctx.params, modelRef, authChoice: choice.id },
      };
      try {
        return await stageProviderAuthCandidate(authContext, true, "codex");
      } finally {
        ctx.credentialsSaved = authContext.credentialsSaved;
      }
    }
    registerSecretValueForRedaction(credential.key);
    const saved = await saveSetupCredential({
      profile: { profileId: "openai:codex-cli-api-key", credential },
      config,
      baseConfig: ctx.cfg,
      modelRef,
      pluginId: "codex",
      agentRuntimeId: "codex",
      agentDir: ctx.agentDir,
      beforePersistentEffect: () => ctx.beforePersistentEffect("credential"),
    });
    ctx.credentialsSaved = true;
    return { ...candidate, authProfileId: saved.profile.profileId, config: saved.config };
  });
}
