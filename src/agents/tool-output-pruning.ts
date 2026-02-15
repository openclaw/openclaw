import type { AgentMessage } from "@mariozechner/pi-agent-core";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { OpenClawConfig } from "../config/config.js";
import { createSubsystemLogger } from "../logging/subsystem.js";

const log = createSubsystemLogger("agent/tool-output-pruning");

/** Chars per token estimate (conservative for English text). */
const CHARS_PER_TOKEN = 4;

export type ToolPruningConfig = {
  /** Default max tokens for tool results. */
  maxToolResultTokens: number;
  /** Head portion to preserve (ratio of maxTokens). */
  headRatio: number;
  /** Tail portion to preserve (ratio of maxTokens). */
  tailRatio: number;
  /** Per-tool token overrides. */
  perToolLimits: Record<string, number>;
  /** Number of recent assistant turns to protect from pruning. */
  protectLastAssistantTurns: number;
};

const DEFAULT_CONFIG: ToolPruningConfig = {
  maxToolResultTokens: 3000,
  headRatio: 0.4,
  tailRatio: 0.1,
  perToolLimits: {
    browser: 2000,
    readMessages: 3000,
    bash: 4000,
  },
  protectLastAssistantTurns: 3,
};

export function resolveToolPruningConfig(cfg?: OpenClawConfig): ToolPruningConfig {
  const raw = cfg?.agents?.defaults?.contextPruning as Record<string, unknown> | undefined;
  if (!raw) {
    return DEFAULT_CONFIG;
  }

  const maxTokens =
    typeof raw.maxToolResultTokens === "number"
      ? raw.maxToolResultTokens
      : DEFAULT_CONFIG.maxToolResultTokens;
  const headRatio = typeof raw.headRatio === "number" ? raw.headRatio : DEFAULT_CONFIG.headRatio;
  const tailRatio = typeof raw.tailRatio === "number" ? raw.tailRatio : DEFAULT_CONFIG.tailRatio;
  const protectLast =
    typeof raw.protectLastAssistantTurns === "number"
      ? raw.protectLastAssistantTurns
      : DEFAULT_CONFIG.protectLastAssistantTurns;

  const perToolLimits = { ...DEFAULT_CONFIG.perToolLimits };
  if (raw.perToolLimits && typeof raw.perToolLimits === "object") {
    for (const [key, val] of Object.entries(raw.perToolLimits as Record<string, unknown>)) {
      if (typeof val === "number") {
        perToolLimits[key] = val;
      }
    }
  }

  return {
    maxToolResultTokens: maxTokens,
    headRatio,
    tailRatio,
    perToolLimits,
    protectLastAssistantTurns: protectLast,
  };
}

/**
 * Get the max token limit for a specific tool.
 */
export function getToolLimit(toolName: string | undefined, config: ToolPruningConfig): number {
  if (toolName && config.perToolLimits[toolName] !== undefined) {
    return config.perToolLimits[toolName];
  }
  return config.maxToolResultTokens;
}

const PLACEHOLDER_TEMPLATE =
  "\n\n--- CONTENT PRUNED ---\n" +
  "[{removedTokens} tokens removed. Full output saved to: {filePath}]\n" +
  "[Use read_tool_output tool with path above to retrieve full content.]\n" +
  "--- END PRUNED ---\n\n";

/**
 * Prune a tool result text using head+tail preservation.
 * Returns the pruned text and the path to the full output file (if saved).
 */
export function pruneToolResultText(params: {
  text: string;
  maxTokens: number;
  headRatio: number;
  tailRatio: number;
  fullOutputPath?: string;
}): { text: string; pruned: boolean } {
  const { text, maxTokens, headRatio, tailRatio } = params;
  const maxChars = maxTokens * CHARS_PER_TOKEN;

  if (text.length <= maxChars) {
    return { text, pruned: false };
  }

  const headChars = Math.floor(maxChars * headRatio);
  const tailChars = Math.floor(maxChars * tailRatio);
  const removedChars = text.length - headChars - tailChars;
  const removedTokens = Math.ceil(removedChars / CHARS_PER_TOKEN);

  const head = text.slice(0, headChars);
  const tail = text.slice(text.length - tailChars);

  const placeholder = PLACEHOLDER_TEMPLATE.replace(
    "{removedTokens}",
    String(removedTokens),
  ).replace("{filePath}", params.fullOutputPath ?? "N/A");

  return {
    text: head + placeholder + tail,
    pruned: true,
  };
}

/**
 * Save full tool output to a temp file for later retrieval.
 */
export async function saveFullToolOutput(text: string, toolName: string): Promise<string> {
  const dir = path.join(os.tmpdir(), "openclaw-tool-outputs");
  await fs.mkdir(dir, { recursive: true });
  const filename = `${toolName}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.txt`;
  const filePath = path.join(dir, filename);
  await fs.writeFile(filePath, text, "utf8");
  log.info(`saved full tool output: ${filePath} (${text.length} chars)`);
  return filePath;
}

/**
 * Read a previously saved full tool output.
 */
export async function readFullToolOutput(
  filePath: string,
): Promise<{ content: string; found: boolean }> {
  try {
    // Security: only allow reading from the expected temp directory
    const expectedDir = path.join(os.tmpdir(), "openclaw-tool-outputs");
    const resolved = path.resolve(filePath);
    if (!resolved.startsWith(expectedDir)) {
      return { content: "Access denied: path outside tool output directory.", found: false };
    }
    const content = await fs.readFile(resolved, "utf8");
    return { content, found: true };
  } catch {
    return { content: `File not found: ${filePath}`, found: false };
  }
}

type TextContent = { type: "text"; text: string; [key: string]: unknown };

function estimateToolResultTextLength(msg: AgentMessage): number {
  const content = (msg as { content?: unknown }).content;
  if (!Array.isArray(content)) {
    return 0;
  }
  let total = 0;
  for (const block of content) {
    if (block && typeof block === "object" && (block as { type?: string }).type === "text") {
      total += ((block as TextContent).text ?? "").length;
    }
  }
  return total;
}

/**
 * Find the index of the last N assistant turns in a message array.
 * Returns the index of the first protected message, or messages.length if
 * fewer than N assistant turns exist.
 */
export function findProtectedBoundary(messages: AgentMessage[], protectCount: number): number {
  if (protectCount <= 0) {
    return messages.length;
  }

  let assistantCount = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    if ((messages[i] as { role?: string }).role === "assistant") {
      assistantCount++;
      if (assistantCount >= protectCount) {
        return i;
      }
    }
  }
  return 0;
}

/**
 * Prune oversized tool results in a message array.
 * Respects per-tool limits and protects the last N assistant turns.
 */
export async function pruneToolResults(params: {
  messages: AgentMessage[];
  config: ToolPruningConfig;
}): Promise<{ messages: AgentMessage[]; prunedCount: number }> {
  const { messages, config } = params;
  const protectedBoundary = findProtectedBoundary(messages, config.protectLastAssistantTurns);

  let prunedCount = 0;
  const result: AgentMessage[] = [];

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    const role = (msg as { role?: string }).role;

    if (role !== "toolResult" || i >= protectedBoundary) {
      result.push(msg);
      continue;
    }

    const toolName = (msg as { toolName?: string }).toolName;
    const maxTokens = getToolLimit(toolName, config);
    const textLength = estimateToolResultTextLength(msg);
    const maxChars = maxTokens * CHARS_PER_TOKEN;

    if (textLength <= maxChars) {
      result.push(msg);
      continue;
    }

    // Prune this tool result
    const content = (msg as { content?: unknown[] }).content;
    if (!Array.isArray(content)) {
      result.push(msg);
      continue;
    }

    // Save full output for retrieval
    const fullText = content
      .filter((b) => (b as { type?: string }).type === "text")
      .map((b) => (b as TextContent).text)
      .join("\n");
    const filePath = await saveFullToolOutput(fullText, toolName ?? "unknown");

    const prunedContent = content.map((block) => {
      if ((block as { type?: string }).type !== "text") {
        return block;
      }
      const textBlock = block as TextContent;
      const { text: prunedText } = pruneToolResultText({
        text: textBlock.text,
        maxTokens,
        headRatio: config.headRatio,
        tailRatio: config.tailRatio,
        fullOutputPath: filePath,
      });
      return { ...textBlock, text: prunedText };
    });

    prunedCount++;
    log.info(
      `pruned tool result: tool=${toolName} original=${textLength} chars ` +
        `limit=${maxChars} chars saved=${filePath}`,
    );

    result.push({ ...msg, content: prunedContent } as AgentMessage);
  }

  return { messages: result, prunedCount };
}
