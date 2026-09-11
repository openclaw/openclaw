/** Commands for adding, pasting, and logging into provider model auth profiles. */
import {
  cancel,
  confirm as clackConfirm,
  isCancel,
  password as clackPassword,
  select as clackSelect,
  text as clackText,
} from "@clack/prompts";
import { readByteStreamWithLimit } from "@openclaw/media-core/read-byte-stream-with-limit";
import { expectDefined } from "@openclaw/normalization-core";
import { resolveExpiresAtMsFromDurationMs } from "@openclaw/normalization-core/number-coercion";
import {
  normalizeOptionalString,
  normalizeStringifiedOptionalString,
} from "@openclaw/normalization-core/string-coerce";
import { styleSelectParams } from "../../../packages/terminal-core/src/prompt-select-styled-params.js";
import { stylePromptMessage } from "../../../packages/terminal-core/src/prompt-style.js";
import { resolveAgentWorkspaceDir } from "../../agents/agent-scope.js";
import { removeProviderAuthProfilesWithLock } from "../../agents/auth-profiles.js";
import {
  promoteAuthProfileInOrder,
  upsertAuthProfileWithLockOrThrow,
} from "../../agents/auth-profiles/profiles.js";
import type { AuthProfileCredential } from "../../agents/auth-profiles/types.js";
import { normalizeProviderId } from "../../agents/model-ref-shared.js";
import { isCliProvider } from "../../agents/model-selection-cli.js";
import { resolveProviderIdForAuth } from "../../agents/provider-auth-aliases.js";
import { resolveDefaultAgentWorkspaceDir } from "../../agents/workspace.js";
import { formatCliCommand } from "../../cli/command-format.js";
import { parseDurationMs } from "../../cli/parse-duration.js";
import { logConfigUpdated } from "../../config/logging.js";
import {
  applyMergePatch,
  createMergePatch,
  mergePatchConflicts,
} from "../../config/merge-patch.js";
import { normalizeAgentModelRefForConfig } from "../../config/model-input.js";
import type { ConfigFileSnapshot, OpenClawConfig } from "../../config/types.openclaw.js";
import {
  applyDefaultModel,
  applyProviderAuthConfigPatch,
  pickAuthMethod,
  restorePriorAgentsDefaultsModelUnlessOptIn,
  resolveProviderMatch,
} from "../../plugins/provider-auth-choice-helpers.js";
import { applyAuthProfileConfig } from "../../plugins/provider-auth-helpers.js";
import { runProviderPluginAuthMethodUnpersisted } from "../../plugins/provider-auth-method.js";
import { persistProviderAuthProfilesAfterLogin } from "../../plugins/provider-auth-persistence.js";
import type { ProviderAuthContext } from "../../plugins/provider-authentication.types.js";
import { resolvePluginProvidersCore } from "../../plugins/providers.runtime.js";
import {
  resolvePluginSetupProviderCore,
  resolvePluginSetupRegistry,
} from "../../plugins/setup-registry.js";
import type {
  ProviderAuthMethod,
  ProviderAuthResult,
  ProviderPlugin,
} from "../../plugins/types.js";
import type { RuntimeEnv } from "../../runtime.js";
import {
  ProviderAuthConfigApplyError,
  ProviderCredentialsSavedError,
} from "../../shared/provider-auth-result.js";
import { isRecord } from "../../utils.js";
import { normalizeSecretInput } from "../../utils/normalize-secret-input.js";
import { createClackPrompter } from "../../wizard/clack-prompter.js";
import type { WizardPrompter } from "../../wizard/prompts.js";
import { validateAnthropicSetupToken } from "../auth-token.js";
import { repairCodexRuntimePluginInstallForModelSelection } from "../codex-runtime-plugin-install.js";
import { repairCopilotRuntimePluginInstallForModelSelection } from "../copilot-runtime-plugin-install.js";
import { saveModelProviderApiKey } from "./auth-api-key.js";
import { tryImportProviderCredential } from "./auth-credential-import.js";
import {
  looksLikeOpenAIApiKey,
  normalizeManualAuthProvider,
  resolveDefaultTokenProfileId,
  validateOpenAICodexApiKeyInput,
} from "./auth-manual-input.js";
import {
  applyProviderLoginDefaultModel,
  completeProviderModelAccess,
  prepareProviderModelAccess,
  withoutProviderModelPolicy,
  type PreparedProviderModelAccess,
} from "./auth-model-policy.js";
import { refreshRunningGatewayAuthState, type ModelAuthRefreshOutcome } from "./auth-refresh.js";
import {
  loadValidConfigSnapshotOrThrow,
  resolveModelsTargetAgent,
  updateConfig,
} from "./shared.js";

function resolveManualTokenExpiryMs(expiresIn: string | undefined): number | undefined {
  const normalizedExpiresIn = normalizeStringifiedOptionalString(expiresIn);
  if (!normalizedExpiresIn) {
    return undefined;
  }
  const durationMs = parseDurationMs(normalizedExpiresIn, { defaultUnit: "d" });
  const expires = resolveExpiresAtMsFromDurationMs(durationMs);
  if (expires === undefined) {
    throw new Error("Invalid expiry duration: resulting token expiry is outside Date range.");
  }
  return expires;
}

function guardCancel<T>(value: T | symbol): T {
  if (typeof value === "symbol" || isCancel(value)) {
    cancel("Cancelled.");
    process.exit(0);
  }
  return value;
}

const confirm = async (params: Parameters<typeof clackConfirm>[0]) =>
  guardCancel(
    await clackConfirm({
      ...params,
      message: stylePromptMessage(params.message),
    }),
  );
const text = async (params: Parameters<typeof clackText>[0]) =>
  guardCancel(
    await clackText({
      ...params,
      message: stylePromptMessage(params.message),
    }),
  );
const password = async (params: Parameters<typeof clackPassword>[0]) =>
  guardCancel(
    await clackPassword({
      ...params,
      message: stylePromptMessage(params.message),
    }),
  );
const select = async <T>(params: Parameters<typeof clackSelect<T>>[0]) =>
  guardCancel(await clackSelect(styleSelectParams(params)));

const MODELS_AUTH_STDIN_MAX_BYTES = 1024 * 1024;

async function readPipedStdin(): Promise<string> {
  const bytes = await readByteStreamWithLimit(process.stdin, {
    maxBytes: MODELS_AUTH_STDIN_MAX_BYTES,
    onOverflow: ({ maxBytes }) => new Error(`Piped auth input exceeds ${maxBytes} bytes.`),
  });
  return bytes.toString("utf8");
}

async function readPastedSecret(params: {
  message: string;
  masked: boolean;
  validate?: (value: string | undefined) => string | undefined;
}): Promise<string> {
  const promptParams = { message: params.message, validate: params.validate };
  const input = process.stdin.isTTY
    ? await (params.masked ? password(promptParams) : text(promptParams))
    : await readPipedStdin();
  const normalized = normalizeSecretInput(input);
  const validationMessage = params.validate?.(normalized);
  if (validationMessage) {
    throw new Error(validationMessage);
  }
  return normalized;
}

function isOpenAIProvider(provider: string): boolean {
  return normalizeManualAuthProvider(provider) === "openai";
}

type ResolvedModelsAuthContext = {
  config: OpenClawConfig;
  configSnapshot: ConfigFileSnapshot;
  agentId: string;
  agentDir: string;
  workspaceDir: string;
  providers: ProviderPlugin[];
};

function listProvidersWithAuthMethods(providers: ProviderPlugin[]): ProviderPlugin[] {
  return providers.filter((provider) => provider.auth.length > 0);
}

function listTokenAuthMethods(provider: ProviderPlugin): ProviderAuthMethod[] {
  return provider.auth.filter((method) => method.kind === "token");
}

function listProvidersWithTokenMethods(providers: ProviderPlugin[]): ProviderPlugin[] {
  return providers.filter((provider) => listTokenAuthMethods(provider).length > 0);
}

function mergeSetupProviders(
  providers: readonly ProviderPlugin[],
  setupProviders: readonly ProviderPlugin[],
): ProviderPlugin[] {
  if (setupProviders.length === 0) {
    return [...providers];
  }
  const setupById = new Map(
    setupProviders.map((provider) => [normalizeProviderId(provider.id), provider] as const),
  );
  const merged = providers.map(
    (provider) => setupById.get(normalizeProviderId(provider.id)) ?? provider,
  );
  const existing = new Set(merged.map((provider) => normalizeProviderId(provider.id)));
  for (const provider of setupProviders) {
    if (!existing.has(normalizeProviderId(provider.id))) {
      merged.push(provider);
    }
  }
  return merged;
}

function preferSetupAuthProviders(params: {
  providers: readonly ProviderPlugin[];
  config: OpenClawConfig;
  workspaceDir: string;
  requestedProvider?: string;
  ownerPluginId?: string;
}): ProviderPlugin[] {
  if (params.ownerPluginId) {
    return mergeSetupProviders(
      params.providers,
      resolvePluginSetupRegistry({
        config: params.config,
        workspaceDir: params.workspaceDir,
        pluginIds: [params.ownerPluginId],
      }).providers.map((entry) => entry.provider),
    );
  }
  const requestedProvider = params.requestedProvider
    ? normalizeManualAuthProvider(params.requestedProvider)
    : undefined;
  if (requestedProvider) {
    const setupProvider = resolvePluginSetupProviderCore({
      provider: requestedProvider,
      config: params.config,
      workspaceDir: params.workspaceDir,
    });
    return setupProvider ? [setupProvider] : [...params.providers];
  }

  const setupProviders = resolvePluginSetupRegistry({
    config: params.config,
    workspaceDir: params.workspaceDir,
  }).providers.map((entry) => entry.provider);
  return mergeSetupProviders(params.providers, setupProviders);
}

async function resolveModelsAuthContext(params?: {
  requestedProvider?: string;
  rawAgentId?: string | null;
  config?: OpenClawConfig;
  ownerPluginId?: string;
}): Promise<ResolvedModelsAuthContext> {
  const configSnapshot = await loadValidConfigSnapshotOrThrow();
  const config = params?.config ?? configSnapshot.runtimeConfig;
  const { agentId, agentDir } = await resolveModelsAuthAgent(params?.rawAgentId, config);
  const workspaceDir =
    resolveAgentWorkspaceDir(config, agentId) ?? resolveDefaultAgentWorkspaceDir();
  const requestedProvider = params?.requestedProvider?.trim();
  const providerRef = requestedProvider
    ? normalizeManualAuthProvider(requestedProvider)
    : undefined;
  // Auth setup also runs inside the Gateway; discovery must not replace its live registry.
  const providers = resolvePluginProvidersCore({
    config,
    workspaceDir,
    mode: "setup",
    includeUntrustedWorkspacePlugins: false,
    ...(params?.ownerPluginId ? { onlyPluginIds: [params.ownerPluginId] } : {}),
    ...(providerRef ? { providerRefs: [providerRef] } : {}),
  });
  const authProviders = preferSetupAuthProviders({
    providers,
    config,
    workspaceDir,
    requestedProvider: providerRef,
    ownerPluginId: params?.ownerPluginId,
  });
  return {
    config,
    configSnapshot,
    agentId,
    agentDir,
    workspaceDir,
    providers: authProviders,
  };
}

async function resolveModelsAuthAgent(rawAgentId?: string | null, config?: OpenClawConfig) {
  const cfg = config ?? (await loadValidConfigSnapshotOrThrow()).runtimeConfig;
  return resolveModelsTargetAgent(cfg, rawAgentId ?? undefined, { kind: "mutation" });
}

function resolveRequestedProviderOrThrow(
  providers: ProviderPlugin[],
  rawProvider?: string,
): ProviderPlugin | null {
  const requested = rawProvider?.trim();
  if (!requested) {
    return null;
  }
  const matched = resolveProviderMatch(providers, requested);
  if (matched) {
    return matched;
  }
  const available = providers
    .map((provider) => provider.id)
    .filter(Boolean)
    .toSorted((a, b) => a.localeCompare(b));
  const availableText = available.length > 0 ? available.join(", ") : "(none)";
  throw new Error(
    `Unknown provider "${requested}". Loaded providers: ${availableText}. Verify plugins via \`${formatCliCommand("openclaw plugins list --json")}\`.`,
  );
}

function resolveTokenMethodOrThrow(
  provider: ProviderPlugin,
  rawMethod?: string,
): ProviderAuthMethod | null {
  const tokenMethods = listTokenAuthMethods(provider);
  if (rawMethod?.trim()) {
    const matched = pickAuthMethod(provider, rawMethod);
    if (matched && matched.kind === "token") {
      return matched;
    }
    const available = tokenMethods.map((method) => method.id).join(", ") || "(none)";
    throw new Error(
      `Unknown token auth method "${rawMethod}" for provider "${provider.id}". Available token methods: ${available}.`,
    );
  }
  return null;
}

async function pickProviderAuthMethod(params: {
  provider: ProviderPlugin;
  requestedMethod?: string;
  prompter: WizardPrompter;
}) {
  const rawRequestedMethod = params.requestedMethod?.trim();
  if (rawRequestedMethod) {
    return pickAuthMethod(params.provider, rawRequestedMethod);
  }
  const oauthMethod = params.provider.auth.find((method) => method.kind === "oauth");
  if (oauthMethod) {
    return oauthMethod;
  }
  if (params.provider.auth.length === 1) {
    return params.provider.auth[0] ?? null;
  }
  return await params.prompter
    .select({
      message: `Auth method for ${params.provider.label}`,
      options: params.provider.auth.map((method) => ({
        value: method.id,
        label: method.label,
        hint: method.hint,
      })),
    })
    .then((id) => params.provider.auth.find((method) => method.id === id) ?? null);
}

async function pickProviderTokenMethod(params: {
  provider: ProviderPlugin;
  requestedMethod?: string;
  prompter: WizardPrompter;
}) {
  const explicitTokenMethod = resolveTokenMethodOrThrow(params.provider, params.requestedMethod);
  if (explicitTokenMethod) {
    return explicitTokenMethod;
  }
  const tokenMethods = listTokenAuthMethods(params.provider);
  if (tokenMethods.length === 0) {
    return null;
  }
  const setupTokenMethod = tokenMethods.find((method) => method.id === "setup-token");
  if (setupTokenMethod) {
    return setupTokenMethod;
  }
  if (tokenMethods.length === 1) {
    return tokenMethods[0] ?? null;
  }
  return await params.prompter
    .select({
      message: `Token method for ${params.provider.label}`,
      options: tokenMethods.map((method) => ({
        value: method.id,
        label: method.label,
        hint: method.hint,
      })),
    })
    .then((id) => tokenMethods.find((method) => method.id === id) ?? null);
}

async function persistProviderAuthResult(params: {
  result: ProviderAuthResult;
  profiles?: ProviderAuthResult["profiles"];
  config: OpenClawConfig;
  configSnapshot: ConfigFileSnapshot;
  agentId: string;
  agentDir: string;
  runtime: RuntimeEnv;
  prompter: WizardPrompter;
  setDefault?: boolean;
  env?: NodeJS.ProcessEnv;
  beforePersistentEffect?: () => void | Promise<void>;
  assertCurrent?: () => void;
  refreshAfterLogin?: ModelsAuthLoginFlowOptions["refreshAfterLogin"];
}): Promise<{ profiles: ProviderAuthResult["profiles"]; authRefresh: ModelAuthRefreshOutcome }> {
  const defaultModel = params.result.defaultModel
    ? normalizeAgentModelRefForConfig(params.result.defaultModel)
    : undefined;
  const profiles = params.profiles ?? params.result.profiles;
  const persistedProfiles: ProviderAuthResult["profiles"] = [];
  const patchOptions = { mergeObjectArraysById: true };
  // Match source and runtime rows using the config owner's canonical model identities.
  const loginConfig = applyProviderAuthConfigPatch(params.config, {});
  const sourceConfig = applyProviderAuthConfigPatch(params.configSnapshot.sourceConfig, {});
  const runtimeConfig = applyProviderAuthConfigPatch(params.configSnapshot.runtimeConfig, {});
  const configPatch = params.result.configPatch
    ? createMergePatch(
        loginConfig,
        restorePriorAgentsDefaultsModelUnlessOptIn({
          cfg: applyProviderAuthConfigPatch(
            loginConfig,
            profiles.length > 0
              ? withoutProviderModelPolicy(params.result.configPatch, loginConfig)
              : params.result.configPatch,
            {
              replaceDefaultModels: params.result.replaceDefaultModels,
            },
          ),
          priorAgentsDefaultsModel: loginConfig.agents?.defaults?.model,
          setDefault: params.setDefault,
        }),
        patchOptions,
      )
    : undefined;
  const shouldUpdateConfig =
    (isRecord(configPatch) && Object.keys(configPatch).length > 0) ||
    Boolean(params.setDefault && defaultModel);
  if (profiles.length > 0 || shouldUpdateConfig) {
    await params.beforePersistentEffect?.();
  }

  try {
    for (const candidate of profiles) {
      const persisted = await persistProviderAuthProfilesAfterLogin({
        profiles: [candidate],
        beforeWrite: params.assertCurrent,
        config: params.config,
        env: params.env,
        agentDir: params.agentDir,
        ...(params.env?.OPENCLAW_STATE_DIR ? { stateDir: params.env.OPENCLAW_STATE_DIR } : {}),
      });
      const profile = expectDefined(persisted[0], "persisted auth profile");
      persistedProfiles.push(profile);
      params.assertCurrent?.();
      await promotePersistedAuthProfile({
        config: params.config,
        agentDir: params.agentDir,
        provider: profile.credential.provider,
        profileId: profile.profileId,
      });
    }

    // Replay only the login's changes; the writer may have newer unrelated settings.
    if (shouldUpdateConfig) {
      const updated = await updateConfig(
        (cfg) => {
          params.assertCurrent?.();
          const priorAgentsDefaultsModel = cfg.agents?.defaults?.model;
          let next = applyProviderAuthConfigPatch(cfg, {});
          if (configPatch) {
            if (
              (mergePatchConflicts(loginConfig, runtimeConfig, configPatch, patchOptions) &&
                mergePatchConflicts(loginConfig, sourceConfig, configPatch, patchOptions)) ||
              mergePatchConflicts(sourceConfig, next, configPatch, patchOptions)
            ) {
              throw new Error(
                "Provider settings changed during sign-in. Review the current settings and retry.",
              );
            }
            // SAFETY: The patch derives from typed config; updateConfig validates the merged value before writing.
            next = applyMergePatch(next, configPatch, patchOptions) as OpenClawConfig;
          }
          next = restorePriorAgentsDefaultsModelUnlessOptIn({
            cfg: next,
            priorAgentsDefaultsModel,
            setDefault: params.setDefault,
          });
          if (params.setDefault && defaultModel) {
            next =
              profiles.length > 0
                ? applyProviderLoginDefaultModel(next, defaultModel)
                : applyDefaultModel(next, defaultModel);
          }
          return next;
        },
        undefined,
        params.assertCurrent,
      ).catch((error: unknown) => {
        if (persistedProfiles.length === 0) {
          throw error;
        }
        throw new ProviderAuthConfigApplyError(error);
      });
      if (defaultModel) {
        const repaired = await repairCodexRuntimePluginInstallForModelSelection({
          cfg: updated,
          model: defaultModel,
        });
        const copilotRepaired = await repairCopilotRuntimePluginInstallForModelSelection({
          cfg: updated,
          model: defaultModel,
        });
        for (const warning of [...repaired.warnings, ...copilotRepaired.warnings]) {
          params.runtime.error?.(warning);
        }
      }
      logConfigUpdated(params.runtime);
    }

    let authRefresh: ModelAuthRefreshOutcome;
    if (params.refreshAfterLogin) {
      await params.refreshAfterLogin(params.agentId);
      authRefresh = "refreshed";
    } else {
      authRefresh = await refreshRunningGatewayAuthState(params.agentId, "login", params.runtime);
    }

    for (const profile of persistedProfiles) {
      params.runtime.log(
        `Auth profile: ${profile.profileId} (${profile.credential.provider}/${credentialMode(profile.credential)})`,
      );
    }
    if (defaultModel) {
      params.runtime.log(
        params.setDefault
          ? `Default model set to ${defaultModel}`
          : `Default model available: ${defaultModel} (current default unchanged; run ${formatCliCommand(`openclaw models set ${defaultModel}`)} to apply)`,
      );
    }
    if (params.result.notes && params.result.notes.length > 0) {
      await params.prompter.note(params.result.notes.join("\n"), "Provider notes");
    }
    return { profiles: persistedProfiles, authRefresh };
  } catch (error) {
    if (persistedProfiles.length > 0 && !(error instanceof ProviderCredentialsSavedError)) {
      throw new ProviderCredentialsSavedError(
        error instanceof Error
          ? `Provider credentials were saved, but sign-in did not finish: ${error.message}`
          : "Provider credentials were saved, but sign-in did not finish.",
        { cause: error },
      );
    }
    throw error;
  }
}

function resolveConfiguredAuthSelectionForProvider(
  cfg: OpenClawConfig,
  provider: string,
): { createIfMissing: boolean; order?: string[] } {
  const providerAuthKey = resolveProviderIdForAuth(provider, { config: cfg });
  for (const [orderProvider, profileIds] of Object.entries(cfg.auth?.order ?? {})) {
    if (
      profileIds.length > 0 &&
      resolveProviderIdForAuth(orderProvider, { config: cfg }) === providerAuthKey
    ) {
      return { createIfMissing: true, order: profileIds };
    }
  }
  const profileIds = Object.entries(cfg.auth?.profiles ?? {})
    .filter(
      ([, profile]) =>
        resolveProviderIdForAuth(profile.provider, { config: cfg, storedCredential: true }) ===
        providerAuthKey,
    )
    .map(([profileId]) => profileId);
  return profileIds.length > 0
    ? { createIfMissing: true, order: profileIds }
    : { createIfMissing: false };
}

async function promotePersistedAuthProfile(params: {
  config: OpenClawConfig;
  agentDir: string;
  provider: string;
  profileId: string;
}): Promise<void> {
  const selection = resolveConfiguredAuthSelectionForProvider(params.config, params.provider);
  const promotion = await promoteAuthProfileInOrder({
    agentDir: params.agentDir,
    provider: params.provider,
    profileId: params.profileId,
    createIfMissing: selection.createIfMissing,
    ...(selection.order ? { createFromOrder: selection.order } : {}),
  });
  if (!promotion.ok) {
    throw new ProviderCredentialsSavedError(
      "The auth profile was saved, but its order could not be updated because the auth store is busy. Wait a moment, then retry the login.",
    );
  }
}

async function runProviderAuthMethod(params: {
  config: OpenClawConfig;
  configSnapshot: ConfigFileSnapshot;
  agentId: string;
  agentDir: string;
  workspaceDir: string;
  provider: ProviderPlugin;
  method: ProviderAuthMethod;
  runtime: RuntimeEnv;
  prompter: WizardPrompter;
  profileId?: string;
  setDefault?: boolean;
  credentialOnly?: boolean;
  assertCurrent?: () => void;
  env?: NodeJS.ProcessEnv;
  isRemote?: boolean;
  signal?: AbortSignal;
  openUrl?: (url: string) => Promise<void>;
  browserAuthorization?: ProviderAuthContext["oauth"]["authorize"];
  beforePersistentEffect?: () => void | Promise<void>;
  refreshAfterLogin?: ModelsAuthLoginFlowOptions["refreshAfterLogin"];
  onModelAccessRequested?: (request: PreparedProviderModelAccess) => void;
}): Promise<{
  result: ProviderAuthResult;
  profiles: ProviderAuthResult["profiles"];
  authRefresh: ModelAuthRefreshOutcome;
}> {
  params.signal?.throwIfAborted();
  params.assertCurrent?.();
  const modelAccess = prepareProviderModelAccess({
    config: params.config,
    agentId: params.agentId,
    provider: params.provider.id,
    providerLabel: params.provider.label,
  });
  const result = await runProviderPluginAuthMethodUnpersisted({
    method: params.method,
    config: params.config,
    credentialOnly: params.credentialOnly,
    assertCurrent: params.assertCurrent,
    env: params.env ?? process.env,
    agentDir: params.agentDir,
    workspaceDir: params.workspaceDir,
    prompter: params.prompter,
    runtime: params.runtime,
    allowSecretRefPrompt: false,
    isRemote: params.isRemote,
    signal: params.signal,
    openUrl: params.openUrl,
    browserAuthorization: params.browserAuthorization,
  });
  params.signal?.throwIfAborted();
  const connectionResult = params.credentialOnly
    ? {
        profiles: result.profiles,
        notes: result.notes,
        ...(result.configPatch
          ? {
              configPatch: {
                ...(result.configPatch.models?.providers
                  ? { models: { providers: result.configPatch.models.providers } }
                  : {}),
                ...(result.configPatch.plugins ? { plugins: result.configPatch.plugins } : {}),
              },
            }
          : {}),
      }
    : result;
  const profiles = resolveLoginProfiles({
    result: connectionResult,
    requestedProfileId: params.profileId,
  });

  const { profiles: persistedProfiles, authRefresh } = await persistProviderAuthResult({
    result: connectionResult,
    profiles,
    assertCurrent: params.assertCurrent,
    config: params.config,
    configSnapshot: params.configSnapshot,
    agentId: params.agentId,
    agentDir: params.agentDir,
    runtime: params.runtime,
    prompter: params.prompter,
    setDefault: params.setDefault,
    env: params.env ?? process.env,
    beforePersistentEffect: params.beforePersistentEffect,
    refreshAfterLogin: params.refreshAfterLogin,
  });
  if (persistedProfiles.length > 0) {
    await completeProviderModelAccess({
      prepared: modelAccess,
      prompter: params.prompter,
      onRequested: params.onModelAccessRequested,
      runtime: params.runtime,
      assertCurrent: () => {
        params.signal?.throwIfAborted();
        params.assertCurrent?.();
      },
    }).catch((error: unknown) => {
      throw new ProviderAuthConfigApplyError(error);
    });
  }
  return { result: connectionResult, profiles: persistedProfiles, authRefresh };
}

/** Runs an interactive provider setup-token auth flow. */
export async function modelsAuthSetupTokenCommand(
  opts: { provider?: string; yes?: boolean; agent?: string },
  runtime: RuntimeEnv,
) {
  if (!process.stdin.isTTY) {
    throw new Error(
      `setup-token requires an interactive TTY. In automation, use ${formatCliCommand("openclaw models auth paste-token --provider <provider>")} instead.`,
    );
  }

  const { config, configSnapshot, agentId, agentDir, workspaceDir, providers } =
    await resolveModelsAuthContext({
      requestedProvider: opts.provider,
      rawAgentId: opts.agent,
    });
  const tokenProviders = listProvidersWithTokenMethods(providers);
  if (tokenProviders.length === 0) {
    throw new Error(
      `No provider token-auth plugins found. Install one via \`${formatCliCommand("openclaw plugins install")}\`.`,
    );
  }

  const provider =
    resolveRequestedProviderOrThrow(tokenProviders, opts.provider) ?? tokenProviders[0] ?? null;
  if (!provider) {
    throw new Error(
      `No token-capable provider is available. Run ${formatCliCommand("openclaw plugins list")} to verify provider plugins are installed.`,
    );
  }

  if (!opts.yes) {
    const proceed = await confirm({
      message: `Continue with ${provider.label} token auth?`,
      initialValue: true,
    });
    if (!proceed) {
      return;
    }
  }

  const prompter = createClackPrompter();
  const method = await pickProviderTokenMethod({ provider, prompter });
  if (!method) {
    throw new Error(`Provider "${provider.id}" does not expose a token auth method.`);
  }

  await runProviderAuthMethod({
    config,
    configSnapshot,
    agentId,
    agentDir,
    workspaceDir,
    provider,
    method,
    runtime,
    prompter,
  });
}

/** Reads a pasted bearer/setup token and stores it as an auth profile. */
export async function modelsAuthPasteTokenCommand(
  opts: {
    provider?: string;
    profileId?: string;
    expiresIn?: string;
    agent?: string;
  },
  runtime: RuntimeEnv,
) {
  const { agentId, agentDir } = await resolveModelsAuthAgent(opts.agent);
  const rawProvider = normalizeOptionalString(opts.provider);
  if (!rawProvider) {
    throw new Error(
      `Missing --provider. Run ${formatCliCommand("openclaw models status")} or ${formatCliCommand("openclaw plugins list")} to choose a provider.`,
    );
  }
  const provider = normalizeManualAuthProvider(rawProvider);
  const profileId =
    normalizeOptionalString(opts.profileId) || resolveDefaultTokenProfileId(provider);

  const validateTokenInput = (value: string | undefined): string | undefined => {
    const trimmed = value?.trim();
    if (!trimmed) {
      return "Required";
    }
    if (provider === "anthropic") {
      return validateAnthropicSetupToken(trimmed.replaceAll(/\s+/g, ""));
    }
    if (isOpenAIProvider(provider) && looksLikeOpenAIApiKey(trimmed)) {
      return `That looks like an OpenAI API key. Use ${formatCliCommand("openclaw models auth paste-api-key --provider openai")} for API-key auth.`;
    }
    return undefined;
  };
  const tokenInput = await readPastedSecret({
    message: `Paste token for ${provider}`,
    masked: true,
    validate: validateTokenInput,
  });
  const token =
    provider === "anthropic"
      ? tokenInput.replaceAll(/\s+/g, "").trim()
      : (normalizeOptionalString(tokenInput) ?? "");

  const expires = resolveManualTokenExpiryMs(opts.expiresIn);

  await upsertAuthProfileWithLockOrThrow({
    profileId,
    credential: {
      type: "token",
      provider,
      token,
      ...(expires ? { expires } : {}),
    },
    agentDir,
  });

  await updateConfig((cfg) => applyAuthProfileConfig(cfg, { profileId, provider, mode: "token" }));

  await refreshRunningGatewayAuthState(agentId, "login", runtime);

  logConfigUpdated(runtime);
  runtime.log(`Auth profile: ${profileId} (${provider}/token)`);
  if (provider === "anthropic") {
    runtime.log("Anthropic setup-token auth is supported in OpenClaw.");
    runtime.log("OpenClaw prefers Claude CLI reuse when it is available on the host.");
    runtime.log("Anthropic staff told us this OpenClaw path is allowed again.");
  }
}

/** Reads a pasted API key and stores it as an auth profile. */
export async function modelsAuthPasteApiKeyCommand(
  opts: {
    provider?: string;
    profileId?: string;
    agent?: string;
  },
  runtime: RuntimeEnv,
) {
  const config = (await loadValidConfigSnapshotOrThrow()).runtimeConfig;
  const { agentId, agentDir } = await resolveModelsAuthAgent(opts.agent, config);
  const rawProvider = normalizeOptionalString(opts.provider);
  if (!rawProvider) {
    throw new Error(
      `Missing --provider. Run ${formatCliCommand("openclaw models status")} or ${formatCliCommand("openclaw plugins list")} to choose a provider.`,
    );
  }
  const provider = normalizeManualAuthProvider(rawProvider);

  const key = await readPastedSecret({
    message: `Paste API key for ${provider}`,
    masked: true,
    validate: (value) => {
      const trimmed = value?.trim();
      if (!trimmed) {
        return "Required";
      }
      if (isOpenAIProvider(provider)) {
        return validateOpenAICodexApiKeyInput(trimmed);
      }
      return undefined;
    },
  });

  const profileId = await saveModelProviderApiKey({
    config,
    provider,
    apiKey: key,
    agentDir,
    profileId: normalizeOptionalString(opts.profileId),
  });

  await refreshRunningGatewayAuthState(agentId, "login", runtime);

  logConfigUpdated(runtime);
  runtime.log(`Auth profile: ${profileId} (${provider}/api_key)`);
}

/** Interactive helper for adding token auth profiles, with provider/method prompts. */
export async function modelsAuthAddCommand(opts: { agent?: string }, runtime: RuntimeEnv) {
  const { config, configSnapshot, agentId, agentDir, workspaceDir, providers } =
    await resolveModelsAuthContext({
      rawAgentId: opts.agent,
    });
  const tokenProviders = listProvidersWithTokenMethods(providers);

  const provider = await select({
    message: "Token provider",
    options: [
      ...tokenProviders.map((providerPlugin) => ({
        value: providerPlugin.id,
        label: providerPlugin.id,
        hint: providerPlugin.docsPath ? `Docs: ${providerPlugin.docsPath}` : undefined,
      })),
      { value: "custom", label: "custom (type provider id)" },
    ],
  });

  const providerId =
    provider === "custom"
      ? normalizeProviderId(
          await text({
            message: "Provider id",
            validate: (value) => (value?.trim() ? undefined : "Required"),
          }),
        )
      : provider;

  const providerPlugin =
    provider === "custom" ? null : resolveRequestedProviderOrThrow(tokenProviders, providerId);
  if (providerPlugin) {
    const tokenMethods = listTokenAuthMethods(providerPlugin);
    const methodId =
      tokenMethods.length > 0
        ? await select({
            message: "Token method",
            options: [
              ...tokenMethods.map((method) => ({
                value: method.id,
                label: method.label,
                hint: method.hint,
              })),
              { value: "paste", label: "paste token" },
            ],
          })
        : "paste";
    if (methodId !== "paste") {
      const prompter = createClackPrompter();
      const method = tokenMethods.find((candidate) => candidate.id === methodId);
      if (!method) {
        throw new Error(
          `Unknown token auth method "${methodId}". Run ${formatCliCommand("openclaw models auth login --provider " + providerPlugin.id)} to choose interactively.`,
        );
      }
      await runProviderAuthMethod({
        config,
        configSnapshot,
        agentId,
        agentDir,
        workspaceDir,
        provider: providerPlugin,
        method,
        runtime,
        prompter,
      });
      return;
    }
  }

  const profileIdDefault = resolveDefaultTokenProfileId(providerId);
  const profileId = (
    await text({
      message: "Profile id",
      initialValue: profileIdDefault,
      validate: (value) => (value?.trim() ? undefined : "Required"),
    })
  ).trim();

  const wantsExpiry = await confirm({
    message: "Does this token expire?",
    initialValue: false,
  });
  const expiresIn = wantsExpiry
    ? (
        await text({
          message: "Expires in (duration)",
          initialValue: "365d",
          validate: (value) => {
            try {
              parseDurationMs(value ?? "", { defaultUnit: "d" });
              return undefined;
            } catch {
              return "Invalid duration (e.g. 365d, 12h, 30m)";
            }
          },
        })
      ).trim()
    : undefined;

  await modelsAuthPasteTokenCommand(
    { provider: providerId, profileId, expiresIn, agent: opts.agent },
    runtime,
  );
}

type LoginOptions = {
  provider?: string;
  method?: string;
  profileId?: string;
  setDefault?: boolean;
  yes?: boolean;
  agent?: string;
  /**
   * When true, remove any existing auth profiles for the resolved provider
   * before invoking the auth flow. This is the escape hatch for stuck
   * cached OAuth profiles where the standard `auth login` short-circuits
   * because credentials already exist on disk.
   */
  force?: boolean;
};

export type ModelsAuthLoginFlowResult = {
  providerId: string;
  methodId: string;
  authRefresh: ModelAuthRefreshOutcome;
  defaultModel?: string;
  imported?: boolean;
  profiles: Array<{
    profileId: string;
    provider: string;
    mode: "api_key" | "oauth" | "token";
  }>;
};

export type ModelsAuthLoginFlowOptions = LoginOptions & {
  ownerPluginId?: string;
  credentialOnly?: boolean;
  assertCurrent?: () => void;
  config?: OpenClawConfig;
  runtime: RuntimeEnv;
  prompter: WizardPrompter;
  onModelAccessRequested?: (request: PreparedProviderModelAccess) => void;
  env?: NodeJS.ProcessEnv;
  isRemote?: boolean;
  signal?: AbortSignal;
  openUrl?: (url: string) => Promise<void>;
  browserAuthorization?: ProviderAuthContext["oauth"]["authorize"];
  beforePersistentEffect?: () => void | Promise<void>;
  /** Publish a hosted login through its current Gateway instead of a separate CLI connection. */
  refreshAfterLogin?: (agentId: string) => Promise<void>;
};

/** Resolves a requested login provider or throws with available provider details. */
export function resolveRequestedLoginProviderOrThrow(
  providers: ProviderPlugin[],
  rawProvider?: string,
): ProviderPlugin | null {
  return resolveRequestedProviderOrThrow(providers, rawProvider);
}

function credentialMode(credential: AuthProfileCredential): "api_key" | "oauth" | "token" {
  if (credential.type === "api_key") {
    return "api_key";
  }
  if (credential.type === "token") {
    return "token";
  }
  return "oauth";
}

/** Applies an optional profile-id override to a single returned login profile. */
export function resolveLoginProfiles(params: {
  result: ProviderAuthResult;
  requestedProfileId?: string;
}): ProviderAuthResult["profiles"] {
  const requestedProfileId = params.requestedProfileId?.trim();
  if (!requestedProfileId) {
    return params.result.profiles;
  }

  if (params.result.profiles.length !== 1) {
    throw new Error(
      "--profile-id requires exactly one returned auth profile from the selected auth method.",
    );
  }

  const [profile] = params.result.profiles;
  return [{ ...expectDefined(profile, "auth profile"), profileId: requestedProfileId }];
}

function maybeLogOpenAICodexNativeSearchTip(runtime: RuntimeEnv, providerId: string) {
  if (providerId !== "openai") {
    return;
  }
  runtime.log(
    `Tip: Codex-capable models can use native Codex web search. Configure the \`web_search\` tool with \`${formatCliCommand("openclaw configure --section web")}\`. Docs: https://docs.openclaw.ai/tools/web`,
  );
}

export async function runModelsAuthLoginFlowCore(
  opts: ModelsAuthLoginFlowOptions,
): Promise<ModelsAuthLoginFlowResult> {
  const requestedProviderId = opts.provider
    ? normalizeManualAuthProvider(opts.provider)
    : undefined;
  let context = await resolveModelsAuthContext({
    requestedProvider: requestedProviderId,
    rawAgentId: opts.agent,
    config: opts.config,
    ownerPluginId: opts.ownerPluginId,
  });
  const prompter = opts.prompter;
  let authProviders = listProvidersWithAuthMethods(context.providers);
  let requestedProvider = requestedProviderId
    ? resolveProviderMatch(authProviders, requestedProviderId)
    : null;
  const useProviderPicker =
    !opts.ownerPluginId &&
    requestedProviderId !== undefined &&
    requestedProvider === null &&
    isCliProvider(requestedProviderId, context.config);
  if (useProviderPicker) {
    context = await resolveModelsAuthContext({
      rawAgentId: opts.agent,
      config: context.config,
    });
    authProviders = listProvidersWithAuthMethods(context.providers);
  }
  if (authProviders.length === 0) {
    throw new Error(
      `No provider plugins found. Install one via \`${formatCliCommand("openclaw plugins install")}\`.`,
    );
  }
  if (useProviderPicker) {
    await prompter.note(
      `Provider "${requestedProviderId}" uses its own CLI login. Select a provider with an OpenClaw auth flow.`,
      "Provider auth",
    );
  } else if (requestedProviderId && !requestedProvider) {
    requestedProvider = resolveRequestedLoginProviderOrThrow(authProviders, requestedProviderId);
  }
  await prompter.note(
    [
      "Scope: System / agent",
      `Agent: ${context.agentId}`,
      "Location: the machine running OpenClaw",
      `For personal model accounts on a Gateway, run ${formatCliCommand("openclaw models accounts login --help")}.`,
    ].join("\n"),
    "Provider sign-in",
  );
  const selectedProvider =
    requestedProvider ??
    (await prompter
      .select({
        message: "Select a provider",
        options: authProviders.map((provider) => ({
          value: provider.id,
          label: provider.label,
          hint: provider.docsPath ? `Docs: ${provider.docsPath}` : undefined,
        })),
      })
      .then((id) => resolveProviderMatch(authProviders, id)));

  if (!selectedProvider) {
    throw new Error(
      `Unknown provider. Run ${formatCliCommand("openclaw models status")} or ${formatCliCommand("openclaw plugins list")} to see available provider plugins.`,
    );
  }

  if (opts.ownerPluginId && selectedProvider.id !== opts.provider) {
    throw new Error("The selected provider login is no longer available.");
  }

  const chosenMethod = opts.ownerPluginId
    ? selectedProvider.auth.find((method) => method.id === opts.method)
    : await pickProviderAuthMethod({
        provider: selectedProvider,
        requestedMethod: opts.method,
        prompter,
      });

  if (!chosenMethod) {
    throw new Error(
      `Unknown auth method. Run ${formatCliCommand("openclaw models auth login --provider " + selectedProvider.id)} without --method to choose interactively.`,
    );
  }

  const modelAccess = prepareProviderModelAccess({
    config: context.config,
    agentId: context.agentId,
    provider: selectedProvider.id,
    providerLabel: selectedProvider.label,
  });
  const imported =
    !opts.credentialOnly && !opts.force && !opts.profileId && !opts.setDefault
      ? await tryImportProviderCredential({
          method: chosenMethod,
          providerId: selectedProvider.id,
          config: context.config,
          agentId: context.agentId,
          runtime: opts.runtime,
          signal: opts.signal,
          beforePersistentEffect: opts.beforePersistentEffect,
        })
      : undefined;
  if (imported && "unavailableReason" in imported) {
    await prompter.note(imported.unavailableReason, "Existing CLI sign-in");
  } else if (imported) {
    await promotePersistedAuthProfile({
      config: context.config,
      agentDir: context.agentDir,
      provider: imported.provider,
      profileId: imported.profileId,
    });
    let authRefresh: ModelAuthRefreshOutcome;
    if (opts.refreshAfterLogin) {
      await opts.refreshAfterLogin(context.agentId);
      authRefresh = "refreshed";
    } else {
      authRefresh = await refreshRunningGatewayAuthState(context.agentId, "login", opts.runtime);
    }
    if (imported.configUpdated) {
      logConfigUpdated(opts.runtime);
    }
    opts.runtime.log(
      `Auth profile: ${imported.profileId} (${imported.provider}/${imported.mode}, imported)`,
    );
    await completeProviderModelAccess({
      prepared: modelAccess,
      prompter,
      onRequested: opts.onModelAccessRequested,
      runtime: opts.runtime,
      assertCurrent: () => {
        opts.signal?.throwIfAborted();
        opts.assertCurrent?.();
      },
    }).catch((error: unknown) => {
      throw new ProviderAuthConfigApplyError(error);
    });
    return {
      providerId: selectedProvider.id,
      methodId: chosenMethod.id,
      authRefresh,
      imported: true,
      profiles: [
        { profileId: imported.profileId, provider: imported.provider, mode: imported.mode },
      ],
    };
  }

  if (opts.force) {
    await opts.beforePersistentEffect?.();
    // Purge existing profiles for this provider only after we have a valid
    // auth method to invoke. Running the purge earlier (before method
    // resolution) would delete the user's working credentials and then
    // throw on an unresolvable `--method`, leaving them without a usable
    // profile and no auth flow started. This is the documented escape
    // hatch for stuck OAuth credentials (expired token, swapped account,
    // etc.) where `auth login` would otherwise short-circuit on the cached
    // profile.
    try {
      const clearedStore = await removeProviderAuthProfilesWithLock({
        cfg: context.config,
        provider: selectedProvider.id,
        agentDir: context.agentDir,
      });
      if (!clearedStore) {
        throw new Error(
          "auth store is busy; close other OpenClaw commands using this state directory and retry",
        );
      }
      opts.runtime.log(
        `Removed cached auth profiles for provider "${selectedProvider.id}" (--force). Running fresh auth flow.`,
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(
        `Could not clear cached profiles for "${selectedProvider.id}" before re-login: ${message}. Re-login was not started because --force must remove cached profiles first.`,
        { cause: err },
      );
    }
    await refreshRunningGatewayAuthState(context.agentId, "logout", opts.runtime);
  }

  const { result, profiles, authRefresh } = await runProviderAuthMethod({
    config: context.config,
    configSnapshot: context.configSnapshot,
    agentId: context.agentId,
    agentDir: context.agentDir,
    workspaceDir: context.workspaceDir,
    provider: selectedProvider,
    method: chosenMethod,
    runtime: opts.runtime,
    prompter,
    profileId: opts.profileId,
    setDefault: opts.setDefault,
    credentialOnly: opts.credentialOnly,
    assertCurrent: opts.assertCurrent,
    env: opts.env,
    isRemote: opts.isRemote,
    signal: opts.signal,
    openUrl: opts.openUrl,
    browserAuthorization: opts.browserAuthorization,
    beforePersistentEffect: opts.beforePersistentEffect,
    refreshAfterLogin: opts.refreshAfterLogin,
    onModelAccessRequested: opts.onModelAccessRequested,
  });
  maybeLogOpenAICodexNativeSearchTip(opts.runtime, selectedProvider.id);
  return {
    providerId: selectedProvider.id,
    methodId: chosenMethod.id,
    authRefresh,
    ...(result.defaultModel ? { defaultModel: result.defaultModel } : {}),
    profiles: profiles.map((profile) => ({
      profileId: profile.profileId,
      provider: profile.credential.provider,
      mode: credentialMode(profile.credential),
    })),
  };
}

export async function modelsAuthLoginCommand(opts: LoginOptions, runtime: RuntimeEnv) {
  if (!process.stdin.isTTY) {
    throw new Error(
      `models auth login requires an interactive TTY. In automation, use ${formatCliCommand("openclaw models auth paste-token --provider <provider>")} when token auth is available.`,
    );
  }

  await runModelsAuthLoginFlowCore({
    ...opts,
    runtime,
    prompter: createClackPrompter(),
  });
}
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
