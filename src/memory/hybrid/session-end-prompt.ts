/**
 * Session-End Memory Prompting
 *
 * Prompts users to save important conversations to memory after meaningful sessions.
 */

import type { OpenClawConfig } from "../../config/config.js";
import { resolveAgentWorkspaceDir } from "../../agents/agent-scope.js";
import { formatDate } from "./daily-memory.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";

const log = createSubsystemLogger("memory-hybrid-prompt");

export const DEFAULT_MIN_SESSION_MINUTES = 5;
export const DEFAULT_SESSION_END_MESSAGE = `💾 **Save to Memory?**

We just had a meaningful conversation. Would you like me to save key points to your daily log (\`memory/{{date}}.md\`)?

You can:
- Reply with the key points you want me to save
- Say "auto" and I'll summarize what we discussed
- Say "skip" to ignore this reminder

This helps build your long-term memory across sessions.`;

/**
 * Resolve session-end prompt configuration with defaults
 */
export function resolveSessionEndPromptConfig(cfg: OpenClawConfig): {
  enabled: boolean;
  minDurationMinutes: number;
  message: string;
} {
  const config = cfg.memory?.hybrid?.sessionEnd;
  return {
    enabled: config?.prompt ?? false,
    minDurationMinutes: config?.minDurationMinutes ?? DEFAULT_MIN_SESSION_MINUTES,
    message: config?.message ?? DEFAULT_SESSION_END_MESSAGE,
  };
}

/**
 * Check if session-end prompting is enabled
 */
export function isSessionEndPromptEnabled(cfg: OpenClawConfig): boolean {
  const config = resolveSessionEndPromptConfig(cfg);
  return config.enabled;
}

/**
 * Check if session qualifies for memory prompt
 */
export function shouldPromptForMemory(
  cfg: OpenClawConfig,
  sessionDurationMs: number,
): boolean {
  if (!isSessionEndPromptEnabled(cfg)) {
    return false;
  }

  const config = resolveSessionEndPromptConfig(cfg);
  const sessionMinutes = sessionDurationMs / (1000 * 60);
  const qualifies = sessionMinutes >= config.minDurationMinutes;

  if (qualifies) {
    log.debug(`Session qualifies for memory prompt (${sessionMinutes.toFixed(1)}m >= ${config.minDurationMinutes}m min)`);
  }

  return qualifies;
}

/**
 * Generate session-end memory prompt
 */
export function generateSessionEndPrompt(
  cfg: OpenClawConfig,
  agentId: string,
  date: Date = new Date(),
): {
  message: string;
  dailyLogPath: string;
} | null {
  if (!isSessionEndPromptEnabled(cfg)) {
    return null;
  }

  const config = resolveSessionEndPromptConfig(cfg);
  const dateStr = formatDate(date);
  const message = config.message.replace(/\{\{date\}\}/g, dateStr);

  const workspaceDir = resolveAgentWorkspaceDir(cfg, agentId);
  const dailyLogPath = `${workspaceDir}/memory/${dateStr}.md`;

  return {
    message,
    dailyLogPath,
  };
}

/**
 * Format session-end prompt for delivery
 */
export function formatSessionEndPromptForUser(
  cfg: OpenClawConfig,
  agentId: string,
  sessionDurationMs: number,
  date: Date = new Date(),
): { text: string; qualifies: boolean } {
  const qualifies = shouldPromptForMemory(cfg, sessionDurationMs);

  if (!qualifies) {
    return {
      text: "",
      qualifies: false,
    };
  }

  const prompt = generateSessionEndPrompt(cfg, agentId, date);
  return {
    text: prompt?.message ?? "",
    qualifies: true,
  };
}

/**
 * Check if user response is an auto-save request
 */
export function isAutoSaveRequest(response: string): boolean {
  const trimmed = response.trim().toLowerCase();
  return trimmed === "auto" || trimmed === "automatic" || trimmed === "yes";
}

/**
 * Check if user wants to skip memory save
 */
export function isSkipRequest(response: string): boolean {
  const trimmed = response.trim().toLowerCase();
  return (
    trimmed === "skip" ||
    trimmed === "no" ||
    trimmed === "ignore" ||
    trimmed === "later"
  );
}
