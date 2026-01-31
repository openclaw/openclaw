import { CopilotClient } from "@github/copilot-sdk";
import type { ModelInfo } from "@github/copilot-sdk";

import type { ModelDefinitionConfig } from "../config/types.models.js";
import { resolveCopilotApiToken } from "./github-copilot-token.js";

const DEFAULT_CONTEXT_WINDOW = 128_000;
const DEFAULT_MAX_TOKENS = 8192;

/**
 * Discovers available models from the user's GitHub Copilot subscription.
 * Uses the Copilot SDK to query models via the Copilot CLI.
 *
 * @param params - Configuration for model discovery
 * @returns Array of model definitions compatible with OpenClaw's model registry
 */
export async function discoverCopilotModels(params: {
  githubToken: string;
  env?: NodeJS.ProcessEnv;
}): Promise<ModelDefinitionConfig[]> {
  let client: CopilotClient | undefined;
  try {
    // Resolve Copilot API token from GitHub token
    const copilotAuth = await resolveCopilotApiToken({
      githubToken: params.githubToken,
      env: params.env,
    });

    // Create SDK client with GitHub token
    client = new CopilotClient({
      githubToken: params.githubToken,
      autoStart: true,
      useLoggedInUser: false,
    });

    await client.start();

    // Query available models from the CLI
    const models = await client.listModels();

    // Convert SDK ModelInfo to OpenClaw ModelDefinitionConfig
    return models.map((model) => convertModelInfoToDefinition(model));
  } catch (error) {
    console.warn(`Failed to discover Copilot models via SDK: ${String(error)}`);
    return [];
  } finally {
    if (client) {
      try {
        await client.stop();
      } catch (err) {
        console.warn(`Failed to stop Copilot SDK client: ${String(err)}`);
      }
    }
  }
}

/**
 * Converts a Copilot SDK ModelInfo to OpenClaw's ModelDefinitionConfig format.
 */
function convertModelInfoToDefinition(model: ModelInfo): ModelDefinitionConfig {
  const isReasoning = model.id.includes("o1") || model.id.includes("o3");
  const supportsVision = model.capabilities?.supports?.vision === true;

  // Determine input modalities
  const input: Array<"text" | "image"> = ["text"];
  if (supportsVision) {
    input.push("image");
  }

  // Use capabilities if available, otherwise defaults
  const contextWindow =
    model.capabilities?.limits?.max_context_window_tokens ?? DEFAULT_CONTEXT_WINDOW;
  const maxTokens = model.capabilities?.limits?.max_prompt_tokens ?? DEFAULT_MAX_TOKENS;

  return {
    id: model.id,
    name: model.name || model.id,
    api: "openai-responses",
    reasoning: isReasoning,
    input,
    cost: {
      // Copilot doesn't expose per-model pricing via SDK, use zeros
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
    },
    contextWindow,
    maxTokens,
  };
}

/**
 * Checks if the Copilot CLI is available in PATH.
 * The SDK requires the CLI to be installed separately.
 */
export async function isCopilotCliAvailable(): Promise<boolean> {
  const client = new CopilotClient({ autoStart: false });
  try {
    await client.start();
    await client.stop();
    return true;
  } catch {
    return false;
  }
}
