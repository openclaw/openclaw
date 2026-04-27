import { resolveProviderMatch } from "../plugins/provider-auth-choice-helpers.js";
import { resolvePluginProviders } from "../plugins/provider-auth-choice.runtime.js";
import { normalizeTokenProviderInput } from "./auth-choice.apply-helpers.js";
function resolveProviderAuthChoiceByKind(params) {
    const provider = resolveProviderMatch(resolvePluginProviders({
        config: params.config,
        workspaceDir: params.workspaceDir,
        env: params.env,
        mode: "setup",
    }), params.providerId);
    const choiceId = provider?.auth.find((method) => method.kind === params.kind)?.wizard?.choiceId;
    return choiceId;
}
export function normalizeApiKeyTokenProviderAuthChoice(params) {
    if (!params.tokenProvider) {
        return params.authChoice;
    }
    const normalizedTokenProvider = normalizeTokenProviderInput(params.tokenProvider);
    if (!normalizedTokenProvider) {
        return params.authChoice;
    }
    if (params.authChoice === "token" || params.authChoice === "setup-token") {
        return (resolveProviderAuthChoiceByKind({
            providerId: normalizedTokenProvider,
            kind: "token",
            config: params.config,
            workspaceDir: params.workspaceDir,
            env: params.env,
        }) ?? params.authChoice);
    }
    if (params.authChoice !== "apiKey") {
        return params.authChoice;
    }
    return (resolveProviderAuthChoiceByKind({
        providerId: normalizedTokenProvider,
        kind: "api_key",
        config: params.config,
        workspaceDir: params.workspaceDir,
        env: params.env,
    }) ?? params.authChoice);
}
export async function applyAuthChoiceApiProviders(_params) {
    return null;
}
