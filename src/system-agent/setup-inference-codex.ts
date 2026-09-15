import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { readCodexCliActiveApiKey } from "../agents/cli-credentials.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { registerSecretValueForRedaction } from "../logging/secret-redaction-registry.js";
import { normalizePluginTargetConfig } from "../plugins/config-state.js";
import { enablePluginWithCapabilityConsent } from "../plugins/enable.js";
import { stripPendingPluginInstallRecords } from "../plugins/install-record-commit.js";
import { withPluginLifecycleLease } from "../plugins/plugin-lifecycle-lease.js";
import { createPluginCapabilityConsentPrompter } from "../wizard/plugin-capability-consent.js";
import { createQuickstartNotePrompter } from "./setup-apply.js";
import {
  SetupInferenceActivationIndeterminateError,
  type StageContext,
  type StagedCandidate,
  type StageFailure,
} from "./setup-inference-core.js";
import { saveSetupCredential } from "./setup-inference-credentials.js";

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
    const credential = (ctx.deps.readCodexCliActiveApiKey ?? readCodexCliActiveApiKey)({
      allowKeychainPrompt: true,
    });
    let authProfileId: string | undefined;
    let authenticatedConfig: OpenClawConfig = {
      ...config,
      plugins: {
        ...config.plugins,
        entries: {
          ...config.plugins?.entries,
          codex: {
            ...entry,
            enabled: true,
            config: {
              ...pluginConfig,
              appServer: {
                ...appServer,
                transport: "stdio",
                ...(credential ? { homeScope: "agent" } : {}),
              },
            },
          },
        },
      },
    };
    if (credential) {
      registerSecretValueForRedaction(credential.key);
      const saved = await saveSetupCredential({
        profile: { profileId: "openai:codex-cli-api-key", credential },
        config: authenticatedConfig,
        baseConfig: ctx.cfg,
        modelRef,
        pluginId: "codex",
        agentRuntimeId: "codex",
        agentDir: ctx.agentDir,
        beforePersistentEffect: () => ctx.beforePersistentEffect("credential"),
      });
      ctx.credentialsSaved = true;
      authProfileId = saved.profile.profileId;
      authenticatedConfig = saved.config;
    }
    return {
      modelRef,
      agentRuntimeId: "codex",
      ...(authProfileId ? { authProfileId } : {}),
      pendingPluginInstalls: config.plugins?.installs,
      config: authenticatedConfig,
    };
  });
}
