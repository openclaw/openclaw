import { upsertAuthProfile } from "../agents/auth-profiles.js";
import { normalizeApiKeyInput, validateApiKeyInput } from "../commands/auth-choice.api-key.js";
import { ensureApiKeyFromOptionEnvOrPrompt } from "../commands/auth-choice.apply-helpers.js";
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

function applyApiKeyConfig(params: {
  ctx: ProviderAuthMethodNonInteractiveContext;
  providerId: string;
  profileId: string;
  applyConfig?: (cfg: OpenClawConfig) => OpenClawConfig;
}) {
  const next = applyAuthProfileConfig(params.ctx.config, {
    profileId: params.profileId,
    provider: params.providerId,
    mode: "api_key",
  });
  return params.applyConfig ? params.applyConfig(next) : next;
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

      return {
        profiles: [
          {
            profileId: resolveProfileId(params),
            credential: buildApiKeyCredential(
              params.providerId,
              credentialInput,
              params.metadata,
              capturedMode ? { secretInputMode: capturedMode } : undefined,
            ),
          },
        ],
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
      });
      if (!resolved) {
        return null;
      }

      const profileId = resolveProfileId(params);
      if (resolved.source !== "profile") {
        const credential = ctx.toApiKeyCredential({
          provider: params.providerId,
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

      return applyApiKeyConfig({
        ctx,
        providerId: params.providerId,
        profileId,
        applyConfig: params.applyConfig,
      });
    },
  };
}
