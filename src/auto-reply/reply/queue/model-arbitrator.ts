import type { OpenClawConfig } from "../../../config/config.js";
import { logVerbose } from "../../../globals.js";
import type { QueueModelArbitrator } from "./arbitration.js";
import type { QueueMode } from "./types.js";

const DEFAULT_LMSTUDIO_BASE_URL = "http://127.0.0.1:1234";
const DEFAULT_OLLAMA_BASE_URL = "http://127.0.0.1:11434";
const DEFAULT_TIMEOUT_MS = 900;
const DEFAULT_TEMPERATURE = 0;
const DEFAULT_LMSTUDIO_MODEL = "qwen3-1.7b-instruct";
const DEFAULT_OLLAMA_MODEL = "qwen3:1.7b";

export function resolveQueueArbitratorProvider(
  cfg: OpenClawConfig,
): "lmstudio" | "ollama" | undefined {
  const arbitratorCfg = cfg.messages?.queue?.arbitrator;
  if (!arbitratorCfg?.enabled) {
    return undefined;
  }
  return arbitratorCfg.provider ?? "lmstudio";
}

type OpenAiChatCompletionResponse = {
  choices?: Array<{
    message?: {
      content?: string | Array<{ type?: string; text?: string }>;
    };
  }>;
};

type OllamaGenerateResponse = {
  response?: string;
};

function normalizeDecision(value: unknown): QueueMode | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = value.trim().toLowerCase();
  if (normalized === "interrupt" || normalized === "steer" || normalized === "collect") {
    return normalized;
  }
  return undefined;
}

function parseConfidence(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function extractDecisionHint(raw: string): QueueMode | undefined {
  const lowered = raw.toLowerCase();
  const jsonFieldMatch = lowered.match(/"decision"\s*:\s*"(interrupt|steer|collect)"/);
  if (jsonFieldMatch?.[1]) {
    return normalizeDecision(jsonFieldMatch[1]);
  }
  const sentenceMatch = lowered.match(/\b(interrupt|steer|collect)\b/);
  if (sentenceMatch?.[1]) {
    return normalizeDecision(sentenceMatch[1]);
  }
  return undefined;
}

function finalizeModelDecision(params: {
  decision?: unknown;
  confidence?: unknown;
}): QueueMode | undefined {
  const decision = normalizeDecision(params.decision);
  if (!decision) {
    return undefined;
  }
  const confidence = parseConfidence(params.confidence);
  if (confidence !== undefined && confidence < 0.55) {
    return "interrupt";
  }
  return decision;
}

function buildPrompt(params: {
  body: string;
  configuredMode: QueueMode;
  isStreaming: boolean;
}): string {
  return [
    "Classify the user's latest message for queue arbitration in an active chat session.",
    "Return exactly one lowercase word and nothing else: interrupt, steer, or collect.",
    "Use interrupt for a new topic, a stop/change request, or if unsure.",
    "Use steer for a clarification, correction, or refinement of the current answer.",
    "Use collect for a tiny fragment that should be merged into the current turn.",
    `streaming=${params.isStreaming ? "true" : "false"}`,
    `configured_mode=${params.configuredMode}`,
    `message=${JSON.stringify(params.body)}`,
  ].join("\n");
}

function parseJsonObject(raw: string): { decision?: string; confidence?: number } | undefined {
  const trimmed = raw.trim();
  try {
    return JSON.parse(trimmed) as { decision?: string; confidence?: number };
  } catch {
    const fenceMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
    const fenced = fenceMatch?.[1]?.trim();
    if (fenced) {
      try {
        return JSON.parse(fenced) as { decision?: string; confidence?: number };
      } catch {
        return undefined;
      }
    }
    const firstBrace = trimmed.indexOf("{");
    const lastBrace = trimmed.lastIndexOf("}");
    if (firstBrace >= 0 && lastBrace > firstBrace) {
      try {
        return JSON.parse(trimmed.slice(firstBrace, lastBrace + 1)) as {
          decision?: string;
          confidence?: number;
        };
      } catch {
        return undefined;
      }
    }
    return undefined;
  }
}

function extractChatCompletionText(payload: OpenAiChatCompletionResponse): string | undefined {
  const content = payload.choices?.[0]?.message?.content;
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    return content
      .map((part) => (part.type === "text" ? part.text : undefined))
      .filter((value): value is string => Boolean(value))
      .join("")
      .trim();
  }
  return undefined;
}

function createLmStudioArbitrator(params: {
  baseUrl: string;
  model: string;
  timeoutMs: number;
  temperature: number;
}): QueueModelArbitrator {
  const endpoint = `${params.baseUrl.replace(/\/+$/, "")}/v1/chat/completions`;
  return async ({ body, configuredMode, isStreaming }) => {
    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: params.model,
          temperature: params.temperature,
          messages: [
            {
              role: "system",
              content:
                "You classify chat updates for queue arbitration. Return exactly one lowercase word only: interrupt, steer, or collect.",
            },
            {
              role: "user",
              content: buildPrompt({ body, configuredMode, isStreaming }),
            },
          ],
        }),
        signal: AbortSignal.timeout(params.timeoutMs),
      });
      if (!response.ok) {
        logVerbose(
          `Queue arbitrator model request failed: provider=lmstudio status=${response.status}`,
        );
        return undefined;
      }
      const raw = extractChatCompletionText(
        (await response.json()) as OpenAiChatCompletionResponse,
      );
      if (!raw) {
        return undefined;
      }
      return (
        normalizeDecision(raw) ??
        finalizeModelDecision(parseJsonObject(raw) ?? {}) ??
        extractDecisionHint(raw)
      );
    } catch (error) {
      logVerbose(`Queue arbitrator model request failed: provider=lmstudio error=${String(error)}`);
      return undefined;
    }
  };
}

function createOllamaArbitrator(params: {
  baseUrl: string;
  model: string;
  timeoutMs: number;
  temperature: number;
}): QueueModelArbitrator {
  const endpoint = `${params.baseUrl.replace(/\/+$/, "")}/api/generate`;
  return async ({ body, configuredMode, isStreaming }) => {
    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: params.model,
          prompt: buildPrompt({ body, configuredMode, isStreaming }),
          stream: false,
          format: "json",
          options: { temperature: params.temperature, num_predict: 32 },
        }),
        signal: AbortSignal.timeout(params.timeoutMs),
      });
      if (!response.ok) {
        logVerbose(
          `Queue arbitrator model request failed: provider=ollama status=${response.status}`,
        );
        return undefined;
      }
      const raw = ((await response.json()) as OllamaGenerateResponse).response?.trim();
      if (!raw) {
        return undefined;
      }
      return (
        normalizeDecision(raw) ??
        finalizeModelDecision(parseJsonObject(raw) ?? {}) ??
        extractDecisionHint(raw)
      );
    } catch (error) {
      logVerbose(`Queue arbitrator model request failed: provider=ollama error=${String(error)}`);
      return undefined;
    }
  };
}

export function resolveQueueModelArbitrator(cfg: OpenClawConfig): QueueModelArbitrator | undefined {
  const arbitratorCfg = cfg.messages?.queue?.arbitrator;
  const provider = resolveQueueArbitratorProvider(cfg);
  if (!arbitratorCfg?.enabled || !provider) {
    return undefined;
  }
  const timeoutMs = arbitratorCfg.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const temperature = arbitratorCfg.temperature ?? DEFAULT_TEMPERATURE;

  if (provider === "ollama") {
    return createOllamaArbitrator({
      baseUrl: arbitratorCfg.baseUrl?.trim() || DEFAULT_OLLAMA_BASE_URL,
      model: arbitratorCfg.model?.trim() || DEFAULT_OLLAMA_MODEL,
      timeoutMs,
      temperature,
    });
  }

  return createLmStudioArbitrator({
    baseUrl: arbitratorCfg.baseUrl?.trim() || DEFAULT_LMSTUDIO_BASE_URL,
    model: arbitratorCfg.model?.trim() || DEFAULT_LMSTUDIO_MODEL,
    timeoutMs,
    temperature,
  });
}
