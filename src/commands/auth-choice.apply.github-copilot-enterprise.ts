import type { ApplyAuthChoiceParams, ApplyAuthChoiceResult } from "./auth-choice.apply.js";
import { githubCopilotLoginCommand } from "../providers/github-copilot-auth.js";
import { applyAuthProfileConfig } from "./onboard-auth.js";

export async function applyAuthChoiceGitHubCopilotEnterprise(
  params: ApplyAuthChoiceParams,
): Promise<ApplyAuthChoiceResult | null> {
  if (params.authChoice !== "github-copilot-enterprise") {
    return null;
  }

  let nextConfig = params.config;

  await params.prompter.note(
    [
      "This will open a GitHub Enterprise device login to authorize Copilot.",
      "Requires a GitHub Enterprise Cloud account with Copilot enabled.",
    ].join("\n"),
    "GitHub Copilot Enterprise",
  );

  if (!process.stdin.isTTY) {
    await params.prompter.note(
      "GitHub Copilot Enterprise login requires an interactive TTY.",
      "GitHub Copilot Enterprise",
    );
    return { config: nextConfig };
  }

  const githubHost = await params.prompter.text({
    message: "GitHub Enterprise host (e.g. myorg.ghe.com)",
    validate: (value) => {
      const trimmed = value.trim();
      if (!trimmed) {
        return "Host is required";
      }
      if (trimmed === "github.com") {
        return "Use the regular GitHub Copilot option for github.com";
      }
      // Basic hostname validation
      if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/i.test(trimmed)) {
        return "Enter a valid hostname";
      }
      return undefined;
    },
  });

  const profileId = `github-copilot:${githubHost.trim()}`;

  try {
    await githubCopilotLoginCommand(
      { yes: true, githubHost: githubHost.trim(), profileId },
      params.runtime,
    );
  } catch (err) {
    await params.prompter.note(
      `GitHub Copilot Enterprise login failed: ${String(err)}`,
      "GitHub Copilot Enterprise",
    );
    return { config: nextConfig };
  }

  nextConfig = applyAuthProfileConfig(nextConfig, {
    profileId,
    provider: "github-copilot",
    mode: "token",
  });

  if (params.setDefaultModel) {
    const model = "github-copilot/gpt-4o";
    nextConfig = {
      ...nextConfig,
      agents: {
        ...nextConfig.agents,
        defaults: {
          ...nextConfig.agents?.defaults,
          model: {
            ...(typeof nextConfig.agents?.defaults?.model === "object"
              ? nextConfig.agents.defaults.model
              : undefined),
            primary: model,
          },
        },
      },
    };
    await params.prompter.note(`Default model set to ${model}`, "Model configured");
  }

  return { config: nextConfig };
}
