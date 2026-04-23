import type { RuntimeEnv } from "../runtime.js";
import type { WizardPrompter } from "../wizard/prompts.js";

export type OAuthPrompt = { message: string; placeholder?: string };

const validateRequiredInput = (value: string) => (value.trim().length > 0 ? undefined : "Required");

export function createVpsAwareOAuthHandlers(params: {
  isRemote: boolean;
  prompter: WizardPrompter;
  runtime: RuntimeEnv;
  spin: ReturnType<WizardPrompter["progress"]>;
  openUrl: (url: string) => Promise<unknown>;
  localBrowserMessage: string;
  manualPromptMessage?: string;
}): {
  onAuth: (event: { url: string }) => Promise<void>;
  onPrompt: (prompt: OAuthPrompt) => Promise<string>;
} {
  const manualPromptMessage = params.manualPromptMessage ?? "Paste the redirect URL";
  let manualCodePromise: Promise<string> | undefined;
  const ensureManualPrompt = (prompt?: OAuthPrompt) => {
    manualCodePromise ??= params.prompter.text({
      message: prompt?.message ?? manualPromptMessage,
      placeholder: prompt?.placeholder,
      validate: validateRequiredInput,
    });
    return manualCodePromise;
  };

  return {
    onAuth: async ({ url }) => {
      if (params.isRemote) {
        params.spin.stop("OAuth URL ready");
        params.runtime.log(`\nOpen this URL in your LOCAL browser:\n\n${url}\n`);
        manualCodePromise = ensureManualPrompt();
        return;
      }

      params.spin.update(params.localBrowserMessage);
      let opened: unknown;
      try {
        opened = await params.openUrl(url);
      } catch {
        opened = false;
      }
      if (opened !== true) {
        params.spin.update(
          "Could not open a browser automatically. Open the URL below, then paste the redirect URL here…",
        );
        params.runtime.log(`\nOpen this URL in your browser:\n\n${url}\n`);
        manualCodePromise = ensureManualPrompt();
        return;
      }
      params.runtime.log(`Open: ${url}`);
    },
    onPrompt: async (prompt) => {
      if (manualCodePromise) {
        return manualCodePromise;
      }
      return await ensureManualPrompt(prompt);
    },
  };
}
