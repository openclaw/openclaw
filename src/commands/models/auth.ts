import { cancel } from "@clack/prompts";
import { readByteStreamWithLimit } from "@openclaw/media-core/read-byte-stream-with-limit";
import { expectDefined } from "@openclaw/normalization-core";
import { resolveExpiresAtMsFromDurationMs } from "@openclaw/normalization-core/number-coercion";
import {
  normalizeOptionalString,
  normalizeStringifiedOptionalString,
} from "@openclaw/normalization-core/string-coerce";
import { resolveAgentWorkspaceDir } from "../../agents/agent-scope.js";
import { removeProviderAuthProfilesWithLock } from "../../agents/auth-profiles.js";
import { upsertAuthProfileWithLockOrThrow } from "../../agents/auth-profiles/profiles.js";
import { loadAuthProfileStoreWithoutExternalProfiles } from "../../agents/auth-profiles/store-runtime.js";
import type { AuthProfileCredential } from "../../agents/auth-profiles/types.js";
import { normalizeProviderId } from "../../agents/model-ref-shared.js";
import { isCliProvider } from "../../agents/model-selection-cli.js";
import { formatCliCommand } from "../../cli/command-format.js";
import { parseDurationMs } from "../../cli/parse-duration.js";
import { logConfigUpdated } from "../../config/logging.js";
import { normalizeAgentModelRefForConfig } from "../../config/model-input.js";
import type { ConfigFileSnapshot, OpenClawConfig } from "../../config/types.openclaw.js";
import {
  applyProviderAuthConfigPatch,
  pickAuthMethod,
  restorePriorAgentsDefaultsModelUnlessOptIn,
  resolveProviderMatch,
} from "../../plugins/provider-auth-choice-helpers.js";
import {
  createProviderAuthConfigPatch,
  writeProviderAuthConfig,
} from "../../plugins/provider-auth-config.js";
import { applyAuthProfileConfig } from "../../plugins/provider-auth-helpers.js";
import { runProviderPluginAuthMethodUnpersisted } from "../../plugins/provider-auth-method.js";
import { persistProviderAuthProfilesAfterLogin } from "../../plugins/provider-auth-persistence.js";
import type { ProviderAuthContext } from "../../plugins/provider-authentication.types.js";
import { applyPrimaryModel } from "../../plugins/provider-model-primary.js";
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
import { ExitError, type RuntimeEnv } from "../../runtime.js";
import {
  ProviderAuthConfigApplyError,
  ProviderCredentialsSavedError,
} from "../../shared/provider-auth-result.js";
import { isRecord } from "../../utils.js";
import { normalizeSecretInput } from "../../utils/normalize-secret-input.js";
import { createClackPrompter } from "../../wizard/clack-prompter.js";
import type { WizardPrompter } from "../../wizard/prompts.js";
import { validateAnthropicSetupToken } from "../auth-token.js";
import {
  confirm as clackConfirm,
  password as clackPassword,
  select as clackSelect,
  text as clackText,
} from "../configure.shared.js";
import { repairModelSelectionRuntimePlugins } from "../runtime-plugin-install.js";
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
import { promotePersistedAuthProfile } from "./auth-profile-promotion.js";
import {
  refreshProviderAuthAfterLogin,
  refreshRunningGatewayAuthState,
  type ModelAuthRefreshOutcome,
} from "./auth-refresh.js";
import {
  resolveReloginProfileIdentity,
  snapshotReloginAuthProfiles,
} from "./auth-relogin-identity.js";
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

function requireManualAuthProvider(raw: string | undefined): string {
  const provider = normalizeOptionalString(raw);
  if (!provider) {
    throw new Error(
      `Missing --provider. Run ${formatCliCommand("openclaw models status")} or ${formatCliCommand("openclaw plugins list")} to choose a provider.`,
    );
  }
  return normalizeManualAuthProvider(provider);
}

function guardCancel<T>(value: T | typeof import("@clack/prompts").CANCEL_SYMBOL): T {
  if (typeof value === "symbol") {
    cancel("Cancelled.");
    throw new ExitError(0);
  }
  return value;
}

const confirm = async (params: Parameters<typeof clackConfirm>[0]) =>
  guardCancel(await clackConfirm(params));
const text = async (params: Parameters<typeof clackText>[0]) =>
  guardCancel(await clackText(params));
const password = async (params: Parameters<typeof clackPassword>[0]) =>
  guardCancel(await clackPassword(params));
const select = async <T>(params: Parameters<typeof clackSelect<T>>[0]) =>
  guardCancel(await clackSelect(params));

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
  validate: (value: string | undefined) => string | undefined;
}): Promise<string> {
  const input = process.stdin.isTTY ? await password(params) : await readPipedStdin();
  const normalized = normalizeSecretInput(input);
  const validationMessage = params.validate(normalized);
  if (validationMessage) {
    throw new Error(validationMessage);
  }
  return normalized;
}

type ResolvedModelsAuthContext = Awaited<ReturnType<typeof resolveModelsAuthContext>>;

function listProvidersWithTokenMethods(providers: ProviderPlugin[]): ProviderPlugin[] {
  return providers.filter((provider) => provider.auth.some((method) => method.kind === "token"));
}

function preferSetupAuthProviders(params: {
  providers: readonly ProviderPlugin[];
  config: OpenClawConfig;
  workspaceDir: string;
  requestedProvider?: string;
  ownerPluginId?: string;
}): ProviderPlugin[] {
  const requestedProvider = params.requestedProvider;
  if (!params.ownerPluginId && requestedProvider) {
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
    ...(params.ownerPluginId ? { pluginIds: [params.ownerPluginId] } : {}),
  }).providers.map((entry) => entry.provider);
  const setupById = new Map(
    setupProviders.map((provider) => [normalizeProviderId(provider.id), provider] as const),
  );
  const existing = new Set(params.providers.map((provider) => normalizeProviderId(provider.id)));
  return [
    ...params.providers.map(
      (provider) => setupById.get(normalizeProviderId(provider.id)) ?? provider,
    ),
    ...setupProviders.filter((provider) => !existing.has(normalizeProviderId(provider.id))),
  ];
}

async function resolveModelsAuthContext(params?: {
  requestedProvider?: string;
  rawAgentId?: string | null;
  config?: OpenClawConfig;
  ownerPluginId?: string;
}) {
  const configSnapshot = await loadValidConfigSnapshotOrThrow();
  const config = params?.config ?? configSnapshot.runtimeConfig;
  const { agentId, agentDir } = resolveModelsTargetAgent(config, params?.rawAgentId ?? undefined, {
    kind: "mutation",
  });
  const workspaceDir = resolveAgentWorkspaceDir(config, agentId);
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

export function resolveRequestedLoginProviderOrThrow(
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

async function pickProviderAuthMethod(params: {
  provider: ProviderPlugin;
  requestedMethod?: string;
  prompter: WizardPrompter;
  tokenOnly?: boolean;
}) {
  const rawRequestedMethod = params.requestedMethod?.trim();
  if (rawRequestedMethod) {
    return pickAuthMethod(params.provider, rawRequestedMethod);
  }
  const methods = params.tokenOnly
    ? params.provider.auth.filter((method) => method.kind === "token")
    : params.provider.auth;
  if (params.tokenOnly && methods.length === 0) {
    return null;
  }
  const preferred = methods.find((method) =>
    params.tokenOnly ? method.id === "setup-token" : method.kind === "oauth",
  );
  if (preferred) {
    return preferred;
  }
  if (methods.length === 1) {
    return methods[0] ?? null;
  }
  return params.prompter
    .select({
      message: `${params.tokenOnly ? "Token" : "Auth"} method for ${params.provider.label}`,
      options: methods.map((method) => ({
        value: method.id,
        label: method.label,
        hint: method.hint,
      })),
    })
    .then((id) => methods.find((method) => method.id === id) ?? null);
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
  validateCurrentCredential?: (
    profileId: string,
    credential: AuthProfileCredential | undefined,
  ) => void;
  assertCurrent?: () => void;
  signal?: AbortSignal;
  refreshAfterLogin?: ModelsAuthLoginFlowOptions["refreshAfterLogin"];
}): Promise<{ profiles: ProviderAuthResult["profiles"]; authRefresh: ModelAuthRefreshOutcome }> {
  const defaultModel = params.result.defaultModel
    ? normalizeAgentModelRefForConfig(params.result.defaultModel)
    : undefined;
  const profiles = params.profiles ?? params.result.profiles;
  const persistedProfiles: ProviderAuthResult["profiles"] = [];
  // Match source and runtime rows using the config owner's canonical model identities.
  const loginConfig = applyProviderAuthConfigPatch(params.config, {});
  const configPatch = params.result.configPatch
    ? createProviderAuthConfigPatch(
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
        validateCurrentCredential: params.validateCurrentCredential,
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
        assertCurrent: params.assertCurrent,
      });
    }

    // Replay only the login's changes; the writer may have newer unrelated settings.
    if (shouldUpdateConfig) {
      const updated = await writeProviderAuthConfig({
        config: params.config,
        configSnapshot: params.configSnapshot,
        configPatch,
        credentialsSaved: persistedProfiles.length > 0,
        beforeCommit: params.assertCurrent,
        writeOptions: { assertCurrent: params.assertCurrent },
        finalizeConfig: (replayed, cfg) => {
          const priorAgentsDefaultsModel = cfg.agents?.defaults?.model;
          const next = restorePriorAgentsDefaultsModelUnlessOptIn({
            cfg: replayed,
            priorAgentsDefaultsModel,
            setDefault: params.setDefault,
          });
          if (params.setDefault && defaultModel) {
            return profiles.length > 0
              ? applyProviderLoginDefaultModel(next, defaultModel)
              : applyPrimaryModel(next, defaultModel);
          }
          return next;
        },
      });
      if (defaultModel) {
        const warnings = await repairModelSelectionRuntimePlugins({
          cfg: updated,
          model: defaultModel,
        });
        for (const warning of warnings) {
          params.runtime.error?.(warning);
        }
      }
      logConfigUpdated(params.runtime);
    }

    const authRefresh = await refreshProviderAuthAfterLogin(params);

    for (const profile of persistedProfiles) {
      params.runtime.log(
        `Auth profile: ${profile.profileId} (${profile.credential.provider}/${profile.credential.type})`,
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

async function runProviderAuthMethod(
  params: Omit<ModelsAuthLoginFlowOptions, "provider" | "method" | "config"> &
    Omit<ResolvedModelsAuthContext, "providers"> & {
      provider: ProviderPlugin;
      method: ProviderAuthMethod;
      existingProfiles?: Readonly<Record<string, AuthProfileCredential>>;
      allowMissingReusedProfile?: boolean;
    },
) {
  params.signal?.throwIfAborted();
  params.assertCurrent?.();
  const modelAccess = prepareProviderModelAccess({
    config: params.config,
    agentId: params.agentId,
    provider: params.provider.id,
    providerLabel: params.provider.label,
  });
  const store = loadAuthProfileStoreWithoutExternalProfiles(params.agentDir);
  const existingProfiles = Object.entries(store.profiles)
    .filter(
      ([profileId, credential]) =>
        credential.provider === params.provider.id &&
        (!params.profileId || profileId === params.profileId),
    )
    .map(([profileId, credential]) => ({ profileId, credential }));
  const result = await runProviderPluginAuthMethodUnpersisted({
    method: params.method,
    config: params.config,
    existingProfiles,
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
  const resolvedIdentity = resolveReloginProfileIdentity({
    profiles: connectionResult.profiles,
    requestedProfileId: params.profileId,
    existingProfiles: params.existingProfiles,
    matchesPersonalAccount: params.method.matchesPersonalAccount,
    allowMissingReusedProfile: params.allowMissingReusedProfile,
  });
  const profiles = resolvedIdentity.profiles;

  const { profiles: persistedProfiles, authRefresh } = await persistProviderAuthResult({
    ...params,
    result: connectionResult,
    profiles,
    env: params.env ?? process.env,
    validateCurrentCredential: resolvedIdentity.validateCurrentCredential,
  });
  if (persistedProfiles.length > 0) {
    await completeLoginModelAccess(params, modelAccess);
  }
  return { result: connectionResult, profiles: persistedProfiles, authRefresh };
}

function completeLoginModelAccess(
  params: Pick<
    ModelsAuthLoginFlowOptions,
    "prompter" | "runtime" | "onModelAccessRequested" | "signal" | "assertCurrent"
  >,
  prepared: ReturnType<typeof prepareProviderModelAccess>,
) {
  return completeProviderModelAccess({
    prepared,
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

export async function modelsAuthSetupTokenCommand(
  opts: { provider?: string; yes?: boolean; agent?: string },
  runtime: RuntimeEnv,
) {
  if (!process.stdin.isTTY) {
    throw new Error(
      `setup-token requires an interactive TTY. In automation, use ${formatCliCommand("openclaw models auth paste-token --provider <provider>")} instead.`,
    );
  }

  const context = await resolveModelsAuthContext({
    requestedProvider: opts.provider,
    rawAgentId: opts.agent,
  });
  const tokenProviders = listProvidersWithTokenMethods(context.providers);
  if (tokenProviders.length === 0) {
    throw new Error(
      `No provider token-auth plugins found. Install one via \`${formatCliCommand("openclaw plugins install")}\`.`,
    );
  }

  const provider =
    resolveRequestedLoginProviderOrThrow(tokenProviders, opts.provider) ?? tokenProviders[0]!;

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
  const method = await pickProviderAuthMethod({ provider, prompter, tokenOnly: true });
  if (!method) {
    throw new Error(`Provider "${provider.id}" does not expose a token auth method.`);
  }

  await runProviderAuthMethod({
    ...context,
    provider,
    method,
    runtime,
    prompter,
  });
}

type ManualAuthOptions = { provider?: string; profileId?: string; agent?: string };

export async function modelsAuthPasteTokenCommand(
  opts: ManualAuthOptions & { expiresIn?: string },
  runtime: RuntimeEnv,
) {
  await pasteManualAuthCredential(opts, runtime, "token");
}

export async function modelsAuthPasteApiKeyCommand(opts: ManualAuthOptions, runtime: RuntimeEnv) {
  await pasteManualAuthCredential(opts, runtime, "api_key");
}

async function pasteManualAuthCredential(
  opts: ManualAuthOptions & { expiresIn?: string },
  runtime: RuntimeEnv,
  mode: "token" | "api_key",
) {
  const config = (await loadValidConfigSnapshotOrThrow()).runtimeConfig;
  const { agentId, agentDir } = resolveModelsTargetAgent(config, opts.agent ?? undefined, {
    kind: "mutation",
  });
  const provider = requireManualAuthProvider(opts.provider);
  const tokenProfileId =
    mode === "token"
      ? normalizeOptionalString(opts.profileId) || resolveDefaultTokenProfileId(provider)
      : undefined;
  const input = await readPastedSecret({
    message: `Paste ${mode === "token" ? "token" : "API key"} for ${provider}`,
    validate: (value) => {
      const trimmed = value?.trim();
      if (!trimmed) {
        return "Required";
      }
      if (mode === "api_key") {
        return provider === "openai" ? validateOpenAICodexApiKeyInput(trimmed) : undefined;
      }
      if (provider === "anthropic") {
        return validateAnthropicSetupToken(trimmed.replaceAll(/\s+/g, ""));
      }
      if (provider === "openai" && looksLikeOpenAIApiKey(trimmed)) {
        return `That looks like an OpenAI API key. Use ${formatCliCommand("openclaw models auth paste-api-key --provider openai")} for API-key auth.`;
      }
      return undefined;
    },
  });
  let profileId = tokenProfileId;
  let warning: string | undefined;
  if (tokenProfileId !== undefined) {
    const token =
      provider === "anthropic"
        ? input.replaceAll(/\s+/g, "").trim()
        : (normalizeOptionalString(input) ?? "");
    const expires = resolveManualTokenExpiryMs(opts.expiresIn);
    await upsertAuthProfileWithLockOrThrow({
      profileId: tokenProfileId,
      credential: { type: "token", provider, token, ...(expires ? { expires } : {}) },
      agentDir,
    });
    await updateConfig((cfg) =>
      applyAuthProfileConfig(cfg, { profileId: tokenProfileId, provider, mode: "token" }),
    );
  } else {
    ({ profileId, warning } = await saveModelProviderApiKey({
      config,
      provider,
      apiKey: input,
      agentDir,
      profileId: normalizeOptionalString(opts.profileId),
    }));
  }
  await refreshRunningGatewayAuthState(agentId, "login", runtime);
  if (warning) {
    runtime.error(warning);
  }
  logConfigUpdated(runtime);
  runtime.log(`Auth profile: ${profileId} (${provider}/${mode})`);
  if (mode === "token" && provider === "anthropic") {
    runtime.log("Anthropic setup-token auth is supported in OpenClaw.");
    runtime.log("OpenClaw prefers Claude CLI reuse when it is available on the host.");
    runtime.log("Anthropic staff told us this OpenClaw path is allowed again.");
  }
}

export async function modelsAuthAddCommand(opts: { agent?: string }, runtime: RuntimeEnv) {
  const context = await resolveModelsAuthContext({ rawAgentId: opts.agent });
  const tokenProviders = listProvidersWithTokenMethods(context.providers);

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
    provider === "custom" ? null : resolveRequestedLoginProviderOrThrow(tokenProviders, providerId);
  if (providerPlugin) {
    const tokenMethods = providerPlugin.auth.filter((method) => method.kind === "token");
    const methodId = await select({
      message: "Token method",
      options: [
        ...tokenMethods.map((method) => ({
          value: method.id,
          label: method.label,
          hint: method.hint,
        })),
        { value: "paste", label: "paste token" },
      ],
    });
    if (methodId !== "paste") {
      const prompter = createClackPrompter();
      const method = tokenMethods.find((candidate) => candidate.id === methodId);
      if (!method) {
        throw new Error(
          `Unknown token auth method "${methodId}". Run ${formatCliCommand("openclaw models auth login --provider " + providerPlugin.id)} to choose interactively.`,
        );
      }
      await runProviderAuthMethod({
        ...context,
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
  /** Discard cached provider profiles before starting a replacement login. */
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

export async function runModelsAuthLoginFlowCore(
  opts: ModelsAuthLoginFlowOptions,
): Promise<ModelsAuthLoginFlowResult> {
  return runModelsAuthLoginFlow(opts, true);
}

export async function runModelsAuthLoginFlowForGateway(
  opts: ModelsAuthLoginFlowOptions,
): Promise<ModelsAuthLoginFlowResult> {
  return runModelsAuthLoginFlow(opts, opts.isRemote === false);
}

async function runModelsAuthLoginFlow(
  opts: ModelsAuthLoginFlowOptions,
  showScopeNote: boolean,
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
  let authProviders = context.providers.filter((provider) => provider.auth.length > 0);
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
    authProviders = context.providers.filter((provider) => provider.auth.length > 0);
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
  if (showScopeNote) {
    await prompter.note(
      [
        "Scope: System / agent",
        `Agent: ${context.agentId}`,
        "Location: the machine running OpenClaw",
        `For personal model accounts on a Gateway, run ${formatCliCommand("openclaw models accounts login --help")}.`,
      ].join("\n"),
      "Provider sign-in",
    );
  }
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
  // Snapshot before --force removes cached credentials. Provider-owned identity
  // matching may safely keep the old profile id for the same authenticated account.
  const existingProfiles = snapshotReloginAuthProfiles({
    agentDir: context.agentDir,
    matchesPersonalAccount: chosenMethod.matchesPersonalAccount,
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
      assertCurrent: opts.assertCurrent,
    });
    const authRefresh = await refreshProviderAuthAfterLogin({ ...opts, agentId: context.agentId });
    if (imported.configUpdated) {
      logConfigUpdated(opts.runtime);
    }
    opts.runtime.log(
      `Auth profile: ${imported.profileId} (${imported.provider}/${imported.mode}, imported)`,
    );
    await completeLoginModelAccess(opts, modelAccess);
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

  const forceLogin = Boolean(opts.force);
  if (forceLogin) {
    await opts.beforePersistentEffect?.();
    // Resolve the method before purging profiles so an invalid --method cannot
    // delete working credentials without starting a replacement login.
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
    ...opts,
    ...context,
    provider: selectedProvider,
    method: chosenMethod,
    prompter,
    existingProfiles,
    allowMissingReusedProfile: forceLogin,
  });
  if (selectedProvider.id === "openai") {
    opts.runtime.log(
      `Tip: Codex-capable models can use native Codex web search. Configure the \`web_search\` tool with \`${formatCliCommand("openclaw configure --section web")}\`. Docs: https://docs.openclaw.ai/tools/web`,
    );
  }
  return {
    providerId: selectedProvider.id,
    methodId: chosenMethod.id,
    authRefresh,
    ...(result.defaultModel ? { defaultModel: result.defaultModel } : {}),
    profiles: profiles.map((profile) => ({
      profileId: profile.profileId,
      provider: profile.credential.provider,
      mode: profile.credential.type,
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
