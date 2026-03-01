import fs from "node:fs/promises";
import path from "node:path";
import { SessionManager } from "@mariozechner/pi-coding-agent";
import type { ThinkLevel } from "../auto-reply/thinking.js";

const HAIKU_MODEL = "claude-3-5-haiku-latest";
const ANTHROPIC_API_URL = "https://api.anthropic.com/v1/messages";

const CHARS_PER_TOKEN = 4;
const MAX_CONTEXT_TOKENS = 10_000;
const MAX_CONTEXT_CHARS = MAX_CONTEXT_TOKENS * CHARS_PER_TOKEN;

const HAIKU_TIMEOUT_MS = 10_000;

/** Levels the classifier may return. */
type ClassifiedLevel = "off" | "low" | "medium" | "high";

const VALID_CLASSIFIED_LEVELS = new Set<ClassifiedLevel>(["off", "low", "medium", "high"]);

const CLASSIFICATION_SYSTEM_PROMPT =
  "You are a complexity classifier. Given the conversation context, determine how much reasoning the AI assistant needs. Reply with exactly one word: off (trivial/greeting), low (simple questions/commands), medium (multi-step tasks, code changes), high (architecture, complex analysis, debugging). Nothing else.";

/** Fallback when haiku call fails or returns unparseable response. */
const FALLBACK_LEVEL: ThinkLevel = "high";

type MessageLike = {
  role: string;
  content: string | Array<{ type: string; text?: string }>;
};

function getAnthropicApiKey(): string | undefined {
  return process.env.ANTHROPIC_OAUTH_TOKEN || process.env.ANTHROPIC_API_KEY;
}

function estimateMessageChars(msg: MessageLike): number {
  if (typeof msg.content === "string") {
    return msg.content.length;
  }
  return msg.content.reduce((sum, block) => sum + (block.text?.length ?? 0), 0);
}

function extractTextContent(msg: MessageLike): string {
  if (typeof msg.content === "string") {
    return msg.content;
  }
  return msg.content
    .filter((b) => b.type === "text")
    .map((b) => b.text ?? "")
    .join("\n");
}

/**
 * Collect the last N whole messages that fit within the character budget.
 * Counts from the end; never truncates a message's start.
 */
function collectRecentMessages(messages: MessageLike[], maxChars: number): MessageLike[] {
  const result: MessageLike[] = [];
  let totalChars = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    const chars = estimateMessageChars(msg);
    if (totalChars + chars > maxChars && result.length > 0) {
      break;
    }
    result.unshift(msg);
    totalChars += chars;
  }
  return result;
}

/**
 * Try to read AGENTS.md (or CLAUDE.md) from the workspace as project context.
 * Returns the file content or undefined if not found.
 */
async function readProjectContext(workspaceDir: string): Promise<string | undefined> {
  for (const name of ["AGENTS.md", "CLAUDE.md"]) {
    try {
      const content = await fs.readFile(path.join(workspaceDir, name), "utf-8");
      if (content.trim()) {
        return content;
      }
    } catch {
      // file not found, try next
    }
  }
  return undefined;
}

/**
 * Read session messages from the session file.
 * Returns an empty array if the session file does not exist.
 */
function readSessionMessages(sessionFile: string): MessageLike[] {
  try {
    const sessionManager = SessionManager.open(sessionFile);
    const ctx = sessionManager.buildSessionContext();
    return (ctx.messages ?? []) as MessageLike[];
  } catch {
    return [];
  }
}

/**
 * Pre-flight call to Haiku to classify the complexity of the upcoming prompt
 * and determine the appropriate thinking level for the main LLM call.
 *
 * Collects project context + recent conversation messages (within ~10k tokens)
 * and asks Haiku to classify as off/low/medium/high.
 *
 * Falls back to "high" on any error.
 */
export async function resolveAutoThinkingLevel(params: {
  sessionFile: string;
  workspaceDir: string;
  prompt: string;
}): Promise<ThinkLevel> {
  const apiKey = getAnthropicApiKey();
  if (!apiKey) {
    return FALLBACK_LEVEL;
  }

  // Build system prompt with project context
  const systemParts: string[] = [CLASSIFICATION_SYSTEM_PROMPT];
  const projectContext = await readProjectContext(params.workspaceDir);
  if (projectContext) {
    // Trim project context to leave room for conversation messages
    const maxProjectChars = Math.floor(MAX_CONTEXT_CHARS * 0.3);
    const trimmed =
      projectContext.length > maxProjectChars
        ? projectContext.slice(0, maxProjectChars) + "\n[truncated]"
        : projectContext;
    systemParts.push(`\nProject context:\n${trimmed}`);
  }

  // Collect recent session messages within the remaining budget
  const sessionMessages = readSessionMessages(params.sessionFile);
  const conversationBudget = Math.floor(MAX_CONTEXT_CHARS * 0.7);
  const recentMessages = collectRecentMessages(sessionMessages, conversationBudget);

  // Build the conversation text for classification
  const conversationLines = recentMessages.map((m) => `${m.role}: ${extractTextContent(m)}`);
  conversationLines.push(`user: ${params.prompt}`);
  const conversationText = conversationLines.join("\n---\n");

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), HAIKU_TIMEOUT_MS);

    const response = await fetch(ANTHROPIC_API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: HAIKU_MODEL,
        max_tokens: 10,
        system: systemParts.join("\n"),
        messages: [{ role: "user", content: conversationText }],
      }),
      signal: controller.signal,
    });

    clearTimeout(timeout);
    if (!response.ok) {
      return FALLBACK_LEVEL;
    }

    const data = (await response.json()) as {
      content?: Array<{ type: string; text?: string }>;
    };
    const text = data?.content?.[0]?.text?.trim().toLowerCase();
    if (text && VALID_CLASSIFIED_LEVELS.has(text as ClassifiedLevel)) {
      return text as ThinkLevel;
    }
    return FALLBACK_LEVEL;
  } catch {
    return FALLBACK_LEVEL;
  }
}
