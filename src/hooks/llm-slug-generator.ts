/**
 * LLM-based slug generator for session memory filenames
 */

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import {
  resolveDefaultAgentId,
  resolveAgentWorkspaceDir,
  resolveAgentDir,
} from "../agents/agent-scope.js";
import { runEmbeddedAgent } from "../agents/embedded-agent.js";
import { parseModelRef } from "../agents/model-selection-normalize.js";
import type { ModelRef } from "../agents/model-selection-normalize.js";
import { resolveDefaultModelForAgent } from "../agents/model-selection.js";
import { resolveAgentTimeoutMs } from "../agents/timeout.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createSubsystemLogger } from "../logging/subsystem.js";

const log = createSubsystemLogger("llm-slug-generator");

/**
 * Resolve which model to use for slug generation.
 *
 * When the hook config (e.g. `hooks.internal.entries["session-memory"].model`)
 * provides a `provider/model` (or bare `model`) string, prefer it so the
 * caller can route slug generation to a cheaper / faster model than the
 * agent's primary model. Falls back to the agent's default model when the
 * override is missing, empty, or unparseable.
 */
export function resolveSlugGeneratorModelRef(params: {
  cfg: OpenClawConfig;
  agentId?: string;
  hookModelOverride?: unknown;
}): ModelRef {
  const fallback = () => resolveDefaultModelForAgent({ cfg: params.cfg, agentId: params.agentId });
  const raw = params.hookModelOverride;
  if (typeof raw !== "string") {
    return fallback();
  }
  const trimmed = raw.trim();
  if (!trimmed) {
    return fallback();
  }
  const fallbackRef = fallback();
  const parsed = parseModelRef(trimmed, fallbackRef.provider);
  if (!parsed) {
    log.warn(
      `Ignoring unparseable session-memory hook model override; falling back to agent default`,
    );
    return fallbackRef;
  }
  return parsed;
}
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
  /**
   * Optional `provider/model` (or bare `model`) override from the hook's
   * config entry. When present and parseable it takes precedence over the
   * agent's default model for this slug-generation run.
   */
  modelOverride?: string;
}): Promise<string | null> {
  let tempSessionFile: string | null = null;

  try {
    const agentId = resolveDefaultAgentId(params.cfg);
    const workspaceDir = resolveAgentWorkspaceDir(params.cfg, agentId);
    const agentDir = resolveAgentDir(params.cfg, agentId);

    // Create a temporary session file for this one-off LLM call
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-slug-"));
    tempSessionFile = path.join(tempDir, "session.jsonl");

    const prompt = `Based on this conversation, generate a short 1-2 word filename slug (lowercase, hyphen-separated, no file extension).

Conversation summary:
${params.sessionContent.slice(0, 2000)}

Reply with ONLY the slug, nothing else. Examples: "vendor-pitch", "api-design", "bug-fix"`;

    const { provider, model } = resolveSlugGeneratorModelRef({
      cfg: params.cfg,
      agentId,
      hookModelOverride: params.modelOverride,
    });
    const timeoutMs = resolveSlugGeneratorTimeoutMs(params.cfg);

    const result = await runEmbeddedAgent({
      sessionId: `slug-generator-${Date.now()}`,
      sessionKey: "temp:slug-generator",
      agentId,
      sessionFile: tempSessionFile,
      workspaceDir,
      agentDir,
      config: params.cfg,
      prompt,
      provider,
      model,
      timeoutMs,
      runId: `slug-gen-${Date.now()}`,
      cleanupBundleMcpOnRunEnd: true,
      // Internal helper run: route failures lane-local so an upstream 400/billing
      // here cannot poison the shared profile (#71709).
      authProfileFailurePolicy: "local",
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
  } finally {
    // Clean up temporary session file
    if (tempSessionFile) {
      try {
        await fs.rm(path.dirname(tempSessionFile), { recursive: true, force: true });
      } catch {
        // Ignore cleanup errors
      }
    }
  }
}
