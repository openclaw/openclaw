/**
 * LLM-based slug generator for session memory filenames
 */

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  resolveDefaultAgentId,
  resolveAgentWorkspaceDir,
  resolveAgentDir,
  resolveAgentEffectiveModelPrimary,
} from "../agents/agent-scope.js";
import { DEFAULT_PROVIDER, DEFAULT_MODEL } from "../agents/defaults.js";
import { parseModelRef } from "../agents/model-selection.js";
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
 * Maximum characters in a generated slug.
 */
const MAX_SLUG_LENGTH = 30;

/**
 * Sanity-check thresholds for raw LLM responses. The prompt asks for a
 * 1-2 word slug, so anything longer is almost certainly not a slug
 * (for example an error message that the embedded agent returned as
 * payload text instead of throwing).
 */
const MAX_RESPONSE_WORDS = 5;
const MAX_RESPONSE_CHARS = 80;

/**
 * Convert a raw LLM response into a filename-safe slug.
 *
 * Returns null if the response does not look like a slug (multi-line,
 * too many words, too long). This guards against error messages or
 * rambling responses leaking into memory filenames.
 *
 * Exported for unit testing.
 */
export function slugifyLLMResponse(text: string): string | null {
  const trimmed = text.trim();
  if (!trimmed) {
    return null;
  }

  // Reject responses that clearly are not a 1-2 word slug.
  if (trimmed.includes("\n")) {
    return null;
  }
  if (trimmed.length > MAX_RESPONSE_CHARS) {
    return null;
  }
  const wordCount = trimmed.split(/\s+/).filter(Boolean).length;
  if (wordCount > MAX_RESPONSE_WORDS) {
    return null;
  }

  // Slugify, then strip leading/trailing dashes AFTER truncation so a
  // dash that lands at position MAX_SLUG_LENGTH-1 is removed.
  const slug = normalizeLowercaseStringOrEmpty(trimmed)
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .slice(0, MAX_SLUG_LENGTH)
    .replace(/^-|-$/g, "");

  return slug || null;
}

/**
 * Generate a short 1-2 word filename slug from session content using LLM
 */
export async function generateSlugViaLLM(params: {
  sessionContent: string;
  cfg: OpenClawConfig;
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

    // Resolve model from agent config instead of using hardcoded defaults
    const modelRef = resolveAgentEffectiveModelPrimary(params.cfg, agentId);
    const parsed = modelRef ? parseModelRef(modelRef, DEFAULT_PROVIDER) : null;
    const provider = parsed?.provider ?? DEFAULT_PROVIDER;
    const model = parsed?.model ?? DEFAULT_MODEL;
    const timeoutMs = resolveSlugGeneratorTimeoutMs(params.cfg);

    const result = await runEmbeddedPiAgent({
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
    });

    // Extract text from payloads
    if (result.payloads && result.payloads.length > 0) {
      const text = result.payloads[0]?.text;
      if (text) {
        const slug = slugifyLLMResponse(text);
        if (slug === null) {
          log.warn(
            `Discarding slug candidate: response did not look like a slug (length=${text.length})`,
          );
        }
        return slug;
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
