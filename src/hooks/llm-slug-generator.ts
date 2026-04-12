/**
 * LLM-based slug generator for session memory filenames.
 *
 * Uses the lightweight `completeSimple` path (no agent scaffold, no system
 * prompt, no tools) to generate a short 1-2 word filename slug from session
 * content.  This avoids the 16-48k token overhead of `runEmbeddedPiAgent`
 * which loads the full workspace context for what is essentially a
 * ~200-token prompt producing a ~5-token response.
 *
 * Model resolution order:
 *   1. agents.defaults.heartbeat.model (typically a cheap model)
 *   2. Agent primary model (fallback)
 */

import { completeSimple, type TextContent } from "@mariozechner/pi-ai";
import {
  resolveDefaultAgentId,
  resolveAgentDir,
} from "../agents/agent-scope.js";
import { DEFAULT_PROVIDER } from "../agents/defaults.js";
import { getApiKeyForModel, requireApiKey } from "../agents/model-auth.js";
import { parseModelRef, resolveDefaultModelForAgent } from "../agents/model-selection.js";
import { resolveModelAsync } from "../agents/pi-embedded-runner/model.js";
import { prepareModelForSimpleCompletion } from "../agents/simple-completion-transport.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { normalizeLowercaseStringOrEmpty } from "../shared/string-coerce.js";

const log = createSubsystemLogger("llm-slug-generator");

const TIMEOUT_MS = 15_000;
const MAX_CONTENT_SLICE = 2_000;
const MAX_SLUG_LENGTH = 30;

function isTextContentBlock(block: { type: string }): block is TextContent {
  return block.type === "text";
}

/**
 * Resolve the model to use for slug generation.
 *
 * Prefers the heartbeat model (cheap, fast) when configured.
 * Falls back to the agent's primary model otherwise.
 */
function resolveSlugModel(cfg: OpenClawConfig): { provider: string; modelId: string } {
  // Prefer heartbeat model — it's configured to be cheap
  const heartbeatModelRef = cfg?.agents?.defaults?.heartbeat?.model;
  if (heartbeatModelRef) {
    const parsed = parseModelRef(heartbeatModelRef, DEFAULT_PROVIDER);
    return { provider: parsed.provider, modelId: parsed.model };
  }

  // Fall back to agent primary
  const agentId = resolveDefaultAgentId(cfg);
  const fallback = resolveDefaultModelForAgent({ cfg, agentId });
  return { provider: fallback.provider, modelId: fallback.model };
}

/**
 * Generate a short 1-2 word filename slug from session content using LLM.
 */
export async function generateSlugViaLLM(params: {
  sessionContent: string;
  cfg: OpenClawConfig;
}): Promise<string | null> {
  try {
    const agentId = resolveDefaultAgentId(params.cfg);
    const agentDir = resolveAgentDir(params.cfg, agentId);
    const { provider, modelId } = resolveSlugModel(params.cfg);

    const resolved = await resolveModelAsync(provider, modelId, agentDir, params.cfg);
    if (!resolved.model) {
      log.warn(`Failed to resolve model ${provider}/${modelId} for slug generation`);
      return null;
    }

    const completionModel = prepareModelForSimpleCompletion({
      model: resolved.model,
      cfg: params.cfg,
    });

    const apiKey = requireApiKey(
      await getApiKeyForModel({ model: completionModel, cfg: params.cfg, agentDir }),
      provider,
    );

    const prompt = `Based on this conversation, generate a short 1-2 word filename slug (lowercase, hyphen-separated, no file extension).

Conversation summary:
${params.sessionContent.slice(0, MAX_CONTENT_SLICE)}

Reply with ONLY the slug, nothing else. Examples: "vendor-pitch", "api-design", "bug-fix"`;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);

    try {
      const result = await completeSimple(
        completionModel,
        {
          messages: [
            {
              role: "user",
              content: prompt,
              timestamp: Date.now(),
            },
          ],
        },
        {
          apiKey,
          maxTokens: 20,
          temperature: 0.3,
          signal: controller.signal,
        },
      );

      const text = result.content
        .filter(isTextContentBlock)
        .map((block) => block.text)
        .join("")
        .trim();

      if (!text) {
        return null;
      }

      const slug = normalizeLowercaseStringOrEmpty(text)
        .replace(/[^a-z0-9-]/g, "-")
        .replace(/-+/g, "-")
        .replace(/^-|-$/g, "")
        .slice(0, MAX_SLUG_LENGTH);

      return slug || null;
    } finally {
      clearTimeout(timeout);
    }
  } catch (err) {
    const message = err instanceof Error ? (err.stack ?? err.message) : String(err);
    log.error(`Failed to generate slug: ${message}`);
    return null;
  }
}
