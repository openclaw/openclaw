import type { OpenClawConfig } from "../../../config/config.js";
import { logVerbose } from "../../../globals.js";
import type { QueueMode } from "../queue.js";
import { resolveQueueArbitratorProvider } from "../queue/model-arbitrator.js";
import {
  getSupervisorRelationDefinition,
  SUPERVISOR_TAXONOMY,
  SUPERVISOR_TAXONOMY_VERSION,
} from "./taxonomy.js";
import { translateLegacyQueueDecision } from "./translate.js";
import type {
  SupervisorRelation,
  SupervisorRelationClassificationInput,
  SupervisorRelationClassificationResult,
  SupervisorRelationClassifier,
} from "./types.js";

const DEFAULT_LMSTUDIO_BASE_URL = "http://127.0.0.1:1234";
const DEFAULT_OLLAMA_BASE_URL = "http://127.0.0.1:11434";
const DEFAULT_TIMEOUT_MS = 900;
const DEFAULT_TEMPERATURE = 0;
const DEFAULT_LMSTUDIO_MODEL = "qwen3-1.7b-instruct";
const DEFAULT_OLLAMA_MODEL = "qwen3:1.7b";

type JsonObject = Record<string, unknown>;

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

function normalizeRelation(value: unknown): SupervisorRelation | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = value.trim().toLowerCase();
  if (
    normalized === "same_task_supplement" ||
    normalized === "same_task_correction" ||
    normalized === "same_task_control" ||
    normalized === "new_task_replace" ||
    normalized === "new_task_parallel" ||
    normalized === "background_relevant" ||
    normalized === "unrelated"
  ) {
    return normalized;
  }
  return undefined;
}

function stripThinkingEnvelope(raw: string): string {
  return raw.replace(/<think>[\s\S]*?<\/think>\s*/gi, "").trim();
}

function parseConfidence(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function extractJsonObject(raw: string): JsonObject | undefined {
  const trimmed = stripThinkingEnvelope(raw);
  try {
    return JSON.parse(trimmed) as JsonObject;
  } catch {
    const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/i)?.[1]?.trim();
    if (fenced) {
      try {
        return JSON.parse(fenced) as JsonObject;
      } catch {
        return undefined;
      }
    }
    const firstBrace = trimmed.indexOf("{");
    const lastBrace = trimmed.lastIndexOf("}");
    if (firstBrace >= 0 && lastBrace > firstBrace) {
      try {
        return JSON.parse(trimmed.slice(firstBrace, lastBrace + 1)) as JsonObject;
      } catch {
        return undefined;
      }
    }
    return undefined;
  }
}

function extractOpenAiContent(payload: OpenAiChatCompletionResponse): string | undefined {
  const content = payload.choices?.[0]?.message?.content;
  if (typeof content === "string") {
    return content.trim();
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

function buildRelationPrompt(input: SupervisorRelationClassificationInput): string {
  const candidateRelations = (
    input.candidateRelations?.length
      ? input.candidateRelations
      : SUPERVISOR_TAXONOMY.relations.map((entry) => entry.id)
  )
    .map((relation) => {
      const definition = getSupervisorRelationDefinition(relation);
      return definition ? `- ${relation}: ${definition.summary}` : `- ${relation}`;
    })
    .join("\n");

  return [
    "Classify the latest event against the supervisor relation taxonomy.",
    "Return one compact JSON object only.",
    "Use keys: relation, confidence, rationale.",
    "rationale must be one short sentence under 16 words.",
    "relation must be one of the candidate relations.",
    `taxonomy_version=${input.taxonomyVersion}`,
    `event_type=${input.event.type}`,
    `event_category=${input.event.category}`,
    `event_source=${input.event.source}`,
    `event_scope=${input.event.scope}`,
    `event_urgency=${input.event.urgency}`,
    `event_text=${JSON.stringify(input.event.payload.text ?? input.event.payload.bodyPreview ?? "")}`,
    `task_phase=${input.taskState.phase}`,
    `task_interrupt_preference=${input.taskState.interruptPreference}`,
    `task_interruptibility=${input.taskState.interruptibility}`,
    `task_is_active=${input.taskState.isActive ? "true" : "false"}`,
    `task_is_streaming=${input.taskState.isStreaming ? "true" : "false"}`,
    "candidate_relations:",
    candidateRelations,
  ].join("\n");
}

function applyModelPromptDirectives(prompt: string, model: string): string {
  if (model.toLowerCase().includes("qwen")) {
    return `${prompt}\n/no_think`;
  }
  return prompt;
}

function buildModelClassificationResult(params: {
  raw: string;
  model: string;
}): SupervisorRelationClassificationResult | undefined {
  const parsed = extractJsonObject(params.raw);
  const relation = normalizeRelation(parsed?.relation ?? parsed?.classification);
  if (!relation) {
    return undefined;
  }
  return {
    relation,
    confidence: parseConfidence(parsed?.confidence),
    rationaleShort: typeof parsed?.rationale === "string" ? parsed.rationale : undefined,
    classifierKind: "model_relation_classifier",
    model: params.model,
  };
}

function reconcileRelationWithTaskState(
  input: SupervisorRelationClassificationInput,
  result: SupervisorRelationClassificationResult,
): SupervisorRelationClassificationResult {
  const isIdleForegroundUserMessage =
    input.event.category === "user" &&
    input.event.scope === "foreground" &&
    !input.taskState.isActive &&
    input.taskState.phase === "idle";

  if (
    isIdleForegroundUserMessage &&
    (result.relation === "same_task_supplement" ||
      result.relation === "same_task_correction" ||
      result.relation === "same_task_control")
  ) {
    return {
      ...result,
      relation: "new_task_replace",
      rationaleShort:
        "Idle foreground user messages should start a new task, not modify an existing one.",
    };
  }

  return result;
}

export function createLegacyQueueSupervisorRelationClassifier(params: {
  queueMode: QueueMode;
}): SupervisorRelationClassifier {
  return {
    async classify(
      _input: SupervisorRelationClassificationInput,
    ): Promise<SupervisorRelationClassificationResult> {
      const translation = translateLegacyQueueDecision(params.queueMode);
      return {
        relation: translation.relation,
        rationaleShort: translation.rationale,
        classifierKind: translation.classifierKind,
      };
    },
  };
}

type ModelClassifierParams = {
  provider: "lmstudio" | "ollama";
  baseUrl: string;
  model: string;
  timeoutMs: number;
  temperature: number;
  fallback: SupervisorRelationClassifier;
};

function createModelBackedSupervisorRelationClassifier(
  params: ModelClassifierParams,
): SupervisorRelationClassifier {
  return {
    async classify(input): Promise<SupervisorRelationClassificationResult> {
      const prompt = applyModelPromptDirectives(buildRelationPrompt(input), params.model);
      try {
        if (params.provider === "lmstudio") {
          const response = await fetch(
            `${params.baseUrl.replace(/\/+$/, "")}/v1/chat/completions`,
            {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                model: params.model,
                temperature: params.temperature,
                max_tokens: 256,
                messages: [
                  {
                    role: "system",
                    content:
                      "You classify agent supervisor events. Output only compact JSON with relation, confidence, rationale. Do not include thinking or markdown.",
                  },
                  { role: "user", content: prompt },
                ],
              }),
              signal: AbortSignal.timeout(params.timeoutMs),
            },
          );
          if (response.ok) {
            const raw = extractOpenAiContent(
              (await response.json()) as OpenAiChatCompletionResponse,
            );
            if (raw) {
              const result = buildModelClassificationResult({ raw, model: params.model });
              if (result) {
                return reconcileRelationWithTaskState(input, result);
              }
            }
          } else {
            logVerbose(
              `supervisor: relation classifier request failed provider=lmstudio status=${response.status}`,
            );
          }
        } else {
          const response = await fetch(`${params.baseUrl.replace(/\/+$/, "")}/api/generate`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              model: params.model,
              prompt,
              stream: false,
              format: "json",
              options: { temperature: params.temperature, num_predict: 256 },
            }),
            signal: AbortSignal.timeout(params.timeoutMs),
          });
          if (response.ok) {
            const raw = ((await response.json()) as OllamaGenerateResponse).response?.trim();
            if (raw) {
              const result = buildModelClassificationResult({ raw, model: params.model });
              if (result) {
                return reconcileRelationWithTaskState(input, result);
              }
            }
          } else {
            logVerbose(
              `supervisor: relation classifier request failed provider=ollama status=${response.status}`,
            );
          }
        }
      } catch (error) {
        logVerbose(
          `supervisor: relation classifier request failed provider=${params.provider} error=${String(error)}`,
        );
      }
      return params.fallback.classify(input);
    },
  };
}

export function resolveSupervisorRelationClassifier(params: {
  cfg: OpenClawConfig;
  queueMode: QueueMode;
}): SupervisorRelationClassifier {
  const fallback = createLegacyQueueSupervisorRelationClassifier({ queueMode: params.queueMode });
  const provider = resolveQueueArbitratorProvider(params.cfg);
  const arbitratorCfg = params.cfg.messages?.queue?.arbitrator;
  if (!provider || !arbitratorCfg?.enabled) {
    return fallback;
  }

  return createModelBackedSupervisorRelationClassifier({
    provider,
    baseUrl:
      arbitratorCfg.baseUrl ??
      (provider === "ollama" ? DEFAULT_OLLAMA_BASE_URL : DEFAULT_LMSTUDIO_BASE_URL),
    model:
      arbitratorCfg.model ??
      (provider === "ollama" ? DEFAULT_OLLAMA_MODEL : DEFAULT_LMSTUDIO_MODEL),
    timeoutMs: arbitratorCfg.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    temperature: arbitratorCfg.temperature ?? DEFAULT_TEMPERATURE,
    fallback,
  });
}

export function buildLegacyQueueClassificationInput(
  input: Omit<SupervisorRelationClassificationInput, "taxonomyVersion">,
): SupervisorRelationClassificationInput {
  return {
    ...input,
    taxonomyVersion: SUPERVISOR_TAXONOMY_VERSION,
  };
}
