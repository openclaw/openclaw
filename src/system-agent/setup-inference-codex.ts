import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { resolveAuthProfileOrder } from "../agents/auth-profiles/order.js";
import { loadAuthProfileStoreWithoutExternalProfilesAsync } from "../agents/auth-profiles/store-runtime.js";
import {
  readCodexCliActiveApiKey,
  readCodexCliCredentialsCached,
} from "../agents/cli-credentials.js";
import { isProviderAuthError } from "../agents/model-auth-runtime-shared.js";
import { resolveApiKeyForProviderCore } from "../agents/model-auth.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { registerSecretValueForRedaction } from "../logging/secret-redaction-registry.js";
import type { PluginCapabilityConsentHandler } from "../plugins/capability-consent.js";
import { normalizePluginTargetConfig } from "../plugins/config-state.js";
import { enablePluginWithCapabilityConsent } from "../plugins/enable.js";
import { stripPendingPluginInstallRecords } from "../plugins/install-record-commit.js";
import {
  isInstalledPluginIndexInstallOwnerAmbiguous,
  resolveInstalledPluginIndexInstallOwner,
} from "../plugins/installed-plugin-index-install-owner.js";
import { isTrustedOfficialPluginInstallRecord } from "../plugins/official-external-install-records.js";
import { getOfficialExternalPluginCatalogEntry } from "../plugins/official-external-plugin-catalog.js";
import { withPluginLifecycleLease } from "../plugins/plugin-lifecycle-lease.js";
import { resolveManifestProviderAuthChoices } from "../plugins/provider-auth-choices.js";
import type { RuntimeEnv } from "../runtime.js";
import { createPluginCapabilityConsentPrompter } from "../wizard/plugin-capability-consent.js";
import type { WizardPrompter } from "../wizard/prompts.js";
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

const acceptAutomaticCodexCapabilities: PluginCapabilityConsentHandler = async (review) => {
  const source = review.source;
  if (
    review.pluginId !== "codex" ||
    source?.kind !== "npm" ||
    !isTrustedOfficialPluginInstallRecord({
      pluginId: "codex",
      packageName: "@openclaw/codex",
      record: {
        source: "npm",
        spec: source.spec,
        resolvedName: source.packageName,
      },
    })
  ) {
    return undefined;
  }
  return { reviewToken: review.reviewToken };
};

type PrepareCodexRuntimeParams = {
  cfg: OpenClawConfig;
  runtime: RuntimeEnv;
  workspace: string;
  beforePersistentEffect: () => void | Promise<void>;
  prompter?: WizardPrompter;
  automaticSetup?: true;
  modelRef?: string;
  agentId?: string;
  ensureCodex: NonNullable<StageContext["deps"]["ensureCodexRuntimePlugin"]>;
  markRetained?: StageContext["deps"]["markRetainedManagedNpmInstall"];
  resolveMetadata?: StageContext["deps"]["resolvePluginMetadataSnapshot"];
};

async function prepareCodexRuntimePlugin(
  params: PrepareCodexRuntimeParams,
): Promise<{ config: OpenClawConfig } | StageFailure> {
  if (params.automaticSetup) {
    const resolveMetadata =
      params.resolveMetadata ??
      (await import("../plugins/plugin-metadata-snapshot.js")).resolvePluginMetadataSnapshot;
    const metadata = resolveMetadata({
      config: params.cfg,
      workspaceDir: params.workspace,
      allowCurrent: false,
    });
    const installed = metadata.index.plugins.find((plugin) => plugin.pluginId === "codex");
    const owner =
      installed && isInstalledPluginIndexInstallOwnerAmbiguous(installed)
        ? undefined
        : (installed && resolveInstalledPluginIndexInstallOwner(installed)) || "codex";
    const record = owner ? metadata.index.installRecords[owner] : undefined;
    const official = getOfficialExternalPluginCatalogEntry("codex");
    const trustedBundled =
      official !== undefined &&
      !record &&
      installed?.origin === "bundled" &&
      installed.packageName === official?.name;
    const trustedInstall =
      record &&
      isTrustedOfficialPluginInstallRecord({
        pluginId: "codex",
        packageName: installed?.packageName ?? official?.name,
        record,
      });
    if ((installed || record) && !trustedBundled && !trustedInstall) {
      return {
        error:
          "Automatic setup requires the official Codex plugin. Remove the conflicting Codex plugin source with openclaw plugins uninstall codex, then retry, or select it manually in Model Setup.",
      };
    }
  }
  const onCapabilityConsent = params.automaticSetup
    ? acceptAutomaticCodexCapabilities
    : params.prompter
      ? createPluginCapabilityConsentPrompter(params.prompter)
      : undefined;
  const enabled = await enablePluginWithCapabilityConsent(
    normalizePluginTargetConfig(stripPendingPluginInstallRecords(params.cfg), "codex"),
    "codex",
    {
      workspaceDir: params.workspace,
      beforePersistentEffect: params.beforePersistentEffect,
      onCapabilityConsent,
      recordOfficialCapabilities: params.automaticSetup,
    },
  );
  if (!enabled.enabled) {
    return { error: `Could not enable the Codex runtime plugin: ${enabled.reason}.` };
  }
  const ensured = await params.ensureCodex({
    cfg: enabled.config,
    model: params.modelRef,
    agentId: params.agentId,
    prompter: params.prompter ?? createQuickstartNotePrompter(params.runtime),
    runtime: params.runtime,
    workspaceDir: params.workspace,
    beforePersistentEffect: params.beforePersistentEffect,
    onCapabilityConsent,
    recordOfficialCapabilities: params.automaticSetup,
  });
  if (!ensured.ok) {
    return { error: ensured.message };
  }
  const install = ensured.cfg.plugins?.installs?.codex;
  if (install?.source === "npm" && install.installPath) {
    const markRetained =
      params.markRetained ??
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
  let config = normalizePluginTargetConfig(ensured.cfg, "codex");
  if (params.automaticSetup) {
    const entry = config.plugins?.entries?.codex;
    const pluginConfig = entry?.config ?? {};
    // Imported credentials belong to an OpenClaw-owned home, never the source CLI home.
    config = {
      ...config,
      plugins: {
        ...config.plugins,
        entries: {
          ...config.plugins?.entries,
          codex: {
            ...entry,
            config: {
              ...pluginConfig,
              appServer: {
                ...(isRecord(pluginConfig.appServer) ? pluginConfig.appServer : {}),
                homeScope: "agent",
              },
            },
          },
        },
      },
    };
  }
  return { config };
}

/** Prepare the official runtime without starting an interactive provider login. */
export async function prepareAutomaticSetupCodex(params: {
  cfg: OpenClawConfig;
  runtime: RuntimeEnv;
  workspace: string;
  beforePersistentEffect: () => void | Promise<void>;
  signal?: AbortSignal;
}): Promise<{ ok: true; config: OpenClawConfig } | StageFailure> {
  return await withPluginLifecycleLease({ signal: params.signal }, async () => {
    const { ensureCodexRuntimePluginForSupervision } =
      await import("../commands/codex-runtime-plugin-install.js");
    const prepared = await prepareCodexRuntimePlugin({
      ...params,
      automaticSetup: true,
      ensureCodex: ensureCodexRuntimePluginForSupervision,
    });
    return "error" in prepared ? prepared : { ok: true, config: prepared.config };
  });
}

export async function stageCodexCandidate(
  ctx: StageContext,
  modelRef: string,
): Promise<StagedCandidate | StageFailure> {
  return await withPluginLifecycleLease({ signal: ctx.params.signal }, async () => {
    const ensureCodex =
      ctx.deps.ensureCodexRuntimePlugin ??
      (await import("../commands/codex-runtime-plugin-install.js"))
        .ensureCodexRuntimePluginForModelSelection;
    const prepared = await prepareCodexRuntimePlugin({
      cfg: ctx.cfg,
      runtime: ctx.params.runtime,
      workspace: ctx.workspace,
      beforePersistentEffect: ctx.beforePersistentEffect,
      prompter: ctx.params.prompter,
      automaticSetup: ctx.params.automaticSetup,
      modelRef,
      agentId: ctx.routeAgentId,
      ensureCodex,
      markRetained: ctx.deps.markRetainedManagedNpmInstall,
      resolveMetadata: ctx.deps.resolvePluginMetadataSnapshot,
    });
    if ("error" in prepared) {
      return prepared;
    }
    const { config } = prepared;
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
    const store = await loadAuthProfileStoreWithoutExternalProfilesAsync(ctx.agentDir);
    const existingProfileId = resolveAuthProfileOrder({
      cfg: config,
      store,
      provider: "openai",
      forModel: modelRef.slice("openai/".length),
    })[0];
    if (existingProfileId) {
      return { ...candidate, authProfileId: existingProfileId };
    }
    const nativeCredential = ctx.params.automaticSetup
      ? (ctx.deps.readCodexCliCredentialsCached ?? readCodexCliCredentialsCached)({
          allowKeychainPrompt: false,
        })
      : null;
    // The normal auth owner checks configured/env keys without native discovery or refresh.
    if (!nativeCredential) {
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
    }
    throwIfSetupInferenceCancelled(ctx.params);
    const credential = ctx.params.automaticSetup
      ? nativeCredential
      : (ctx.deps.readCodexCliActiveApiKey ?? readCodexCliActiveApiKey)({
          allowKeychainPrompt: true,
        });
    if (!credential) {
      if (ctx.params.automaticSetup) {
        return { error: "Codex needs ChatGPT sign-in before it can be activated." };
      }
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
      return await stageProviderAuthCandidate(
        { ...ctx, cfg: config, params: { ...ctx.params, modelRef, authChoice: choice.id } },
        true,
        "codex",
      );
    }
    if (credential.type === "api_key") {
      registerSecretValueForRedaction(credential.key);
    } else {
      registerSecretValueForRedaction(credential.access);
      registerSecretValueForRedaction(credential.refresh);
      if (credential.idToken) {
        registerSecretValueForRedaction(credential.idToken);
      }
    }
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
    ctx.effects.credentialsSaved = true;
    return { ...candidate, authProfileId: saved.profile.profileId, config: saved.config };
  });
}
