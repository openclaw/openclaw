/**
 * Auto-rename Telegram DM forum topics on first message using LLM.
 *
 * This module provides LLM-based label generation.
 * Config resolution is in auto-topic-label-config.ts (lightweight, testable).
 * The actual topic rename call is channel-specific and handled by the caller.
 */
import { completeSimple, type TextContent } from "@mariozechner/pi-ai";
import { getApiKeyForModel, requireApiKey } from "../../agents/model-auth.js";
import { resolveDefaultModelForAgent } from "../../agents/model-selection.js";
import { resolveModelAsync } from "../../agents/pi-embedded-runner/model.js";
import type { OpenClawConfig } from "../../config/config.js";
import { logVerbose } from "../../globals.js";

export { resolveAutoTopicLabelConfig } from "./auto-topic-label-config.js";
export type { AutoTopicLabelConfig } from "../../config/types.telegram.js";

const MAX_LABEL_LENGTH = 128;
const TIMEOUT_MS = 15_000;

export type AutoTopicLabelParams = {
  /** The user's first message text. */
  userMessage: string;
  /** System prompt for the LLM. */
  prompt: string;
  /** The full config object. */
  cfg: OpenClawConfig;
  /** Agent ID for model resolution. */
  agentId?: string;
};

function isTextContentBlock(block: { type: string }): block is TextContent {
  return block.type === "text";
}

/**
 * Generate a topic label using LLM.
 * Returns the generated label or null on failure.
 */
export async function generateTopicLabel(params: {
  userMessage: string;
  prompt: string;
  cfg: OpenClawConfig;
  agentId?: string;
}): Promise<string | null> {
  const { userMessage, prompt, cfg, agentId } = params;
  const modelRef = resolveDefaultModelForAgent({ cfg, agentId });
  const resolved = await resolveModelAsync(modelRef.provider, modelRef.model, undefined, cfg);
  if (!resolved.model) {
    logVerbose(`auto-topic-label: failed to resolve model ${modelRef.provider}/${modelRef.model}`);
    return null;
  }

  const apiKey = requireApiKey(
    await getApiKeyForModel({ model: resolved.model, cfg }),
    modelRef.provider,
  );

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const result = await completeSimple(
      resolved.model,
      {
        messages: [
          {
            role: "user",
            content: `${prompt}\n\n${userMessage}`,
            timestamp: Date.now(),
          },
        ],
      },
      {
        apiKey,
        maxTokens: 100,
        temperature: 0.3,
        signal: controller.signal,
      },
    );

    const text = result.content
      .filter(isTextContentBlock)
      .map((b) => b.text)
      .join("")
      .trim();

    if (!text) {
      return null;
    }

    // Enforce max length for Telegram topic names.
    return text.slice(0, MAX_LABEL_LENGTH);
  } finally {
    clearTimeout(timeout);
  }
}
