/** Builds API-key provider auth methods that write profiles and config updates. */
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { normalizeUniqueStringEntries } from "@openclaw/normalization-core/string-normalization";
import { resolveAgentModelPrimaryValue } from "../config/model-input.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { SecretInput } from "../config/types.secrets.js";
import { normalizeOptionalSecretInput } from "../utils/normalize-secret-input.js";
import type {
  ProviderAuthContext,
  ProviderAuthMethod,
  ProviderAuthMethodNonInteractiveContext,
  ProviderNonInteractiveApiKeyCredentialParams,
  ProviderPluginWizardSetup,
} from "./types.js";

type ProviderAuthMethodNonInteractiveValidationContext = Parameters<
  NonNullable<ProviderAuthMethod["validateNonInteractive"]>
>[0];

type ProviderApiKeyAuthMethodOptions = {
  providerId: string;
  methodId: string;
  label: string;
  hint?: string;
  wizard?: ProviderPluginWizardSetup;
  optionKey: string;
  flagName: `--${string}`;
  envVar: string;
  promptMessage: string;
  validateApiKey?: (apiKey: string) => string | undefined;
  profileId?: string;
  profileIds?: string[];
  allowProfile?: boolean;
  defaultModel?: string;
  preserveExistingPrimary?: boolean;
  expectedProviders?: string[];
  metadata?: Record<string, string>;
  noteMessage?: string;
  noteTitle?: string;
  applyConfig?: (cfg: OpenClawConfig) => OpenClawConfig;
  resolveDefaultModel?: (params: {
    apiKey: string;
    config: OpenClawConfig;
    signal?: AbortSignal;
  }) => Promise<string | undefined>;
};

/** Captures the resolved key and its original storage input without persisting credentials. */
export async function captureProviderApiKey(
  ctx: Pick<
    ProviderAuthContext,
    "config" | "workspaceDir" | "prompter" | "secretInputMode" | "allowSecretRefPrompt"
  >,
  params: Omit<
    Parameters<typeof import("./provider-auth-input.js").ensureApiKeyFromOptionEnvOrPrompt>[0],
    | "config"
    | "workspaceDir"
    | "prompter"
    | "secretInputMode"
    | "normalize"
    | "validate"
    | "setCredential"
  > & { missingInputMessage?: string },
): Promise<{ apiKey: string; input: SecretInput; mode?: ProviderAuthContext["secretInputMode"] }> {
  const { missingInputMessage, ...inputOptions } = params;
  const { ensureApiKeyFromOptionEnvOrPrompt, normalizeApiKeyInput, validateApiKeyInput } =
    await import("./provider-api-key-auth.runtime.js");
  let input: SecretInput | undefined;
  let mode: ProviderAuthContext["secretInputMode"];
  let captured = false;
  const apiKey = await ensureApiKeyFromOptionEnvOrPrompt({
    ...inputOptions,
    config: ctx.config,
    workspaceDir: ctx.workspaceDir,
    prompter: ctx.prompter,
    secretInputMode:
      ctx.allowSecretRefPrompt === false
        ? (ctx.secretInputMode ?? "plaintext")
        : ctx.secretInputMode,
    normalize: normalizeApiKeyInput,
    validate: validateApiKeyInput,
    setCredential: async (credential, selectedMode) => {
      input = credential;
      mode = selectedMode;
      captured = true;
    },
  });
  if (!captured) {
    throw new Error(
      missingInputMessage ?? `Missing API key input for provider "${params.provider}".`,
    );
  }
  return { apiKey, input: input ?? "", mode };
}

/** Persists a newly supplied key; existing profiles retain their stored credential and metadata. */
export async function persistProviderApiKey(
  ctx: Pick<ProviderAuthMethodNonInteractiveContext, "toApiKeyCredential" | "agentDir">,
  profileId: string,
  params: ProviderNonInteractiveApiKeyCredentialParams,
): Promise<boolean> {
  if (params.resolved.source === "profile") {
    return true;
  }
  const credential = ctx.toApiKeyCredential(params);
  if (!credential) {
    return false;
  }
  const { upsertAuthProfileWithLockOrThrow } = await import("./provider-api-key-auth.runtime.js");
  await upsertAuthProfileWithLockOrThrow({
    profileId,
    credential,
    agentDir: ctx.agentDir,
  });
  return true;
}

function resolveProfileIds(params: {
  providerId: string;
  profileId?: string;
  profileIds?: string[];
}) {
  const explicit = normalizeUniqueStringEntries(params.profileIds ?? []);
  if (explicit.length > 0) {
    return explicit;
  }
  return [normalizeOptionalString(params.profileId) || `${params.providerId}:default`];
}

async function resolveDefaultModel(
  params: ProviderApiKeyAuthMethodOptions,
  context: { apiKey: string; config: OpenClawConfig; signal?: AbortSignal },
): Promise<string | undefined> {
  if (!params.resolveDefaultModel) {
    return params.defaultModel;
  }
  try {
    return await params.resolveDefaultModel(context);
  } catch {
    // Key-scoped discovery improves the first-run default, but an advisory
    // catalog outage must not discard credentials or block onboarding.
    context.signal?.throwIfAborted();
    return params.defaultModel;
  }
}

/** Creates a provider auth method that captures, stores, and configures API-key credentials. */
export function createProviderApiKeyAuthMethod(
  params: ProviderApiKeyAuthMethodOptions,
): ProviderAuthMethod {
  const assertValidApiKey = (apiKey: string) => {
    const error = params.validateApiKey?.(apiKey);
    if (error) {
      throw new Error(error);
    }
  };
  const resolveNonInteractiveCredential = async (
    ctx: ProviderAuthMethodNonInteractiveValidationContext,
  ) => {
    const resolved = await ctx.resolveApiKey({
      provider: params.providerId,
      flagValue: normalizeOptionalSecretInput(ctx.opts?.[params.optionKey]),
      flagName: params.flagName,
      envVar: params.envVar,
      ...(params.allowProfile === false ? { allowProfile: false } : {}),
    });
    if (resolved) {
      assertValidApiKey(resolved.key);
    }
    return resolved;
  };
  return {
    id: params.methodId,
    label: params.label,
    hint: params.hint,
    kind: "api_key",
    starterModel: params.defaultModel,
    wizard: params.wizard,
    run: async (ctx) => {
      const flagValue = normalizeOptionalSecretInput(ctx.opts?.[params.optionKey]);
      const { buildApiKeyCredential } = await import("./provider-api-key-auth.runtime.js");
      const { apiKey, input, mode } = await captureProviderApiKey(ctx, {
        token: flagValue ?? normalizeOptionalSecretInput(ctx.opts?.token),
        tokenProvider: flagValue
          ? params.providerId
          : normalizeOptionalSecretInput(ctx.opts?.tokenProvider),
        env: ctx.env,
        expectedProviders: params.expectedProviders ?? [params.providerId],
        provider: params.providerId,
        envLabel: params.envVar,
        promptMessage: params.promptMessage,
        noteMessage: params.noteMessage,
        noteTitle: params.noteTitle,
      });
      assertValidApiKey(apiKey);
      const profileIds = resolveProfileIds(params);
      const defaultModel = await resolveDefaultModel(params, {
        apiKey,
        config: ctx.config,
        ...(ctx.signal ? { signal: ctx.signal } : {}),
      });

      return {
        profiles: profileIds.map((profileId) => ({
          profileId,
          credential: buildApiKeyCredential(
            normalizeOptionalString(profileId.split(":", 1)[0]) || params.providerId,
            input,
            params.metadata,
            mode
              ? {
                  secretInputMode: mode,
                  config: ctx.config,
                }
              : undefined,
          ),
        })),
        ...(params.applyConfig ? { configPatch: params.applyConfig(ctx.config) } : {}),
        ...(defaultModel ? { defaultModel } : {}),
      };
    },
    validateNonInteractive: async (ctx) => Boolean(await resolveNonInteractiveCredential(ctx)),
    runNonInteractive: async (ctx) => {
      const resolved = await resolveNonInteractiveCredential(ctx);
      if (!resolved) {
        return null;
      }

      const profileIds = resolveProfileIds(params);
      for (const profileId of profileIds) {
        if (
          !(await persistProviderApiKey(ctx, profileId, {
            provider: normalizeOptionalString(profileId.split(":", 1)[0]) || params.providerId,
            resolved,
            ...(params.metadata ? { metadata: params.metadata } : {}),
          }))
        ) {
          return null;
        }
      }

      const defaultModel = await resolveDefaultModel(params, {
        apiKey: resolved.key,
        config: ctx.config,
      });
      const { applyAuthProfileConfig, applyPrimaryModel } =
        await import("./provider-api-key-auth.runtime.js");
      let next = ctx.config;
      for (const profileId of profileIds) {
        next = applyAuthProfileConfig(next, {
          profileId,
          provider: normalizeOptionalString(profileId.split(":", 1)[0]) || params.providerId,
          mode: "api_key",
        });
      }
      if (params.applyConfig) {
        next = params.applyConfig(next);
      }
      return defaultModel &&
        !(
          params.preserveExistingPrimary === true &&
          resolveAgentModelPrimaryValue(next.agents?.defaults?.model) !== undefined
        )
        ? applyPrimaryModel(next, defaultModel)
        : next;
    },
  };
}
