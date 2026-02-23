/**
 * Session-End Memory Flush
 *
 * Extracts and persists important context from a session before it resets
 * due to idle timeout, daily reset, or manual /new command.
 *
 * This ensures no context is lost when sessions reset before reaching
 * the normal pre-compaction flush threshold.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { OpenClawConfig } from "../../config/config.js";
import type { SessionEntry } from "../../config/sessions.js";
import { runWithModelFallback } from "../../agents/model-fallback.js";
import { runEmbeddedPiAgent } from "../../agents/pi-embedded.js";
import { logVerbose } from "../../globals.js";
import { SILENT_REPLY_TOKEN } from "../tokens.js";

/**
 * Comprehensive prompt designed to extract maximum context from a session.
 * This is more thorough than the pre-compaction flush because:
 * 1. Session is ending - this is our last chance to preserve context
 * 2. We want to capture everything valuable, not just "durable memories"
 * 3. The context may not have reached compaction threshold yet
 */
export const SESSION_END_FLUSH_PROMPT = `SESSION ENDING - COMPREHENSIVE MEMORY EXTRACTION

This session is about to reset. Extract and save ALL valuable context to memory files.

## EXTRACTION CHECKLIST - Review the conversation and extract:

### 1. FACTS & INFORMATION
- Names, identifiers, account IDs mentioned
- File paths, URLs, API endpoints discussed
- Configuration values, settings, preferences stated
- Technical specifications, versions, requirements
- Dates, deadlines, schedules mentioned

### 2. DECISIONS & CONCLUSIONS
- What was decided or agreed upon?
- What approaches were chosen and why?
- What was rejected or ruled out?

### 3. TASKS & ACTION ITEMS
- What needs to be done (explicit or implied)?
- What's in progress vs completed?
- What's blocked and why?

### 4. CONTEXT & RELATIONSHIPS
- How do discussed topics relate to each other?
- What's the broader context or goal?
- What assumptions or constraints apply?

### 5. PROBLEMS & SOLUTIONS
- What issues were identified?
- What solutions were implemented or proposed?
- What troubleshooting was done?

### 6. USER PREFERENCES & PATTERNS
- Communication style preferences
- Workflow preferences mentioned
- Tool or approach preferences

## OUTPUT INSTRUCTIONS

1. Write to memory/YYYY-MM-DD.md (create memory/ dir if needed)
2. Use today's date for the filename
3. Append to existing content if file exists
4. Use clear headers and bullet points
5. Include timestamps where relevant
6. Be comprehensive - better to over-capture than miss something

If the session contains no meaningful content to extract (e.g., just a greeting), reply with ${SILENT_REPLY_TOKEN}.`;

export const SESSION_END_FLUSH_SYSTEM_PROMPT = `You are performing a session-end memory extraction.

CRITICAL: This is your LAST CHANCE to preserve context from this conversation before the session resets.

Guidelines:
- Be thorough - extract everything that might be useful later
- Be specific - include actual values, not vague descriptions
- Be organized - use clear structure and headers
- Append to existing memory files, don't overwrite
- Focus on facts and actionable information
- Preserve technical details exactly (paths, IDs, configs)

If nothing valuable to extract, reply with ${SILENT_REPLY_TOKEN}.
Do NOT reply with any other message to the user.`;

/**
 * Default model for session-end flush (cheap but capable)
 */
export const DEFAULT_SESSION_END_FLUSH_MODEL = "anthropic/claude-3-5-haiku-20241022";

export type SessionEndFlushSettings = {
  enabled: boolean;
  model: string;
  prompt: string;
  systemPrompt: string;
};

/**
 * Resolve session-end flush settings from config
 */
export function resolveSessionEndFlushSettings(
  cfg?: OpenClawConfig,
): SessionEndFlushSettings | null {
  const sessionCfg = cfg?.session;
  const resetCfg = sessionCfg?.reset;

  // Check if enabled (default: false for backward compatibility)
  const enabled = resetCfg?.flushMemoryOnReset ?? false;
  if (!enabled) {
    return null;
  }

  // Use configured model or default to Haiku (cheap)
  const model = resetCfg?.flushModel ?? DEFAULT_SESSION_END_FLUSH_MODEL;
  const prompt = resetCfg?.flushPrompt?.trim() || SESSION_END_FLUSH_PROMPT;
  const systemPrompt = resetCfg?.flushSystemPrompt?.trim() || SESSION_END_FLUSH_SYSTEM_PROMPT;

  return {
    enabled,
    model,
    prompt,
    systemPrompt,
  };
}

/**
 * Run memory flush before session reset.
 *
 * This function is called when a session is about to reset due to:
 * - Idle timeout expiry
 * - Daily reset boundary
 * - Manual /new or /reset command
 *
 * It loads the existing session transcript and runs an agent turn
 * to extract and persist important context to memory files.
 */
export async function runSessionEndFlush(params: {
  cfg: OpenClawConfig;
  sessionEntry: SessionEntry;
  sessionKey: string;
  agentId: string;
  workspaceDir: string;
  agentDir: string;
}): Promise<void> {
  const settings = resolveSessionEndFlushSettings(params.cfg);
  if (!settings) {
    return;
  }

  const sessionFile = params.sessionEntry.sessionFile;
  if (!sessionFile || !fs.existsSync(sessionFile)) {
    logVerbose(`session-end flush: no session file found for ${params.sessionKey}`);
    return;
  }

  // Check if session has any meaningful content
  const totalTokens = params.sessionEntry.totalTokens ?? 0;
  if (totalTokens < 100) {
    logVerbose(`session-end flush: skipping - session too short (${totalTokens} tokens)`);
    return;
  }

  logVerbose(
    `session-end flush: extracting context from ${params.sessionKey} (${totalTokens} tokens)`,
  );

  try {
    // Parse model string into provider and model parts
    const modelParts = settings.model.split("/");
    const flushProvider = modelParts[0] || "anthropic";
    const flushModel = modelParts.slice(1).join("/") || "claude-3-5-haiku-20241022";

    await runWithModelFallback({
      cfg: params.cfg,
      provider: flushProvider,
      model: flushModel,
      agentDir: params.agentDir,
      run: (provider, model) => {
        return runEmbeddedPiAgent({
          sessionId: params.sessionEntry.sessionId,
          sessionKey: params.sessionKey,
          sessionFile,
          workspaceDir: params.workspaceDir,
          agentDir: params.agentDir,
          config: params.cfg,
          prompt: settings.prompt,
          extraSystemPrompt: settings.systemPrompt,
          provider,
          model,
          thinkLevel: "off",
          verboseLevel: "off",
          reasoningLevel: "off",
          timeoutMs: 60_000,
          runId: crypto.randomUUID(),
          enforceFinalTag: false,
        });
      },
    });

    logVerbose(`session-end flush: completed for ${params.sessionKey}`);
  } catch (err) {
    logVerbose(`session-end flush failed: ${String(err)}`);
    // Don't throw - session reset should proceed even if flush fails
  }
}
