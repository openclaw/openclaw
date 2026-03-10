import type { OAuthCredentials } from "@mariozechner/pi-ai";
import { loginAnthropic } from "@mariozechner/pi-ai";
import type { RuntimeEnv } from "../runtime.js";
import type { WizardPrompter } from "../wizard/prompts.js";
import { createVpsAwareOAuthHandlers } from "./oauth-flow.js";

export async function loginAnthropicOAuth(params: {
  prompter: WizardPrompter;
  runtime: RuntimeEnv;
  isRemote: boolean;
  openUrl: (url: string) => Promise<void>;
}): Promise<OAuthCredentials | null> {
  const { prompter, runtime, isRemote, openUrl } = params;

  await prompter.note(
    isRemote
      ? [
          "You are running in a remote/VPS environment.",
          "A URL will be shown for you to open in your LOCAL browser.",
          "After signing in, paste the authorization code shown by Anthropic.",
          "Format: code#state",
        ].join("\n")
      : [
          "Browser will open for Anthropic authentication.",
          "If it doesn't open automatically, use the printed URL.",
          "Paste the authorization code shown by Anthropic.",
          "Format: code#state",
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
      localBrowserMessage: "Complete sign-in in browser…",
      manualPromptMessage: "Paste Anthropic authorization code (code#state)",
    });

    const creds = await loginAnthropic(
      (url) => {
        void onAuth({ url });
      },
      () =>
        onPrompt({
          message: "Paste Anthropic authorization code (code#state)",
          placeholder: "code#state",
        }),
    );

    spin.stop("Anthropic OAuth complete");
    return creds ?? null;
  } catch (err) {
    spin.stop("Anthropic OAuth failed");
    runtime.error(String(err));
    await prompter.note(
      [
        "Trouble with OAuth?",
        "1) Ensure your Claude account has API access enabled.",
        "2) Re-run and copy the full code exactly as shown (code#state).",
        "3) If needed, retry with a fresh browser session.",
      ].join("\n"),
      "OAuth help",
    );
    throw err;
  }
}
