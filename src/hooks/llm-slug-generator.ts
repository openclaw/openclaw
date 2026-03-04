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
import {
  buildModelAliasIndex,
  isCliProvider,
  resolveModelRefFromString,
} from "../agents/model-selection.js";
import { runEmbeddedPiAgent } from "../agents/pi-embedded.js";
import type { OpenClawConfig } from "../config/config.js";
import { createSubsystemLogger } from "../logging/subsystem.js";

const log = createSubsystemLogger("llm-slug-generator");
const DEFAULT_LLM_SLUG_TIMEOUT_MS = 45_000;
const MIN_LLM_SLUG_TIMEOUT_MS = 5_000;
const MAX_LLM_SLUG_TIMEOUT_MS = 300_000;

function clampNumber(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function resolveSlugTimeoutMs(cfg: OpenClawConfig): number {
  const hookEntry = cfg.hooks?.internal?.entries?.["session-memory"];
  const raw =
    hookEntry && typeof hookEntry === "object"
      ? (hookEntry as Record<string, unknown>).llmSlugTimeoutMs
      : undefined;
  const parsed =
    typeof raw === "number"
      ? Number.isFinite(raw)
        ? Math.floor(raw)
        : undefined
      : typeof raw === "string"
        ? Number.parseInt(raw, 10)
        : undefined;
  if (typeof parsed !== "number" || Number.isNaN(parsed) || parsed <= 0) {
    return DEFAULT_LLM_SLUG_TIMEOUT_MS;
  }
  return clampNumber(parsed, MIN_LLM_SLUG_TIMEOUT_MS, MAX_LLM_SLUG_TIMEOUT_MS);
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

    const aliasIndex = buildModelAliasIndex({ cfg: params.cfg, defaultProvider: DEFAULT_PROVIDER });

    // Hook-level model override: hooks.internal.entries.session-memory.model
    const hookEntry = params.cfg.hooks?.internal?.entries?.["session-memory"];
    const hookModelRaw =
      hookEntry && typeof hookEntry === "object"
        ? (hookEntry as Record<string, unknown>).model
        : undefined;
    const hookResolved =
      typeof hookModelRaw === "string" && hookModelRaw
        ? resolveModelRefFromString({
            raw: hookModelRaw,
            defaultProvider: DEFAULT_PROVIDER,
            aliasIndex,
          })
        : null;

    let provider: string;
    let model: string;

    if (hookResolved && !isCliProvider(hookResolved.ref.provider, params.cfg)) {
      // Use explicitly configured hook model
      provider = hookResolved.ref.provider;
      model = hookResolved.ref.model;
    } else {
      // Fall back to agent's effective model
      const modelRef = resolveAgentEffectiveModelPrimary(params.cfg, agentId);
      const resolved = modelRef
        ? resolveModelRefFromString({
            raw: modelRef,
            defaultProvider: DEFAULT_PROVIDER,
            aliasIndex,
          })
        : null;
      const rawProvider = resolved?.ref.provider ?? DEFAULT_PROVIDER;
      const rawModel = resolved?.ref.model ?? DEFAULT_MODEL;
      // Slug generation is a lightweight embedded LLM call — CLI backends are not supported.
      provider = isCliProvider(rawProvider, params.cfg) ? DEFAULT_PROVIDER : rawProvider;
      model = isCliProvider(rawProvider, params.cfg) ? DEFAULT_MODEL : rawModel;
    }
    const timeoutMs = resolveSlugTimeoutMs(params.cfg);

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
      trigger: "memory",
      thinkLevel: "minimal",
      disableTools: true,
      timeoutMs,
      runId: `slug-gen-${Date.now()}`,
    });

    // Extract text from payloads
    if (result.payloads && result.payloads.length > 0) {
      const text = result.payloads[0]?.text;
      if (text) {
        // Clean up the response - extract just the slug
        const slug = text
          .trim()
          .toLowerCase()
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
