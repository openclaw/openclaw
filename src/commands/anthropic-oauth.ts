import type { OAuthCredentials } from "@mariozechner/pi-ai";
import { loginAnthropic } from "@mariozechner/pi-ai";
import type { RuntimeEnv } from "../runtime.js";
import type { WizardPrompter } from "../wizard/prompts.js";

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
          "Anthropic OAuth uses localhost:3456 for the callback.",
        ].join("\n"),
    "Anthropic OAuth",
  );

  const spin = prompter.progress("Starting OAuth flow…");
  try {
    let manualCodePromise: Promise<string> | undefined;

    const creds = await loginAnthropic(
      (url: string) => {
        if (isRemote) {
          spin.stop("OAuth URL ready");
          runtime.log(`\nOpen this URL in your LOCAL browser:\n\n${url}\n`);
          manualCodePromise = prompter
            .text({
              message: "Paste the redirect URL",
              validate: (value) => (value.trim().length > 0 ? undefined : "Required"),
            })
            .then((value) => String(value));
          return;
        }

        spin.update(localBrowserMessage ?? "Complete sign-in in browser…");
        openUrl(url).catch((err) => runtime.error(String(err)));
        runtime.log(`Open: ${url}`);
      },
      async () => {
        if (manualCodePromise) {
          return manualCodePromise;
        }
        const code = await prompter.text({
          message: "Paste the redirect URL (or authorization code)",
          validate: (value) => (value.trim().length > 0 ? undefined : "Required"),
        });
        return String(code);
      },
    );
    spin.stop("Anthropic OAuth complete");
    return creds ?? null;
  } catch (err) {
    spin.stop("Anthropic OAuth failed");
    runtime.error(String(err));
    await prompter.note("Trouble with OAuth? See https://docs.openclaw.ai/start/faq", "OAuth help");
    throw err;
  }
}
