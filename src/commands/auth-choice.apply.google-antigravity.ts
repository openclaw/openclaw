import type { ApplyAuthChoiceParams, ApplyAuthChoiceResult } from "./auth-choice.apply.js";
import { applyAuthChoicePluginProvider } from "./auth-choice.apply.plugin-provider.js";

export async function applyAuthChoiceGoogleAntigravity(
  params: ApplyAuthChoiceParams,
): Promise<ApplyAuthChoiceResult | null> {
  if (params.authChoice !== "google-antigravity") {
    return null;
  }

  await params.prompter.note(
    [
      "This is an unofficial integration and is not endorsed by Google.",
      "Some users have reported account restrictions or suspensions after using third-party Antigravity flows.",
      "Proceed only if you understand and accept this risk.",
    ].join("\n"),
    "Google Antigravity caution",
  );

  const proceed = await params.prompter.confirm({
    message: "Continue with Google Antigravity OAuth?",
    initialValue: false,
  });
  if (!proceed) {
    await params.prompter.note("Skipped Google Antigravity OAuth setup.", "Setup skipped");
    return { config: params.config };
  }

  return await applyAuthChoicePluginProvider(params, {
    authChoice: "google-antigravity",
    pluginId: "google-antigravity-auth",
    providerId: "google-antigravity",
    methodId: "oauth",
    label: "Google Antigravity",
  });
}
