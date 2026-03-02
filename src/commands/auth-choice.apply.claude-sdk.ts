import type { ApplyAuthChoiceParams, ApplyAuthChoiceResult } from "./auth-choice.apply.js";
import { applyAgentDefaultModelPrimary } from "./onboard-auth.config-shared.js";

const DEFAULT_CLAUDE_SDK_MODEL = "claude-sdk/opus";

export async function applyAuthChoiceClaudeSdk(
  params: ApplyAuthChoiceParams,
): Promise<ApplyAuthChoiceResult | null> {
  if (params.authChoice !== "claude-sdk") {
    return null;
  }

  await params.prompter.note(
    [
      "Claude Code SDK reuses your local `claude` CLI authentication.",
      "Make sure the `claude` CLI is installed and signed in (Max subscription).",
    ].join("\n"),
    "Claude Code SDK",
  );

  let nextConfig = params.config;
  if (params.setDefaultModel) {
    nextConfig = applyAgentDefaultModelPrimary(nextConfig, DEFAULT_CLAUDE_SDK_MODEL);
  }

  return { config: nextConfig, agentModelOverride: DEFAULT_CLAUDE_SDK_MODEL };
}
