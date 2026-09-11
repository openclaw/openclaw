/**
 * Applies non-interactive setup for provider plugins.
 *
 * This path resolves trusted plugin providers, delegates setup to their
 * non-interactive method, and installs runtime plugins required by the model.
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import type { ApiKeyCredential } from "../../../agents/auth-profiles/types.js";
import { resolveAgentModelPrimaryValue } from "../../../config/model-input.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { enablePluginWithCapabilityConsent } from "../../../plugins/enable.js";
import { resolvePreferredProviderForAuthChoice } from "../../../plugins/provider-auth-choice-preference.js";
import { resolveManifestProviderAuthChoice } from "../../../plugins/provider-auth-choices.js";
import {
  resolveDeprecatedProviderInstallCatalogEntry,
  resolveProviderInstallCatalogEntry,
} from "../../../plugins/provider-install-catalog.js";
import type {
  ProviderAuthOptionBag,
  ProviderNonInteractiveApiKeyCredentialParams,
  ProviderResolveNonInteractiveApiKeyParams,
} from "../../../plugins/types.js";
import type { RuntimeEnv } from "../../../runtime.js";
import { createLazyRuntimeSurface } from "../../../shared/lazy-runtime.js";
import { createNonInteractiveLoggingPrompter } from "../../non-interactive-prompter.js";
import {
  prepareAgentModelDefaults,
  projectAgentModelDefaults,
  type OnboardingAgentTarget,
} from "../../onboard-agent-target.js";
import { rejectOnboardingOption } from "../../onboard-options.js";
import type { OnboardOptions } from "../../onboard-types.js";
import {
  CODEX_RUNTIME_PLUGIN_ID,
  ensureModelSelectionRuntimePlugins,
} from "../../runtime-plugin-install.js";

const PROVIDER_PLUGIN_CHOICE_PREFIX = "provider-plugin:";

async function loadPluginProviderRuntime() {
  return import("./auth-choice.plugin-providers.runtime.js");
}

const loadAuthChoicePluginProvidersRuntime = createLazyRuntimeSurface(
  loadPluginProviderRuntime,
  ({ authChoicePluginProvidersRuntime }) => authChoicePluginProvidersRuntime,
);

/** Applies a plugin-defined auth choice, or returns undefined when it is not plugin-backed. */
export async function applyNonInteractivePluginProviderChoice(params: {
  nextConfig: OpenClawConfig;
  authChoice: string;
  opts: OnboardOptions;
  runtime: RuntimeEnv;
  baseConfig: OpenClawConfig;
  target: OnboardingAgentTarget;
  resolveApiKey: (input: ProviderResolveNonInteractiveApiKeyParams) => Promise<{
    key: string;
    source: "profile" | "env" | "flag";
    envVarName?: string;
  } | null>;
  toApiKeyCredential: (
    input: ProviderNonInteractiveApiKeyCredentialParams,
  ) => ApiKeyCredential | null;
}): Promise<OpenClawConfig | null | undefined> {
  const { agentDir, workspaceDir } = params.target;
  const reject = (message: string): null => {
    rejectOnboardingOption(params.opts, params.runtime, message);
    return null;
  };
  let nextConfig = params.nextConfig;
  const prefixedProviderId = params.authChoice.startsWith(PROVIDER_PLUGIN_CHOICE_PREFIX)
    ? params.authChoice.slice(PROVIDER_PLUGIN_CHOICE_PREFIX.length).split(":", 1)[0]?.trim()
    : undefined;
  // Prefixed choices bypass generic validation, so reject empty IDs before provider discovery.
  if (prefixedProviderId === "") {
    return reject(
      `Auth choice ${JSON.stringify(params.authChoice)} is missing a provider id. Use "${PROVIDER_PLUGIN_CHOICE_PREFIX}<provider-id>".`,
    );
  }
  const preferredProviderId =
    prefixedProviderId ||
    (await resolvePreferredProviderForAuthChoice({
      choice: params.authChoice,
      config: nextConfig,
      workspaceDir,
      includeUntrustedWorkspacePlugins: false,
    }));
  const trustedManifestMatch = resolveManifestProviderAuthChoice(params.authChoice, {
    config: nextConfig,
    workspaceDir,
    includeUntrustedWorkspacePlugins: false,
  });
  if (trustedManifestMatch) {
    const enabled = await enablePluginWithCapabilityConsent(
      nextConfig,
      trustedManifestMatch.pluginId,
      {
        workspaceDir,
      },
    );
    if (!enabled.enabled) {
      return reject(enabled.reason ?? "Provider plugin could not be enabled.");
    }
    nextConfig = enabled.config;
  }
  // Provider discovery is lazy so non-plugin auth choices do not pull plugin
  // runtime code into the basic non-interactive setup path.
  const {
    resolveOwningPluginIdsForProviderRef,
    resolveProviderPluginChoice,
    resolvePluginProviders,
  } = await loadAuthChoicePluginProvidersRuntime();
  const owningPluginIds = preferredProviderId
    ? resolveOwningPluginIdsForProviderRef({
        provider: preferredProviderId,
        config: nextConfig,
        workspaceDir,
      })
    : undefined;
  let providerChoice = resolveProviderPluginChoice({
    providers: resolvePluginProviders({
      config: nextConfig,
      workspaceDir,
      onlyPluginIds: owningPluginIds,
      ...(preferredProviderId ? { providerRefs: [preferredProviderId] } : {}),
      mode: "setup",
      includeUntrustedWorkspacePlugins: false,
    }),
    choice: params.authChoice,
    manifestChoice: trustedManifestMatch,
  });
  if (!providerChoice) {
    if (prefixedProviderId) {
      // Explicit provider-plugin choices are user intent; fail closed if the
      // target provider is unavailable rather than falling back to core auth.
      return reject(
        [
          `Auth choice "${params.authChoice}" was not matched to a trusted provider plugin.`,
          "If this provider comes from a workspace plugin, trust/allow it first and retry.",
        ].join("\n"),
      );
    }
    // Keep mismatch diagnostics metadata-only so untrusted workspace plugins are not loaded.
    const untrustedOnlyManifestMatch =
      !trustedManifestMatch &&
      resolveManifestProviderAuthChoice(params.authChoice, {
        config: nextConfig,
        workspaceDir,
        includeUntrustedWorkspacePlugins: true,
      });
    if (untrustedOnlyManifestMatch) {
      // Manifest metadata can identify untrusted matches without loading the
      // plugin implementation, preserving workspace trust boundaries.
      return reject(
        [
          `Auth choice "${params.authChoice}" matched a provider plugin that is not trusted or enabled for setup.`,
          "If this provider comes from a workspace plugin, trust/allow it first and retry.",
        ].join("\n"),
      );
    }
    const installCatalogParams = {
      config: nextConfig,
      workspaceDir,
      includeUntrustedWorkspacePlugins: false,
    };
    const deprecatedInstallCatalogEntry = resolveDeprecatedProviderInstallCatalogEntry(
      params.authChoice,
      installCatalogParams,
    );
    if (deprecatedInstallCatalogEntry) {
      return reject(
        `${JSON.stringify(params.authChoice)} is no longer supported. Use --auth-choice ${JSON.stringify(deprecatedInstallCatalogEntry.choiceId)} instead.`,
      );
    }
    const installCatalogEntry = resolveProviderInstallCatalogEntry(
      params.authChoice,
      installCatalogParams,
    );
    if (!installCatalogEntry) {
      return undefined;
    }
    const { ensureOnboardingPluginInstalled } = await import("../../onboarding-plugin-install.js");
    const installResult = await ensureOnboardingPluginInstalled({
      cfg: nextConfig,
      entry: {
        pluginId: installCatalogEntry.pluginId,
        label: installCatalogEntry.label,
        install: installCatalogEntry.install,
        ...(installCatalogEntry.origin === "bundled"
          ? { trustedSourceLinkedOfficialInstall: true }
          : {}),
      },
      prompter: createNonInteractiveLoggingPrompter(
        params.runtime,
        (message) => `Non-interactive setup cannot prompt for plugin install: ${message}`,
      ),
      runtime: params.runtime,
      workspaceDir,
      promptInstall: false,
    });
    if (!installResult.installed) {
      return reject(
        `Unable to install the ${installCatalogEntry.label} plugin for non-interactive setup.`,
      );
    }
    nextConfig = installResult.cfg;
    providerChoice = resolveProviderPluginChoice({
      providers: resolvePluginProviders({
        config: nextConfig,
        workspaceDir,
        onlyPluginIds: [installCatalogEntry.pluginId],
        providerRefs: [installCatalogEntry.providerId],
        mode: "setup",
        includeUntrustedWorkspacePlugins: false,
      }),
      choice: params.authChoice,
      manifestChoice: installCatalogEntry,
    });
    if (!providerChoice) {
      return reject(
        `Installed plugin "${installCatalogEntry.label}" did not expose auth choice "${params.authChoice}".`,
      );
    }
  }

  const enableResult = await enablePluginWithCapabilityConsent(
    nextConfig,
    providerChoice.provider.pluginId ?? providerChoice.provider.id,
    { workspaceDir },
  );
  if (!enableResult.enabled) {
    return reject(
      `${providerChoice.provider.label} plugin is disabled (${enableResult.reason ?? "blocked"}).`,
    );
  }

  const method = providerChoice.method;
  if (!method.runNonInteractive) {
    // Interactive-only plugin setup methods may prompt, so non-interactive
    // setup must reject them before entering plugin code.
    return reject(
      [
        `Auth choice "${params.authChoice}" requires interactive mode.`,
        `The ${providerChoice.provider.label} provider plugin does not implement non-interactive setup.`,
      ].join("\n"),
    );
  }

  const agentScopedModels = enableResult.config.agents?.ownership === "explicit";
  const providerConfig = agentScopedModels
    ? prepareAgentModelDefaults(enableResult.config, params.target)
    : enableResult.config;
  const projectProviderResult = (updated: OpenClawConfig) =>
    agentScopedModels
      ? projectAgentModelDefaults(enableResult.config, params.target, updated)
      : updated;
  const runNonInteractive = method.runNonInteractive;
  const context = {
    authChoice: params.authChoice,
    config: providerConfig,
    baseConfig: params.baseConfig,
    opts: params.opts as ProviderAuthOptionBag,
    runtime: params.runtime,
    agentDir,
    workspaceDir,
    resolveApiKey: params.resolveApiKey,
    toApiKeyCredential: params.toApiKeyCredential,
  };
  const { isSetupCredentialReplacement, saveSetupCredential, selectSetupCredential } =
    await import("../../../system-agent/setup-inference-credentials.js");
  let result: OpenClawConfig | null;
  if (
    isSetupCredentialReplacement({
      provider: providerChoice.provider.id,
      baseConfig: params.baseConfig,
      agentDir,
    })
  ) {
    const [
      { withAuthProfileStoreAgentDir, clearRuntimeAuthProfileStoreSnapshot },
      { loadAuthProfileStoreWithoutExternalProfiles, saveAuthProfileStore },
      { loadPersistedAuthProfileStore },
      { closeAuthProfileReadPool },
      { closeOpenClawAgentDatabases },
      { splitTrailingAuthProfile },
      { resolveSetupModel },
      { prepareCustomSetupCredentials },
    ] = await Promise.all([
      import("../../../agents/auth-profiles/store.js"),
      import("../../../agents/auth-profiles/store-runtime.js"),
      import("../../../agents/auth-profiles/persisted.js"),
      import("../../../agents/auth-profiles/sqlite.js"),
      import("../../../state/openclaw-agent-db.js"),
      import("../../../agents/model-ref-profile.js"),
      import("../../../system-agent/setup-inference-core.js"),
      import("../../../system-agent/setup-inference-custom.js"),
    ]);
    const realStore = loadAuthProfileStoreWithoutExternalProfiles(agentDir);
    // This is preparation for the same owner, not a new agent. Preserve static
    // metadata even when cross-agent copying is disabled; never clone refresh material.
    const seeded = {
      version: realStore.version,
      ...(realStore.order ? { order: structuredClone(realStore.order) } : {}),
      profiles: Object.fromEntries(
        Object.entries(realStore.profiles).filter(
          ([, credential]) => credential.type !== "oauth" && !credential.setup?.replacement,
        ),
      ),
    };
    const stagingRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-setup-credential-"));
    const stagingAgentDir = path.join(stagingRoot, "agents", "setup", "agent");
    try {
      await fs.mkdir(stagingAgentDir, { recursive: true });
      result = await withAuthProfileStoreAgentDir(stagingAgentDir, stagingRoot, async () => {
        saveAuthProfileStore(seeded, stagingAgentDir, { syncExternalCli: false });
        return await runNonInteractive({
          ...context,
          agentDir: stagingAgentDir,
          runtime: {
            ...params.runtime,
            exit: (code) => {
              throw new Error(`Provider setup exited with code ${code}; see its error above.`);
            },
          },
        });
      });
      if (!result) {
        return null;
      }
      const prepared = prepareCustomSetupCredentials({
        config: structuredClone(result),
        providerId: providerChoice.provider.id,
      });
      const profiles = Object.entries(
        loadPersistedAuthProfileStore(stagingAgentDir)?.profiles ?? {},
      )
        .filter(
          ([profileId, credential]) => !isDeepStrictEqual(credential, seeded.profiles[profileId]),
        )
        .map(([profileId, credential]) => ({ profileId, credential }));
      if (
        !isDeepStrictEqual(
          result.models?.providers?.[providerChoice.provider.id]?.apiKey,
          providerConfig.models?.providers?.[providerChoice.provider.id]?.apiKey,
        )
      ) {
        profiles.push(...prepared.profiles);
      }
      if (profiles.length > 0) {
        const selected = resolveAgentModelPrimaryValue(result.agents?.defaults?.model);
        const modelRef = resolveSetupModel({
          label: providerChoice.provider.label,
          providerId: providerChoice.provider.id,
          defaultModel:
            selected && selectSetupCredential(profiles, selected, prepared.config)
              ? splitTrailingAuthProfile(selected).model
              : method.starterModel,
        });
        if (typeof modelRef !== "string") {
          throw new Error(modelRef.error);
        }
        const profile = selectSetupCredential(profiles, modelRef, prepared.config);
        if (!profile) {
          throw new Error(
            "Provider setup did not save a replacement credential. Your connection is unchanged.",
          );
        }
        await saveSetupCredential({
          profile,
          config: projectProviderResult(prepared.config),
          baseConfig: params.baseConfig,
          agentDir,
          modelRef,
          authChoice: trustedManifestMatch?.choiceId ?? providerChoice.wizard?.choiceId,
          pluginId: providerChoice.provider.pluginId,
        });
        result = null;
      }
    } finally {
      clearRuntimeAuthProfileStoreSnapshot(stagingAgentDir);
      closeAuthProfileReadPool({ kind: "root", rootPath: stagingRoot });
      closeOpenClawAgentDatabases(stagingRoot);
      await fs.rm(stagingRoot, { recursive: true, force: true });
    }
    if (!result) {
      return reject(
        "Replacement credential saved but inactive. Your connection is unchanged. Open Model Setup to test and activate the saved sign-in.",
      );
    }
  } else {
    result = await runNonInteractive(context);
  }
  if (!result) {
    return result;
  }
  const selectedModel = resolveAgentModelPrimaryValue(result.agents?.defaults?.model);
  if (!selectedModel) {
    return projectProviderResult(result);
  }
  // Model selection can imply a runtime plugin even when auth setup belonged to
  // a provider plugin; install those runtimes before persisting the config.
  const runtimes = await ensureModelSelectionRuntimePlugins({
    cfg: result,
    model: selectedModel,
    prompter: createNonInteractiveLoggingPrompter(params.runtime, (message) => message),
    runtime: params.runtime,
    workspaceDir,
    output: "silent",
  });
  if (!runtimes.ok) {
    return reject(runtimes.message);
  }
  if (runtimes.codexInstalled) {
    // Non-interactive onboarding never auto-applies migration; emit a hint so
    // the operator knows Codex CLI state is available to import deliberately.
    // Gated on installed (not freshlyInstalled) so repair runs against an
    // already-present harness still surface the hint.
    const { offerPostInstallMigrations } =
      await import("../../../wizard/setup.post-install-migration.js");
    await offerPostInstallMigrations({
      config: runtimes.cfg,
      runtime: params.runtime,
      installedPluginIds: [CODEX_RUNTIME_PLUGIN_ID],
      nonInteractive: true,
    });
  }
  return projectProviderResult(runtimes.cfg);
}
