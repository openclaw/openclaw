/** Coordinates provider OAuth flows exposed by plugin-owned auth integrations. */
import type { RuntimeEnv } from "../runtime.js";
import type { WizardPrompter } from "../wizard/prompts.js";

/** Prompt payload used when OAuth flow code entry needs user input. */
export type OAuthPrompt = { message: string; placeholder?: string; signal?: AbortSignal };

const validateRequiredInput = (value: string) => (value.trim().length > 0 ? undefined : "Required");

/** Creates OAuth callbacks that use local browser auth locally and manual code entry on VPS hosts. */
export function createVpsAwareOAuthHandlers(params: {
  isRemote: boolean;
  prompter: WizardPrompter;
  runtime: RuntimeEnv;
  spin: ReturnType<WizardPrompter["progress"]>;
  openUrl: (url: string) => Promise<unknown>;
  localBrowserMessage: string;
}): {
  onAuth: (event: { url: string }) => Promise<void>;
  onPrompt: (prompt: OAuthPrompt) => Promise<string>;
} {
  return {
    onAuth: async ({ url }) => {
      if (params.isRemote) {
        params.spin.stop("OAuth URL ready");
        params.runtime.log(`\nOpen this URL in your LOCAL browser:\n\n${url}\n`);
        return;
      }

      params.spin.update(params.localBrowserMessage);
      await params.openUrl(url);
      params.runtime.log(`Open: ${url}`);
    },
    onPrompt: async (prompt) => {
      const code = await params.prompter.text({
        message: prompt.message,
        placeholder: prompt.placeholder,
        signal: prompt.signal,
        validate: validateRequiredInput,
      });
      return code;
    },
  };
}
