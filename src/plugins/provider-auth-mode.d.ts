import type { WizardPrompter } from "../wizard/prompts.js";
import type { SecretInputMode } from "./provider-auth-types.js";
export type SecretInputModePromptCopy = {
    modeMessage?: string;
    plaintextLabel?: string;
    plaintextHint?: string;
    refLabel?: string;
    refHint?: string;
};
export declare function resolveSecretInputModeForEnvSelection(params: {
    prompter: Pick<WizardPrompter, "select">;
    explicitMode?: SecretInputMode;
    copy?: SecretInputModePromptCopy;
}): Promise<SecretInputMode>;
