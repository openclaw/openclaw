import { complete, type Model, type Api } from "@mariozechner/pi-ai";
import { resolveOpenClawAgentDir } from "../../agents/agent-paths.js";
import { getApiKeyForModel } from "../../agents/model-auth.js";
import { discoverAuthStorage, discoverModels } from "../../agents/pi-model-discovery.js";
import type { OpenClawConfig } from "../../config/config.js";
import { resolveAgentModelPrimaryValue } from "../../config/model-input.js";
import { logVerbose } from "../../globals.js";

/**
 * Generate a short thread title using the agent's configured model.
 * Falls back to truncated message text if model/API is unavailable.
 */
export async function generateThreadTitle(params: {
  cfg: OpenClawConfig;
  messageText: string;
  agentDir?: string;
}): Promise<string> {
  const text = params.messageText.trim();
  if (!text) {
    return "New Thread";
  }

  // Fallback: truncated message
  const fallback = text.length > 80 ? text.slice(0, 77) + "..." : text;

  try {
    // Get agent's configured model
    const modelRef = resolveAgentModelPrimaryValue(params.cfg?.agents?.defaults?.model);
    if (!modelRef) {
      logVerbose("thread-title: no model configured, using fallback");
      return fallback;
    }

    // Parse provider/model from ref (e.g., "anthropic/claude-sonnet-4-6")
    const [provider, modelId] = modelRef.includes("/")
      ? modelRef.split("/", 2)
      : ["openai", modelRef];

    // Discover models and auth
    const agentDir = params.agentDir ?? resolveOpenClawAgentDir();
    const authStorage = discoverAuthStorage(agentDir);
    const modelRegistry = discoverModels(authStorage, agentDir);

    // Find the model in registry
    const model = modelRegistry.find(provider, modelId) as Model<Api> | null;
    if (!model) {
      logVerbose(`thread-title: model ${provider}/${modelId} not found, using fallback`);
      return fallback;
    }

    // Get API key
    const apiKeyInfo = await getApiKeyForModel({
      model,
      cfg: params.cfg,
      agentDir,
    });
    if (!apiKeyInfo.apiKey) {
      logVerbose(`thread-title: no API key for ${provider}, using fallback`);
      return fallback;
    }

    const prompt = `Generate a 3-6 word title for this Discord thread. Be concise and descriptive. Return ONLY the title, no quotes or extra text.

Message: ${text.slice(0, 500)}`;

    // Make completion call using pi-ai
    const message = await complete(
      model,
      { messages: [] },
      {
        apiKey: apiKeyInfo.apiKey,
        maxTokens: 30,
        systemPrompt: prompt,
      },
    );

    // Extract title from response
    let title = "";
    if (typeof message.content === "string") {
      title = (message.content as string).trim();
    } else if (Array.isArray(message.content)) {
      for (const part of message.content) {
        if (
          typeof part === "object" &&
          part !== null &&
          "type" in part &&
          part.type === "text" &&
          "text" in part
        ) {
          title += String((part as { text: unknown }).text);
        }
      }
      title = title.trim();
    }

    // Validate and return
    if (title && title.length > 0 && title.length <= 100) {
      return title;
    }
    return fallback;
  } catch (err) {
    logVerbose(`thread-title: error generating title: ${String(err)}`);
    return fallback;
  }
}
