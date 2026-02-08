import type { OpenClawConfig } from "../../config/config.js";
import { logVerbose } from "../../globals.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { runCommandWithTimeout } from "../../process/exec.js";

const log = createSubsystemLogger("discord/smart-ack");

// Default to Sonnet via CLI for fast, reliable classification
const DEFAULT_ACK_MODEL = "sonnet";
const DEFAULT_ACK_TIMEOUT_MS = 15000;

export type SmartAckConfig = {
  /** Enable smart contextual triage. */
  enabled?: boolean;
  /** Model for triage via Claude CLI. Default: sonnet. */
  model?: string;
  /** Timeout for triage generation in ms. Default: 15000. */
  timeoutMs?: number;
};

export type SmartAckResult = {
  /** The response text (without formatting). */
  text: string;
  /** Whether this is a full response (true) or interim acknowledgment (false). */
  isFull: boolean;
};

/** Rich context for the triage model to make context-aware decisions. */
export type SmartAckContext = {
  /** Agent name from identity config or workspace. */
  agentName?: string;
  /** Agent personality vibe (e.g., "warm", "sharp"). */
  agentVibe?: string;
  /** Agent creature type (e.g., "ghost", "familiar"). */
  agentCreature?: string;
  /** Conversation context (formatted body with history for guilds, raw text for DMs). */
  conversationContext?: string;
  /** Channel-level system prompt, if any. */
  channelSystemPrompt?: string;
  /** Whether this is a direct message. */
  isDirectMessage?: boolean;
};

type ClaudeCliResponse = {
  result?: string;
  is_error?: boolean;
  session_id?: string;
};

function parseCliResponse(stdout: string): string | null {
  const trimmed = stdout.trim();
  if (!trimmed) {
    return null;
  }

  try {
    const parsed = JSON.parse(trimmed) as ClaudeCliResponse;
    if (parsed.is_error) {
      return null;
    }
    return parsed.result?.trim() || null;
  } catch {
    // If not JSON, treat as plain text response
    return trimmed || null;
  }
}

function buildTriagePrompt(params: {
  message: string;
  senderName?: string;
  context?: SmartAckContext;
}): string {
  const { message, senderName, context } = params;
  const parts: string[] = [];

  // Identity block
  const surface = context?.isDirectMessage ? "DM" : "server";
  parts.push(`You are a helpful AI assistant responding in a Discord ${surface}.`);
  if (senderName) {
    parts.push(`The user's name is ${senderName}.`);
  }
  if (context?.agentName) {
    parts.push(`Your name is ${context.agentName}.`);
  }
  if (context?.agentVibe) {
    parts.push(`Your personality is ${context.agentVibe}.`);
  }
  if (context?.agentCreature) {
    parts.push(`You are a ${context.agentCreature}.`);
  }

  // Channel system prompt
  if (context?.channelSystemPrompt) {
    parts.push(`\n\nChannel guidelines:\n${context.channelSystemPrompt}`);
  }

  // Conversation context (includes history for guild channels)
  if (context?.conversationContext && context.conversationContext !== message) {
    parts.push(`\n\nRecent conversation context:\n${context.conversationContext}`);
  }

  // Classification instructions
  parts.push(
    `\n\nClassify this message and respond appropriately.\n\n` +
      `If you can fully answer in 1-3 sentences: prefix your response with "FULL: " and give a complete, ` +
      `friendly reply. This applies to greetings, thanks, casual chat, short factual questions, ` +
      `acknowledgments, and anything you can confidently answer from the conversation context.\n` +
      `If it needs deeper work: prefix your response with "ACK: " and give a brief acknowledgment ` +
      `showing you understand the request (e.g. "Working on..." or "Let me look into..."). ` +
      `This applies to technical questions, code requests, multi-step tasks, research, ` +
      `or anything requiring tools, file access, or information beyond what you have.\n\n` +
      `IMPORTANT: Any request that would require using tools MUST be "ACK:". This includes requests to ` +
      `read/write/find files, run commands, search the web, browse URLs, interact with the device, ` +
      `send messages, generate images/audio, or perform any action beyond pure conversation. ` +
      `Never fabricate tool results; always defer these to the main model.\n\n` +
      `You MUST start your response with either "FULL: " or "ACK: " and nothing else.\n\n` +
      `Writing style: never use em-dashes or hyphens as grammatical punctuation. ` +
      `Use commas, periods, or semicolons instead.\n\n` +
      `User's message:\n${message}`,
  );

  return parts.join(" ");
}

// Patterns that strongly suggest the user wants a tool-backed action, not a
// pure conversational reply.  Checked as a hard guardrail after model
// classification so that even if the model says "FULL" we force "ACK".
const TOOL_REQUEST_PATTERNS: RegExp[] = [
  /\bread\b.*\bfile/i,
  /\bpick\b.*\bfile/i,
  /\bopen\b.*\bfile/i,
  /\bfind\b.*\bfile/i,
  /\blist\b.*\bfiles/i,
  /\bwrite\b.*\bfile/i,
  /\bcreate\b.*\bfile/i,
  /\bdelete\b.*\bfile/i,
  /\brun\b.*\bcommand/i,
  /\bexecute\b/i,
  /\bsearch\b.*\b(web|internet|google|online)/i,
  /\bbrowse\b/i,
  /\bfetch\b.*\burl/i,
  /\bsend\b.*\bmessage/i,
  /\bgenerate\b.*\b(image|audio|speech)/i,
  /\bon\s+(my|the|this)\s+(device|machine|computer|server|system)/i,
  /\b(my|the|this)\s+(device|machine|computer|server|system)\b/i,
  /\bshell\b/i,
  /\bterminal\b/i,
  /\bdownload\b/i,
  /\binstall\b/i,
  /\bdeploy\b/i,
  /\bssh\b/i,
];

function looksLikeToolRequest(message: string): boolean {
  return TOOL_REQUEST_PATTERNS.some((pattern) => pattern.test(message));
}

/**
 * Generate a triage response using Claude CLI with Sonnet.
 * Uses the Max subscription instead of per-token API charges.
 *
 * For simple messages (greetings, thanks, casual chat), returns a full response
 * that short-circuits the main Opus dispatch. For complex requests, returns an
 * interim acknowledgment while Opus works.
 */
export async function generateSmartAck(params: {
  message: string;
  senderName?: string;
  cfg: OpenClawConfig;
  config?: SmartAckConfig;
  context?: SmartAckContext;
  signal?: AbortSignal;
}): Promise<SmartAckResult | null> {
  const { message, senderName, config, context, signal } = params;

  if (signal?.aborted) {
    return null;
  }

  const model = config?.model ?? DEFAULT_ACK_MODEL;
  const timeoutMs = config?.timeoutMs ?? DEFAULT_ACK_TIMEOUT_MS;

  const prompt = buildTriagePrompt({ message, senderName, context });

  // Build CLI args for claude command
  const args = ["--model", model, "-p", prompt, "--output-format", "json", "--max-turns", "1"];

  try {
    logVerbose(`smart-ack: running claude --model ${model}`);

    const result = await runCommandWithTimeout(["claude", ...args], {
      timeoutMs,
      input: "",
    });

    if (signal?.aborted) {
      logVerbose("smart-ack: aborted after CLI returned");
      return null;
    }

    if (result.code !== 0) {
      const err = result.stderr || result.stdout || "CLI failed";
      log.warn(`smart-ack: CLI exited with code ${result.code}: ${err}`);
      return null;
    }

    const ack = parseCliResponse(result.stdout);
    if (!ack) {
      logVerbose("smart-ack: empty response from CLI");
      return null;
    }

    // Parse FULL/ACK prefix to determine response type.
    // Also handle "SIMPLE:" as a fallback for FULL (model sometimes echoes category labels).
    const hasFullPrefix =
      ack.startsWith("FULL: ") ||
      ack.startsWith("FULL:") ||
      ack.startsWith("SIMPLE: ") ||
      ack.startsWith("SIMPLE:");
    const isAck = ack.startsWith("ACK: ") || ack.startsWith("ACK:");

    // Strip prefix before guardrail check so the text is always clean.
    const cleanText = hasFullPrefix
      ? ack.replace(/^(?:FULL|SIMPLE):\s*/, "")
      : isAck
        ? ack.replace(/^ACK:\s*/, "")
        : ack;

    // Hard guardrail: override FULL→ACK when the message implies tool usage.
    // The model sometimes ignores prompt instructions and fabricates tool results.
    let isFull = hasFullPrefix;
    if (isFull && looksLikeToolRequest(message)) {
      log.info(`smart ack: overriding FULL→ACK for tool-like request`);
      isFull = false;
    }

    if (!cleanText.trim()) {
      logVerbose("smart-ack: empty after prefix strip");
      return null;
    }

    const kind = isFull ? "full" : "interim";
    logVerbose(`smart-ack: generated ${kind} response (${cleanText.length} chars)`);
    log.info(`smart ack (${kind}): ${cleanText}`);

    return { text: cleanText, isFull };
  } catch (err) {
    if (signal?.aborted) {
      logVerbose("smart-ack: generation aborted");
    } else {
      log.warn(`smart-ack: generation failed: ${formatErrorMessage(err)}`);
    }
    return null;
  }
}

export type SmartAckController = {
  /** Cancel the smart ack triage. */
  cancel: () => void;
  /** Wait for the triage result. Resolves as soon as the model responds. */
  result: Promise<SmartAckResult | null>;
};

/**
 * Start a smart triage generation. Returns a controller with the result promise
 * that resolves as soon as the model responds (no delay). Can be cancelled if
 * the caller no longer needs the result.
 */
export function startSmartAck(params: {
  message: string;
  senderName?: string;
  cfg: OpenClawConfig;
  config?: SmartAckConfig;
  context?: SmartAckContext;
}): SmartAckController {
  const abortController = new AbortController();

  const result = generateSmartAck({
    ...params,
    signal: abortController.signal,
  });

  return {
    cancel: () => {
      abortController.abort();
    },
    result,
  };
}
