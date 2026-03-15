import {
  cancel,
  confirm as clackConfirm,
  isCancel,
  select as clackSelect,
  text as clackText,
} from "@clack/prompts";
import {
  resolveAgentDir,
  resolveAgentWorkspaceDir,
  resolveDefaultAgentId,
} from "../../agents/agent-scope.js";
import {
  clearAuthProfileCooldown,
  listProfilesForProvider,
  loadAuthProfileStoreForRuntime,
  upsertAuthProfile,
} from "../../agents/auth-profiles.js";
import type { AuthProfileCredential } from "../../agents/auth-profiles/types.js";
import { normalizeProviderId } from "../../agents/model-selection.js";
import { resolveDefaultAgentWorkspaceDir } from "../../agents/workspace.js";
import { formatCliCommand } from "../../cli/command-format.js";
import { parseDurationMs } from "../../cli/parse-duration.js";
import { logConfigUpdated } from "../../config/logging.js";
import { resolvePluginProviders } from "../../plugins/providers.js";
import type { ProviderAuthResult, ProviderPlugin } from "../../plugins/types.js";
import type { RuntimeEnv } from "../../runtime.js";
import { stylePromptHint, stylePromptMessage } from "../../terminal/prompt-style.js";
import { createClackPrompter } from "../../wizard/clack-prompter.js";
import { validateAnthropicSetupToken } from "../auth-token.js";
import { isRemoteEnvironment } from "../oauth-env.js";
import { createVpsAwareOAuthHandlers } from "../oauth-flow.js";
import { applyAuthProfileConfig, writeOAuthCredentials } from "../onboard-auth.js";
import { openUrl } from "../onboard-helpers.js";
import {
  applyOpenAICodexModelDefault,
  OPENAI_CODEX_DEFAULT_MODEL,
} from "../openai-codex-model-default.js";
import { loginOpenAICodexOAuth } from "../openai-codex-oauth.js";
import {
  applyDefaultModel,
  mergeConfigPatch,
  pickAuthMethod,
  resolveProviderMatch,
} from "../provider-auth-helpers.js";
import { loadValidConfigOrThrow, updateConfig } from "./shared.js";

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
const select = async <T>(params: Parameters<typeof clackSelect<T>>[0]) =>
  guardCancel(
    await clackSelect({
      ...params,
      message: stylePromptMessage(params.message),
      options: params.options.map((opt) =>
        opt.hint === undefined ? opt : { ...opt, hint: stylePromptHint(opt.hint) },
      ),
    }),
  );

type TokenProvider = "anthropic";

function resolveTokenProvider(raw?: string): TokenProvider | "custom" | null {
  const trimmed = raw?.trim();
  if (!trimmed) {
    return null;
  }
  const normalized = normalizeProviderId(trimmed);
  if (normalized === "anthropic") {
    return "anthropic";
  }
  return "custom";
}

function resolveDefaultTokenProfileId(provider: string): string {
  return `${normalizeProviderId(provider)}:manual`;
}

export async function modelsAuthSetupTokenCommand(
  opts: { provider?: string; yes?: boolean },
  runtime: RuntimeEnv,
) {
  const provider = resolveTokenProvider(opts.provider ?? "anthropic");
  if (provider !== "anthropic") {
    throw new Error("Only --provider anthropic is supported for setup-token.");
  }

  if (!process.stdin.isTTY) {
    throw new Error("setup-token requires an interactive TTY.");
  }

  if (!opts.yes) {
    const proceed = await confirm({
      message: "Have you run `claude setup-token` and copied the token?",
      initialValue: true,
    });
    if (!proceed) {
      return;
    }
  }

  const tokenInput = await text({
    message: "Paste Anthropic setup-token",
    validate: (value) => validateAnthropicSetupToken(String(value ?? "")),
  });
  const token = String(tokenInput ?? "").trim();
  const profileId = resolveDefaultTokenProfileId(provider);

  upsertAuthProfile({
    profileId,
    credential: {
      type: "token",
      provider,
      token,
    },
  });

  await updateConfig((cfg) =>
    applyAuthProfileConfig(cfg, {
      profileId,
      provider,
      mode: "token",
    }),
  );

  logConfigUpdated(runtime);
  runtime.log(`Auth profile: ${profileId} (${provider}/token)`);
}

export async function modelsAuthPasteTokenCommand(
  opts: {
    provider?: string;
    profileId?: string;
    expiresIn?: string;
  },
  runtime: RuntimeEnv,
) {
  const rawProvider = opts.provider?.trim();
  if (!rawProvider) {
    throw new Error("Missing --provider.");
  }
  const provider = normalizeProviderId(rawProvider);
  const profileId = opts.profileId?.trim() || resolveDefaultTokenProfileId(provider);

  const tokenInput = await text({
    message: `Paste token for ${provider}`,
    validate: (value) => (value?.trim() ? undefined : "Required"),
  });
  const token = String(tokenInput ?? "").trim();

  const expires =
    opts.expiresIn?.trim() && opts.expiresIn.trim().length > 0
      ? Date.now() + parseDurationMs(String(opts.expiresIn ?? "").trim(), { defaultUnit: "d" })
      : undefined;

  upsertAuthProfile({
    profileId,
    credential: {
      type: "token",
      provider,
      token,
      ...(expires ? { expires } : {}),
    },
  });

  await updateConfig((cfg) => applyAuthProfileConfig(cfg, { profileId, provider, mode: "token" }));

  logConfigUpdated(runtime);
  runtime.log(`Auth profile: ${profileId} (${provider}/token)`);
}

export async function modelsAuthAddCommand(_opts: Record<string, never>, runtime: RuntimeEnv) {
  const provider = await select({
    message: "Token provider",
    options: [
      { value: "anthropic", label: "anthropic" },
      { value: "custom", label: "custom (type provider id)" },
    ],
  });

  const providerId =
    provider === "custom"
      ? normalizeProviderId(
          String(
            await text({
              message: "Provider id",
              validate: (value) => (value?.trim() ? undefined : "Required"),
            }),
          ),
        )
      : provider;

  const method = (await select({
    message: "Token method",
    options: [
      ...(providerId === "anthropic"
        ? [
            {
              value: "setup-token",
              label: "setup-token (claude)",
              hint: "Paste a setup-token from `claude setup-token`",
            },
          ]
        : []),
      { value: "paste", label: "paste token" },
    ],
  })) as "setup-token" | "paste";

  if (method === "setup-token") {
    await modelsAuthSetupTokenCommand({ provider: providerId }, runtime);
    return;
  }

  const profileIdDefault = resolveDefaultTokenProfileId(providerId);
  const profileId = String(
    await text({
      message: "Profile id",
      initialValue: profileIdDefault,
      validate: (value) => (value?.trim() ? undefined : "Required"),
    }),
  ).trim();

  const wantsExpiry = await confirm({
    message: "Does this token expire?",
    initialValue: false,
  });
  const expiresIn = wantsExpiry
    ? String(
        await text({
          message: "Expires in (duration)",
          initialValue: "365d",
          validate: (value) => {
            try {
              parseDurationMs(String(value ?? ""), { defaultUnit: "d" });
              return undefined;
            } catch {
              return "Invalid duration (e.g. 365d, 12h, 30m)";
            }
          },
        }),
      ).trim()
    : undefined;

  await modelsAuthPasteTokenCommand({ provider: providerId, profileId, expiresIn }, runtime);
}

type LoginOptions = {
  provider?: string;
  method?: string;
  setDefault?: boolean;
};

/**
 * Clear stale cooldown/disabled state for all profiles matching a provider.
 * When a user explicitly runs `models auth login`, they intend to fix auth —
 * stale `auth_permanent` / `billing` lockouts should not persist across
 * a deliberate re-authentication attempt.
 */
async function clearStaleProfileLockouts(provider: string, agentDir: string): Promise<void> {
  try {
    const store = loadAuthProfileStoreForRuntime(agentDir);
    const profileIds = listProfilesForProvider(store, provider);
    for (const profileId of profileIds) {
      await clearAuthProfileCooldown({ store, profileId, agentDir });
    }
  } catch {
    // Best-effort housekeeping — never block re-authentication.
  }
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

function credentialMode(credential: AuthProfileCredential): "api_key" | "oauth" | "token" {
  if (credential.type === "api_key") {
    return "api_key";
  }
  if (credential.type === "token") {
    return "token";
  }
  return "oauth";
}

async function runBuiltInOpenAICodexLogin(params: {
  opts: LoginOptions;
  runtime: RuntimeEnv;
  prompter: ReturnType<typeof createClackPrompter>;
  agentDir: string;
}) {
  const creds = await loginOpenAICodexOAuth({
    prompter: params.prompter,
    runtime: params.runtime,
    isRemote: isRemoteEnvironment(),
    openUrl: async (url) => {
      await openUrl(url);
    },
    localBrowserMessage: "Complete sign-in in browser…",
  });
  if (!creds) {
    throw new Error("OpenAI Codex OAuth did not return credentials.");
  }

  const profileId = await writeOAuthCredentials("openai-codex", creds, params.agentDir, {
    syncSiblingAgents: true,
  });
  await updateConfig((cfg) => {
    let next = applyAuthProfileConfig(cfg, {
      profileId,
      provider: "openai-codex",
      mode: "oauth",
    });
    if (params.opts.setDefault) {
      next = applyOpenAICodexModelDefault(next).next;
    }
    return next;
  });

  logConfigUpdated(params.runtime);
  params.runtime.log(`Auth profile: ${profileId} (openai-codex/oauth)`);
  if (params.opts.setDefault) {
    params.runtime.log(`Default model set to ${OPENAI_CODEX_DEFAULT_MODEL}`);
  } else {
    params.runtime.log(
      `Default model available: ${OPENAI_CODEX_DEFAULT_MODEL} (use --set-default to apply)`,
    );
  }
}

export async function modelsAuthLoginCommand(opts: LoginOptions, runtime: RuntimeEnv) {
  if (!process.stdin.isTTY) {
    throw new Error("models auth login requires an interactive TTY.");
  }

  const config = await loadValidConfigOrThrow();
  const defaultAgentId = resolveDefaultAgentId(config);
  const agentDir = resolveAgentDir(config, defaultAgentId);
  const workspaceDir =
    resolveAgentWorkspaceDir(config, defaultAgentId) ?? resolveDefaultAgentWorkspaceDir();
  const requestedProviderId = normalizeProviderId(String(opts.provider ?? ""));
  const prompter = createClackPrompter();

  if (requestedProviderId === "openai-codex") {
    await clearStaleProfileLockouts("openai-codex", agentDir);
    await runBuiltInOpenAICodexLogin({
      opts,
      runtime,
      prompter,
      agentDir,
    });
    return;
  }

  const providers = resolvePluginProviders({ config, workspaceDir });
  if (providers.length === 0) {
    throw new Error(
      `No provider plugins found. Install one via \`${formatCliCommand("openclaw plugins install")}\`.`,
    );
  }

  const requestedProvider = resolveRequestedLoginProviderOrThrow(providers, opts.provider);
  const selectedProvider =
    requestedProvider ??
    (await prompter
      .select({
        message: "Select a provider",
        options: providers.map((provider) => ({
          value: provider.id,
          label: provider.label,
          hint: provider.docsPath ? `Docs: ${provider.docsPath}` : undefined,
        })),
      })
      .then((id) => resolveProviderMatch(providers, String(id))));

  if (!selectedProvider) {
    throw new Error("Unknown provider. Use --provider <id> to pick a provider plugin.");
  }

  await clearStaleProfileLockouts(selectedProvider.id, agentDir);

  const chosenMethod =
    pickAuthMethod(selectedProvider, opts.method) ??
    (selectedProvider.auth.length === 1
      ? selectedProvider.auth[0]
      : await prompter
          .select({
            message: `Auth method for ${selectedProvider.label}`,
            options: selectedProvider.auth.map((method) => ({
              value: method.id,
              label: method.label,
              hint: method.hint,
            })),
          })
          .then((id) => selectedProvider.auth.find((method) => method.id === String(id))));

  if (!chosenMethod) {
    throw new Error("Unknown auth method. Use --method <id> to select one.");
  }

  const isRemote = isRemoteEnvironment();
  const result: ProviderAuthResult = await chosenMethod.run({
    config,
    agentDir,
    workspaceDir,
    prompter,
    runtime,
    isRemote,
    openUrl: async (url) => {
      await openUrl(url);
    },
    oauth: {
      createVpsAwareHandlers: (params) => createVpsAwareOAuthHandlers(params),
    },
  });

  for (const profile of result.profiles) {
    upsertAuthProfile({
      profileId: profile.profileId,
      credential: profile.credential,
      agentDir,
    });
  }

  await updateConfig((cfg) => {
    let next = cfg;
    if (result.configPatch) {
      next = mergeConfigPatch(next, result.configPatch);
    }
    for (const profile of result.profiles) {
      next = applyAuthProfileConfig(next, {
        profileId: profile.profileId,
        provider: profile.credential.provider,
        mode: credentialMode(profile.credential),
      });
    }
    if (opts.setDefault && result.defaultModel) {
      next = applyDefaultModel(next, result.defaultModel);
    }
    return next;
  });

  logConfigUpdated(runtime);
  for (const profile of result.profiles) {
    runtime.log(
      `Auth profile: ${profile.profileId} (${profile.credential.provider}/${credentialMode(profile.credential)})`,
    );
  }
  if (result.defaultModel) {
    runtime.log(
      opts.setDefault
        ? `Default model set to ${result.defaultModel}`
        : `Default model available: ${result.defaultModel} (use --set-default to apply)`,
    );
  }
  if (result.notes && result.notes.length > 0) {
    await prompter.note(result.notes.join("\n"), "Provider notes");
  }
}
