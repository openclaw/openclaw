import { modelKey } from "../agents/model-selection.js";
import { ensureApiKeyFromEnvOrPrompt } from "../plugins/provider-auth-input.js";
import { OLLAMA_DEFAULT_BASE_URL } from "../plugins/provider-model-defaults.js";
import { fetchWithTimeout } from "../utils/fetch-timeout.js";
import { normalizeSecretInput } from "../utils/normalize-secret-input.js";
import { applyCustomApiConfig, buildAnthropicVerificationProbeRequest, buildEndpointIdFromUrl, buildOpenAiVerificationProbeRequest, normalizeEndpointId, normalizeOptionalProviderApiKey, resolveCustomModelAliasError, resolveCustomProviderId, } from "./onboard-custom-config.js";
export { applyCustomApiConfig, buildAnthropicVerificationProbeRequest, buildOpenAiVerificationProbeRequest, CustomApiError, parseNonInteractiveCustomApiFlags, resolveCustomProviderId, } from "./onboard-custom-config.js";
const VERIFY_TIMEOUT_MS = 30_000;
const COMPATIBILITY_OPTIONS = [
    {
        value: "openai",
        label: "OpenAI-compatible",
        hint: "Uses /chat/completions",
    },
    {
        value: "anthropic",
        label: "Anthropic-compatible",
        hint: "Uses /messages",
    },
    {
        value: "unknown",
        label: "Unknown (detect automatically)",
        hint: "Probes OpenAI then Anthropic endpoints",
    },
];
function formatVerificationError(error) {
    if (!error) {
        return "unknown error";
    }
    if (error instanceof Error) {
        return error.message;
    }
    if (typeof error === "string") {
        return error;
    }
    try {
        return JSON.stringify(error);
    }
    catch {
        return "unknown error";
    }
}
async function requestVerification(params) {
    try {
        const res = await fetchWithTimeout(params.endpoint, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                ...params.headers,
            },
            body: JSON.stringify(params.body),
        }, VERIFY_TIMEOUT_MS);
        return { ok: res.ok, status: res.status };
    }
    catch (error) {
        return { ok: false, error };
    }
}
async function requestOpenAiVerification(params) {
    return await requestVerification(buildOpenAiVerificationProbeRequest(params));
}
async function requestAnthropicVerification(params) {
    return await requestVerification(buildAnthropicVerificationProbeRequest(params));
}
async function promptBaseUrlAndKey(params) {
    const baseUrlInput = await params.prompter.text({
        message: "API Base URL",
        initialValue: params.initialBaseUrl ?? OLLAMA_DEFAULT_BASE_URL,
        placeholder: "https://api.example.com/v1",
        validate: (val) => {
            return URL.canParse(val) ? undefined : "Please enter a valid URL (e.g. http://...)";
        },
    });
    const baseUrl = baseUrlInput.trim();
    const providerHint = buildEndpointIdFromUrl(baseUrl) || "custom";
    let apiKeyInput;
    const resolvedApiKey = await ensureApiKeyFromEnvOrPrompt({
        config: params.config,
        provider: providerHint,
        envLabel: "CUSTOM_API_KEY",
        promptMessage: "API Key (leave blank if not required)",
        normalize: normalizeSecretInput,
        validate: () => undefined,
        prompter: params.prompter,
        secretInputMode: params.secretInputMode,
        setCredential: async (apiKey) => {
            apiKeyInput = apiKey;
        },
    });
    return {
        baseUrl,
        apiKey: normalizeOptionalProviderApiKey(apiKeyInput),
        resolvedApiKey: normalizeSecretInput(resolvedApiKey),
    };
}
async function promptCustomApiRetryChoice(prompter) {
    return await prompter.select({
        message: "What would you like to change?",
        options: [
            { value: "baseUrl", label: "Change base URL" },
            { value: "model", label: "Change model" },
            { value: "both", label: "Change base URL and model" },
        ],
    });
}
async function promptCustomApiModelId(prompter) {
    return (await prompter.text({
        message: "Model ID",
        placeholder: "e.g. llama3, claude-3-7-sonnet",
        validate: (val) => (val.trim() ? undefined : "Model ID is required"),
    })).trim();
}
async function applyCustomApiRetryChoice(params) {
    let { baseUrl, apiKey, resolvedApiKey, modelId } = params.current;
    if (params.retryChoice === "baseUrl" || params.retryChoice === "both") {
        const retryInput = await promptBaseUrlAndKey({
            prompter: params.prompter,
            config: params.config,
            secretInputMode: params.secretInputMode,
            initialBaseUrl: baseUrl,
        });
        baseUrl = retryInput.baseUrl;
        apiKey = retryInput.apiKey;
        resolvedApiKey = retryInput.resolvedApiKey;
    }
    if (params.retryChoice === "model" || params.retryChoice === "both") {
        modelId = await promptCustomApiModelId(params.prompter);
    }
    return { baseUrl, apiKey, resolvedApiKey, modelId };
}
export async function promptCustomApiConfig(params) {
    const { prompter, runtime, config } = params;
    const baseInput = await promptBaseUrlAndKey({
        prompter,
        config,
        secretInputMode: params.secretInputMode,
    });
    let baseUrl = baseInput.baseUrl;
    let apiKey = baseInput.apiKey;
    let resolvedApiKey = baseInput.resolvedApiKey;
    const compatibilityChoice = await prompter.select({
        message: "Endpoint compatibility",
        options: COMPATIBILITY_OPTIONS.map((option) => ({
            value: option.value,
            label: option.label,
            hint: option.hint,
        })),
    });
    let modelId = await promptCustomApiModelId(prompter);
    let compatibility = compatibilityChoice === "unknown" ? null : compatibilityChoice;
    while (true) {
        let verifiedFromProbe = false;
        if (!compatibility) {
            const probeSpinner = prompter.progress("Detecting endpoint type...");
            const openaiProbe = await requestOpenAiVerification({
                baseUrl,
                apiKey: resolvedApiKey,
                modelId,
            });
            if (openaiProbe.ok) {
                probeSpinner.stop("Detected OpenAI-compatible endpoint.");
                compatibility = "openai";
                verifiedFromProbe = true;
            }
            else {
                const anthropicProbe = await requestAnthropicVerification({
                    baseUrl,
                    apiKey: resolvedApiKey,
                    modelId,
                });
                if (anthropicProbe.ok) {
                    probeSpinner.stop("Detected Anthropic-compatible endpoint.");
                    compatibility = "anthropic";
                    verifiedFromProbe = true;
                }
                else {
                    probeSpinner.stop("Could not detect endpoint type.");
                    await prompter.note("This endpoint did not respond to OpenAI or Anthropic style requests.", "Endpoint detection");
                    const retryChoice = await promptCustomApiRetryChoice(prompter);
                    ({ baseUrl, apiKey, resolvedApiKey, modelId } = await applyCustomApiRetryChoice({
                        prompter,
                        config,
                        secretInputMode: params.secretInputMode,
                        retryChoice,
                        current: { baseUrl, apiKey, resolvedApiKey, modelId },
                    }));
                    continue;
                }
            }
        }
        if (verifiedFromProbe) {
            break;
        }
        const verifySpinner = prompter.progress("Verifying...");
        const result = compatibility === "anthropic"
            ? await requestAnthropicVerification({ baseUrl, apiKey: resolvedApiKey, modelId })
            : await requestOpenAiVerification({ baseUrl, apiKey: resolvedApiKey, modelId });
        if (result.ok) {
            verifySpinner.stop("Verification successful.");
            break;
        }
        if (result.status !== undefined) {
            verifySpinner.stop(`Verification failed: status ${result.status}`);
        }
        else {
            verifySpinner.stop(`Verification failed: ${formatVerificationError(result.error)}`);
        }
        const retryChoice = await promptCustomApiRetryChoice(prompter);
        ({ baseUrl, apiKey, resolvedApiKey, modelId } = await applyCustomApiRetryChoice({
            prompter,
            config,
            secretInputMode: params.secretInputMode,
            retryChoice,
            current: { baseUrl, apiKey, resolvedApiKey, modelId },
        }));
        if (compatibilityChoice === "unknown") {
            compatibility = null;
        }
    }
    const suggestedId = buildEndpointIdFromUrl(baseUrl);
    const providerIdInput = await prompter.text({
        message: "Endpoint ID",
        initialValue: suggestedId,
        placeholder: "custom",
        validate: (value) => {
            const normalized = normalizeEndpointId(value);
            if (!normalized) {
                return "Endpoint ID is required.";
            }
            return undefined;
        },
    });
    const aliasInput = await prompter.text({
        message: "Model alias (optional)",
        placeholder: "e.g. local, ollama",
        initialValue: "",
        validate: (value) => {
            const resolvedProvider = resolveCustomProviderId({
                config,
                baseUrl,
                providerId: providerIdInput,
            });
            const modelRef = modelKey(resolvedProvider.providerId, modelId);
            return resolveCustomModelAliasError({ raw: value, cfg: config, modelRef });
        },
    });
    const resolvedCompatibility = compatibility ?? "openai";
    const result = applyCustomApiConfig({
        config,
        baseUrl,
        modelId,
        compatibility: resolvedCompatibility,
        apiKey,
        providerId: providerIdInput,
        alias: aliasInput,
    });
    if (result.providerIdRenamedFrom && result.providerId) {
        await prompter.note(`Endpoint ID "${result.providerIdRenamedFrom}" already exists for a different base URL. Using "${result.providerId}".`, "Endpoint ID");
    }
    runtime.log(`Configured custom provider: ${result.providerId}/${result.modelId}`);
    return result;
}
