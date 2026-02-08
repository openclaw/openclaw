import type { AgentStreamEvent } from "../../auto-reply/types.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { runCommandWithTimeout } from "../../process/exec.js";

const log = createSubsystemLogger("discord/smart-status");

const DEFAULT_INTERVAL_MS = 15000;
const DEFAULT_HAIKU_TIMEOUT_MS = 5000;
const DEFAULT_MODEL = "haiku";
const MAX_TEXT_TAIL = 500;
const MAX_THINKING_TAIL = 300;

export type SmartStatusConfig = {
  /** Interval between Haiku status updates (ms). Default: 15000. */
  intervalMs?: number;
  /** Model for status generation. Default: haiku. */
  model?: string;
  /** Timeout for the model call (ms). Default: 5000. */
  timeoutMs?: number;
};

type AccumulatedContext = {
  /** Tool names with call counts. */
  tools: Map<string, number>;
  /** Count of errored tool calls. */
  toolErrors: number;
  /** Tail of text output (truncated to MAX_TEXT_TAIL chars). */
  textTail: string;
  /** Tail of thinking output (truncated to MAX_THINKING_TAIL chars). */
  thinkingTail: string;
  /** Whether any new context arrived since last Haiku call. */
  dirty: boolean;
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

function buildContextSummary(ctx: AccumulatedContext): string {
  const parts: string[] = [];

  if (ctx.tools.size > 0) {
    const toolLines = [...ctx.tools.entries()]
      .map(([name, count]) => (count > 1 ? `${name} (x${count})` : name))
      .join(", ");
    parts.push(`Tools used: ${toolLines}`);
  }
  if (ctx.toolErrors > 0) {
    parts.push(`Tool errors: ${ctx.toolErrors}`);
  }
  if (ctx.thinkingTail) {
    parts.push(`Recent thinking: "${ctx.thinkingTail}"`);
  }
  if (ctx.textTail) {
    parts.push(`Recent output: "${ctx.textTail}"`);
  }

  return parts.join("\n");
}

async function askHaikuForStatus(params: {
  userMessage: string;
  contextSummary: string;
  model: string;
  timeoutMs: number;
}): Promise<string | null> {
  const prompt =
    `You are generating a brief status update to show a user while an AI agent processes their request in a Discord server.\n\n` +
    `The user asked: "${params.userMessage}"\n\n` +
    `Here is what the agent has been doing:\n${params.contextSummary}\n\n` +
    `Rules:\n` +
    `- Write a brief, natural status update (max 8 words) describing what the agent is currently doing.\n` +
    `- Use present continuous tense (e.g. "Reading your calendar events...", "Searching for matching files...")\n` +
    `- If the context is too vague or there is nothing meaningful to report, respond with SKIP.\n` +
    `- Only respond with SKIP or the status text, nothing else.`;

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
        `smart-status: CLI exited with code ${result.code}: ${result.stderr || result.stdout || "unknown"}`,
      );
      return null;
    }
    const text = parseCliResponse(result.stdout);
    if (!text || text.toUpperCase().startsWith("SKIP")) {
      return null;
    }
    return text;
  } catch (err) {
    log.warn(`smart-status: failed: ${formatErrorMessage(err)}`);
    return null;
  }
}

/**
 * Create a smart status tracker that accumulates streaming context and periodically
 * generates context-aware Haiku status updates. Replaces the tool-feedback-filter
 * and progress timer for Discord.
 */
export function createSmartStatus(params: {
  userMessage: string;
  onUpdate: (text: string) => void;
  config?: SmartStatusConfig;
}): {
  push: (event: AgentStreamEvent) => void;
  dispose: () => void;
  /** Suppress updates for the given duration (e.g. after smart ack delivery). */
  suppress: (durationMs: number) => void;
} {
  const intervalMs = params.config?.intervalMs ?? DEFAULT_INTERVAL_MS;
  const model = params.config?.model ?? DEFAULT_MODEL;
  const timeoutMs = params.config?.timeoutMs ?? DEFAULT_HAIKU_TIMEOUT_MS;

  const ctx: AccumulatedContext = {
    tools: new Map(),
    toolErrors: 0,
    textTail: "",
    thinkingTail: "",
    dirty: false,
  };

  let disposed = false;
  let generating = false;
  let suppressedUntil = 0;
  let intervalTimer: ReturnType<typeof setInterval> | undefined;

  async function generateUpdate() {
    if (disposed || generating || !ctx.dirty) {
      return;
    }
    if (Date.now() < suppressedUntil) {
      return;
    }
    generating = true;
    ctx.dirty = false;

    try {
      const summary = buildContextSummary(ctx);
      if (!summary) {
        return;
      }
      const status = await askHaikuForStatus({
        userMessage: params.userMessage,
        contextSummary: summary,
        model,
        timeoutMs,
      });
      if (status && !disposed) {
        params.onUpdate(status);
      }
    } catch (err) {
      log.warn(`smart-status: update failed: ${formatErrorMessage(err)}`);
    } finally {
      generating = false;
    }
  }

  // Start periodic timer.
  intervalTimer = setInterval(() => void generateUpdate(), intervalMs);

  function push(event: AgentStreamEvent) {
    if (disposed) {
      return;
    }
    ctx.dirty = true;

    switch (event.type) {
      case "tool_start": {
        const count = ctx.tools.get(event.toolName) ?? 0;
        ctx.tools.set(event.toolName, count + 1);
        break;
      }
      case "tool_result": {
        if (event.isError) {
          ctx.toolErrors += 1;
        }
        break;
      }
      case "text": {
        // Keep a rolling tail of text output.
        ctx.textTail = (ctx.textTail + event.text).slice(-MAX_TEXT_TAIL);
        break;
      }
      case "thinking": {
        ctx.thinkingTail = (ctx.thinkingTail + event.text).slice(-MAX_THINKING_TAIL);
        break;
      }
    }
  }

  function suppress(durationMs: number) {
    suppressedUntil = Date.now() + durationMs;
  }

  function dispose() {
    disposed = true;
    if (intervalTimer) {
      clearInterval(intervalTimer);
      intervalTimer = undefined;
    }
  }

  return { push, dispose, suppress };
}
