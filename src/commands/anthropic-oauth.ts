import type { OAuthCredentials } from "@mariozechner/pi-ai";
import { loginAnthropic } from "@mariozechner/pi-ai";
import type { RuntimeEnv } from "../runtime.js";
import type { WizardPrompter } from "../wizard/prompts.js";
import { createVpsAwareOAuthHandlers } from "./oauth-flow.js";

export async function loginAnthropicOAuth(params: {
  prompter: WizardPrompter;
  runtime: RuntimeEnv;
  isRemote: boolean;
  openUrl: (url: string) => Promise<unknown>;
  localBrowserMessage?: string;
}): Promise<OAuthCredentials | null> {
  const { prompter, runtime, isRemote, openUrl, localBrowserMessage } = params;

  await prompter.note(
    isRemote
      ? [
          "You are running in a remote/VPS environment.",
          "A URL will be shown for you to open in your LOCAL browser.",
          "After signing in, paste the redirect URL back here.",
        ].join("\n")
      : [
          "Browser will open for Anthropic authentication.",
          "If the callback doesn't auto-complete, paste the redirect URL.",
          "Anthropic OAuth uses a localhost callback.",
        ].join("\n"),
    "Anthropic OAuth",
  );

  const spin = prompter.progress("Starting OAuth flow…");
  try {
    const { onAuth, onPrompt } = createVpsAwareOAuthHandlers({
      isRemote,
      prompter,
      runtime,
      spin,
      openUrl,
      localBrowserMessage: localBrowserMessage ?? "Complete sign-in in browser…",
    });

    const creds = await loginAnthropic({
      onAuth: ({ url }) => {
        void onAuth({ url });
      },
      onPrompt,
      onProgress: (message) => spin.update(message),
      ...(isRemote ? { onManualCodeInput: () => onPrompt({ message: "Paste the redirect URL" }) } : {}),
    });
    spin.stop("Anthropic OAuth complete");
    return creds ?? null;
  } catch (err) {
    spin.stop("Anthropic OAuth failed");
    runtime.error(String(err));
    await prompter.note("Trouble with OAuth? See https://docs.openclaw.ai/start/faq", "OAuth help");
    throw err;
  }
}
