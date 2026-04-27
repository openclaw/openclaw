import type { ApplyAuthChoiceParams, ApplyAuthChoiceResult } from "./auth-choice.apply.types.js";
import type { AuthChoice } from "./onboard-types.js";
export declare function normalizeApiKeyTokenProviderAuthChoice(params: {
    authChoice: AuthChoice;
    tokenProvider?: string;
    config?: ApplyAuthChoiceParams["config"];
    workspaceDir?: string;
    env?: NodeJS.ProcessEnv;
}): AuthChoice;
export declare function applyAuthChoiceApiProviders(_params: ApplyAuthChoiceParams): Promise<ApplyAuthChoiceResult | null>;
