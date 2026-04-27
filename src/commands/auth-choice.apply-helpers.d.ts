import type { ApplyAuthChoiceParams } from "./auth-choice.apply.types.js";
import { applyDefaultModelChoice } from "./auth-choice.default-model.js";
export type { SecretInputModePromptCopy, SecretRefSetupPromptCopy, } from "../plugins/provider-auth-input.js";
export { ensureApiKeyFromEnvOrPrompt, ensureApiKeyFromOptionEnvOrPrompt, maybeApplyApiKeyFromOption, normalizeSecretInputModeInput, normalizeTokenProviderInput, promptSecretRefForSetup, resolveSecretInputModeForEnvSelection, } from "../plugins/provider-auth-input.js";
export declare function createAuthChoiceAgentModelNoter(params: ApplyAuthChoiceParams): (model: string) => Promise<void>;
export interface ApplyAuthChoiceModelState {
    config: ApplyAuthChoiceParams["config"];
    agentModelOverride: string | undefined;
}
export declare function createAuthChoiceModelStateBridge(bindings: {
    getConfig: () => ApplyAuthChoiceParams["config"];
    setConfig: (config: ApplyAuthChoiceParams["config"]) => void;
    getAgentModelOverride: () => string | undefined;
    setAgentModelOverride: (model: string | undefined) => void;
}): ApplyAuthChoiceModelState;
export declare function createAuthChoiceDefaultModelApplier(params: ApplyAuthChoiceParams, state: ApplyAuthChoiceModelState): (options: Omit<Parameters<typeof applyDefaultModelChoice>[0], "config" | "setDefaultModel" | "noteAgentModel" | "prompter">) => Promise<void>;
export declare function createAuthChoiceDefaultModelApplierForMutableState(params: ApplyAuthChoiceParams, getConfig: () => ApplyAuthChoiceParams["config"], setConfig: (config: ApplyAuthChoiceParams["config"]) => void, getAgentModelOverride: () => string | undefined, setAgentModelOverride: (model: string | undefined) => void): ReturnType<typeof createAuthChoiceDefaultModelApplier>;
