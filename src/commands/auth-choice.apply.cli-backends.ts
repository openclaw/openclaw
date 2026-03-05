import {
  checkCliBackendAvailability,
  formatCliBackendStatus,
} from "../agents/cli-backend-availability.js";
import type { ApplyAuthChoiceParams, ApplyAuthChoiceResult } from "./auth-choice.apply.js";
import { applyPrimaryModel } from "./model-picker.js";

const CLAUDE_CLI_DEFAULT_MODEL = "claude-cli/sonnet";
const CODEX_CLI_DEFAULT_MODEL = "codex-cli/codex";

export async function applyAuthChoiceCliBackends(
  params: ApplyAuthChoiceParams,
): Promise<ApplyAuthChoiceResult | null> {
  if (params.authChoice !== "claude-cli" && params.authChoice !== "codex-cli") {
    return null;
  }

  const availability = await checkCliBackendAvailability(params.authChoice);
  await params.prompter.note(
    formatCliBackendStatus(availability),
    `${availability.binaryName} CLI status`,
  );

  if (!availability.binaryFound) {
    await params.prompter.note(
      `Install the ${availability.binaryName} CLI and re-run this setup.`,
      "Binary not found",
    );
    return { config: params.config };
  }

  if (!availability.credentialsFound) {
    await params.prompter.note(
      `Run \`${availability.binaryName} auth login\` to authenticate before using this backend.`,
      "Credentials not found",
    );
    return { config: params.config };
  }

  const defaultModel =
    params.authChoice === "claude-cli" ? CLAUDE_CLI_DEFAULT_MODEL : CODEX_CLI_DEFAULT_MODEL;

  let nextConfig = params.config;
  if (params.setDefaultModel) {
    nextConfig = applyPrimaryModel(nextConfig, defaultModel);
    await params.prompter.note(`Default model set to ${defaultModel}`, "Model configured");
  }

  return { config: nextConfig };
}
