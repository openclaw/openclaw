import { logVerbose } from "../../globals.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { runCommandWithTimeout } from "../../process/exec.js";

const log = createSubsystemLogger("discord/tool-feedback");

const DEFAULT_BUFFER_MS = 3000;
const DEFAULT_MAX_WAIT_MS = 8000;
const DEFAULT_FILTER_MODEL = "haiku";
const DEFAULT_FILTER_TIMEOUT_MS = 5000;

type BufferedTool = {
  toolName: string;
  detail?: string;
  timestamp: number;
};

export type ToolFeedbackFilterConfig = {
  /** Buffer window: how long to wait for more tools before flushing. Default: 3000. */
  bufferMs?: number;
  /** Max time before flushing regardless of new tools. Default: 8000. */
  maxWaitMs?: number;
  /** Model for filtering. Default: haiku. */
  model?: string;
  /** Timeout for the model call. Default: 5000. */
  timeoutMs?: number;
};

type CliResponse = {
  result?: string;
  is_error?: boolean;
};

function parseCliResponse(stdout: string): string | null {
  const trimmed = stdout.trim();
  if (!trimmed) {
    return null;
  }
  try {
    const parsed = JSON.parse(trimmed) as CliResponse;
    if (parsed.is_error) {
      return null;
    }
    return parsed.result?.trim() || null;
  } catch {
    return trimmed || null;
  }
}

/** Max characters for a single tool detail in the batch summary. */
const MAX_DETAIL_LENGTH = 60;

/** Keys to extract from tool input as a short detail string. */
const DETAIL_KEYS: Record<string, string[]> = {
  Read: ["file_path"],
  Write: ["file_path"],
  Edit: ["file_path"],
  Glob: ["pattern"],
  Grep: ["pattern"],
  Bash: ["command"],
  WebSearch: ["query"],
  WebFetch: ["url"],
  Task: ["description"],
};

function extractToolDetail(toolName: string, input?: Record<string, unknown>): string | undefined {
  if (!input) {
    return undefined;
  }
  const keys = DETAIL_KEYS[toolName];
  if (!keys) {
    return undefined;
  }
  for (const key of keys) {
    const value = input[key];
    if (typeof value === "string" && value.length > 0) {
      return value.length > MAX_DETAIL_LENGTH ? value.slice(0, MAX_DETAIL_LENGTH) + "…" : value;
    }
  }
  return undefined;
}

function summarizeToolBatch(tools: BufferedTool[]): string {
  // Group by tool name, collecting details
  const groups = new Map<string, { count: number; details: string[] }>();
  for (const tool of tools) {
    const group = groups.get(tool.toolName) ?? { count: 0, details: [] };
    group.count += 1;
    if (tool.detail) {
      group.details.push(tool.detail);
    }
    groups.set(tool.toolName, group);
  }
  return [...groups.entries()]
    .map(([name, group]) => {
      const label = group.count > 1 ? `${name} (x${group.count})` : name;
      if (group.details.length > 0) {
        // Show up to 3 details to keep the summary manageable
        const shown = group.details.slice(0, 3).join(", ");
        return `${label}: ${shown}`;
      }
      return label;
    })
    .join("; ");
}

async function askHaikuToFilter(params: {
  userMessage: string;
  toolSummary: string;
  model: string;
  timeoutMs: number;
}): Promise<string | null> {
  const prompt =
    `You are deciding what status to show a user while an AI agent processes their request in a Discord server.\n\n` +
    `The user asked: "${params.userMessage}"\n\n` +
    `The agent just used these tools: ${params.toolSummary}\n\n` +
    `Rules:\n` +
    `- Consider whether the tools are directly fulfilling what the user asked for, or just background exploration.\n` +
    `- If the user asked to read, find, search, fetch, or look up something, and the tools are doing exactly that, ` +
    `write a brief status update describing the action.\n` +
    `- If the tools are just background exploration the agent is doing on its own to gather context before answering ` +
    `(e.g., reading several code files to understand a codebase), respond with SKIP.\n` +
    `- For tools like running commands, writing files, editing code, web searches, or running subagents, ` +
    `always write a brief status update.\n` +
    `- Status updates should be max 8 words, in present tense (e.g. "Reading the configuration file..." or "Searching for matching files...")\n` +
    `- Only respond with SKIP or the status text, nothing else`;

  const args = [
    "--model",
    params.model,
    "-p",
    prompt,
    "--output-format",
    "json",
    "--max-turns",
    "1",
  ];

  try {
    const result = await runCommandWithTimeout(["claude", ...args], {
      timeoutMs: params.timeoutMs,
    });
    if (result.code !== 0) {
      log.warn(
        `tool-feedback-filter: CLI exited with code ${result.code}: ${result.stderr || result.stdout || "unknown"}`,
      );
      return null;
    }
    const text = parseCliResponse(result.stdout);
    if (!text || text.toUpperCase().startsWith("SKIP")) {
      return null;
    }
    return text;
  } catch (err) {
    log.warn(`tool-feedback-filter: failed: ${formatErrorMessage(err)}`);
    return null;
  }
}

/**
 * Create a buffered tool feedback filter that collects tool calls and uses Haiku
 * to decide which are worth showing to the user. Prevents spamming the status
 * message with every single Read/Glob/Grep call.
 */
export function createToolFeedbackFilter(params: {
  userMessage: string;
  onUpdate: (text: string) => void;
  config?: ToolFeedbackFilterConfig;
}): {
  push: (tool: { toolName: string; toolCallId: string; input?: Record<string, unknown> }) => void;
  dispose: () => void;
} {
  const bufferMs = params.config?.bufferMs ?? DEFAULT_BUFFER_MS;
  const maxWaitMs = params.config?.maxWaitMs ?? DEFAULT_MAX_WAIT_MS;
  const model = params.config?.model ?? DEFAULT_FILTER_MODEL;
  const timeoutMs = params.config?.timeoutMs ?? DEFAULT_FILTER_TIMEOUT_MS;

  const buffer: BufferedTool[] = [];
  let debounceTimer: ReturnType<typeof setTimeout> | undefined;
  let maxWaitTimer: ReturnType<typeof setTimeout> | undefined;
  let flushing = false;
  let disposed = false;

  async function flush() {
    if (buffer.length === 0 || flushing || disposed) {
      return;
    }
    flushing = true;

    // Take all buffered tools
    const batch = buffer.splice(0, buffer.length);

    // Clear timers
    if (debounceTimer) {
      clearTimeout(debounceTimer);
      debounceTimer = undefined;
    }
    if (maxWaitTimer) {
      clearTimeout(maxWaitTimer);
      maxWaitTimer = undefined;
    }

    try {
      const toolSummary = summarizeToolBatch(batch);
      logVerbose(`tool-feedback-filter: flushing batch: ${toolSummary}`);

      const status = await askHaikuToFilter({
        userMessage: params.userMessage,
        toolSummary,
        model,
        timeoutMs,
      });

      if (status && !disposed) {
        params.onUpdate(`*${status}*`);
      }
    } catch (err) {
      log.warn(`tool-feedback-filter: flush failed: ${formatErrorMessage(err)}`);
    } finally {
      flushing = false;
    }
  }

  function push(tool: { toolName: string; toolCallId: string; input?: Record<string, unknown> }) {
    if (disposed) {
      return;
    }
    const detail = extractToolDetail(tool.toolName, tool.input);
    buffer.push({ toolName: tool.toolName, detail, timestamp: Date.now() });

    // Reset debounce timer
    if (debounceTimer) {
      clearTimeout(debounceTimer);
    }
    debounceTimer = setTimeout(() => void flush(), bufferMs);

    // Start max-wait timer on first tool in batch
    if (!maxWaitTimer) {
      maxWaitTimer = setTimeout(() => void flush(), maxWaitMs);
    }
  }

  function dispose() {
    disposed = true;
    if (debounceTimer) {
      clearTimeout(debounceTimer);
      debounceTimer = undefined;
    }
    if (maxWaitTimer) {
      clearTimeout(maxWaitTimer);
      maxWaitTimer = undefined;
    }
  }

  return { push, dispose };
}
