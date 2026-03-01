import type { StreamFn } from "@mariozechner/pi-agent-core";
import { createAssistantMessageEventStream } from "@mariozechner/pi-ai";
import type { MessageTracker } from "./message-tracker.js";
import type { ScenarioProviderModel } from "./types.js";

/**
 * Interpolate simple `{key}` placeholders in a template string.
 * Only replaces known keys — unknown placeholders are left as-is.
 */
function interpolateTemplate(template: string, vars: Record<string, string | undefined>): string {
  return template.replace(/\{(\w+)\}/g, (match, key: string) => vars[key] ?? match);
}

/**
 * Create a fake `StreamFn` that returns scripted responses after a
 * configurable delay. Supports error injection and AbortSignal.
 */
export function createFakeStreamFn(params: {
  models: Record<string, ScenarioProviderModel>;
  tracker: MessageTracker;
  signal?: AbortSignal;
  rng?: () => number;
}): StreamFn {
  const random = params.rng ?? Math.random;

  const streamFn: StreamFn = (_model, context, _options) => {
    const modelId =
      typeof _model === "string" ? _model : typeof _model.id === "string" ? _model.id : "unknown";
    const modelCfg = params.models[modelId] ?? { latencyMs: 100, response: "ok" };
    const stream = createAssistantMessageEventStream();

    // Find the last user message in context for causal tracking
    const messages = context?.messages ?? [];
    let lastUserText = "";
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];
      if (msg.role === "user") {
        if (typeof msg.content === "string") {
          lastUserText = msg.content;
        } else if (Array.isArray(msg.content)) {
          const textPart = msg.content.find(
            (p): p is { type: "text"; text: string } => "type" in p && p.type === "text",
          );
          if (textPart) {
            lastUserText = textPart.text;
          }
        }
        break;
      }
    }

    const makeErrorMessage = (errorMessage: string) => ({
      role: "assistant" as const,
      content: [],
      stopReason: "error" as const,
      errorMessage,
      api: "fake" as never,
      provider: "fake" as never,
      model: modelId,
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      timestamp: Date.now(),
    });

    let settled = false;

    const timer = setTimeout(() => {
      if (settled) {
        return;
      }
      settled = true;

      try {
        if (params.signal?.aborted) {
          stream.push({
            type: "error",
            reason: "aborted",
            error: makeErrorMessage("Simulation aborted"),
          });
          return;
        }

        if (modelCfg.errorRate && random() < modelCfg.errorRate) {
          stream.push({
            type: "error",
            reason: "error",
            error: makeErrorMessage("Simulated provider error"),
          });
          return;
        }

        const responseText = interpolateTemplate(modelCfg.response, {
          agentId: modelId,
          messageText: lastUserText,
        });

        stream.push({
          type: "done",
          reason: "stop",
          message: {
            role: "assistant",
            content: [{ type: "text", text: responseText }],
            stopReason: "stop",
            api: "fake" as never,
            provider: "fake" as never,
            model: modelId,
            usage: {
              input: 100,
              output: 50,
              cacheRead: 0,
              cacheWrite: 0,
              totalTokens: 150,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
            },
            timestamp: Date.now(),
          },
        });
      } finally {
        stream.end();
      }
    }, modelCfg.latencyMs);

    // Prevent ghost replies after abort
    params.signal?.addEventListener(
      "abort",
      () => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        stream.push({
          type: "error",
          reason: "aborted",
          error: makeErrorMessage("Simulation aborted"),
        });
        stream.end();
      },
      { once: true },
    );

    return stream;
  };

  return streamFn;
}
