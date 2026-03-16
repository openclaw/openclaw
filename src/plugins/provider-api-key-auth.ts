import { upsertAuthProfile } from "../agents/auth-profiles.js";
import { normalizeApiKeyInput, validateApiKeyInput } from "../commands/auth-choice.api-key.js";
import { ensureApiKeyFromOptionEnvOrPrompt } from "../commands/auth-choice.apply-helpers.js";
import { applyPrimaryModel } from "../commands/model-picker.js";
import { buildApiKeyCredential } from "../commands/onboard-auth.credentials.js";
import { applyAuthProfileConfig } from "../commands/onboard-auth.js";
import type { OpenClawConfig } from "../config/config.js";
import type { SecretInput } from "../config/types.secrets.js";
import { normalizeOptionalSecretInput } from "../utils/normalize-secret-input.js";
import type {
  ProviderAuthMethod,
  ProviderAuthMethodNonInteractiveContext,
  ProviderPluginWizardSetup,
} from "./types.js";

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
  profileId?: string;
  profileIds?: string[];
  allowProfile?: boolean;
  defaultModel?: string;
  expectedProviders?: string[];
  metadata?: Record<string, string>;
  noteMessage?: string;
  noteTitle?: string;
  applyConfig?: (cfg: OpenClawConfig) => OpenClawConfig;
};

function resolveStringOption(opts: Record<string, unknown> | undefined, optionKey: string) {
  return normalizeOptionalSecretInput(opts?.[optionKey]);
}

function resolveProfileId(params: { providerId: string; profileId?: string }) {
  return params.profileId?.trim() || `${params.providerId}:default`;
}

function resolveProfileIds(params: {
  providerId: string;
  profileId?: string;
  profileIds?: string[];
}) {
  const explicit = Array.from(
    new Set((params.profileIds ?? []).map((value) => value.trim()).filter(Boolean)),
  );
  if (explicit.length > 0) {
    return explicit;
  }
  return [resolveProfileId(params)];
}

function applyApiKeyConfig(params: {
  ctx: ProviderAuthMethodNonInteractiveContext;
  providerId: string;
  profileIds: string[];
  defaultModel?: string;
  applyConfig?: (cfg: OpenClawConfig) => OpenClawConfig;
}) {
  let next = params.ctx.config;
  for (const profileId of params.profileIds) {
    next = applyAuthProfileConfig(next, {
      profileId,
      provider: profileId.split(":", 1)[0]?.trim() || params.providerId,
      mode: "api_key",
    });
  }
  if (params.applyConfig) {
    next = params.applyConfig(next);
  }
  return params.defaultModel ? applyPrimaryModel(next, params.defaultModel) : next;
}

export function createProviderApiKeyAuthMethod(
  params: ProviderApiKeyAuthMethodOptions,
): ProviderAuthMethod {
  return {
    id: params.methodId,
    label: params.label,
    hint: params.hint,
    kind: "api_key",
    wizard: params.wizard,
    run: async (ctx) => {
      const opts = ctx.opts as Record<string, unknown> | undefined;
      const flagValue = resolveStringOption(opts, params.optionKey);
      let capturedSecretInput: SecretInput | undefined;
      let capturedCredential = false;
      let capturedMode: "plaintext" | "ref" | undefined;

      await ensureApiKeyFromOptionEnvOrPrompt({
        token: flagValue ?? normalizeOptionalSecretInput(ctx.opts?.token),
        tokenProvider: flagValue
          ? params.providerId
          : normalizeOptionalSecretInput(ctx.opts?.tokenProvider),
        secretInputMode:
          ctx.allowSecretRefPrompt === false
            ? (ctx.secretInputMode ?? "plaintext")
            : ctx.secretInputMode,
        config: ctx.config,
        expectedProviders: params.expectedProviders ?? [params.providerId],
        provider: params.providerId,
        envLabel: params.envVar,
        promptMessage: params.promptMessage,
        normalize: normalizeApiKeyInput,
        validate: validateApiKeyInput,
        prompter: ctx.prompter,
        noteMessage: params.noteMessage,
        noteTitle: params.noteTitle,
        setCredential: async (apiKey, mode) => {
          capturedSecretInput = apiKey;
          capturedCredential = true;
          capturedMode = mode;
        },
      });

      if (!capturedCredential) {
        throw new Error(`Missing API key input for provider "${params.providerId}".`);
      }
      const credentialInput = capturedSecretInput ?? "";
      const profileIds = resolveProfileIds(params);

      return {
        profiles: profileIds.map((profileId) => ({
          profileId,
          credential: buildApiKeyCredential(
            profileId.split(":", 1)[0]?.trim() || params.providerId,
            credentialInput,
            params.metadata,
            capturedMode ? { secretInputMode: capturedMode } : undefined,
          ),
        })),
        ...(params.applyConfig ? { configPatch: params.applyConfig(ctx.config) } : {}),
        ...(params.defaultModel ? { defaultModel: params.defaultModel } : {}),
      };
    },
    runNonInteractive: async (ctx) => {
      const opts = ctx.opts as Record<string, unknown> | undefined;
      const resolved = await ctx.resolveApiKey({
        provider: params.providerId,
        flagValue: resolveStringOption(opts, params.optionKey),
        flagName: params.flagName,
        envVar: params.envVar,
        ...(params.allowProfile === false ? { allowProfile: false } : {}),
      });
      if (!resolved) {
        return null;
      }

      const profileIds = resolveProfileIds(params);
      if (resolved.source !== "profile") {
        for (const profileId of profileIds) {
          const credential = ctx.toApiKeyCredential({
            provider: profileId.split(":", 1)[0]?.trim() || params.providerId,
            resolved,
            ...(params.metadata ? { metadata: params.metadata } : {}),
          });
          if (!credential) {
            return null;
          }
          upsertAuthProfile({
            profileId,
            credential,
            agentDir: ctx.agentDir,
          });
        }
      }

      return applyApiKeyConfig({
        ctx,
        providerId: params.providerId,
        profileIds,
        defaultModel: params.defaultModel,
        applyConfig: params.applyConfig,
      });
    },
  };
}
