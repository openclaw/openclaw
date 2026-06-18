/** Coordinates provider OAuth flows exposed by plugin-owned auth integrations. */
import type { RuntimeEnv } from "../runtime.js";
import type { WizardPrompter } from "../wizard/prompts.js";

/** Prompt payload used when OAuth flow code entry needs user input. */
export type OAuthPrompt = { message: string; placeholder?: string };

const validateRequiredInput = (value: string) => (value.trim().length > 0 ? undefined : "Required");

function withOAuthUrl(message: string, url: string): string {
  return ["Open this URL in your LOCAL browser:", "", url, "", message].join("\n");
}

/** Creates OAuth callbacks that use local browser auth locally and manual code entry on VPS hosts. */
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
  const manualPromptMessage =
    params.manualPromptMessage ?? "After signing in, paste the redirect URL here.";
  // Remote/headless hosts cannot open the user's browser, and a client that
  // presents the auth challenge in-band (e.g. the Windows companion over RPC)
  // cannot use a browser opened on the gateway host either. In both cases the
  // authorization URL must be surfaced in the prompt rather than auto-opened.
  const surfaceUrlInBand = params.isRemote || params.prompter.presentsAuthChallenge === true;
  // Manual flow starts in onAuth and finishes in onPrompt.
  let manualCodePromise: Promise<string> | undefined;
  let lastAuthUrl: string | undefined;

  return {
    onAuth: async ({ url }) => {
      lastAuthUrl = url;
      if (surfaceUrlInBand) {
        params.spin.stop("OAuth URL ready");
        params.runtime.log(`\nOpen this URL in your LOCAL browser:\n\n${url}\n`);
        manualCodePromise = params.prompter.text({
          message: withOAuthUrl(manualPromptMessage, url),
          validate: validateRequiredInput,
        });
        return;
      }

      params.spin.update(params.localBrowserMessage);
      await params.openUrl(url);
      params.runtime.log(`Open: ${url}`);
    },
    onPrompt: async (prompt) => {
      if (manualCodePromise) {
        return manualCodePromise;
      }
      const code = await params.prompter.text({
        message: lastAuthUrl ? withOAuthUrl(prompt.message, lastAuthUrl) : prompt.message,
        placeholder: prompt.placeholder,
        validate: validateRequiredInput,
      });
      return code;
    },
  };
}
