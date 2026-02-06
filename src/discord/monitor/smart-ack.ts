import type { OpenClawConfig } from "../../config/config.js";
import { logVerbose } from "../../globals.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { runCommandWithTimeout } from "../../process/exec.js";

// Default to Haiku via CLI for fast acknowledgments using Max subscription
const DEFAULT_ACK_MODEL = "haiku";
const DEFAULT_ACK_TIMEOUT_MS = 8000;
const DEFAULT_ACK_DELAY_MS = 30000;

export type SmartAckConfig = {
  /** Enable smart contextual acknowledgments. */
  enabled?: boolean;
  /**
   * Delay in milliseconds before sending acknowledgment.
   * Only sends if main response hasn't arrived. Default: 30000 (30 seconds).
   */
  delayMs?: number;
  /** Model for acknowledgment generation via Claude CLI. Default: haiku. */
  model?: string;
  /** Timeout for acknowledgment generation in ms. Default: 8000. */
  timeoutMs?: number;
};

export type SmartAckResult = {
  /** The response text (without formatting). */
  text: string;
  /** Whether this is a full response (true) or interim acknowledgment (false). */
  isFull: boolean;
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

/**
 * Generate a contextual acknowledgment message using Claude CLI with Haiku.
 * Uses the Max subscription instead of per-token API charges.
 *
 * For simple messages (greetings, thanks, casual chat), returns a full response
 * that can replace the main model run. For complex requests, returns an interim
 * acknowledgment formatted in italics.
 */
export async function generateSmartAck(params: {
  message: string;
  senderName?: string;
  cfg: OpenClawConfig;
  config?: SmartAckConfig;
  signal?: AbortSignal;
}): Promise<SmartAckResult | null> {
  const { message, senderName, config, signal } = params;

  if (signal?.aborted) {
    return null;
  }

  const model = config?.model ?? DEFAULT_ACK_MODEL;
  const timeoutMs = config?.timeoutMs ?? DEFAULT_ACK_TIMEOUT_MS;

  const nameContext = senderName ? `The user's name is ${senderName}. ` : "";

  const prompt =
    `You are a helpful AI assistant responding in a Discord server. ${nameContext}` +
    `Decide if this message is SIMPLE or COMPLEX.\n\n` +
    `SIMPLE messages are: greetings, thanks, casual chat, short questions with obvious answers, ` +
    `acknowledgments, or anything a fast model can fully answer in 1-2 sentences.\n` +
    `COMPLEX messages are: technical questions, code requests, multi-step tasks, research, ` +
    `or anything needing deep thought or tools.\n\n` +
    `If SIMPLE: prefix your response with "FULL: " and give a complete, friendly reply (1-2 sentences).\n` +
    `If COMPLEX: prefix your response with "ACK: " and give a brief acknowledgment showing you ` +
    `understand the request (e.g. "Working on..." or "Let me look into..."). ` +
    `Do NOT answer complex requests, just acknowledge them.\n\n` +
    `User's message:\n${message}`;

  // Build CLI args for claude command
  const args = ["--model", model, "-p", prompt, "--output-format", "json", "--max-turns", "1"];

  try {
    logVerbose(`smart-ack: running claude --model ${model}`);

    const result = await runCommandWithTimeout(["claude", ...args], {
      timeoutMs,
    });

    if (signal?.aborted) {
      logVerbose("smart-ack: aborted after CLI returned");
      return null;
    }

    if (result.code !== 0) {
      const err = result.stderr || result.stdout || "CLI failed";
      logVerbose(`smart-ack: CLI exited with code ${result.code}: ${err}`);
      return null;
    }

    const ack = parseCliResponse(result.stdout);
    if (!ack) {
      logVerbose("smart-ack: empty response from CLI");
      return null;
    }

    // Parse FULL/ACK prefix to determine response type
    const isFull = ack.startsWith("FULL: ") || ack.startsWith("FULL:");
    const isAck = ack.startsWith("ACK: ") || ack.startsWith("ACK:");
    const cleanText = isFull
      ? ack.replace(/^FULL:\s*/, "")
      : isAck
        ? ack.replace(/^ACK:\s*/, "")
        : ack;

    if (!cleanText.trim()) {
      logVerbose("smart-ack: empty after prefix strip");
      return null;
    }

    logVerbose(
      `smart-ack: generated ${isFull ? "full response" : "acknowledgment"} (${cleanText.length} chars)`,
    );

    return { text: cleanText, isFull };
  } catch (err) {
    if (signal?.aborted) {
      logVerbose("smart-ack: generation aborted (main response arrived first or timeout)");
    } else {
      logVerbose(`smart-ack: generation failed: ${formatErrorMessage(err)}`);
    }
    return null;
  }
}

export type SmartAckController = {
  /** Cancel the smart ack (e.g., when main response arrives). */
  cancel: () => void;
  /** Wait for the smart ack result (if delay passed and not cancelled). */
  result: Promise<SmartAckResult | null>;
};

/**
 * Start a smart acknowledgment generation with delay.
 * Returns a controller that can be cancelled when the main response arrives.
 */
export function startSmartAck(params: {
  message: string;
  senderName?: string;
  cfg: OpenClawConfig;
  config?: SmartAckConfig;
}): SmartAckController {
  const delayMs = params.config?.delayMs ?? DEFAULT_ACK_DELAY_MS;
  const abortController = new AbortController();
  let cancelled = false;
  let resolveResult: (value: SmartAckResult | null) => void;

  const result = new Promise<SmartAckResult | null>((resolve) => {
    resolveResult = resolve;
  });

  // Start generation immediately but hold result until delay passes
  const generationPromise = generateSmartAck({
    ...params,
    signal: abortController.signal,
  });

  // Set up the delay timer
  const delayTimer = setTimeout(async () => {
    if (cancelled) {
      resolveResult(null);
      return;
    }

    try {
      const ack = await generationPromise;
      if (!cancelled) {
        resolveResult(ack);
      } else {
        resolveResult(null);
      }
    } catch {
      resolveResult(null);
    }
  }, delayMs);

  return {
    cancel: () => {
      cancelled = true;
      abortController.abort();
      clearTimeout(delayTimer);
      resolveResult(null);
    },
    result,
  };
}

export { DEFAULT_ACK_DELAY_MS };
