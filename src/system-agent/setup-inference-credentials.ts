import { randomUUID } from "node:crypto";
import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import { buildAuthProfileId } from "../agents/auth-profiles/identity.js";
import { loadAuthProfileStoreWithoutExternalProfiles } from "../agents/auth-profiles/store-runtime.js";
import type { AuthProfileCredential } from "../agents/auth-profiles/types.js";
import {
  fingerprintAuthProfileCredential,
  fingerprintAuthProfileOwnerShape,
} from "../agents/execution-auth-binding.js";
import { resolveModelRuntimePolicy } from "../agents/model-runtime-policy.js";
import { resolveProviderIdForAuth } from "../agents/provider-auth-aliases.js";
import { normalizeAgentModelRefForConfig } from "../config/model-input.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { PluginInstallRecord } from "../config/types.plugins.js";
import { formatErrorMessage } from "../infra/errors.js";
import { enablePluginWithCapabilityConsent } from "../plugins/enable.js";
import { withPluginLifecycleLease } from "../plugins/plugin-lifecycle-lease.js";
import {
  applyProviderPluginAuthMethodResultConfig,
  prepareAuthChoiceLoadedPluginProvider,
} from "../plugins/provider-auth-choice.js";
import {
  type ProviderAuthChoiceMetadata,
  resolveManifestProviderAuthChoice,
  resolveManifestProviderAuthChoices,
} from "../plugins/provider-auth-choices.js";
import { buildApiKeyCredential } from "../plugins/provider-auth-helpers.js";
import { runProviderPluginAuthMethodUnpersisted } from "../plugins/provider-auth-method.js";
import { persistProviderAuthProfilesAfterLogin } from "../plugins/provider-auth-persistence.js";
import { resolveProviderInstallCatalogEntry } from "../plugins/provider-install-catalog.js";
import { resolvePluginProvidersCore } from "../plugins/providers.runtime.js";
import type { ProviderAuthMethod, ProviderAuthResult, ProviderPlugin } from "../plugins/types.js";
import { createPluginCapabilityConsentPrompter } from "../wizard/plugin-capability-consent.js";
import { createQuickstartNotePrompter } from "./setup-apply.js";
import {
  choiceMatchesCredential,
  supportsSetupManualSecret,
  supportsSetupTextInference,
} from "./setup-inference-auth-options.js";
import {
  type ActivateSetupInferenceParams,
  type ActivateSetupInferenceDeps,
  type StagedCandidate,
  type StageContext,
  type StageFailure,
  parseInferenceRef,
  resolveSetupModel,
  SetupInferenceCancelledError,
  throwIfSetupInferenceCancelled,
  waitForProviderAuth,
} from "./setup-inference-core.js";
import { projectSetupInferenceConfig } from "./setup-model-selection.js";

type SavedCandidate = {
  candidate: StagedCandidate;
  choice?: ProviderAuthChoiceMetadata;
  credentialFingerprint: string;
};
// This projection keeps provider preparation across retries. Credentials and their
// current identity remain owned by the auth store; no successful verdict is cached.
const savedCandidates = new Map<string, Map<string, SavedCandidate>>();

function credentialFingerprint(
  profileId: string,
  credential: AuthProfileCredential,
): string | undefined {
  return (
    fingerprintAuthProfileCredential({ profileId, credential }) ??
    fingerprintAuthProfileOwnerShape({ profileId, credential })
  );
}

export function forgetSavedSetupCandidate(agentDir: string, profileId: string): void {
  const candidates = savedCandidates.get(agentDir);
  candidates?.delete(profileId);
  if (candidates?.size === 0) {
    savedCandidates.delete(agentDir);
  }
}

export function currentSavedCandidate(
  agentDir: string,
  profileId: string,
  credential: AuthProfileCredential,
): SavedCandidate | undefined {
  const saved = savedCandidates.get(agentDir)?.get(profileId);
  if (saved && saved.credentialFingerprint !== credentialFingerprint(profileId, credential)) {
    forgetSavedSetupCandidate(agentDir, profileId);
    return undefined;
  }
  return saved;
}

export async function loadProviderAuthMethod(params: {
  cfg: OpenClawConfig;
  workspace: string;
  choice: ProviderAuthChoiceMetadata;
  deps: Pick<ActivateSetupInferenceDeps, "resolvePluginProviders">;
  activation?: ActivateSetupInferenceParams;
  beforePersistentEffect?: () => Promise<void>;
}): Promise<
  { config: OpenClawConfig; provider: ProviderPlugin; method: ProviderAuthMethod } | StageFailure
> {
  const activation = params.activation;
  return await withPluginLifecycleLease({ signal: params.activation?.signal }, async () => {
    const enabled = await enablePluginWithCapabilityConsent(params.cfg, params.choice.pluginId, {
      workspaceDir: params.workspace,
      beforePersistentEffect: params.beforePersistentEffect,
      onCapabilityConsent: activation?.prompter
        ? createPluginCapabilityConsentPrompter(activation.prompter, () =>
            throwIfSetupInferenceCancelled(activation),
          )
        : undefined,
    });
    if (!enabled.enabled) {
      return {
        error: `${params.choice.choiceLabel} is disabled (${enabled.reason ?? "blocked"}).`,
      };
    }
    const providers = (params.deps.resolvePluginProviders ?? resolvePluginProvidersCore)({
      config: enabled.config,
      workspaceDir: params.workspace,
      mode: "setup",
      includeUntrustedWorkspacePlugins: false,
      onlyPluginIds: [params.choice.pluginId],
    });
    const provider = providers.find(
      (entry) =>
        entry.pluginId === params.choice.pluginId &&
        normalizeProviderId(entry.id) === normalizeProviderId(params.choice.providerId),
    );
    const method = provider?.auth.find((entry) => entry.id === params.choice.methodId);
    if (!provider || !method || !supportsSetupTextInference(method.wizard?.onboardingScopes)) {
      return { error: "That provider setup is not available on this Gateway." };
    }
    return { config: enabled.config, provider, method };
  });
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

export async function saveSetupCredential(params: {
  profile: ProviderAuthResult["profiles"][number];
  config: OpenClawConfig;
  agentDir: string;
  beforePersistentEffect?: () => void | Promise<void>;
  /** Retains the wizard auth owner's selected state directory and cancellation boundary. */
  persistAuthProfiles?: (profiles: ProviderAuthResult["profiles"]) => Promise<void>;
}): Promise<{ profile: ProviderAuthResult["profiles"][number]; config: OpenClawConfig }> {
  const candidate = {
    ...params.profile,
    profileId: `${normalizeProviderId(params.profile.credential.provider)}:setup-${randomUUID()}`,
  };
  const prepared = applyProviderPluginAuthMethodResultConfig({
    config: params.config,
    result: { profiles: [candidate] },
  });
  await params.beforePersistentEffect?.();
  if (params.persistAuthProfiles) {
    await params.persistAuthProfiles([candidate]);
    return { profile: candidate, config: prepared };
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
    pendingPluginInstalls?: Record<string, PluginInstallRecord>;
  },
): Promise<StagedCandidate | StageFailure> {
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
  let preparedConfig = params.config;
  if (profile && params.credentialState === "new") {
    const saved = await saveSetupCredential({
      profile,
      config: preparedConfig,
      agentDir: ctx.agentDir,
      beforePersistentEffect: () => ctx.beforePersistentEffect("credential"),
    });
    ctx.credentialsSaved = true;
    profile = saved.profile;
    preparedConfig = saved.config;
  }
  const pluginId = params.pluginId ?? params.choice?.pluginId ?? params.provider?.pluginId;
  const projection = {
    base: ctx.cfg,
    prepared: preparedConfig,
    modelRef,
    sourceModelRef: resolvedModel,
    agentId: ctx.routeAgentId,
    profileId: profile?.profileId,
    credential: profile?.credential,
    pluginId,
  };
  const config = projectSetupInferenceConfig(projection);
  const candidate: StagedCandidate = {
    modelRef,
    config,
    agentRuntimeId:
      resolveModelRuntimePolicy({
        config,
        provider: ref.provider,
        modelId: parseInferenceRef(modelRef).model,
        agentId: ctx.routeAgentId,
      }).policy?.id ?? "openclaw",
    authProfileId: profile?.profileId,
    pluginId,
    pendingPluginInstalls: params.pendingPluginInstalls,
  };
  if (profile) {
    const fingerprint = credentialFingerprint(profile.profileId, profile.credential);
    if (fingerprint) {
      let candidates = savedCandidates.get(ctx.agentDir);
      if (!candidates) {
        candidates = new Map();
        savedCandidates.set(ctx.agentDir, candidates);
      }
      candidates.set(profile.profileId, {
        candidate: {
          ...candidate,
          config: projectSetupInferenceConfig({ ...projection, base: {} }),
        },
        choice: params.choice,
        credentialFingerprint: fingerprint,
      });
    }
  }
  return candidate;
}

export async function stageSavedAuthCandidate(
  ctx: StageContext,
  profileId: string,
): Promise<StagedCandidate | StageFailure> {
  const store = loadAuthProfileStoreWithoutExternalProfiles(ctx.agentDir);
  const credential = store.profiles[profileId];
  if (!credential) {
    forgetSavedSetupCandidate(ctx.agentDir, profileId);
    return {
      error: "That saved sign-in is no longer available. Open Model Setup and choose again.",
    };
  }
  const saved = currentSavedCandidate(ctx.agentDir, profileId, credential);
  const savedChoice = saved?.choice;
  const choices = (
    ctx.deps.resolveManifestProviderAuthChoices ?? resolveManifestProviderAuthChoices
  )({
    config: ctx.cfg,
    workspaceDir: ctx.workspace,
    includeUntrustedWorkspacePlugins: false,
    includeWorkspacePlugins: false,
  });
  const choice = savedChoice
    ? choices.find(
        (entry) =>
          entry.choiceId === savedChoice.choiceId && entry.pluginId === savedChoice.pluginId,
      )
    : choices.find((entry) => choiceMatchesCredential(entry, credential));
  if (saved?.choice && !choice) {
    return {
      error: "The saved sign-in's provider is no longer available. Review installed providers.",
    };
  }
  const loaded = choice
    ? await loadProviderAuthMethod({ ...ctx, choice, activation: ctx.params })
    : undefined;
  if (loaded && "error" in loaded) {
    return loaded;
  }
  if (!saved && !loaded) {
    return {
      error:
        "Choose this provider's endpoint and model again. Your saved sign-in is still available.",
    };
  }
  const modelRef = saved?.candidate.modelRef ?? loaded?.method.starterModel;
  const config = applyProviderPluginAuthMethodResultConfig({
    config: saved?.candidate.config ?? loaded?.config ?? ctx.cfg,
    result: { profiles: [{ profileId, credential }] },
  });
  ctx.credentialsSaved = true;
  return await stagePreparedCandidate(ctx, {
    result: { profiles: [{ profileId, credential }], defaultModel: modelRef },
    config,
    credentialState: "saved",
    choice,
    provider: loaded?.provider,
    pluginId: saved?.candidate.pluginId,
    pendingPluginInstalls: saved?.candidate.pendingPluginInstalls,
  });
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
  const loaded = await loadProviderAuthMethod({ ...ctx, choice, activation: ctx.params });
  if ("error" in loaded) {
    return loaded;
  }
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
  const config = applyProviderPluginAuthMethodResultConfig({
    config: loaded.config,
    result: prepared,
  });
  return await stagePreparedCandidate(ctx, {
    result: prepared,
    config,
    choice,
    modelRef,
    credentialState: "new",
  });
}

export async function stageProviderAuthCandidate(
  ctx: StageContext,
  interactive: boolean,
): Promise<StagedCandidate | StageFailure> {
  const { params } = ctx;
  const apiKey = params.apiKey?.trim();
  if (!interactive && !apiKey) {
    return { error: "Enter an API key or token first." };
  }
  const authChoice = params.authChoice?.trim();
  if (interactive && authChoice === "custom-api-key") {
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
    const provider = prepared.config.models?.providers?.[prepared.providerId];
    const key = provider?.apiKey;
    const profiles: ProviderAuthResult["profiles"] = key
      ? [
          {
            profileId: buildAuthProfileId({ providerId: prepared.providerId }),
            credential: buildApiKeyCredential(prepared.providerId, key, undefined, {
              config: prepared.config,
              secretInputMode: "plaintext",
            }),
          },
        ]
      : [];
    const profile = profiles[0];
    if (
      provider?.headers?.["api-key"] &&
      profile?.credential.type === "api_key" &&
      profile.credential.key
    ) {
      profile.secretStorage = { kind: "store", namePrefix: "CUSTOM_API_KEY" };
    }
    if (provider) {
      delete provider.apiKey;
    }
    const config = applyProviderPluginAuthMethodResultConfig({
      config: prepared.config,
      result: { profiles },
    });
    return await stagePreparedCandidate(ctx, {
      result: { profiles, defaultModel: `${prepared.providerId}/${prepared.modelId}` },
      config,
      credentialState: "new",
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
  if (interactive && authChoice && managedWizardChoice) {
    if (!params.prompter) {
      return { error: "Installing this provider requires an interactive setup session." };
    }
    const prepared = await prepareAuthChoiceLoadedPluginProvider({
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
    });
    throwIfSetupInferenceCancelled(params);
    if (!prepared || prepared.retrySelection || !prepared.agentModelOverride?.trim()) {
      return {
        error:
          prepared?.installError ||
          `${managedWizardChoice.label} was not installed and configured. Review the installer details and try again.`,
      };
    }
    return await stagePreparedCandidate(ctx, {
      result: { profiles: prepared.authProfiles, defaultModel: prepared.agentModelOverride },
      config: prepared.config,
      credentialState: "new",
      choice,
      provider: prepared.provider,
      pendingPluginInstalls: prepared.pendingPluginInstalls,
    });
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
  const loaded = await loadProviderAuthMethod({ ...ctx, choice, activation: params });
  if ("error" in loaded) {
    return loaded;
  }
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
    });
  } catch (error) {
    if (error instanceof SetupInferenceCancelledError || params.signal?.aborted) {
      return { error: "Provider login was cancelled." };
    }
    return {
      error: `${loaded.provider.label} could not prepare this ${interactive ? "login" : "credential"} for app-guided setup: ${formatErrorMessage(error)}`,
    };
  }
}
