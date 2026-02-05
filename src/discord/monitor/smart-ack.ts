import { completeSimple, type TextContent } from "@mariozechner/pi-ai";
import type { OpenClawConfig } from "../../config/config.js";
import { getApiKeyForModel, requireApiKey } from "../../agents/model-auth.js";
import { resolveModel } from "../../agents/pi-embedded-runner/model.js";
import { logVerbose } from "../../globals.js";
import { formatErrorMessage } from "../../infra/errors.js";

// Default to Haiku for fast, low-cost acknowledgments
const DEFAULT_ACK_MODEL_PROVIDER = "anthropic";
const DEFAULT_ACK_MODEL_ID = "claude-3-5-haiku-latest";
const DEFAULT_ACK_TIMEOUT_MS = 5000;
const DEFAULT_ACK_DELAY_MS = 30000;

export type SmartAckConfig = {
  /** Enable smart contextual acknowledgments. */
  enabled?: boolean;
  /**
   * Delay in milliseconds before sending acknowledgment.
   * Only sends if main response hasn't arrived. Default: 30000 (30 seconds).
   */
  delayMs?: number;
  /** Model provider for acknowledgment generation. Default: anthropic. */
  provider?: string;
  /** Model ID for acknowledgment generation. Default: claude-3-5-haiku-latest. */
  model?: string;
  /** Timeout for acknowledgment generation in ms. Default: 5000. */
  timeoutMs?: number;
};

const isTextContentBlock = (block: unknown): block is TextContent =>
  typeof block === "object" && block !== null && (block as TextContent).type === "text";

/**
 * Generate a contextual acknowledgment message using a fast model (Haiku).
 * Returns null if generation fails or times out.
 */
export async function generateSmartAck(params: {
  message: string;
  senderName?: string;
  cfg: OpenClawConfig;
  config?: SmartAckConfig;
  signal?: AbortSignal;
}): Promise<string | null> {
  const { message, senderName, cfg, config, signal } = params;

  if (signal?.aborted) {
    return null;
  }

  const provider = config?.provider ?? DEFAULT_ACK_MODEL_PROVIDER;
  const modelId = config?.model ?? DEFAULT_ACK_MODEL_ID;
  const timeoutMs = config?.timeoutMs ?? DEFAULT_ACK_TIMEOUT_MS;

  const resolved = resolveModel(provider, modelId, undefined, cfg);
  if (!resolved.model) {
    logVerbose(`smart-ack: failed to resolve model ${provider}/${modelId}: ${resolved.error}`);
    return null;
  }

  let apiKey: string;
  try {
    apiKey = requireApiKey(await getApiKeyForModel({ model: resolved.model, cfg }), provider);
  } catch (err) {
    logVerbose(`smart-ack: failed to get API key for ${provider}: ${formatErrorMessage(err)}`);
    return null;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  // Link to parent signal
  if (signal) {
    signal.addEventListener("abort", () => controller.abort(), { once: true });
  }

  try {
    const nameContext = senderName ? `The user's name is ${senderName}. ` : "";

    const res = await completeSimple(
      resolved.model,
      {
        messages: [
          {
            role: "user",
            content:
              `You are a helpful AI assistant. Generate a brief, friendly acknowledgment (1-2 sentences) ` +
              `that shows you understand what the user is asking for. ${nameContext}` +
              `The acknowledgment should be specific to their request, not generic. ` +
              `Start with something like "I see you want to..." or "Working on..." or "Let me help you with...". ` +
              `Keep it warm but concise. Do NOT actually answer the request, just acknowledge it.\n\n` +
              `User's message:\n${message}`,
            timestamp: Date.now(),
          },
        ],
      },
      {
        apiKey,
        maxTokens: 100,
        temperature: 0.7,
        signal: controller.signal,
      },
    );

    const ack = res.content
      .filter(isTextContentBlock)
      .map((block) => block.text.trim())
      .filter(Boolean)
      .join(" ")
      .trim();

    if (!ack) {
      return null;
    }

    // Format as italics for Discord
    return `*${ack}*`;
  } catch (err) {
    if (controller.signal.aborted) {
      logVerbose("smart-ack: generation aborted (main response arrived first or timeout)");
    } else {
      logVerbose(`smart-ack: generation failed: ${formatErrorMessage(err)}`);
    }
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

export type SmartAckController = {
  /** Cancel the smart ack (e.g., when main response arrives). */
  cancel: () => void;
  /** Wait for the smart ack result (if delay passed and not cancelled). */
  result: Promise<string | null>;
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
  let resolveResult: (value: string | null) => void;

  const result = new Promise<string | null>((resolve) => {
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
