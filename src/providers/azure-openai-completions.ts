/**
 * Azure OpenAI Completions provider.
 *
 * Uses the `AzureOpenAI` client from the `openai` SDK with the chat completions
 * API (`/chat/completions`). The streaming loop mirrors the standard
 * openai-completions provider; only the client construction differs.
 *
 * Auto-registers as `"azure-openai-completions"` on import.
 */

import {
  registerApiProvider,
  createAssistantMessageEventStream,
  getEnvApiKey,
  calculateCost,
  supportsXhigh,
  convertMessages,
  parseStreamingJson,
} from "@mariozechner/pi-ai";
import { AzureOpenAI } from "openai";

const DEFAULT_AZURE_API_VERSION = "2024-12-01-preview";

/** Azure OpenAI follows the standard OpenAI chat completions wire format. */
const AZURE_COMPAT = {
  supportsStore: false,
  supportsDeveloperRole: false,
  supportsReasoningEffort: true,
  supportsUsageInStreaming: true,
  maxTokensField: "max_completion_tokens" as const,
  requiresToolResultName: false,
  requiresAssistantAfterToolResult: false,
  requiresThinkingAsText: false,
  requiresMistralToolIds: false,
  thinkingFormat: "openai" as const,
  openRouterRouting: {},
  vercelGatewayRouting: {},
  supportsStrictMode: true,
};

// ---------------------------------------------------------------------------
// Local helpers (not exported from pi-ai's main package)
// ---------------------------------------------------------------------------

function buildBaseOptions(
  model: { maxTokens: number },
  options?: Record<string, unknown>,
  apiKey?: string,
): Record<string, unknown> {
  return {
    temperature: options?.temperature,
    maxTokens: (options?.maxTokens as number) || Math.min(model.maxTokens, 32000),
    signal: options?.signal,
    apiKey: apiKey || options?.apiKey,
    cacheRetention: options?.cacheRetention,
    sessionId: options?.sessionId,
    headers: options?.headers,
    onPayload: options?.onPayload,
    maxRetryDelayMs: options?.maxRetryDelayMs,
  };
}

function clampReasoning(effort: string | undefined): string | undefined {
  return effort === "xhigh" ? "high" : effort;
}

function hasToolHistory(messages: Array<{ role: string; content: unknown }>): boolean {
  for (const msg of messages) {
    if (msg.role === "toolResult") return true;
    if (msg.role === "assistant" && Array.isArray(msg.content)) {
      if (msg.content.some((b: Record<string, unknown>) => b.type === "toolCall")) return true;
    }
  }
  return false;
}

function convertTools(tools: Array<Record<string, unknown>>): unknown[] {
  return tools.map((tool) => ({
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
      strict: false,
    },
  }));
}

function mapStopReason(reason: string | null): string {
  if (reason === null) return "stop";
  switch (reason) {
    case "stop":
      return "stop";
    case "length":
      return "length";
    case "function_call":
    case "tool_calls":
      return "toolUse";
    case "content_filter":
      return "error";
    default:
      return "stop";
  }
}

// ---------------------------------------------------------------------------
// Azure client & params
// ---------------------------------------------------------------------------

function createClient(
  model: Record<string, unknown>,
  apiKey: string,
  options?: Record<string, unknown>,
): AzureOpenAI {
  let key = apiKey;
  if (!key) {
    key = process.env.AZURE_OPENAI_API_KEY || "";
    if (!key) {
      throw new Error(
        "Azure OpenAI API key is required. Set AZURE_OPENAI_API_KEY environment variable or configure apiKey in provider config.",
      );
    }
  }

  const headers: Record<string, string> = {
    ...(model.headers as Record<string, string> | undefined),
  };
  if (options?.headers) {
    Object.assign(headers, options.headers);
  }

  const apiVersion =
    (options?.azureApiVersion as string | undefined) ||
    process.env.AZURE_OPENAI_API_VERSION ||
    DEFAULT_AZURE_API_VERSION;

  const baseUrl = ((model.baseUrl as string) || "").replace(/\/+$/, "");

  return new AzureOpenAI({
    apiKey: key,
    apiVersion,
    dangerouslyAllowBrowser: true,
    defaultHeaders: headers,
    baseURL: baseUrl || undefined,
  });
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function buildParams(model: any, context: any, options: any): any {
  const messages = convertMessages(model, context, AZURE_COMPAT);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const params: any = {
    model: model.id, // Azure deployment name
    messages,
    stream: true,
    stream_options: { include_usage: true },
  };

  if (options?.maxTokens) {
    params.max_completion_tokens = options.maxTokens;
  }
  if (options?.temperature !== undefined) {
    params.temperature = options.temperature;
  }

  if (context.tools) {
    params.tools = convertTools(context.tools);
  } else if (hasToolHistory(context.messages)) {
    params.tools = [];
  }

  if (options?.toolChoice) {
    params.tool_choice = options.toolChoice;
  }
  if (options?.reasoningEffort && model.reasoning) {
    params.reasoning_effort = options.reasoningEffort;
  }

  return params;
}

// ---------------------------------------------------------------------------
// Streaming implementation
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const streamAzureOpenAICompletions = (model: any, context: any, options?: any) => {
  const stream = createAssistantMessageEventStream();

  (async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const output: any = {
      role: "assistant",
      content: [],
      api: "azure-openai-completions",
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
      const apiKey = options?.apiKey || getEnvApiKey(model.provider) || "";
      const client = createClient(model, apiKey, options);
      const params = buildParams(model, context, options);
      options?.onPayload?.(params);

      const openaiStream = (await client.chat.completions.create(params, {
        signal: options?.signal,
      })) as unknown as AsyncIterable<Record<string, any>>;

      stream.push({ type: "start", partial: output });

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let currentBlock: any = null;
      const blocks = output.content;
      const blockIndex = () => blocks.length - 1;

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const finishCurrentBlock = (block: any) => {
        if (!block) return;
        if (block.type === "text") {
          stream.push({
            type: "text_end",
            contentIndex: blockIndex(),
            content: block.text,
            partial: output,
          });
        } else if (block.type === "thinking") {
          stream.push({
            type: "thinking_end",
            contentIndex: blockIndex(),
            content: block.thinking,
            partial: output,
          });
        } else if (block.type === "toolCall") {
          block.arguments = JSON.parse(block.partialArgs || "{}");
          delete block.partialArgs;
          stream.push({
            type: "toolcall_end",
            contentIndex: blockIndex(),
            toolCall: block,
            partial: output,
          });
        }
      };

      // Main streaming loop — mirrors pi-ai openai-completions chunk processing.
      for await (const chunk of openaiStream) {
        if (chunk.usage) {
          const cachedTokens = chunk.usage.prompt_tokens_details?.cached_tokens || 0;
          const inputTokens = (chunk.usage.prompt_tokens || 0) - cachedTokens;
          const outputTokens = chunk.usage.completion_tokens || 0;
          output.usage = {
            input: inputTokens,
            output: outputTokens,
            cacheRead: cachedTokens,
            cacheWrite: 0,
            totalTokens: inputTokens + outputTokens + cachedTokens,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          };
          calculateCost(model, output.usage);
        }

        const choice = chunk.choices[0];
        if (!choice) continue;

        if (choice.finish_reason) {
          output.stopReason = mapStopReason(choice.finish_reason);
        }

        if (choice.delta) {
          const delta = choice.delta;

          // --- Text content ---
          if (delta.content !== null && delta.content !== undefined && delta.content.length > 0) {
            if (!currentBlock || currentBlock.type !== "text") {
              finishCurrentBlock(currentBlock);
              currentBlock = { type: "text", text: "" };
              output.content.push(currentBlock);
              stream.push({ type: "text_start", contentIndex: blockIndex(), partial: output });
            }
            if (currentBlock.type === "text") {
              currentBlock.text += delta.content;
              stream.push({
                type: "text_delta",
                contentIndex: blockIndex(),
                delta: delta.content,
                partial: output,
              });
            }
          }

          // --- Reasoning / thinking ---
          const reasoningFields = ["reasoning_content", "reasoning", "reasoning_text"];
          let foundReasoningField: string | null = null;
          for (const field of reasoningFields) {
            if (delta[field] !== null && delta[field] !== undefined && delta[field].length > 0) {
              foundReasoningField = field;
              break;
            }
          }

          if (foundReasoningField) {
            if (!currentBlock || currentBlock.type !== "thinking") {
              finishCurrentBlock(currentBlock);
              currentBlock = {
                type: "thinking",
                thinking: "",
                thinkingSignature: foundReasoningField,
              };
              output.content.push(currentBlock);
              stream.push({
                type: "thinking_start",
                contentIndex: blockIndex(),
                partial: output,
              });
            }
            if (currentBlock.type === "thinking") {
              const reasoningDelta = delta[foundReasoningField];
              currentBlock.thinking += reasoningDelta;
              stream.push({
                type: "thinking_delta",
                contentIndex: blockIndex(),
                delta: reasoningDelta,
                partial: output,
              });
            }
          }

          // --- Tool calls ---
          if (delta.tool_calls) {
            for (const toolCall of delta.tool_calls) {
              if (
                !currentBlock ||
                currentBlock.type !== "toolCall" ||
                (toolCall.id && currentBlock.id !== toolCall.id)
              ) {
                finishCurrentBlock(currentBlock);
                currentBlock = {
                  type: "toolCall",
                  id: toolCall.id || "",
                  name: toolCall.function?.name || "",
                  arguments: {},
                  partialArgs: "",
                };
                output.content.push(currentBlock);
                stream.push({
                  type: "toolcall_start",
                  contentIndex: blockIndex(),
                  partial: output,
                });
              }
              if (currentBlock.type === "toolCall") {
                if (toolCall.id) currentBlock.id = toolCall.id;
                if (toolCall.function?.name) currentBlock.name = toolCall.function.name;
                let toolDelta = "";
                if (toolCall.function?.arguments) {
                  toolDelta = toolCall.function.arguments;
                  currentBlock.partialArgs += toolCall.function.arguments;
                  currentBlock.arguments = parseStreamingJson(currentBlock.partialArgs);
                }
                stream.push({
                  type: "toolcall_delta",
                  contentIndex: blockIndex(),
                  delta: toolDelta,
                  partial: output,
                });
              }
            }
          }

          // --- Reasoning details (encrypted reasoning) ---
          const reasoningDetails = delta.reasoning_details;
          if (reasoningDetails && Array.isArray(reasoningDetails)) {
            for (const detail of reasoningDetails) {
              if (detail.type === "reasoning.encrypted" && detail.id && detail.data) {
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                const matchingToolCall = output.content.find(
                  (b: any) => b.type === "toolCall" && b.id === detail.id,
                );
                if (matchingToolCall) {
                  matchingToolCall.thoughtSignature = JSON.stringify(detail);
                }
              }
            }
          }
        }
      }

      finishCurrentBlock(currentBlock);

      if (options?.signal?.aborted) {
        throw new Error("Request was aborted");
      }
      if (output.stopReason === "aborted" || output.stopReason === "error") {
        throw new Error("An unknown error occurred");
      }

      stream.push({ type: "done", reason: output.stopReason, message: output });
      stream.end();
    } catch (error) {
      for (const block of output.content) delete block.index;
      output.stopReason = options?.signal?.aborted ? "aborted" : "error";
      output.errorMessage = error instanceof Error ? error.message : JSON.stringify(error);
      stream.push({ type: "error", reason: output.stopReason, error: output });
      stream.end();
    }
  })();

  return stream;
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const streamSimpleAzureOpenAICompletions = (model: any, context: any, options?: any) => {
  const apiKey = options?.apiKey || getEnvApiKey(model.provider);
  if (!apiKey) {
    throw new Error(`No API key for provider: ${model.provider}`);
  }
  const base = buildBaseOptions(model, options, apiKey);
  const reasoningEffort = supportsXhigh(model)
    ? options?.reasoning
    : clampReasoning(options?.reasoning);
  const toolChoice = options?.toolChoice;
  return streamAzureOpenAICompletions(model, context, {
    ...base,
    reasoningEffort,
    toolChoice,
  });
};

// ---------------------------------------------------------------------------
// Auto-register on import
// ---------------------------------------------------------------------------

registerApiProvider({
  api: "azure-openai-completions" as never,
  stream: streamAzureOpenAICompletions,
  streamSimple: streamSimpleAzureOpenAICompletions,
});
