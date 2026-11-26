import { formatErrorMessage } from "../infra/errors.js";
import { parseOAuthAuthorizationInput } from "../plugin-sdk/provider-oauth-runtime.js";
import type { RuntimeEnv } from "../runtime.js";
import type { WizardPrompter } from "../wizard/prompts.js";

/** Prompt payload used when OAuth flow code entry needs user input. */
type OAuthPrompt = { message: string; placeholder?: string };

/** Creates OAuth callbacks that use local browser auth locally and manual code entry on VPS hosts. */
export function createVpsAwareOAuthHandlers(params: {
  isRemote: boolean;
  prompter: WizardPrompter;
  runtime: RuntimeEnv;
  spin: ReturnType<WizardPrompter["progress"]>;
  openUrl: (url: string) => Promise<unknown>;
  localBrowserMessage: string;
  manualPromptMessage?: string;
  manualPromptSignal?: AbortSignal;
}): {
  onAuth: (event: { url: string }) => Promise<void>;
  onPrompt: (prompt: OAuthPrompt) => Promise<string>;
} {
  const manualPromptMessage = params.manualPromptMessage ?? "Paste the redirect URL";
  // Remote hosts cannot open the user's browser, so auth starts in onAuth and finishes in onPrompt.
  let manualCodePromise: Promise<string> | undefined;
  let authUrl: URL | undefined;
  // Plain text: PKCE makes the pasted code useless to anyone without this attempt's verifier.
  const promptForAuthorization = (prompt: OAuthPrompt) => {
    const redirectUri = authUrl?.searchParams.get("redirect_uri");
    return params.prompter.text({
      message: prompt.message,
      placeholder:
        prompt.placeholder ?? (redirectUri ? `${redirectUri}?code=...&state=...` : undefined),
      signal: params.manualPromptSignal,
      validate: (value) => {
        try {
          parseOAuthAuthorizationInput(value, {
            state: authUrl?.searchParams.get("state") ?? undefined,
            signInUrl: authUrl?.href,
          });
          return undefined;
        } catch (error) {
          return formatErrorMessage(error);
        }
      },
    });
  };

  return {
    onAuth: async ({ url }) => {
      authUrl = URL.parse(url) ?? undefined;
      if (params.isRemote) {
        params.spin.stop("OAuth URL ready");
        // Terminal sign-in has no browser link of its own; the Gateway carries the URL on the step.
        params.runtime.log(`\nOpen this URL in your LOCAL browser:\n\n${url}\n`);
        await params.openUrl(url);
        manualCodePromise = promptForAuthorization({ message: manualPromptMessage });
        // Cancellation can win before the provider requests this already-open prompt.
        void manualCodePromise.catch(() => {});
        return;
      }

      params.spin.update(params.localBrowserMessage);
      await params.openUrl(url);
      params.runtime.log(`Open: ${url}`);
    },
    onPrompt: async (prompt) => manualCodePromise ?? (await promptForAuthorization(prompt)),
  };
}
