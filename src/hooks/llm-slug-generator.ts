/**
 * LLM-based slug generator for session memory filenames
 */

import { randomUUID } from "node:crypto";
import {
  resolveDefaultAgentId,
  resolveAgentWorkspaceDir,
  resolveAgentDir,
} from "../agents/agent-scope.js";
import { resolveDefaultModelForAgent } from "../agents/model-selection.js";
import { runEmbeddedPiAgent } from "../agents/pi-embedded.js";
import { resolveAgentTimeoutMs } from "../agents/timeout.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { normalizeLowercaseStringOrEmpty } from "../shared/string-coerce.js";

const log = createSubsystemLogger("llm-slug-generator");
const DEFAULT_SLUG_GENERATOR_TIMEOUT_MS = 15_000;

function resolveSlugGeneratorTimeoutMs(cfg: OpenClawConfig): number {
  const configuredTimeoutSeconds = cfg.agents?.defaults?.timeoutSeconds;
  if (typeof configuredTimeoutSeconds !== "number" || !Number.isFinite(configuredTimeoutSeconds)) {
    return DEFAULT_SLUG_GENERATOR_TIMEOUT_MS;
  }
  return resolveAgentTimeoutMs({ cfg });
}

/**
 * Generate a short 1-2 word filename slug from session content using LLM
 */
export async function generateSlugViaLLM(params: {
  sessionContent: string;
  cfg: OpenClawConfig;
}): Promise<string | null> {
  try {
    const agentId = resolveDefaultAgentId(params.cfg);
    const workspaceDir = resolveAgentWorkspaceDir(params.cfg, agentId);
    const agentDir = resolveAgentDir(params.cfg, agentId);
    const sessionId = `slug-generator-${randomUUID()}`;

    const prompt = `Based on this conversation, generate a short 1-2 word filename slug (lowercase, hyphen-separated, no file extension).

Conversation summary:
${params.sessionContent.slice(0, 2000)}

Reply with ONLY the slug, nothing else. Examples: "vendor-pitch", "api-design", "bug-fix"`;

    const { provider, model } = resolveDefaultModelForAgent({
      cfg: params.cfg,
      agentId,
    });
    const timeoutMs = resolveSlugGeneratorTimeoutMs(params.cfg);

    const result = await runEmbeddedPiAgent({
      sessionId,
      sessionKey: "temp:slug-generator",
      agentId,
      workspaceDir,
      agentDir,
      config: params.cfg,
      prompt,
      provider,
      model,
      timeoutMs,
      runId: `slug-gen-${Date.now()}`,
      cleanupBundleMcpOnRunEnd: true,
    });

    // Extract text from payloads
    if (result.payloads && result.payloads.length > 0) {
      const text = result.payloads[0]?.text;
      if (text) {
        // Clean up the response - extract just the slug
        const slug = normalizeLowercaseStringOrEmpty(text)
          .replace(/[^a-z0-9-]/g, "-")
          .replace(/-+/g, "-")
          .replace(/^-|-$/g, "")
          .slice(0, 30); // Max 30 chars

        return slug || null;
      }
    }

    return null;
  } catch (err) {
    const message = err instanceof Error ? (err.stack ?? err.message) : String(err);
    log.error(`Failed to generate slug: ${message}`);
    return null;
  }
}
