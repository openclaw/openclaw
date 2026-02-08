import type { RuntimeEnv } from "../runtime.js";
import type { WizardPrompter } from "../wizard/prompts.js";

type OAuthPrompt = { message: string; placeholder?: string };

const validateRequiredInput = (value: string) => (value.trim().length > 0 ? undefined : "Required");

/**
 * Extracts authorization code from OAuth callback URL.
 * Handles both traditional redirect and manual paste scenarios.
 */
function extractAuthCodeFromUrl(urlOrCode: string): string {
  // If it looks like a URL, extract the code parameter
  if (urlOrCode.includes("?") || urlOrCode.includes("code=")) {
    try {
      const url = new URL(urlOrCode);
      const code = url.searchParams.get("code");
      if (code) return code;
    } catch {
      // Not a valid URL, treat as raw code
    }
  }
  // Return as-is if it's a raw authorization code
  return urlOrCode.trim();
}

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
    params.manualPromptMessage ?? "Paste the redirect URL (or authorization code)";
  let manualCodePromise: Promise<string> | undefined;
  let codeResolver: ((code: string) => void) | undefined;

  return {
    onAuth: async ({ url }) => {
      if (params.isRemote) {
        params.spin.stop("OAuth URL ready");
        params.runtime.log(
          `\nOpen this URL in your LOCAL browser:\n\n${url}\n` +
          `\nBrowser will show a success page after you authorize.\n` +
          `The authorization will be automatically detected or you can paste the redirect URL below.\n`
        );

        // Create a promise that can be resolved either by:
        // 1. Automatic callback detection (via onPrompt)
        // 2. Manual user paste (via prompter.text)
        // Whichever happens first wins
        manualCodePromise = new Promise<string>((resolve) => {
          codeResolver = resolve;

          // Start manual prompt as fallback with timeout
          // If callback is detected via onPrompt, this gets ignored
          setTimeout(() => {
            if (codeResolver === resolve) {
              // Still waiting, show manual prompt
              params.prompter
                .text({
                  message: manualPromptMessage,
                  validate: validateRequiredInput,
                })
                .then((value) => {
                  const code = extractAuthCodeFromUrl(String(value));
                  resolve(code);
                })
                .catch(() => {
                  // User cancelled, reject
                  resolve("");
                });
            }
          }, 500); // Small delay to check for immediate callback
        });
        return;
      }

      params.spin.update(params.localBrowserMessage);
      await params.openUrl(url);
      params.runtime.log(`Open: ${url}`);
    },
    onPrompt: async (prompt) => {
      // If we're waiting for manual code and have a resolver, try to resolve it
      if (codeResolver && manualCodePromise) {
        // The prompt likely contains the authorization code or callback redirect
        const code = extractAuthCodeFromUrl(prompt.message);
        if (code && code.length > 10) {
          // Looks like a real authorization code
          codeResolver(code);
          codeResolver = undefined; // Prevent double-resolution
          return code;
        }
      }

      // Normal path: ask user for code/URL
      if (manualCodePromise) {
        return manualCodePromise;
      }

      const code = await params.prompter.text({
        message: prompt.message,
        placeholder: prompt.placeholder,
        validate: validateRequiredInput,
      });
      return extractAuthCodeFromUrl(String(code));
    },
  };
}
