import type { StreamFn } from "@mariozechner/pi-agent-core";
import type {
  AssistantMessage,
  StopReason,
  TextContent,
  ToolCall,
  Usage,
} from "@mariozechner/pi-ai";
import { createAssistantMessageEventStream } from "@mariozechner/pi-ai";
import { GoogleAuth } from "google-auth-library";

// ── Anthropic SSE event types ───────────────────────────────────────────────

interface AnthropicContentBlockStart {
  type: "content_block_start";
  index: number;
  content_block: {
    type: "text" | "tool_use";
    id?: string;
    text?: string;
    name?: string;
    input?: string;
  };
}

interface AnthropicContentBlockDelta {
  type: "content_block_delta";
  index: number;
  delta: {
    type: "text_delta" | "input_json_delta";
    text?: string;
    partial_json?: string;
  };
}

interface AnthropicMessageStart {
  type: "message_start";
  message: {
    id: string;
    model: string;
    usage: {
      input_tokens: number;
      output_tokens: number;
      cache_creation_input_tokens?: number;
      cache_read_input_tokens?: number;
    };
  };
}

interface AnthropicMessageDelta {
  type: "message_delta";
  delta: {
    stop_reason: string;
  };
  usage?: {
    output_tokens: number;
  };
}

type AnthropicSSEEvent =
  | AnthropicMessageStart
  | AnthropicContentBlockStart
  | AnthropicContentBlockDelta
  | AnthropicMessageDelta
  | { type: "content_block_stop"; index: number }
  | { type: "message_stop" }
  | { type: "ping" }
  | { type: "error"; error: { type: string; message: string } };

// ── SSE parser ──────────────────────────────────────────────────────────────

async function* parseSSEStream(
  reader: ReadableStreamDefaultReader<Uint8Array>,
): AsyncGenerator<AnthropicSSEEvent> {
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    buffer += decoder.decode(value, { stream: true });

    const parts = buffer.split("\n\n");
    buffer = parts.pop() ?? "";

    for (const part of parts) {
      const lines = part.split("\n");
      let eventData = "";

      for (const line of lines) {
        if (line.startsWith("data: ")) {
          eventData += line.slice(6);
        }
      }

      if (!eventData) {
        continue;
      }

      try {
        yield JSON.parse(eventData) as AnthropicSSEEvent;
      } catch {
        console.warn(
          "[vertex-anthropic-stream] Skipping malformed SSE data:",
          eventData.slice(0, 120),
        );
      }
    }
  }

  // Process remaining buffer
  if (buffer.trim()) {
    const lines = buffer.split("\n");
    let eventData = "";
    for (const line of lines) {
      if (line.startsWith("data: ")) {
        eventData += line.slice(6);
      }
    }
    if (eventData) {
      try {
        yield JSON.parse(eventData) as AnthropicSSEEvent;
      } catch {
        console.warn(
          "[vertex-anthropic-stream] Skipping malformed trailing SSE data:",
          eventData.slice(0, 120),
        );
      }
    }
  }
}

// ── Main StreamFn factory ───────────────────────────────────────────────────

export function createVertexAnthropicStreamFn(project: string, location: string): StreamFn {
  if (!project || !location) {
    throw new Error(
      "Vertex AI requires GOOGLE_CLOUD_PROJECT and GOOGLE_CLOUD_LOCATION environment variables",
    );
  }
  const auth = new GoogleAuth({ scopes: "https://www.googleapis.com/auth/cloud-platform" });

  return (model, context, options) => {
    const stream = createAssistantMessageEventStream();

    const run = async () => {
      try {
        const client = await auth.getClient();
        const tokenResponse = await client.getAccessToken();
        const accessToken =
          typeof tokenResponse === "string" ? tokenResponse : tokenResponse?.token;
        if (!accessToken) {
          throw new Error("Failed to obtain Google Cloud access token from ADC");
        }

        const modelId = model.id;
        const url =
          `https://${location}-aiplatform.googleapis.com/v1/projects/${project}` +
          `/locations/${location}/publishers/anthropic/models/${modelId}:streamRawPredict`;

        // Build Anthropic messages body
        const messages = (context.messages ?? []).map((msg) => ({
          role: msg.role as string,
          content: msg.content,
        }));

        const body: Record<string, unknown> = {
          anthropic_version: "vertex-2023-10-16",
          stream: true,
          messages,
        };

        if (context.systemPrompt) {
          body.system = context.systemPrompt;
        }

        if (options?.maxTokens) {
          body.max_tokens = options.maxTokens;
        } else if (model.maxTokens) {
          body.max_tokens = model.maxTokens;
        } else {
          body.max_tokens = 8192;
        }

        if (typeof options?.temperature === "number") {
          body.temperature = options.temperature;
        }

        if (context.tools && context.tools.length > 0) {
          body.tools = context.tools.map((tool) => ({
            name: tool.name,
            description: tool.description ?? "",
            input_schema: tool.parameters ?? { type: "object", properties: {} },
          }));
        }

        const headers: Record<string, string> = {
          "Content-Type": "application/json",
          Authorization: `Bearer ${accessToken}`,
          ...options?.headers,
        };

        const response = await fetch(url, {
          method: "POST",
          headers,
          body: JSON.stringify(body),
          signal: options?.signal,
        });

        if (!response.ok) {
          const errorText = await response.text().catch(() => "unknown error");
          throw new Error(`Vertex AI rawPredict error ${response.status}: ${errorText}`);
        }

        if (!response.body) {
          throw new Error("Vertex AI rawPredict returned empty response body");
        }

        const reader = response.body.getReader();

        // Accumulate content blocks from streaming events
        const contentBlocks: Array<{
          type: "text" | "tool_use";
          text?: string;
          id?: string;
          name?: string;
          inputJson?: string;
        }> = [];

        let inputTokens = 0;
        let outputTokens = 0;
        let cacheReadTokens = 0;
        let cacheWriteTokens = 0;
        let stopReason = "stop";

        for await (const event of parseSSEStream(reader)) {
          switch (event.type) {
            case "message_start": {
              const u = event.message.usage;
              inputTokens += u.input_tokens ?? 0;
              outputTokens += u.output_tokens ?? 0;
              cacheReadTokens += u.cache_read_input_tokens ?? 0;
              cacheWriteTokens += u.cache_creation_input_tokens ?? 0;
              break;
            }
            case "content_block_start": {
              const block = event.content_block;
              contentBlocks[event.index] = {
                type: block.type,
                text: block.text ?? "",
                id: block.id,
                name: block.name,
                inputJson: "",
              };
              break;
            }
            case "content_block_delta": {
              const cb = contentBlocks[event.index];
              if (!cb) {
                break;
              }
              if (event.delta.type === "text_delta" && event.delta.text) {
                cb.text = (cb.text ?? "") + event.delta.text;
              } else if (event.delta.type === "input_json_delta" && event.delta.partial_json) {
                cb.inputJson = (cb.inputJson ?? "") + event.delta.partial_json;
              }
              break;
            }
            case "message_delta": {
              stopReason = event.delta.stop_reason ?? "stop";
              if (event.usage?.output_tokens) {
                outputTokens = event.usage.output_tokens;
              }
              break;
            }
            case "error": {
              throw new Error(`Anthropic streaming error: ${event.error.message}`);
            }
            default:
              break;
          }
        }

        // Build AssistantMessage content
        const content: (TextContent | ToolCall)[] = [];
        for (const block of contentBlocks) {
          if (!block) {
            continue;
          }
          if (block.type === "text" && block.text) {
            content.push({ type: "text", text: block.text });
          } else if (block.type === "tool_use" && block.name) {
            let args: Record<string, unknown> = {};
            if (block.inputJson) {
              try {
                args = JSON.parse(block.inputJson) as Record<string, unknown>;
              } catch {
                console.warn(
                  "[vertex-anthropic-stream] Failed to parse tool input JSON:",
                  block.inputJson.slice(0, 120),
                );
              }
            }
            content.push({
              type: "toolCall",
              id: block.id ?? `vertex_call_${Date.now()}`,
              name: block.name,
              arguments: args,
            });
          }
        }

        const hasToolCalls = content.some((c) => c.type === "toolCall");
        const mappedStopReason: StopReason =
          stopReason === "tool_use" || hasToolCalls ? "toolUse" : "stop";

        const usage: Usage = {
          input: inputTokens,
          output: outputTokens,
          cacheRead: cacheReadTokens,
          cacheWrite: cacheWriteTokens,
          totalTokens: inputTokens + outputTokens,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        };

        const assistantMessage: AssistantMessage = {
          role: "assistant",
          content,
          stopReason: mappedStopReason,
          api: model.api,
          provider: model.provider,
          model: model.id,
          usage,
          timestamp: Date.now(),
        };

        const reason: Extract<StopReason, "stop" | "length" | "toolUse"> =
          mappedStopReason === "toolUse" ? "toolUse" : "stop";

        stream.push({
          type: "done",
          reason,
          message: assistantMessage,
        });
      } catch (err) {
        const errorMessage = err instanceof Error ? err.message : String(err);
        stream.push({
          type: "error",
          reason: "error",
          error: {
            role: "assistant" as const,
            content: [],
            stopReason: "error" as StopReason,
            errorMessage,
            api: model.api,
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
            timestamp: Date.now(),
          },
        });
      } finally {
        stream.end();
      }
    };

    queueMicrotask(() => void run());
    return stream;
  };
}
