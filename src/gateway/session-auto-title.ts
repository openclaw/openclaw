/**
 * Auto-generate session titles via AI summarization after N turns.
 *
 * After a configurable number of turns (default 3), a lightweight AI call
 * generates a concise title (≤50 chars by default). The title is stored in
 * `session.aiTitle` and takes precedence over the truncated first-user-message
 * fallback, but is overridden by `displayName` (manual rename).
 */

import { DEFAULT_MODEL, DEFAULT_PROVIDER } from "../agents/defaults.js";
import { resolveEnvApiKey } from "../agents/model-auth.js";
import { resolveConfiguredModelRef } from "../agents/model-selection.js";
import { updateSessionStoreEntry, type SessionEntry } from "../config/sessions.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { extractAssistantVisibleText } from "../shared/chat-message-content.js";
import { stripInlineDirectiveTagsForDisplay } from "../utils/directive-tags.js";
import { readRecentSessionMessages } from "./session-utils.fs.js";

/** Resolved config for auto-title generation. */
export type SessionTitleConfig = {
  enabled: boolean;
  turnsBeforeTitle: number;
  maxChars: number;
};

const DEFAULT_SESSION_TITLE_CONFIG: SessionTitleConfig = {
  enabled: true,
  turnsBeforeTitle: 3,
  maxChars: 50,
};

/** Merge user config with defaults. */
export function resolveSessionTitleConfig(
  userConfig?: { enabled?: boolean; turnsBeforeTitle?: number; maxChars?: number } | null,
): SessionTitleConfig {
  if (!userConfig) {
    return DEFAULT_SESSION_TITLE_CONFIG;
  }
  return {
    enabled: userConfig.enabled ?? DEFAULT_SESSION_TITLE_CONFIG.enabled,
    turnsBeforeTitle: userConfig.turnsBeforeTitle ?? DEFAULT_SESSION_TITLE_CONFIG.turnsBeforeTitle,
    maxChars: userConfig.maxChars ?? DEFAULT_SESSION_TITLE_CONFIG.maxChars,
  };
}

/**
 * Count user-turns in a message list. Each user role message counts as one turn.
 */
export function countUserTurns(messages: unknown[]): number {
  let count = 0;
  for (const msg of messages) {
    if (!msg || typeof msg !== "object") {
      continue;
    }
    const rec = msg as Record<string, unknown>;
    const role = typeof rec.role === "string" ? rec.role : "";
    if (role === "user") {
      count++;
    }
  }
  return count;
}

/**
 * Extract a short conversation summary for the title prompt.
 * Returns up to `maxMessages` messages as plain text, truncated.
 */
export function extractConversationForTitlePrompt(
  messages: unknown[],
  maxMessages = 6,
  maxCharsPerMsg = 200,
): string {
  const recent = messages.slice(-maxMessages);
  const lines: string[] = [];
  for (const msg of recent) {
    if (!msg || typeof msg !== "object") {
      continue;
    }
    const rec = msg as Record<string, unknown>;
    const role = typeof rec.role === "string" ? rec.role : "";
    if (role !== "user" && role !== "assistant") {
      continue;
    }

    let text = "";
    const content = rec.content;
    if (typeof content === "string") {
      text = content;
    } else if (Array.isArray(content)) {
      for (const part of content) {
        if (!part || typeof part !== "object") {
          continue;
        }
        const p = part as Record<string, unknown>;
        if (typeof p.text === "string" && (p.type === "text" || p.type === "output_text")) {
          text = p.text;
          break;
        }
      }
    }

    // For assistant messages, also try extractAssistantVisibleText
    if (!text && role === "assistant") {
      try {
        text = extractAssistantVisibleText(rec) ?? "";
      } catch {
        // ignore
      }
    }

    if (!text) {
      continue;
    }
    text = stripInlineDirectiveTagsForDisplay(text).text.trim();
    if (!text) {
      continue;
    }
    if (text.length > maxCharsPerMsg) {
      text = text.slice(0, maxCharsPerMsg - 3) + "...";
    }
    lines.push(`${role}: ${text}`);
  }
  return lines.join("\n");
}

/**
 * Build the prompt for AI title generation.
 */
export function buildTitlePrompt(conversation: string, maxChars: number): string {
  return (
    `Summarize the following conversation in a short title of at most ${maxChars} characters. ` +
    `Reply with ONLY the title, no quotes, no punctuation at the end, no explanation.\n\n${conversation}`
  );
}

/**
 * Check if auto-title should be generated for a session.
 * Returns true if:
 * - Title config is enabled
 * - Session doesn't already have an aiTitle (don't regenerate)
 * - Session doesn't have a displayName (user manual rename takes precedence)
 * - There are enough user turns
 */
export function shouldGenerateAutoTitle(
  entry: SessionEntry | undefined,
  config: SessionTitleConfig,
  userTurnCount: number,
): boolean {
  if (!config.enabled) {
    return false;
  }
  if (!entry) {
    return false;
  }
  if (entry.aiTitle?.trim()) {
    return false; // already generated
  }
  if (entry.displayName?.trim()) {
    return false; // user renamed
  }
  return userTurnCount >= config.turnsBeforeTitle;
}

/**
 * Resolve provider endpoint config for title generation.
 * Uses the default model configured in the gateway, falling back to
 * env vars (OPENAI_BASE_URL / OPENAI_API_KEY).
 */
function resolveTitleProviderConfig(
  cfg?: OpenClawConfig,
): { baseUrl: string; apiKey?: string; model: string } | null {
  // Try the configured default provider/model first
  if (cfg) {
    const resolved = resolveConfiguredModelRef({
      cfg,
      defaultProvider: DEFAULT_PROVIDER,
      defaultModel: DEFAULT_MODEL,
    });
    const provider = resolved.provider;
    const model = resolved.model;

    // Resolve API key for the provider
    const envResult = resolveEnvApiKey(provider);
    const apiKey = envResult?.apiKey;

    // Resolve base URL from provider config (cfg.models.providers, not cfg.providers)
    const providerCfg = cfg.models?.providers?.[provider];
    const baseUrl =
      typeof providerCfg === "object" && providerCfg !== null
        ? (providerCfg as Record<string, unknown>).baseUrl
        : undefined;

    if (typeof baseUrl === "string" && baseUrl.trim()) {
      return { baseUrl: baseUrl.trim(), apiKey, model };
    }

    // Try the OPENAI_BASE_URL env var as fallback
    const envBaseUrl = process.env.OPENAI_BASE_URL;
    if (envBaseUrl?.trim()) {
      return { baseUrl: envBaseUrl.trim(), apiKey, model };
    }
  }

  // Final fallback: env vars only
  const envBaseUrl = process.env.OPENAI_BASE_URL;
  if (!envBaseUrl) {
    return null;
  }
  const apiKey = process.env.OPENAI_API_KEY;
  const model = process.env.OPENAI_MODEL || "gpt-4o-mini";
  return { baseUrl: envBaseUrl, apiKey, model };
}

/**
 * Make a lightweight chat completion call to generate a title.
 */
async function generateAiTitleWithFetch(
  conversation: string,
  maxChars: number,
  providerOpts: {
    baseUrl: string;
    apiKey?: string;
    model: string;
  },
): Promise<string | null> {
  const prompt = buildTitlePrompt(conversation, maxChars);

  try {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (providerOpts.apiKey) {
      headers["Authorization"] = `Bearer ${providerOpts.apiKey}`;
    }

    // Ensure baseUrl ends without trailing slash for consistent URL join
    const baseUrl = providerOpts.baseUrl.replace(/\/+$/, "");

    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: providerOpts.model,
        messages: [{ role: "user", content: prompt }],
        max_tokens: 60,
        temperature: 0.3,
      }),
      signal: AbortSignal.timeout(15_000),
    });

    if (!response.ok) {
      return null;
    }

    const data = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const content = data?.choices?.[0]?.message?.content?.trim();
    if (!content) {
      return null;
    }

    // Truncate to maxChars if needed
    return content.length > maxChars ? content.slice(0, maxChars - 1) + "…" : content;
  } catch {
    return null;
  }
}

/**
 * Main entry point: trigger auto-title generation for a session if conditions are met.
 * This is designed to be called asynchronously (fire-and-forget) after a run completes.
 */
export async function triggerAutoTitleGeneration(params: {
  sessionKey: string;
  sessionEntry: SessionEntry | undefined;
  config: SessionTitleConfig;
  storePath: string | undefined;
  sessionId: string;
  sessionFile?: string;
  cfg?: OpenClawConfig;
}): Promise<void> {
  const { sessionKey, sessionEntry, config, storePath, sessionId, sessionFile, cfg } = params;

  // Read recent messages to count turns and build conversation summary
  const messages = readRecentSessionMessages(sessionId, storePath, sessionFile, {
    maxMessages: 20,
  });

  const userTurnCount = countUserTurns(messages);

  if (!shouldGenerateAutoTitle(sessionEntry, config, userTurnCount)) {
    return;
  }

  const conversation = extractConversationForTitlePrompt(messages);
  if (!conversation.trim()) {
    return;
  }

  const providerConfig = resolveTitleProviderConfig(cfg);
  if (!providerConfig) {
    return;
  }

  const aiTitle = await generateAiTitleWithFetch(conversation, config.maxChars, providerConfig);
  if (!aiTitle || !aiTitle.trim()) {
    return;
  }

  // Persist the aiTitle to the session entry
  if (!storePath) {
    return;
  }
  try {
    await updateSessionStoreEntry({
      storePath,
      sessionKey,
      update: async () => ({ aiTitle: aiTitle.trim() as string }),
    });
  } catch {
    // Non-critical; don't block on failure
  }
}
