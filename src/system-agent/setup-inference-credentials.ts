import { randomUUID } from "node:crypto";
import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import { resolveAmbientOwnerAgentId } from "../agents/agent-scope-config.js";
import { resolveAgentEffectiveModelPrimary } from "../agents/agent-scope.js";
import { loadAuthProfileStoreWithoutExternalProfiles } from "../agents/auth-profiles/store-runtime.js";
import { resolveModelRuntimePolicy } from "../agents/model-runtime-policy.js";
import { resolveProviderIdForAuth } from "../agents/provider-auth-aliases.js";
import { applyMergePatch } from "../config/merge-patch.js";
import { normalizeAgentModelRefForConfig } from "../config/model-input.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { PluginInstallRecord } from "../config/types.plugins.js";
import { resolveUtilityModelSeparationError } from "../config/utility-model-separation-migration.js";
import { formatErrorMessage } from "../infra/errors.js";
import {
  applyProviderPluginAuthMethodResultConfig,
  prepareAuthChoiceLoadedPluginProvider,
} from "../plugins/provider-auth-choice.js";
import {
  type ProviderAuthChoiceMetadata,
  resolveManifestProviderAuthChoice,
  resolveManifestProviderAuthChoices,
} from "../plugins/provider-auth-choices.js";
import { runProviderPluginAuthMethodUnpersisted } from "../plugins/provider-auth-method.js";
import { persistProviderAuthProfilesAfterLogin } from "../plugins/provider-auth-persistence.js";
import { resolveProviderInstallCatalogEntry } from "../plugins/provider-install-catalog.js";
import type { ProviderAuthResult, ProviderPlugin } from "../plugins/types.js";
import { createQuickstartNotePrompter } from "./setup-apply.js";
import {
  choiceMatchesCredential,
  supportsSetupManualSecret,
  supportsSetupTextInference,
} from "./setup-inference-auth-options.js";
import {
  type StagedCandidate,
  type StageContext,
  type StageFailure,
  parseInferenceRef,
  resolveSetupModel,
  validateSetupModelTarget,
  SetupInferenceCancelledError,
  throwIfSetupInferenceCancelled,
  waitForProviderAuth,
} from "./setup-inference-core.js";
import { prepareCustomSetupCredentials } from "./setup-inference-custom.js";
import { projectSetupInferenceConfig } from "./setup-model-selection.js";
import {
  withSetupProviderAuthMethod,
  type SetupProviderAuthMethod,
} from "./setup-provider-method.js";

function assertUtilitySeparation(ctx: StageContext, modelTarget: "utility" | undefined): void {
  if (modelTarget !== "utility") {
    return;
  }
  const error = resolveUtilityModelSeparationError(ctx.cfg);
  if (error) {
    throw new Error(error);
  }
}

export function selectSetupCredential(
  profiles: ProviderAuthResult["profiles"],
  modelRef: string,
  config: OpenClawConfig,
) {
  const provider = resolveProviderIdForAuth(parseInferenceRef(modelRef).provider, { config });
  return profiles.find(
    (profile) =>
      resolveProviderIdForAuth(profile.credential.provider, { config, storedCredential: true }) ===
      provider,
  );
}

export function isSetupCredentialReplacement(params: {
  provider: string;
  baseConfig: OpenClawConfig;
  agentDir: string;
}): boolean {
  const store = loadAuthProfileStoreWithoutExternalProfiles(params.agentDir);
  const provider = resolveProviderIdForAuth(params.provider, {
    config: params.baseConfig,
    storedCredential: true,
  });
  return (
    Object.values(store.profiles).some(
      (credential) =>
        !credential.setup &&
        resolveProviderIdForAuth(credential.provider, {
          config: params.baseConfig,
          storedCredential: true,
        }) === provider,
    ) ||
    Boolean(params.baseConfig.models?.providers?.[provider]?.apiKey) ||
    parseInferenceRef(
      resolveAgentEffectiveModelPrimary(
        params.baseConfig,
        resolveAmbientOwnerAgentId(params.baseConfig),
      ) ?? "",
    ).provider === provider
  );
}

export async function saveSetupCredential(params: {
  profile: ProviderAuthResult["profiles"][number];
  config: OpenClawConfig;
  baseConfig: OpenClawConfig;
  agentDir: string;
  modelRef: string;
  authChoice?: string;
  pluginId?: string;
  agentRuntimeId?: string;
  beforePersistentEffect?: () => void | Promise<void>;
  /** Retains the wizard auth owner's selected state directory and cancellation boundary. */
  persistAuthProfiles?: (profiles: ProviderAuthResult["profiles"]) => Promise<void>;
}): Promise<{ profile: ProviderAuthResult["profiles"][number]; config: OpenClawConfig }> {
  const replacement = isSetupCredentialReplacement({
    ...params,
    provider: params.profile.credential.provider,
  });
  const candidate = {
    ...params.profile,
    profileId: `${normalizeProviderId(params.profile.credential.provider)}:setup-${randomUUID()}`,
    credential: { ...params.profile.credential },
  };
  const prepared = applyProviderPluginAuthMethodResultConfig({
    config: params.config,
    result: { profiles: [candidate] },
  });
  const retryConfig = projectSetupInferenceConfig({
    base: {},
    prepared,
    modelRef: params.modelRef,
    agentId: resolveAmbientOwnerAgentId(params.baseConfig),
    profileId: candidate.profileId,
    credential: candidate.credential,
    pluginId: params.pluginId,
  });
  // A guided provider login can belong to a separately selected runtime plugin.
  // Retain its connection settings with the saved credential for a cold retry.
  const runtimePlugin = params.agentRuntimeId
    ? prepared.plugins?.entries?.[params.agentRuntimeId]
    : undefined;
  if (params.agentRuntimeId && runtimePlugin) {
    ((retryConfig.plugins ??= {}).entries ??= {})[params.agentRuntimeId] =
      structuredClone(runtimePlugin);
  }
  if (prepared.plugins?.installs) {
    (retryConfig.plugins ??= {}).installs = prepared.plugins.installs;
  }
  const providerConfig =
    retryConfig.models?.providers?.[parseInferenceRef(params.modelRef).provider];
  const apiKeyHeader = Boolean(providerConfig?.headers?.["api-key"]);
  if (apiKeyHeader && providerConfig?.headers) {
    delete providerConfig.headers["api-key"];
  }
  candidate.credential.setup = {
    replacement,
    modelRef: params.modelRef,
    configJson: JSON.stringify(retryConfig),
    authChoice: params.authChoice,
    pluginId: params.pluginId,
    agentRuntimeId: params.agentRuntimeId,
    ...(apiKeyHeader ? { apiKeyHeader: true as const } : {}),
  };
  await params.beforePersistentEffect?.();
  if (params.persistAuthProfiles) {
    await params.persistAuthProfiles([candidate]);
    const credential = loadAuthProfileStoreWithoutExternalProfiles(params.agentDir).profiles[
      candidate.profileId
    ];
    if (!credential) {
      throw new Error(
        "The saved setup credential could not be read. Check Model Setup before retrying.",
      );
    }
    return { profile: { ...candidate, credential }, config: prepared };
  }
  const profiles = await persistProviderAuthProfilesAfterLogin({
    profiles: [candidate],
    config: prepared,
    agentDir: params.agentDir,
  });
  return { profile: profiles[0]!, config: prepared };
}

async function stagePreparedCandidate(
  ctx: StageContext,
  params: {
    result: ProviderAuthResult;
    config: OpenClawConfig;
    credentialState: "new" | "saved";
    choice?: ProviderAuthChoiceMetadata;
    provider?: ProviderPlugin;
    pluginId?: string;
    modelRef?: string;
    modelTarget?: "utility";
    pendingPluginInstalls?: Record<string, PluginInstallRecord>;
    agentRuntimeId?: string;
  },
): Promise<StagedCandidate | StageFailure> {
  const modelTarget = params.choice?.modelTarget ?? params.modelTarget;
  const roleError = validateSetupModelTarget(modelTarget, ctx.params.modelTarget);
  if (roleError) {
    return roleError;
  }
  assertUtilitySeparation(ctx, modelTarget);
  const resolvedModel = resolveSetupModel({
    label: params.provider?.label ?? params.choice?.choiceLabel ?? "Custom provider",
    providerId:
      params.provider?.id ??
      params.choice?.providerId ??
      parseInferenceRef(params.result.defaultModel ?? "").provider,
    defaultModel: params.result.defaultModel,
    modelRef: params.modelRef ?? ctx.params.modelRef,
  });
  if (typeof resolvedModel !== "string") {
    return resolvedModel;
  }
  const ref = parseInferenceRef(resolvedModel);
  const normalizedModel = params.provider
    ?.normalizeModelId?.({ provider: ref.provider, modelId: ref.model })
    ?.trim();
  const modelRef = normalizedModel ? `${ref.provider}/${normalizedModel}` : resolvedModel;
  let profile = selectSetupCredential(params.result.profiles, modelRef, params.config);
  if (params.result.profiles.length > 0 && !profile) {
    return {
      error: `${params.provider?.label ?? ref.provider} did not return credentials for "${modelRef}".`,
    };
  }
  const pluginId = params.pluginId ?? params.choice?.pluginId ?? params.provider?.pluginId;
  let preparedConfig = params.config;
  if (profile && params.credentialState === "new") {
    const saved = await saveSetupCredential({
      profile,
      config: preparedConfig,
      baseConfig: ctx.cfg,
      modelRef,
      pluginId,
      authChoice: params.choice?.choiceId,
      agentRuntimeId: params.agentRuntimeId,
      agentDir: ctx.agentDir,
      beforePersistentEffect: () => {
        assertUtilitySeparation(ctx, modelTarget);
        return ctx.beforePersistentEffect("credential");
      },
    });
    ctx.credentialsSaved = true;
    profile = saved.profile;
    preparedConfig = saved.config;
  }
  const config = projectSetupInferenceConfig({
    base: ctx.cfg,
    prepared: preparedConfig,
    modelRef,
    sourceModelRef: resolvedModel,
    agentId: ctx.routeAgentId,
    profileId: profile?.profileId,
    credential: profile?.credential,
    pluginId,
  });
  return {
    modelRef,
    ...(modelTarget ? { modelTarget } : {}),
    config,
    agentRuntimeId:
      params.agentRuntimeId ??
      resolveModelRuntimePolicy({
        config,
        provider: ref.provider,
        modelId: parseInferenceRef(modelRef).model,
        agentId: ctx.routeAgentId,
      }).policy?.id ??
      "openclaw",
    authProfileId: profile?.profileId,
    pluginId,
    pendingPluginInstalls: params.pendingPluginInstalls,
  };
}

export async function stageSavedAuthCandidate(
  ctx: StageContext,
  profileId: string,
): Promise<StagedCandidate | StageFailure> {
  const store = loadAuthProfileStoreWithoutExternalProfiles(ctx.agentDir);
  const credential = store.profiles[profileId];
  if (!credential) {
    return {
      error: "That saved sign-in is no longer available. Open Model Setup and choose again.",
    };
  }
  const saved = credential.setup;
  const choices = (
    ctx.deps.resolveManifestProviderAuthChoices ?? resolveManifestProviderAuthChoices
  )({
    config: ctx.cfg,
    workspaceDir: ctx.workspace,
    includeUntrustedWorkspacePlugins: false,
    includeWorkspacePlugins: false,
  });
  const choice = saved?.authChoice
    ? choices.find(
        (entry) => entry.choiceId === saved.authChoice && entry.pluginId === saved.pluginId,
      )
    : choices.find((entry) => choiceMatchesCredential(entry, credential));
  if (saved?.authChoice && !choice) {
    return {
      error: "The saved sign-in's provider is no longer available. Review installed providers.",
    };
  }
  const roleError = validateSetupModelTarget(choice?.modelTarget, ctx.params.modelTarget);
  if (roleError) {
    return roleError;
  }
  assertUtilitySeparation(ctx, choice?.modelTarget);
  const materialize = async (
    loaded?: SetupProviderAuthMethod,
  ): Promise<StagedCandidate | StageFailure> => {
    if (!saved && !loaded) {
      return {
        error:
          "Choose this provider's endpoint and model again. Your saved sign-in is still available.",
      };
    }
    const modelRef = saved?.modelRef ?? loaded?.method.starterModel;
    const { validateConfigObjectRaw } = await import("../config/validation-core.js");
    const storedConfig = saved
      ? validateConfigObjectRaw(applyMergePatch(ctx.cfg, JSON.parse(saved.configJson)))
      : undefined;
    if (storedConfig && !storedConfig.ok) {
      return {
        error:
          "The saved connection settings are no longer valid. Choose the provider settings again.",
      };
    }
    const config = applyProviderPluginAuthMethodResultConfig({
      config: storedConfig?.ok ? storedConfig.config : (loaded?.config ?? ctx.cfg),
      result: { profiles: [{ profileId, credential }] },
    });
    if (saved?.apiKeyHeader && credential.type === "api_key") {
      const providerConfig = config.models?.providers?.[parseInferenceRef(saved.modelRef).provider];
      const key = credential.keyRef ?? credential.key;
      if (providerConfig && key) {
        (providerConfig.headers ??= {})["api-key"] = key;
      }
    }
    ctx.credentialsSaved = true;
    return await stagePreparedCandidate(ctx, {
      result: { profiles: [{ profileId, credential }], defaultModel: modelRef },
      config,
      credentialState: "saved",
      choice,
      provider: loaded?.provider,
      pluginId: saved?.pluginId,
      agentRuntimeId: saved?.agentRuntimeId,
      pendingPluginInstalls: config.plugins?.installs,
    });
  };
  return choice
    ? withSetupProviderAuthMethod({ ...ctx, choice, activation: ctx.params }, materialize)
    : materialize();
}

export async function stageProviderAutoCandidate(
  ctx: StageContext,
  choiceId: string,
): Promise<StagedCandidate | StageFailure> {
  const choice = (ctx.deps.resolveManifestProviderAuthChoice ?? resolveManifestProviderAuthChoice)(
    choiceId,
    {
      config: ctx.cfg,
      workspaceDir: ctx.workspace,
      includeUntrustedWorkspacePlugins: false,
      includeWorkspacePlugins: false,
    },
  );
  if (
    !choice ||
    choice.appGuidedDiscovery !== true ||
    !supportsSetupTextInference(choice.onboardingScopes)
  ) {
    return { error: "That detected provider is no longer available on this Gateway." };
  }
  const roleError = validateSetupModelTarget(choice.modelTarget, ctx.params.modelTarget);
  if (roleError) {
    return roleError;
  }
  assertUtilitySeparation(ctx, choice.modelTarget);
  return await withSetupProviderAuthMethod(
    { ...ctx, choice, activation: ctx.params },
    async (loaded) => {
      const guidedSetup = loaded.method.appGuidedSetup;
      const modelRef = ctx.params.modelRef?.trim();
      if (!guidedSetup || !modelRef) {
        return { error: "The detected provider model is missing. Run detection again." };
      }
      const prepared = await guidedSetup.prepare({
        config: loaded.config,
        env: process.env,
        workspaceDir: ctx.workspace,
        modelRef,
        ...(ctx.params.signal ? { signal: ctx.params.signal } : {}),
      });
      if (!prepared || normalizeAgentModelRefForConfig(prepared.defaultModel ?? "") !== modelRef) {
        return {
          error: `${choice.choiceLabel} could not prepare the detected model. Run detection again.`,
        };
      }
      return await stagePreparedCandidate(ctx, {
        result: prepared,
        config: applyProviderPluginAuthMethodResultConfig({
          config: loaded.config,
          result: prepared,
        }),
        choice,
        modelRef,
        credentialState: "new",
      });
    },
  );
}

export async function stageProviderAuthCandidate(
  ctx: StageContext,
  interactive: boolean,
  agentRuntimeId?: string,
): Promise<StagedCandidate | StageFailure> {
  const { params } = ctx;
  const apiKey = params.apiKey?.trim();
  if (!interactive && !apiKey) {
    return { error: "Enter an API key or token first." };
  }
  const authChoice = params.authChoice?.trim();
  if (interactive && authChoice === "custom-api-key") {
    const roleError = validateSetupModelTarget(undefined, params.modelTarget);
    if (roleError) {
      return roleError;
    }
    if (params.isRemoteProviderAuth ?? params.surface === "gateway") {
      return {
        error:
          "For a custom provider, run openclaw onboard --auth-choice custom-api-key on the Gateway host, then return here and refresh connections.",
      };
    }
    if (!params.prompter) {
      return { error: "Custom provider setup requires an interactive setup session." };
    }
    const { promptCustomApiConfig } = await import("../commands/onboard-custom.js");
    const prepared = await waitForProviderAuth(
      promptCustomApiConfig({
        config: ctx.cfg,
        runtime: params.runtime,
        prompter: params.prompter,
        target: { agentId: ctx.routeAgentId, agentDir: ctx.agentDir, workspaceDir: ctx.workspace },
        setAsPrimary: false,
        verification: "deferred",
      }),
      params.signal,
    );
    throwIfSetupInferenceCancelled(params);
    const { config, profiles } = prepareCustomSetupCredentials(prepared);
    return await stagePreparedCandidate(ctx, {
      result: { profiles, defaultModel: `${prepared.providerId}/${prepared.modelId}` },
      config,
      credentialState: "new",
      agentRuntimeId,
    });
  }
  const choice = authChoice
    ? (ctx.deps.resolveManifestProviderAuthChoice ?? resolveManifestProviderAuthChoice)(
        authChoice,
        {
          config: ctx.cfg,
          workspaceDir: ctx.workspace,
          includeUntrustedWorkspacePlugins: false,
          includeWorkspacePlugins: false,
        },
      )
    : undefined;
  const installEntry = authChoice
    ? resolveProviderInstallCatalogEntry(authChoice, {
        config: ctx.cfg,
        workspaceDir: ctx.workspace,
        includeUntrustedWorkspacePlugins: false,
      })
    : undefined;
  const managedWizardChoice = !choice
    ? installEntry && supportsSetupTextInference(installEntry.onboardingScopes)
      ? installEntry
      : undefined
    : supportsSetupTextInference(choice.onboardingScopes) &&
        (choice.appGuidedSecret === true ||
          (!choice.appGuidedAuth && choice.appGuidedDiscovery !== true))
      ? { pluginId: choice.pluginId, label: choice.groupLabel ?? choice.choiceLabel }
      : undefined;
  const roleError = validateSetupModelTarget(
    choice?.modelTarget ?? installEntry?.modelTarget,
    params.modelTarget,
  );
  if (roleError) {
    return roleError;
  }
  assertUtilitySeparation(ctx, choice?.modelTarget ?? installEntry?.modelTarget);
  if (interactive && authChoice && managedWizardChoice) {
    if (!params.prompter) {
      return { error: "Installing this provider requires an interactive setup session." };
    }
    return await prepareAuthChoiceLoadedPluginProvider(
      {
        authChoice,
        config: ctx.cfg,
        runtime: params.runtime,
        prompter: params.prompter,
        agentDir: ctx.agentDir,
        agentId: ctx.routeAgentId,
        workspaceDir: ctx.workspace,
        setDefaultModel: false,
        preserveExistingDefaultModel: true,
        signal: params.signal,
        isRemote: params.isRemoteProviderAuth ?? params.surface === "gateway",
        beforePersistentEffect: ctx.beforePersistentEffect,
      },
      async (prepared, provider) => {
        throwIfSetupInferenceCancelled(params);
        const selectedModel = prepared?.utilityModelOverride ?? prepared?.agentModelOverride;
        if (!prepared || prepared.retrySelection || !selectedModel?.trim()) {
          return {
            error:
              prepared?.installError ||
              `${managedWizardChoice.label} was not installed and configured. Review the installer details and try again.`,
          };
        }
        return await stagePreparedCandidate(ctx, {
          result: { profiles: prepared.authProfiles, defaultModel: selectedModel },
          ...(prepared.modelTarget ? { modelTarget: prepared.modelTarget } : {}),
          config: prepared.config,
          credentialState: "new",
          choice,
          provider,
          pendingPluginInstalls: prepared.pendingPluginInstalls,
          agentRuntimeId,
        });
      },
    );
  }
  const unavailable = interactive
    ? "That provider setup is not available on this Gateway."
    : "That key-based provider is not available on this Gateway.";
  if (
    !choice ||
    !supportsSetupTextInference(choice.onboardingScopes) ||
    (!interactive && !supportsSetupManualSecret(choice)) ||
    (interactive &&
      (choice.assistantVisibility === "manual-only" ||
        (!choice.appGuidedAuth && choice.appGuidedDiscovery !== true)))
  ) {
    return { error: unavailable };
  }
  return await withSetupProviderAuthMethod(
    { ...ctx, choice, activation: params },
    async (loaded) => {
      const { method } = loaded;
      if (
        interactive &&
        choice.appGuidedDiscovery !== true &&
        method.kind !== "oauth" &&
        method.kind !== "device_code"
      ) {
        return { error: unavailable };
      }
      try {
        if (interactive && !params.prompter) {
          return { error: "This provider login requires an interactive setup session." };
        }
        throwIfSetupInferenceCancelled(params);
        let result = await waitForProviderAuth(
          runProviderPluginAuthMethodUnpersisted({
            config: loaded.config,
            runtime: params.runtime,
            method,
            agentDir: ctx.agentDir,
            workspaceDir: ctx.workspace,
            prompter: params.prompter ?? createQuickstartNotePrompter(params.runtime),
            signal: params.signal,
            assertCurrent: () => throwIfSetupInferenceCancelled(params),
            isRemote: params.isRemoteProviderAuth ?? params.surface === "gateway",
            ...(!interactive
              ? {
                  secretInputMode: "plaintext" as const,
                  allowSecretRefPrompt: false,
                  opts: {
                    token: apiKey!,
                    tokenProvider: loaded.provider.id,
                    ...(choice.optionKey ? { [choice.optionKey]: apiKey } : {}),
                    ...(params.modelRef
                      ? { customModelId: parseInferenceRef(params.modelRef).model }
                      : {}),
                  },
                }
              : {}),
          }),
          params.signal,
        );
        throwIfSetupInferenceCancelled(params);
        let config = applyProviderPluginAuthMethodResultConfig({ config: loaded.config, result });
        if (interactive && choice.appGuidedDiscovery === true) {
          const guided = method.appGuidedSetup;
          if (!guided) {
            return { error: unavailable };
          }
          const selectedModel = params.modelRef?.trim() || result.defaultModel;
          const selected = selectedModel
            ? { modelRef: selectedModel }
            : await guided.detect({
                config,
                env: process.env,
                workspaceDir: ctx.workspace,
                signal: params.signal,
              });
          if (!selected) {
            return {
              error: `${loaded.provider.label} setup completed, but no compatible model was found. Add a compatible model and try again.`,
            };
          }
          const prepared = await guided.prepare({
            config,
            env: process.env,
            workspaceDir: ctx.workspace,
            modelRef: selected.modelRef,
            signal: params.signal,
          });
          if (
            !prepared ||
            normalizeAgentModelRefForConfig(prepared.defaultModel ?? "") !== selected.modelRef
          ) {
            return {
              error: `${loaded.provider.label} could not prepare its detected model. Try setup again.`,
            };
          }
          config = applyProviderPluginAuthMethodResultConfig({ config, result: prepared });
          result = {
            ...prepared,
            profiles: [
              ...new Map(
                [...result.profiles, ...prepared.profiles].map((profile) => [
                  profile.profileId,
                  profile,
                ]),
              ).values(),
            ],
          };
        }
        return await stagePreparedCandidate(ctx, {
          result,
          config,
          choice,
          credentialState: "new",
          ...(choice.appGuidedDiscovery ? {} : { provider: loaded.provider }),
          agentRuntimeId,
          pendingPluginInstalls: config.plugins?.installs,
        });
      } catch (error) {
        if (error instanceof SetupInferenceCancelledError || params.signal?.aborted) {
          return { error: "Provider login was cancelled." };
        }
        return {
          error: `${loaded.provider.label} could not prepare this ${interactive ? "login" : "credential"} for app-guided setup: ${formatErrorMessage(error)}`,
        };
      }
    },
  );
}
