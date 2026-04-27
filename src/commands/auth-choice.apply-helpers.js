import { applyDefaultModelChoice } from "./auth-choice.default-model.js";
export { ensureApiKeyFromEnvOrPrompt, ensureApiKeyFromOptionEnvOrPrompt, maybeApplyApiKeyFromOption, normalizeSecretInputModeInput, normalizeTokenProviderInput, promptSecretRefForSetup, resolveSecretInputModeForEnvSelection, } from "../plugins/provider-auth-input.js";
export function createAuthChoiceAgentModelNoter(params) {
    return async (model) => {
        if (!params.agentId) {
            return;
        }
        await params.prompter.note(`Default model set to ${model} for agent "${params.agentId}".`, "Model configured");
    };
}
export function createAuthChoiceModelStateBridge(bindings) {
    return {
        get config() {
            return bindings.getConfig();
        },
        set config(config) {
            bindings.setConfig(config);
        },
        get agentModelOverride() {
            return bindings.getAgentModelOverride();
        },
        set agentModelOverride(model) {
            bindings.setAgentModelOverride(model);
        },
    };
}
export function createAuthChoiceDefaultModelApplier(params, state) {
    const noteAgentModel = createAuthChoiceAgentModelNoter(params);
    return async (options) => {
        const applied = await applyDefaultModelChoice({
            config: state.config,
            setDefaultModel: params.setDefaultModel,
            noteAgentModel,
            prompter: params.prompter,
            ...options,
        });
        state.config = applied.config;
        state.agentModelOverride = applied.agentModelOverride ?? state.agentModelOverride;
    };
}
export function createAuthChoiceDefaultModelApplierForMutableState(params, getConfig, setConfig, getAgentModelOverride, setAgentModelOverride) {
    return createAuthChoiceDefaultModelApplier(params, createAuthChoiceModelStateBridge({
        getConfig,
        setConfig,
        getAgentModelOverride,
        setAgentModelOverride,
    }));
}
