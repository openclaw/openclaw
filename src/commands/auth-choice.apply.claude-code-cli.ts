import type { ApplyAuthChoiceParams, ApplyAuthChoiceResult } from "./auth-choice.apply.js";
import { createAuthChoiceAgentModelNoter } from "./auth-choice.apply-helpers.js";
import {
  applyClaudeCodeCliDefaultConfig,
  applyClaudeCodeCliProviderConfig,
  CLAUDE_CODE_CLI_DEFAULT_MODEL,
  resolveClaudeCodeCliCommandPath,
} from "./auth-choice.claude-code-cli.js";
import { applyDefaultModelChoice } from "./auth-choice.default-model.js";

export async function applyAuthChoiceClaudeCodeCli(
  params: ApplyAuthChoiceParams,
): Promise<ApplyAuthChoiceResult | null> {
  if (params.authChoice !== "claude-code-cli") {
    return null;
  }

  const commandPath = resolveClaudeCodeCliCommandPath();
  if (commandPath) {
    await params.prompter.note(
      `Detected Claude Code CLI at ${commandPath}. OpenClaw will use it for claude-cli models.`,
      "Claude Code CLI",
    );
  } else {
    await params.prompter.note(
      [
        "Claude Code CLI was not detected in PATH.",
        "OpenClaw can still be configured now; install or add `claude` to PATH before first run.",
      ].join("\n"),
      "Claude Code CLI",
    );
  }

  const noteAgentModel = createAuthChoiceAgentModelNoter(params);
  const applied = await applyDefaultModelChoice({
    config: params.config,
    setDefaultModel: params.setDefaultModel,
    defaultModel: CLAUDE_CODE_CLI_DEFAULT_MODEL,
    applyDefaultConfig: (config) =>
      applyClaudeCodeCliDefaultConfig(config, {
        commandPath,
      }),
    applyProviderConfig: (config) =>
      applyClaudeCodeCliProviderConfig(config, {
        commandPath,
      }),
    noteDefault: CLAUDE_CODE_CLI_DEFAULT_MODEL,
    noteAgentModel,
    prompter: params.prompter,
  });

  return {
    config: applied.config,
    agentModelOverride: applied.agentModelOverride,
  };
}
