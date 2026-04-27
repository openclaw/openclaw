import type { RuntimeEnv } from "../runtime.js";
import type { WizardPrompter } from "../wizard/prompts.js";
export type OAuthPrompt = {
    message: string;
    placeholder?: string;
};
export declare function createVpsAwareOAuthHandlers(params: {
    isRemote: boolean;
    prompter: WizardPrompter;
    runtime: RuntimeEnv;
    spin: ReturnType<WizardPrompter["progress"]>;
    openUrl: (url: string) => Promise<unknown>;
    localBrowserMessage: string;
    manualPromptMessage?: string;
}): {
    onAuth: (event: {
        url: string;
    }) => Promise<void>;
    onPrompt: (prompt: OAuthPrompt) => Promise<string>;
};
