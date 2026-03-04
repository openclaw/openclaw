/**
 * LLM Gateway Provider Integrations
 *
 * Groq (cheap) and Anthropic (premium) provider implementations
 */

import type {
  GatewayRequest,
  GatewayResponse,
  ProviderConfig,
  GroqConfig,
  AnthropicConfig,
  TokenUsage,
  ToolCall,
} from "../types.js";

/**
 * Base provider class
 */
export abstract class BaseProvider {
  protected config: ProviderConfig;

  constructor(config: ProviderConfig) {
    this.config = config;
  }

  abstract complete(request: GatewayRequest): Promise<GatewayResponse>;
  abstract stream(
    request: GatewayRequest,
    onChunk: (chunk: string) => void,
  ): Promise<GatewayResponse>;

  protected generateId(): string {
    return `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  }

  protected calculateCost(usage: TokenUsage): number {
    return (usage.totalTokens / 1000) * this.config.costPer1kTokens;
  }
}

/**
 * Groq Provider (cheap tier)
 *
 * Ultra-fast inference using Groq's LPU architecture
 * Supports LLaMA, Mixtral, and other open models
 */
export class GroqProvider extends BaseProvider {
  private groqConfig: GroqConfig;

  constructor(config: GroqConfig) {
    super(config);
    this.groqConfig = config;
  }

  async complete(request: GatewayRequest): Promise<GatewayResponse> {
    const startTime = Date.now();

    const response = await fetch(`${this.config.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.config.apiKey}`,
      },
      body: JSON.stringify({
        model: request.model || this.config.defaultModel,
        messages: this.convertMessages(request.messages),
        max_tokens: request.maxTokens || this.config.maxTokens,
        temperature: request.temperature ?? 0.7,
        tools: request.tools,
        stream: false,
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Groq API error: ${response.status} - ${error}`);
    }

    const data = (await response.json()) as GroqResponse;
    const usage: TokenUsage = {
      promptTokens: data.usage?.prompt_tokens || 0,
      completionTokens: data.usage?.completion_tokens || 0,
      totalTokens: data.usage?.total_tokens || 0,
    };

    return {
      id: this.generateId(),
      requestId: request.id,
      tier: "cheap",
      provider: "groq",
      model: data.model,
      content: data.choices[0]?.message?.content || "",
      toolCalls: this.convertToolCalls(data.choices[0]?.message?.tool_calls),
      usage,
      cost: this.calculateCost(usage),
      cached: false,
      latencyMs: Date.now() - startTime,
    };
  }

  async stream(
    request: GatewayRequest,
    onChunk: (chunk: string) => void,
  ): Promise<GatewayResponse> {
    const startTime = Date.now();

    const response = await fetch(`${this.config.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.config.apiKey}`,
      },
      body: JSON.stringify({
        model: request.model || this.config.defaultModel,
        messages: this.convertMessages(request.messages),
        max_tokens: request.maxTokens || this.config.maxTokens,
        temperature: request.temperature ?? 0.7,
        tools: request.tools,
        stream: true,
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Groq API error: ${response.status} - ${error}`);
    }

    const reader = response.body?.getReader();
    if (!reader) {
      throw new Error("No response body");
    }

    const decoder = new TextDecoder();
    let fullContent = "";
    let usage: TokenUsage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
    let model = request.model || this.config.defaultModel;

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }

        const chunk = decoder.decode(value);
        const lines = chunk.split("\n").filter((line) => line.startsWith("data: "));

        for (const line of lines) {
          const data = line.slice(6);
          if (data === "[DONE]") {
            continue;
          }

          try {
            const parsed = JSON.parse(data) as GroqStreamChunk;
            const content = parsed.choices[0]?.delta?.content || "";
            if (content) {
              fullContent += content;
              onChunk(content);
            }
            if (parsed.model) {
              model = parsed.model;
            }
            if (parsed.x_groq?.usage) {
              usage = {
                promptTokens: parsed.x_groq.usage.prompt_tokens || 0,
                completionTokens: parsed.x_groq.usage.completion_tokens || 0,
                totalTokens: parsed.x_groq.usage.total_tokens || 0,
              };
            }
          } catch {
            // Skip malformed JSON
          }
        }
      }
    } finally {
      reader.releaseLock();
    }

    return {
      id: this.generateId(),
      requestId: request.id,
      tier: "cheap",
      provider: "groq",
      model,
      content: fullContent,
      usage,
      cost: this.calculateCost(usage),
      cached: false,
      latencyMs: Date.now() - startTime,
    };
  }

  private convertMessages(messages: GatewayRequest["messages"]): GroqMessage[] {
    return messages.map((msg) => ({
      role: msg.role,
      content:
        typeof msg.content === "string"
          ? msg.content
          : msg.content
              .filter((b) => b.type === "text")
              .map((b) => b.text || "")
              .join("\n"),
      name: msg.name,
      tool_calls: msg.toolCalls,
      tool_call_id: msg.toolCallId,
    }));
  }

  private convertToolCalls(toolCalls?: GroqToolCall[]): ToolCall[] | undefined {
    if (!toolCalls) {
      return undefined;
    }
    return toolCalls.map((tc) => ({
      id: tc.id,
      type: "function" as const,
      function: {
        name: tc.function.name,
        arguments: tc.function.arguments,
      },
    }));
  }
}

/**
 * Anthropic Provider (premium tier)
 *
 * High-quality responses with Claude models
 * Best for complex reasoning and analysis
 */
export class AnthropicProvider extends BaseProvider {
  private anthropicConfig: AnthropicConfig;

  constructor(config: AnthropicConfig) {
    super(config);
    this.anthropicConfig = config;
  }

  async complete(request: GatewayRequest): Promise<GatewayResponse> {
    const startTime = Date.now();

    const { system, messages } = this.extractSystemPrompt(request.messages);

    const response = await fetch(`${this.config.baseUrl}/messages`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": this.config.apiKey || "",
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: request.model || this.config.defaultModel,
        max_tokens: request.maxTokens || this.config.maxTokens,
        system,
        messages,
        tools: this.convertTools(request.tools),
        stream: false,
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Anthropic API error: ${response.status} - ${error}`);
    }

    const data = (await response.json()) as AnthropicResponse;
    const usage: TokenUsage = {
      promptTokens: data.usage?.input_tokens || 0,
      completionTokens: data.usage?.output_tokens || 0,
      totalTokens: (data.usage?.input_tokens || 0) + (data.usage?.output_tokens || 0),
    };

    // Extract text content
    const textContent = data.content
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("\n");

    // Extract tool use blocks
    const toolCalls = data.content
      .filter((block) => block.type === "tool_use")
      .map((block) => ({
        id: block.id,
        type: "function" as const,
        function: {
          name: block.name,
          arguments: JSON.stringify(block.input),
        },
      }));

    return {
      id: this.generateId(),
      requestId: request.id,
      tier: "premium",
      provider: "anthropic",
      model: data.model,
      content: textContent,
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
      usage,
      cost: this.calculateCost(usage),
      cached: false,
      latencyMs: Date.now() - startTime,
    };
  }

  async stream(
    request: GatewayRequest,
    onChunk: (chunk: string) => void,
  ): Promise<GatewayResponse> {
    const startTime = Date.now();

    const { system, messages } = this.extractSystemPrompt(request.messages);

    const response = await fetch(`${this.config.baseUrl}/messages`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": this.config.apiKey || "",
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: request.model || this.config.defaultModel,
        max_tokens: request.maxTokens || this.config.maxTokens,
        system,
        messages,
        tools: this.convertTools(request.tools),
        stream: true,
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Anthropic API error: ${response.status} - ${error}`);
    }

    const reader = response.body?.getReader();
    if (!reader) {
      throw new Error("No response body");
    }

    const decoder = new TextDecoder();
    let fullContent = "";
    let carryOver = ""; // Buffer for partial SSE events
    let usage: TokenUsage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
    let model = request.model || this.config.defaultModel;

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }

        // Add to carry-over buffer
        carryOver += decoder.decode(value);

        // Split on double newlines (SSE event separator)
        const events = carryOver.split("\n\n");

        // Keep the last potentially incomplete event
        carryOver = events.pop() || "";

        for (const event of events) {
          const lines = event.split("\n").filter((line) => line.startsWith("data: "));

          for (const line of lines) {
            const data = line.slice(6);
            try {
              const parsed = JSON.parse(data) as AnthropicStreamEvent;

              switch (parsed.type) {
                case "content_block_delta":
                  if (parsed.delta?.type === "text_delta") {
                    const text = parsed.delta.text || "";
                    fullContent += text;
                    onChunk(text);
                  }
                  break;
                case "message_delta":
                  if (parsed.usage) {
                    usage.completionTokens = parsed.usage.output_tokens || 0;
                    usage.totalTokens = usage.promptTokens + usage.completionTokens;
                  }
                  break;
                case "message_start":
                  if (parsed.message?.model) {
                    model = parsed.message.model;
                  }
                  if (parsed.message?.usage) {
                    usage.promptTokens = parsed.message.usage.input_tokens || 0;
                  }
                  break;
              }
            } catch {
              // Skip malformed JSON
            }
          }
        }
      }
    } finally {
      reader.releaseLock();
    }

    return {
      id: this.generateId(),
      requestId: request.id,
      tier: "premium",
      provider: "anthropic",
      model,
      content: fullContent,
      usage,
      cost: this.calculateCost(usage),
      cached: false,
      latencyMs: Date.now() - startTime,
    };
  }

  private extractSystemPrompt(messages: GatewayRequest["messages"]): {
    system: string;
    messages: AnthropicMessage[];
  } {
    let system = "";
    const anthropicMessages: AnthropicMessage[] = [];

    for (const msg of messages) {
      if (msg.role === "system") {
        // Handle both string and block-based content for system prompts
        const systemContent =
          typeof msg.content === "string"
            ? msg.content
            : Array.isArray(msg.content)
              ? msg.content
                  .map((block) => (block.type === "text" ? block.text || "" : ""))
                  .join("\n")
              : "";
        system += (system ? "\n\n" : "") + systemContent;
        continue;
      }

      const content = this.convertContent(msg.content);

      if (msg.role === "tool") {
        anthropicMessages.push({
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: msg.toolCallId || "",
              content: typeof msg.content === "string" ? msg.content : content,
            },
          ],
        });
      } else if (msg.role === "assistant" && msg.toolCalls) {
        anthropicMessages.push({
          role: "assistant",
          content: [
            ...content,
            ...msg.toolCalls.map((tc) => ({
              type: "tool_use" as const,
              id: tc.id,
              name: tc.function.name,
              input:
                typeof tc.function.arguments === "string"
                  ? JSON.parse(tc.function.arguments)
                  : tc.function.arguments,
            })),
          ],
        });
      } else {
        anthropicMessages.push({
          role: msg.role,
          content,
        });
      }
    }

    return { system, messages: anthropicMessages };
  }

  private convertContent(
    content:
      | string
      | Array<{
          type: string;
          text?: string;
          source?: { type: string; media_type: string; data: string };
        }>,
  ) {
    if (typeof content === "string") {
      return [{ type: "text" as const, text: content }];
    }

    return content
      .map((block) => {
        if (block.type === "text") {
          return { type: "text" as const, text: block.text || "" };
        }
        if (block.type === "image" && block.source) {
          return {
            type: "image" as const,
            source: {
              type: block.source.type,
              media_type: block.source.media_type,
              data: block.source.data,
            },
          };
        }
        return null;
      })
      .filter(Boolean);
  }

  private convertTools(tools?: GatewayRequest["tools"]) {
    if (!tools) {
      return undefined;
    }
    return tools.map((tool) => ({
      name: tool.function.name,
      description: tool.function.description,
      input_schema: tool.function.parameters || {},
    }));
  }
}

// Type definitions for Groq API
interface GroqMessage {
  role: string;
  content: string;
  name?: string;
  tool_calls?: GroqToolCall[];
  tool_call_id?: string;
}

interface GroqToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

interface GroqResponse {
  id: string;
  model: string;
  choices: Array<{
    message: {
      role: string;
      content?: string;
      tool_calls?: GroqToolCall[];
    };
    finish_reason: string;
  }>;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

interface GroqStreamChunk {
  id: string;
  model: string;
  choices: Array<{
    delta: { content?: string; role?: string };
    finish_reason?: string;
  }>;
  x_groq?: {
    usage?: {
      prompt_tokens: number;
      completion_tokens: number;
      total_tokens: number;
    };
  };
}

// Type definitions for Anthropic API
interface AnthropicMessage {
  role: "user" | "assistant";
  content: Array<
    | { type: "text"; text: string }
    | { type: "image"; source: { type: string; media_type: string; data: string } }
    | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
    | { type: "tool_result"; tool_use_id: string; content: string | unknown[] }
  >;
}

interface AnthropicResponse {
  id: string;
  model: string;
  type: "message";
  role: "assistant";
  content: Array<
    | { type: "text"; text: string }
    | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
  >;
  usage?: {
    input_tokens: number;
    output_tokens: number;
  };
}

interface AnthropicStreamEvent {
  type: string;
  index?: number;
  delta?: { type: string; text?: string };
  message?: {
    model?: string;
    usage?: { input_tokens?: number };
  };
  usage?: { output_tokens?: number };
}
