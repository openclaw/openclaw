import {
  loadAuthProfileStoreForInspection,
  resolveApiKeyForProfile,
  resolveAuthProfileOrder,
  type AuthProfileStore,
} from "../agents/auth-profiles.js";
import { resolveEnvApiKey } from "../agents/model-auth-env.js";
import { resolveUsableCustomProviderApiKey } from "../agents/model-auth.js";
import { normalizeProviderId } from "../agents/provider-id.js";
import type { OpenClawConfig } from "../config/types.js";
import {
  coerceSecretRef,
  parseEnvTemplateSecretRef,
  type SecretInput,
  type SecretRef,
} from "../config/types.secrets.js";
import { resolveDefaultSecretProviderAlias } from "../secrets/ref-contract.js";
import { resolveSecretRefString } from "../secrets/resolve.js";
import type { WizardPrompter } from "../wizard/prompts.js";
import {
  resolveSecretInputModeForEnvSelection,
  type SecretInputModePromptCopy,
} from "./provider-auth-mode.js";
import {
  extractEnvVarFromSourceLabel,
  promptSecretRefForSetup,
  resolveRefFallbackInput,
  type SecretRefSetupPromptCopy,
} from "./provider-auth-ref.js";
import type { SecretInputMode } from "./provider-auth-types.js";

export {
  extractEnvVarFromSourceLabel,
  promptSecretRefForSetup,
  resolveRefFallbackInput,
  type SecretRefSetupPromptCopy,
} from "./provider-auth-ref.js";
export {
  resolveSecretInputModeForEnvSelection,
  type SecretInputModePromptCopy,
} from "./provider-auth-mode.js";

const DEFAULT_KEY_PREVIEW = { head: 4, tail: 4 };

export function normalizeApiKeyInput(raw: string): string {
  const trimmed = String(raw ?? "").trim();
  if (!trimmed) {
    return "";
  }

  const assignmentMatch = trimmed.match(/^(?:export\s+)?[A-Za-z_][A-Za-z0-9_]*\s*=\s*(.+)$/);
  const valuePart = assignmentMatch ? assignmentMatch[1].trim() : trimmed;

  const unquoted =
    valuePart.length >= 2 &&
    ((valuePart.startsWith('"') && valuePart.endsWith('"')) ||
      (valuePart.startsWith("'") && valuePart.endsWith("'")) ||
      (valuePart.startsWith("`") && valuePart.endsWith("`")))
      ? valuePart.slice(1, -1)
      : valuePart;

  const withoutSemicolon = unquoted.endsWith(";") ? unquoted.slice(0, -1) : unquoted;

  return withoutSemicolon.trim();
}

export const validateApiKeyInput = (value: string) =>
  normalizeApiKeyInput(value).length > 0 ? undefined : "Required";

export function formatApiKeyPreview(
  raw: string,
  opts: { head?: number; tail?: number } = {},
): string {
  const trimmed = raw.trim();
  if (!trimmed) {
    return "…";
  }
  const head = opts.head ?? DEFAULT_KEY_PREVIEW.head;
  const tail = opts.tail ?? DEFAULT_KEY_PREVIEW.tail;
  if (trimmed.length <= head + tail) {
    const shortHead = Math.min(2, trimmed.length);
    const shortTail = Math.min(2, trimmed.length - shortHead);
    if (shortTail <= 0) {
      return `${trimmed.slice(0, shortHead)}…`;
    }
    return `${trimmed.slice(0, shortHead)}…${trimmed.slice(-shortTail)}`;
  }
  return `${trimmed.slice(0, head)}…${trimmed.slice(-tail)}`;
}

async function loadScopedAuthProfileStore(agentDir?: string): Promise<AuthProfileStore> {
  return loadAuthProfileStoreForInspection(agentDir);
}

function resolveProviderApiKeyRef(params: {
  config: OpenClawConfig;
  provider: string;
}): SecretRef | null {
  const providers = params.config.models?.providers ?? {};
  const providerEntry =
    providers[params.provider] ??
    Object.entries(providers).find(
      ([key]) => normalizeProviderId(key) === normalizeProviderId(params.provider),
    )?.[1];
  return coerceSecretRef(providerEntry?.apiKey, params.config.secrets?.defaults);
}

async function resolveExistingProviderApiKey(params: {
  config: OpenClawConfig;
  provider: string;
  reuseProviders?: string[];
  agentDir?: string;
  allowProfile?: boolean;
}): Promise<{ apiKey: string; source: string; credential: SecretInput } | null> {
  try {
    const providersToSearch = Array.from(
      new Set(
        [params.provider, ...(params.reuseProviders ?? [])]
          .map((provider) => provider.trim())
          .filter(Boolean),
      ),
    );
    const envKey = resolveEnvApiKey(params.provider);
    if (envKey) {
      return {
        apiKey: envKey.apiKey,
        source: envKey.source,
        credential: envKey.apiKey,
      };
    }

    if (params.allowProfile !== false) {
      const store = await loadScopedAuthProfileStore(params.agentDir);
      for (const provider of providersToSearch) {
        const orderedProfiles = resolveAuthProfileOrder({
          cfg: params.config,
          store,
          provider,
        });
        const candidateProfileIds = new Set<string>(orderedProfiles);

        for (const [profileId, profile] of Object.entries(store.profiles)) {
          if (profile?.type === "api_key" && profile.provider === provider) {
            candidateProfileIds.add(profileId);
          }
        }

        for (const profileId of candidateProfileIds) {
          const profile = store.profiles[profileId];
          if (profile?.type !== "api_key") {
            continue;
          }
          try {
            const resolved = await resolveApiKeyForProfile({
              cfg: params.config,
              store,
              profileId,
              agentDir: params.agentDir,
            });
            if (!resolved?.apiKey) {
              continue;
            }
            return {
              apiKey: resolved.apiKey,
              source: `profile:${profileId}`,
              credential: (() => {
                if (profile.keyRef) {
                  return profile.keyRef;
                }
                if (typeof profile.key === "string" && profile.key.trim().length > 0) {
                  const inlineEnvRef = parseEnvTemplateSecretRef(
                    profile.key,
                    resolveDefaultSecretProviderAlias(params.config, "env", {
                      preferFirstProviderForSource: true,
                    }),
                  );
                  return inlineEnvRef ?? profile.key;
                }
                return resolved.apiKey;
              })(),
            };
          } catch {
            continue;
          }
        }
      }
    }

    for (const provider of providersToSearch) {
      const configApiKeyRef = resolveProviderApiKeyRef({
        config: params.config,
        provider,
      });
      if (configApiKeyRef) {
        try {
          const resolvedValue = await resolveSecretRefString(configApiKeyRef, {
            config: params.config,
            env: process.env,
          });
          if (resolvedValue.trim()) {
            return {
              apiKey: resolvedValue,
              source: "models.json",
              credential: configApiKeyRef,
            };
          }
        } catch {
          // Fall through to other config-backed detection paths.
        }
      }

      const configApiKey = resolveUsableCustomProviderApiKey({
        cfg: params.config,
        provider,
        env: process.env,
      });
      if (configApiKey) {
        return {
          apiKey: configApiKey.apiKey,
          source: configApiKey.source,
          credential: configApiKey.apiKey,
        };
      }
    }

    return null;
  } catch {
    return null;
  }
}
export function normalizeTokenProviderInput(
  tokenProvider: string | null | undefined,
): string | undefined {
  const normalized = String(tokenProvider ?? "")
    .trim()
    .toLowerCase();
  return normalized || undefined;
}

export function normalizeSecretInputModeInput(
  secretInputMode: string | null | undefined,
): SecretInputMode | undefined {
  const normalized = String(secretInputMode ?? "")
    .trim()
    .toLowerCase();
  if (normalized === "plaintext" || normalized === "ref") {
    return normalized;
  }
  return undefined;
}

export async function maybeApplyApiKeyFromOption(params: {
  token: string | undefined;
  tokenProvider: string | undefined;
  secretInputMode?: SecretInputMode;
  expectedProviders: string[];
  normalize: (value: string) => string;
  setCredential: (apiKey: SecretInput, mode?: SecretInputMode) => Promise<void>;
}): Promise<string | undefined> {
  const tokenProvider = normalizeTokenProviderInput(params.tokenProvider);
  const expectedProviders = params.expectedProviders
    .map((provider) => normalizeTokenProviderInput(provider))
    .filter((provider): provider is string => Boolean(provider));
  if (!params.token || !tokenProvider || !expectedProviders.includes(tokenProvider)) {
    return undefined;
  }
  const apiKey = params.normalize(params.token);
  await params.setCredential(apiKey, params.secretInputMode);
  return apiKey;
}

export async function ensureApiKeyFromOptionEnvOrPrompt(params: {
  token: string | undefined;
  tokenProvider: string | undefined;
  secretInputMode?: SecretInputMode;
  config: OpenClawConfig;
  agentDir?: string;
  allowProfile?: boolean;
  expectedProviders: string[];
  reuseProviders?: string[];
  provider: string;
  envLabel: string;
  promptMessage: string;
  normalize: (value: string) => string;
  validate: (value: string) => string | undefined;
  prompter: WizardPrompter;
  setCredential: (apiKey: SecretInput, mode?: SecretInputMode) => Promise<void>;
  noteMessage?: string;
  noteTitle?: string;
}): Promise<string> {
  const optionApiKey = await maybeApplyApiKeyFromOption({
    token: params.token,
    tokenProvider: params.tokenProvider,
    secretInputMode: params.secretInputMode,
    expectedProviders: params.expectedProviders,
    normalize: params.normalize,
    setCredential: params.setCredential,
  });
  if (optionApiKey) {
    return optionApiKey;
  }

  if (params.noteMessage) {
    await params.prompter.note(params.noteMessage, params.noteTitle);
  }

  return await ensureApiKeyFromEnvOrPrompt({
    config: params.config,
    agentDir: params.agentDir,
    allowProfile: params.allowProfile,
    reuseProviders: params.reuseProviders ?? params.expectedProviders,
    provider: params.provider,
    envLabel: params.envLabel,
    promptMessage: params.promptMessage,
    normalize: params.normalize,
    validate: params.validate,
    prompter: params.prompter,
    secretInputMode: params.secretInputMode,
    setCredential: params.setCredential,
  });
}

export async function ensureApiKeyFromEnvOrPrompt(params: {
  config: OpenClawConfig;
  agentDir?: string;
  allowProfile?: boolean;
  reuseProviders?: string[];
  provider: string;
  envLabel: string;
  promptMessage: string;
  normalize: (value: string) => string;
  validate: (value: string) => string | undefined;
  prompter: WizardPrompter;
  secretInputMode?: SecretInputMode;
  setCredential: (apiKey: SecretInput, mode?: SecretInputMode) => Promise<void>;
}): Promise<string> {
  const selectedMode = await resolveSecretInputModeForEnvSelection({
    prompter: params.prompter,
    explicitMode: params.secretInputMode,
  });
  const envKey = resolveEnvApiKey(params.provider);
  const existingApiKey = await resolveExistingProviderApiKey({
    config: params.config,
    provider: params.provider,
    reuseProviders: params.reuseProviders,
    agentDir: params.agentDir,
    allowProfile: params.allowProfile,
  });

  if (selectedMode === "ref") {
    if (typeof params.prompter.select !== "function") {
      const fallback = resolveRefFallbackInput({
        config: params.config,
        provider: params.provider,
        preferredEnvVar: envKey?.source ? extractEnvVarFromSourceLabel(envKey.source) : undefined,
      });
      await params.setCredential(fallback.ref, selectedMode);
      return fallback.resolvedValue;
    }
    const resolved = await promptSecretRefForSetup({
      provider: params.provider,
      config: params.config,
      prompter: params.prompter,
      preferredEnvVar: envKey?.source ? extractEnvVarFromSourceLabel(envKey.source) : undefined,
    });
    await params.setCredential(resolved.ref, selectedMode);
    return resolved.resolvedValue;
  }

  if (existingApiKey && selectedMode === "plaintext") {
    const existingCredentialLabel =
      existingApiKey.source.startsWith("env:") || existingApiKey.source.startsWith("shell env:")
        ? params.envLabel
        : `${params.provider} credentials`;
    const useExisting = await params.prompter.confirm({
      message: `Use existing ${existingCredentialLabel} (${existingApiKey.source}, ${formatApiKeyPreview(existingApiKey.apiKey)})?`,
      initialValue: true,
    });
    if (useExisting) {
      await params.setCredential(existingApiKey.credential, selectedMode);
      return existingApiKey.apiKey;
    }
  }

  const key = await params.prompter.text({
    message: params.promptMessage,
    validate: params.validate,
  });
  const apiKey = params.normalize(String(key ?? ""));
  await params.setCredential(apiKey, selectedMode);
  return apiKey;
}
