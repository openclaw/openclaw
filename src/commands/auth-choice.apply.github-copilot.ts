import { toAgentModelListLike } from "../config/model-input.js";
import { githubCopilotLoginCommand } from "../providers/github-copilot-auth.js";
import {
  buildCopilotModelDefinition,
  fetchCopilotModels,
} from "../providers/github-copilot-models.js";
import type { ApplyAuthChoiceParams, ApplyAuthChoiceResult } from "./auth-choice.apply.js";
import { applyAuthProfileConfig } from "./onboard-auth.js";

export async function applyAuthChoiceGitHubCopilot(
  params: ApplyAuthChoiceParams,
): Promise<ApplyAuthChoiceResult | null> {
  if (params.authChoice !== "github-copilot") {
    return null;
  }

  let nextConfig = params.config;

  await params.prompter.note(
    [
      "This will open a GitHub device login to authorize Copilot.",
      "Requires an active GitHub Copilot subscription.",
    ].join("\n"),
    "GitHub Copilot",
  );

  if (!process.stdin.isTTY) {
    await params.prompter.note(
      "GitHub Copilot login requires an interactive TTY.",
      "GitHub Copilot",
    );
    return { config: nextConfig };
  }

  let accessToken: string | undefined;
  try {
    accessToken = await githubCopilotLoginCommand({ yes: true }, params.runtime);
  } catch (err) {
    await params.prompter.note(`GitHub Copilot login failed: ${String(err)}`, "GitHub Copilot");
    return { config: nextConfig };
  }

  nextConfig = applyAuthProfileConfig(nextConfig, {
    profileId: "github-copilot:github",
    provider: "github-copilot",
    mode: "token",
  });

  // Attempt to discover available models to populate config
  if (accessToken) {
    try {
      const discoveredModels = await fetchCopilotModels(accessToken);
      if (discoveredModels.length > 0) {
        params.runtime.log(`Discovered ${discoveredModels.length} Copilot models.`);

        // Populate the `models.providers["github-copilot"].models` list
        // so they are explicitly available for selection/use.
        const providerConfig = nextConfig.models?.providers?.["github-copilot"] || {
          baseUrl: "https://api.individual.githubcopilot.com", // default, may be overridden by token resolution later
          api: "openai-responses",
          models: [],
        };

        // Merge discovered models, avoiding duplicates
        const existingIds = new Set(providerConfig.models.map((m) => m.id));
        const newModels = discoveredModels
          .filter((id) => !existingIds.has(id))
          .map((id) => buildCopilotModelDefinition(id));

        nextConfig = {
          ...nextConfig,
          models: {
            ...nextConfig.models,
            providers: {
              ...nextConfig.models?.providers,
              "github-copilot": {
                ...providerConfig,
                models: [...providerConfig.models, ...newModels],
              },
            },
          },
        };
      }
    } catch (err) {
      // Non-fatal
      params.runtime.log(`Model discovery failed: ${String(err)}`);
    }
  }

  if (params.setDefaultModel) {
    const model = "github-copilot/gpt-4o";
    nextConfig = {
      ...nextConfig,
      agents: {
        ...nextConfig.agents,
        defaults: {
          ...nextConfig.agents?.defaults,
          model: {
            ...toAgentModelListLike(nextConfig.agents?.defaults?.model),
            primary: model,
          },
        },
      },
    };
    await params.prompter.note(`Default model set to ${model}`, "Model configured");
  }

  return { config: nextConfig };
}
