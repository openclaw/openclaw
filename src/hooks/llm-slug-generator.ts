/**
 * LLM-based slug generator for session memory filenames.
 * Uses the narrative model (mind-memory plugin config) when configured,
 * falling back to the main agent model. Calls the LLM directly via
 * SubconsciousAgent — no full agent session overhead.
 */

import {
  resolveDefaultAgentId,
  resolveAgentDir,
  resolveAgentEffectiveModelPrimary,
} from "../agents/agent-scope.js";
import { DEFAULT_PROVIDER, DEFAULT_MODEL } from "../agents/defaults.js";
import { getApiKeyForModel } from "../agents/model-auth.js";
import { parseModelRef } from "../agents/model-selection.js";
import { resolveModel } from "../agents/pi-embedded-runner/model.js";
import { createSubconsciousAgent } from "../agents/pi-embedded-runner/subconscious-agent.js";
import type { OpenClawConfig } from "../config/config.js";
import { createSubsystemLogger } from "../logging/subsystem.js";

const log = createSubsystemLogger("llm-slug-generator");

/**
 * Resolve provider/model for slug generation: prefer narrative model from
 * mind-memory config, fall back to the primary agent model.
 */
function resolveSlugModelRef(
  cfg: OpenClawConfig,
  agentId: string,
): { provider: string; model: string } {
  const agentDefaults = cfg.agents?.defaults;
  const narrativeModelStr = agentDefaults?.smallModel ?? agentDefaults?.auxiliaryModel;
  if (typeof narrativeModelStr === "string" && narrativeModelStr.trim()) {
    const sep = narrativeModelStr.indexOf("/");
    if (sep > 0) {
      return { provider: narrativeModelStr.slice(0, sep), model: narrativeModelStr.slice(sep + 1) };
    }
  }
  const modelRef = resolveAgentEffectiveModelPrimary(cfg, agentId);
  const parsed = modelRef ? parseModelRef(modelRef, DEFAULT_PROVIDER) : null;
  return { provider: parsed?.provider ?? DEFAULT_PROVIDER, model: parsed?.model ?? DEFAULT_MODEL };
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
    const { provider, model: modelId } = resolveSlugModelRef(params.cfg, agentId);

    const { model, authStorage, modelRegistry } = resolveModel(
      provider,
      modelId,
      agentDir,
      params.cfg,
    );
    if (!model) {
      log.warn(`Could not resolve slug model ${provider}/${modelId}`);
      return null;
    }

    // Inject API key into authStorage so the subconscious agent can authenticate.
    try {
      const apiKeyInfo = await getApiKeyForModel({ model, cfg: params.cfg, agentDir });
      if (apiKeyInfo.apiKey) {
        if (model.provider === "github-copilot") {
          const { resolveCopilotApiToken } = await import("../providers/github-copilot-token.js");
          const copilotToken = await resolveCopilotApiToken({ githubToken: apiKeyInfo.apiKey });
          authStorage.setRuntimeApiKey(model.provider, copilotToken.token);
        } else {
          authStorage.setRuntimeApiKey(model.provider, apiKeyInfo.apiKey);
        }
      }
    } catch (err) {
      log.warn(
        `Could not resolve API key for slug model: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    const agent = createSubconsciousAgent({
      model,
      authStorage,
      modelRegistry,
      disableThinking: true,
    });

    const prompt = `Based on this conversation, generate a short 1-2 word filename slug (lowercase, hyphen-separated, no file extension).

Conversation summary:
${params.sessionContent.slice(0, 2000)}

Reply with ONLY the slug, nothing else. Examples: "vendor-pitch", "api-design", "bug-fix"`;

    const result = await agent.complete(prompt);
    const text = result?.text;
    if (!text) {
      return null;
    }

    const slug = text
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9-]/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 30);

    return slug || null;
  } catch (err) {
    const message = err instanceof Error ? (err.stack ?? err.message) : String(err);
    log.error(`Failed to generate slug: ${message}`);
    return null;
  }
}
