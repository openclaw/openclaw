import {
  type GenerateContentConfig,
  type GenerateContentParameters,
  GoogleGenAI,
  type HttpOptions,
  ResourceScope,
  type ThinkingConfig,
  ThinkingLevel,
} from "@google/genai";
import { calculateCost, clampThinkingLevel } from "../models.js";
import type {
  Api,
  AssistantMessage,
  Context,
  Model,
  ThinkingLevel as AgentThinkingLevel,
  SimpleStreamOptions,
  StreamFunction,
  StreamOptions,
  TextContent,
  ThinkingBudgets,
  ThinkingContent,
  ToolCall,
} from "../types.js";
import { AssistantMessageEventStream } from "../utils/event-stream.js";
import { sanitizeSurrogates } from "../utils/sanitize-unicode.js";
import type { GoogleThinkingLevel } from "./google-shared.js";
import {
  convertMessages,
  convertTools,
  isThinkingPart,
  mapStopReason,
  mapToolChoice,
  retainThoughtSignature,
} from "./google-shared.js";
import { buildBaseOptions } from "./simple-options.js";

export interface GoogleVertexOptions extends StreamOptions {
  toolChoice?: "auto" | "none" | "any";
  thinking?: {
    enabled: boolean;
    budgetTokens?: number; // -1 for dynamic, 0 to disable
    level?: GoogleThinkingLevel;
  };
  project?: string;
  location?: string;
}

const API_VERSION = "v1";
const GCP_VERTEX_CREDENTIALS_MARKER = "gcp-vertex-credentials";

const THINKING_LEVEL_MAP: Record<GoogleThinkingLevel, ThinkingLevel> = {
  THINKING_LEVEL_UNSPECIFIED: ThinkingLevel.THINKING_LEVEL_UNSPECIFIED,
  MINIMAL: ThinkingLevel.MINIMAL,
  LOW: ThinkingLevel.LOW,
  MEDIUM: ThinkingLevel.MEDIUM,
  HIGH: ThinkingLevel.HIGH,
};

// Counter for generating unique tool call IDs
let toolCallCounter = 0;

export const streamGoogleVertex: StreamFunction<"google-vertex", GoogleVertexOptions> = (
  model: Model<"google-vertex">,
  context: Context,
  options?: GoogleVertexOptions,
): AssistantMessageEventStream => {
  const stream = new AssistantMessageEventStream();

  void (async () => {
    const output: AssistantMessage = {
      role: "assistant",
      content: [],
      api: "google-vertex" as Api,
      provider: model.provider,
      model: model.id,
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop",
      timestamp: Date.now(),
    };

    try {
      const apiKey = resolveApiKey(options);
      // Create the client using either a Vertex API key, if provided, or ADC with project and location
      const client = apiKey
        ? createClientWithApiKey(model, apiKey, options?.headers)
        : createClient(model, resolveProject(options), resolveLocation(options), options?.headers);
      let params = buildParams(model, context, options);
      const nextParams = await options?.onPayload?.(params, model);
      if (nextParams !== undefined) {
        params = nextParams as GenerateContentParameters;
      }
      const googleStream = await client.models.generateContentStream(params);

      stream.push({ type: "start", partial: output });
      let currentBlock: TextContent | ThinkingContent | null = null;
      const blocks = output.content;
      const blockIndex = () => blocks.length - 1;
      for await (const chunk of googleStream) {
        // Vertex uses the same @google/genai GenerateContentResponse type as Gemini.
        // responseId is documented there as an output-only identifier for each response.
        output.responseId ||= chunk.responseId;
        const candidate = chunk.candidates?.[0];
        if (candidate?.content?.parts) {
          for (const part of candidate.content.parts) {
            if (part.text !== undefined) {
              const isThinking = isThinkingPart(part);
              if (
                !currentBlock ||
                (isThinking && currentBlock.type !== "thinking") ||
                (!isThinking && currentBlock.type !== "text")
              ) {
                if (currentBlock) {
                  if (currentBlock.type === "text") {
                    stream.push({
                      type: "text_end",
                      contentIndex: blocks.length - 1,
                      content: currentBlock.text,
                      partial: output,
                    });
                  } else {
                    stream.push({
                      type: "thinking_end",
                      contentIndex: blockIndex(),
                      content: currentBlock.thinking,
                      partial: output,
                    });
                  }
                }
                if (isThinking) {
                  currentBlock = { type: "thinking", thinking: "", thinkingSignature: undefined };
                  output.content.push(currentBlock);
                  stream.push({
                    type: "thinking_start",
                    contentIndex: blockIndex(),
                    partial: output,
                  });
                } else {
                  currentBlock = { type: "text", text: "" };
                  output.content.push(currentBlock);
                  stream.push({ type: "text_start", contentIndex: blockIndex(), partial: output });
                }
              }
              if (currentBlock.type === "thinking") {
                currentBlock.thinking += part.text;
                currentBlock.thinkingSignature = retainThoughtSignature(
                  currentBlock.thinkingSignature,
                  part.thoughtSignature,
                );
                stream.push({
                  type: "thinking_delta",
                  contentIndex: blockIndex(),
                  delta: part.text,
                  partial: output,
                });
              } else {
                currentBlock.text += part.text;
                currentBlock.textSignature = retainThoughtSignature(
                  currentBlock.textSignature,
                  part.thoughtSignature,
                );
                stream.push({
                  type: "text_delta",
                  contentIndex: blockIndex(),
                  delta: part.text,
                  partial: output,
                });
              }
            }

            if (part.functionCall) {
              if (currentBlock) {
                if (currentBlock.type === "text") {
                  stream.push({
                    type: "text_end",
                    contentIndex: blockIndex(),
                    content: currentBlock.text,
                    partial: output,
                  });
                } else {
                  stream.push({
                    type: "thinking_end",
                    contentIndex: blockIndex(),
                    content: currentBlock.thinking,
                    partial: output,
                  });
                }
                currentBlock = null;
              }

              const providedId = part.functionCall.id;
              const needsNewId =
                !providedId ||
                output.content.some((b) => b.type === "toolCall" && b.id === providedId);
              const toolCallId = needsNewId
                ? `${part.functionCall.name}_${Date.now()}_${++toolCallCounter}`
                : providedId;

              const toolCall: ToolCall = {
                type: "toolCall",
                id: toolCallId,
                name: part.functionCall.name || "",
                arguments: (part.functionCall.args as Record<string, unknown>) ?? {},
                ...(part.thoughtSignature && { thoughtSignature: part.thoughtSignature }),
              };

              output.content.push(toolCall);
              stream.push({ type: "toolcall_start", contentIndex: blockIndex(), partial: output });
              stream.push({
                type: "toolcall_delta",
                contentIndex: blockIndex(),
                delta: JSON.stringify(toolCall.arguments),
                partial: output,
              });
              stream.push({
                type: "toolcall_end",
                contentIndex: blockIndex(),
                toolCall,
                partial: output,
              });
            }
          }
        }

        if (candidate?.finishReason) {
          output.stopReason = mapStopReason(candidate.finishReason);
          if (output.content.some((b) => b.type === "toolCall")) {
            output.stopReason = "toolUse";
          }
        }

        if (chunk.usageMetadata) {
          output.usage = {
            input:
              (chunk.usageMetadata.promptTokenCount || 0) -
              (chunk.usageMetadata.cachedContentTokenCount || 0),
            output:
              (chunk.usageMetadata.candidatesTokenCount || 0) +
              (chunk.usageMetadata.thoughtsTokenCount || 0),
            cacheRead: chunk.usageMetadata.cachedContentTokenCount || 0,
            cacheWrite: 0,
            totalTokens: chunk.usageMetadata.totalTokenCount || 0,
            cost: {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              total: 0,
            },
          };
          calculateCost(model, output.usage);
        }
      }

      if (currentBlock) {
        if (currentBlock.type === "text") {
          stream.push({
            type: "text_end",
            contentIndex: blockIndex(),
            content: currentBlock.text,
            partial: output,
          });
        } else {
          stream.push({
            type: "thinking_end",
            contentIndex: blockIndex(),
            content: currentBlock.thinking,
            partial: output,
          });
        }
      }

      if (options?.signal?.aborted) {
        throw new Error("Request was aborted");
      }

      if (output.stopReason === "aborted" || output.stopReason === "error") {
        throw new Error("An unknown error occurred");
      }

      stream.push({ type: "done", reason: output.stopReason, message: output });
      stream.end();
    } catch (error) {
      // Remove internal index property used during streaming
      for (const block of output.content) {
        if ("index" in block) {
          delete (block as { index?: number }).index;
        }
      }
      output.stopReason = options?.signal?.aborted ? "aborted" : "error";
      output.errorMessage = error instanceof Error ? error.message : JSON.stringify(error);
      stream.push({ type: "error", reason: output.stopReason, error: output });
      stream.end();
    }
  })();

  return stream;
};

export const streamSimpleGoogleVertex: StreamFunction<"google-vertex", SimpleStreamOptions> = (
  model: Model<"google-vertex">,
  context: Context,
  options?: SimpleStreamOptions,
): AssistantMessageEventStream => {
  const base = buildBaseOptions(model, options, undefined);
  if (!options?.reasoning) {
    return streamGoogleVertex(model, context, {
      ...base,
      thinking: { enabled: false },
    } satisfies GoogleVertexOptions);
  }

  const clampedReasoning = clampThinkingLevel(model, options.reasoning);
  const effort = (clampedReasoning === "off" ? "high" : clampedReasoning) as ClampedThinkingLevel;
  const geminiModel = model as unknown as Model<"google-generative-ai">;

  if (isGemini3ProModel(geminiModel) || isGemini3FlashModel(geminiModel)) {
    return streamGoogleVertex(model, context, {
      ...base,
      thinking: {
        enabled: true,
        level: getGemini3ThinkingLevel(effort, geminiModel),
      },
    } satisfies GoogleVertexOptions);
  }

  return streamGoogleVertex(model, context, {
    ...base,
    thinking: {
      enabled: true,
      budgetTokens: getGoogleBudget(geminiModel, effort, options.thinkingBudgets),
    },
  } satisfies GoogleVertexOptions);
};

function createClient(
  model: Model<"google-vertex">,
  project: string,
  location: string,
  optionsHeaders?: Record<string, string>,
): GoogleGenAI {
  return new GoogleGenAI({
    vertexai: true,
    project,
    location,
    apiVersion: API_VERSION,
    httpOptions: buildHttpOptions(model, optionsHeaders),
  });
}

function createClientWithApiKey(
  model: Model<"google-vertex">,
  apiKey: string,
  optionsHeaders?: Record<string, string>,
): GoogleGenAI {
  return new GoogleGenAI({
    vertexai: true,
    apiKey,
    apiVersion: API_VERSION,
    httpOptions: buildHttpOptions(model, optionsHeaders),
  });
}

function buildHttpOptions(
  model: Model<"google-vertex">,
  optionsHeaders?: Record<string, string>,
): HttpOptions | undefined {
  const httpOptions: HttpOptions = {};
  const baseUrl = resolveCustomBaseUrl(model.baseUrl);
  if (baseUrl) {
    httpOptions.baseUrl = baseUrl;
    httpOptions.baseUrlResourceScope = ResourceScope.COLLECTION;
    if (baseUrlIncludesApiVersion(baseUrl)) {
      httpOptions.apiVersion = "";
    }
  }

  if (model.headers || optionsHeaders) {
    httpOptions.headers = { ...model.headers, ...optionsHeaders };
  }

  return Object.keys(httpOptions).length > 0 ? httpOptions : undefined;
}

function resolveCustomBaseUrl(baseUrl: string): string | undefined {
  const trimmed = baseUrl.trim();
  if (!trimmed || trimmed.includes("{location}")) {
    return undefined;
  }
  return trimmed;
}

function baseUrlIncludesApiVersion(baseUrl: string): boolean {
  try {
    const url = new URL(baseUrl);
    return url.pathname.split("/").some((part) => /^v\d+(?:beta\d*)?$/.test(part));
  } catch {
    return /(?:^|\/)v\d+(?:beta\d*)?(?:\/|$)/.test(baseUrl);
  }
}

function resolveApiKey(options?: GoogleVertexOptions): string | undefined {
  const apiKey = options?.apiKey?.trim() || process.env.GOOGLE_CLOUD_API_KEY?.trim();
  if (!apiKey || apiKey === GCP_VERTEX_CREDENTIALS_MARKER || isPlaceholderApiKey(apiKey)) {
    return undefined;
  }
  return apiKey;
}

function isPlaceholderApiKey(apiKey: string): boolean {
  return /^<[^>]+>$/.test(apiKey);
}

function resolveProject(options?: GoogleVertexOptions): string {
  const project =
    options?.project || process.env.GOOGLE_CLOUD_PROJECT || process.env.GCLOUD_PROJECT;
  if (!project) {
    throw new Error(
      "Vertex AI requires a project ID. Set GOOGLE_CLOUD_PROJECT/GCLOUD_PROJECT or pass project in options.",
    );
  }
  return project;
}

function resolveLocation(options?: GoogleVertexOptions): string {
  const location = options?.location || process.env.GOOGLE_CLOUD_LOCATION;
  if (!location) {
    throw new Error(
      "Vertex AI requires a location. Set GOOGLE_CLOUD_LOCATION or pass location in options.",
    );
  }
  return location;
}

function buildParams(
  model: Model<"google-vertex">,
  context: Context,
  options: GoogleVertexOptions = {},
): GenerateContentParameters {
  const contents = convertMessages(model, context);

  const generationConfig: GenerateContentConfig = {};
  if (options.temperature !== undefined) {
    generationConfig.temperature = options.temperature;
  }
  if (options.maxTokens !== undefined) {
    generationConfig.maxOutputTokens = options.maxTokens;
  }

  const config: GenerateContentConfig = {
    ...(Object.keys(generationConfig).length > 0 && generationConfig),
    ...(context.systemPrompt && { systemInstruction: sanitizeSurrogates(context.systemPrompt) }),
    ...(context.tools && context.tools.length > 0 && { tools: convertTools(context.tools) }),
  };

  if (context.tools && context.tools.length > 0 && options.toolChoice) {
    config.toolConfig = {
      functionCallingConfig: {
        mode: mapToolChoice(options.toolChoice),
      },
    };
  } else {
    config.toolConfig = undefined;
  }

  if (options.thinking?.enabled && model.reasoning) {
    const thinkingConfig: ThinkingConfig = { includeThoughts: true };
    if (options.thinking.level !== undefined) {
      thinkingConfig.thinkingLevel = THINKING_LEVEL_MAP[options.thinking.level];
    } else if (options.thinking.budgetTokens !== undefined) {
      thinkingConfig.thinkingBudget = options.thinking.budgetTokens;
    }
    config.thinkingConfig = thinkingConfig;
  } else if (model.reasoning && options.thinking && !options.thinking.enabled) {
    config.thinkingConfig = getDisabledThinkingConfig(model);
  }

  if (options.signal) {
    if (options.signal.aborted) {
      throw new Error("Request aborted");
    }
    config.abortSignal = options.signal;
  }

  const params: GenerateContentParameters = {
    model: model.id,
    contents,
    config,
  };

  return params;
}

type ClampedThinkingLevel = Exclude<AgentThinkingLevel, "xhigh">;

function isGemini3ProModel(model: Model<"google-generative-ai">): boolean {
  return /gemini-3(?:\.\d+)?-pro/.test(model.id.toLowerCase());
}

function isGemini3FlashModel(model: Model<"google-generative-ai">): boolean {
  return /gemini-3(?:\.\d+)?-flash/.test(model.id.toLowerCase());
}

function getDisabledThinkingConfig(model: Model<"google-vertex">): ThinkingConfig {
  // Google docs: Gemini 3.1 Pro cannot disable thinking, and Gemini 3 Flash / Flash-Lite
  // do not support full thinking-off either. For Gemini 3 models, use the lowest supported
  // thinkingLevel without includeThoughts so hidden thinking stays internal.
  const geminiModel = model as unknown as Model<"google-generative-ai">;
  if (isGemini3ProModel(geminiModel)) {
    return { thinkingLevel: ThinkingLevel.LOW };
  }
  if (isGemini3FlashModel(geminiModel)) {
    return { thinkingLevel: ThinkingLevel.MINIMAL };
  }

  // Gemini 2.x supports disabling via thinkingBudget = 0.
  return { thinkingBudget: 0 };
}

function getGemini3ThinkingLevel(
  effort: ClampedThinkingLevel,
  model: Model<"google-generative-ai">,
): GoogleThinkingLevel {
  if (isGemini3ProModel(model)) {
    switch (effort) {
      case "minimal":
      case "low":
        return "LOW";
      case "medium":
      case "high":
        return "HIGH";
    }
  }
  switch (effort) {
    case "minimal":
      return "MINIMAL";
    case "low":
      return "LOW";
    case "medium":
      return "MEDIUM";
    case "high":
      return "HIGH";
  }
  return "HIGH";
}

function getGoogleBudget(
  model: Model<"google-generative-ai">,
  effort: ClampedThinkingLevel,
  customBudgets?: ThinkingBudgets,
): number {
  if (customBudgets?.[effort] !== undefined) {
    return customBudgets[effort];
  }

  if (model.id.includes("2.5-pro")) {
    const budgets: Record<ClampedThinkingLevel, number> = {
      minimal: 128,
      low: 2048,
      medium: 8192,
      high: 32768,
    };
    return budgets[effort];
  }

  if (model.id.includes("2.5-flash")) {
    const budgets: Record<ClampedThinkingLevel, number> = {
      minimal: 128,
      low: 2048,
      medium: 8192,
      high: 24576,
    };
    return budgets[effort];
  }

  return -1;
}
