import { upsertAuthProfile } from "../agents/auth-profiles/profiles.js";
import { createLazyRuntimeSurface } from "../shared/lazy-runtime.js";
import { normalizeOptionalString } from "../shared/string-coerce.js";
import { normalizeStringEntries } from "../shared/string-normalization.js";
import { normalizeOptionalSecretInput } from "../utils/normalize-secret-input.js";
const loadProviderApiKeyAuthRuntime = createLazyRuntimeSurface(() => import("./provider-api-key-auth.runtime.js"), ({ providerApiKeyAuthRuntime }) => providerApiKeyAuthRuntime);
function resolveStringOption(opts, optionKey) {
    return normalizeOptionalSecretInput(opts?.[optionKey]);
}
function resolveProfileId(params) {
    return normalizeOptionalString(params.profileId) || `${params.providerId}:default`;
}
function resolveProfileIds(params) {
    const explicit = Array.from(new Set(normalizeStringEntries(params.profileIds ?? [])));
    if (explicit.length > 0) {
        return explicit;
    }
    return [resolveProfileId(params)];
}
async function applyApiKeyConfig(params) {
    const { applyAuthProfileConfig, applyPrimaryModel } = await loadProviderApiKeyAuthRuntime();
    let next = params.ctx.config;
    for (const profileId of params.profileIds) {
        next = applyAuthProfileConfig(next, {
            profileId,
            provider: normalizeOptionalString(profileId.split(":", 1)[0]) || params.providerId,
            mode: "api_key",
        });
    }
    if (params.applyConfig) {
        next = params.applyConfig(next);
    }
    return params.defaultModel ? applyPrimaryModel(next, params.defaultModel) : next;
}
export function createProviderApiKeyAuthMethod(params) {
    return {
        id: params.methodId,
        label: params.label,
        hint: params.hint,
        kind: "api_key",
        wizard: params.wizard,
        run: async (ctx) => {
            const opts = ctx.opts;
            const flagValue = resolveStringOption(opts, params.optionKey);
            let capturedSecretInput;
            let capturedCredential = false;
            let capturedMode;
            const { buildApiKeyCredential, ensureApiKeyFromOptionEnvOrPrompt, normalizeApiKeyInput, validateApiKeyInput, } = await loadProviderApiKeyAuthRuntime();
            await ensureApiKeyFromOptionEnvOrPrompt({
                token: flagValue ?? normalizeOptionalSecretInput(ctx.opts?.token),
                tokenProvider: flagValue
                    ? params.providerId
                    : normalizeOptionalSecretInput(ctx.opts?.tokenProvider),
                secretInputMode: ctx.allowSecretRefPrompt === false
                    ? (ctx.secretInputMode ?? "plaintext")
                    : ctx.secretInputMode,
                config: ctx.config,
                env: ctx.env,
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
                    credential: buildApiKeyCredential(normalizeOptionalString(profileId.split(":", 1)[0]) || params.providerId, credentialInput, params.metadata, capturedMode
                        ? {
                            secretInputMode: capturedMode,
                            config: ctx.config,
                        }
                        : undefined),
                })),
                ...(params.applyConfig ? { configPatch: params.applyConfig(ctx.config) } : {}),
                ...(params.defaultModel ? { defaultModel: params.defaultModel } : {}),
            };
        },
        runNonInteractive: async (ctx) => {
            const opts = ctx.opts;
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
                        provider: normalizeOptionalString(profileId.split(":", 1)[0]) || params.providerId,
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
            return await applyApiKeyConfig({
                ctx,
                providerId: params.providerId,
                profileIds,
                defaultModel: params.defaultModel,
                applyConfig: params.applyConfig,
            });
        },
    };
}
