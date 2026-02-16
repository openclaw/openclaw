/**
 * Copilot SDK stream adapter for pi-ai.
 *
 * Replaces the default pi-ai streamSimple path for `github-copilot` models.
 * Instead of going through pi-ai → Anthropic/OpenAI SDK → copilot-proxy,
 * this uses the official @github/copilot-sdk which bundles the Copilot CLI.
 * The CLI handles rate-limit retries (jittered backoff, `retry-after` header
 * parsing) at the HTTP transport layer — something the higher-level SDKs
 * can't do.
 */

import type {
  AssistantMessage,
  Api,
  Context,
  Model,
  SimpleStreamOptions,
  StreamFunction,
  TextContent,
  ThinkingContent,
  ToolCall,
  AssistantMessageEventStream,
} from "@mariozechner/pi-ai";
import { CopilotClient, type CopilotSession, type SessionEvent } from "@github/copilot-sdk";

// We need the concrete class at runtime for `new AssistantMessageEventStream()`.
// pi-ai only exports the type; import the implementation directly.
// eslint-disable-next-line
const { AssistantMessageEventStream: EventStreamClass } =
  (await import("@mariozechner/pi-ai/dist/utils/event-stream.js")) as {
    AssistantMessageEventStream: new () => AssistantMessageEventStream;
  };

// ---------------------------------------------------------------------------
// Singleton client management
// ---------------------------------------------------------------------------

let sharedClient: CopilotClient | null = null;
let clientRefCount = 0;

function getOrCreateClient(githubToken?: string): CopilotClient {
  if (!sharedClient) {
    sharedClient = new CopilotClient({
      useStdio: true,
      autoStart: true,
      autoRestart: true,
      logLevel: "warning",
      ...(githubToken ? { githubToken, useLoggedInUser: false } : { useLoggedInUser: true }),
    });
  }
  clientRefCount++;
  return sharedClient;
}

/**
 * Gracefully release the shared client when the last consumer is done.
 * Callers should not await this — it's fire-and-forget cleanup.
 */
export function releaseClient(): void {
  clientRefCount = Math.max(0, clientRefCount - 1);
  if (clientRefCount === 0 && sharedClient) {
    const c = sharedClient;
    sharedClient = null;
    c.stop().catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// System prompt + message conversion
// ---------------------------------------------------------------------------

function contextToPrompt(context: Context): string {
  const parts: string[] = [];
  for (const msg of context.messages) {
    if (msg.role === "user") {
      const text =
        typeof msg.content === "string"
          ? msg.content
          : msg.content
              .filter((c): c is { type: "text"; text: string } => c.type === "text")
              .map((c) => c.text)
              .join("\n");
      if (text) {
        parts.push(text);
      }
    }
  }
  // The last user message is the actual prompt; earlier ones are context.
  return parts.at(-1) ?? "";
}

// ---------------------------------------------------------------------------
// Event translation: Copilot SDK SessionEvent → pi-ai AssistantMessageEvent
// ---------------------------------------------------------------------------

function createEmptyOutput(model: Model<Api>): AssistantMessage {
  return {
    role: "assistant",
    content: [],
    api: model.api,
    provider: model.provider ?? "github-copilot",
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
}

// ---------------------------------------------------------------------------
// The stream function
// ---------------------------------------------------------------------------

/**
 * Create a pi-ai-compatible StreamFunction backed by the Copilot SDK.
 *
 * @param githubToken Optional GitHub token. When omitted the SDK will try
 *   `gh` CLI auth or env vars automatically.
 */
export function createCopilotSdkStreamFn(githubToken?: string): StreamFunction {
  const client = getOrCreateClient(githubToken);

  return (model: Model<Api>, context: Context, options?: SimpleStreamOptions) => {
    const stream = new EventStreamClass();
    const output = createEmptyOutput(model);

    // Track content indices for pi-ai events
    let textContentIndex = -1;
    let thinkingContentIndex = -1;
    let currentTextContent: TextContent | null = null;
    let currentThinkingContent: ThinkingContent | null = null;

    // Keep track of tool call mapping (SDK toolCallId → content index)
    const toolCallIndices = new Map<string, number>();

    void (async () => {
      let session: CopilotSession | null = null;
      try {
        // Determine model ID — strip the `github-copilot/` prefix if present.
        const modelId = model.id.includes("/") ? model.id.split("/").pop()! : model.id;

        session = await client.createSession({
          model: modelId,
          systemMessage: context.systemPrompt
            ? { mode: "replace", content: context.systemPrompt }
            : undefined,
          streaming: true,
          // Disable infinite sessions — OpenClaw manages its own session/compaction.
          infiniteSessions: { enabled: false },
          // Disable built-in tools — OpenClaw provides its own.
          availableTools: [],
        });

        const prompt = contextToPrompt(context);
        if (!prompt) {
          output.stopReason = "stop";
          stream.push({ type: "done", reason: "stop", message: output });
          stream.end();
          return;
        }

        // Emit start
        stream.push({ type: "start", partial: output });

        // Subscribe to session events and translate to pi-ai events
        session.on((event: SessionEvent) => {
          switch (event.type) {
            case "assistant.message_delta": {
              // Streaming text delta
              if (!currentTextContent) {
                currentTextContent = { type: "text", text: "" };
                output.content.push(currentTextContent);
                textContentIndex = output.content.length - 1;
                stream.push({
                  type: "text_start",
                  contentIndex: textContentIndex,
                  partial: output,
                });
              }
              currentTextContent.text += event.data.deltaContent;
              stream.push({
                type: "text_delta",
                contentIndex: textContentIndex,
                delta: event.data.deltaContent,
                partial: output,
              });
              break;
            }

            case "assistant.reasoning_delta": {
              // Streaming thinking delta
              if (!currentThinkingContent) {
                currentThinkingContent = { type: "thinking", thinking: "" };
                output.content.push(currentThinkingContent);
                thinkingContentIndex = output.content.length - 1;
                stream.push({
                  type: "thinking_start",
                  contentIndex: thinkingContentIndex,
                  partial: output,
                });
              }
              currentThinkingContent.thinking += event.data.deltaContent;
              stream.push({
                type: "thinking_delta",
                contentIndex: thinkingContentIndex,
                delta: event.data.deltaContent,
                partial: output,
              });
              break;
            }

            case "assistant.reasoning": {
              // Complete thinking block (non-streamed or final)
              if (currentThinkingContent) {
                currentThinkingContent.thinking = event.data.content;
                stream.push({
                  type: "thinking_end",
                  contentIndex: thinkingContentIndex,
                  content: event.data.content,
                  partial: output,
                });
                currentThinkingContent = null;
              }
              break;
            }

            case "assistant.message": {
              // Final assistant message — finalize any open text block
              if (currentTextContent) {
                // Prefer the final content from the complete message over deltas
                const finalContent = event.data.content;
                if (finalContent && finalContent !== currentTextContent.text) {
                  currentTextContent.text = finalContent;
                }
                stream.push({
                  type: "text_end",
                  contentIndex: textContentIndex,
                  content: currentTextContent.text,
                  partial: output,
                });
                currentTextContent = null;
              } else if (event.data.content) {
                // No deltas were received — create the text block from the final message
                const tc: TextContent = { type: "text", text: event.data.content };
                output.content.push(tc);
                textContentIndex = output.content.length - 1;
                stream.push({
                  type: "text_start",
                  contentIndex: textContentIndex,
                  partial: output,
                });
                stream.push({
                  type: "text_end",
                  contentIndex: textContentIndex,
                  content: tc.text,
                  partial: output,
                });
              }

              // Handle tool requests
              if (event.data.toolRequests) {
                for (const req of event.data.toolRequests) {
                  const toolCall: ToolCall = {
                    type: "toolCall",
                    id: req.toolCallId,
                    name: req.name,
                    arguments:
                      typeof req.arguments === "string"
                        ? JSON.parse(req.arguments)
                        : ((req.arguments as Record<string, unknown>) ?? {}),
                  };
                  output.content.push(toolCall);
                  const idx = output.content.length - 1;
                  toolCallIndices.set(req.toolCallId, idx);
                  stream.push({ type: "toolcall_start", contentIndex: idx, partial: output });
                  stream.push({
                    type: "toolcall_end",
                    contentIndex: idx,
                    toolCall,
                    partial: output,
                  });
                }
                output.stopReason = "toolUse";
              }
              break;
            }

            case "assistant.usage": {
              // Update usage stats
              output.usage = {
                input: event.data.inputTokens ?? 0,
                output: event.data.outputTokens ?? 0,
                cacheRead: event.data.cacheReadTokens ?? 0,
                cacheWrite: event.data.cacheWriteTokens ?? 0,
                totalTokens:
                  (event.data.inputTokens ?? 0) +
                  (event.data.outputTokens ?? 0) +
                  (event.data.cacheReadTokens ?? 0),
                cost: {
                  input: 0,
                  output: 0,
                  cacheRead: 0,
                  cacheWrite: 0,
                  total: event.data.cost ?? 0,
                },
              };
              // Use server-reported model if available
              if (event.data.model) {
                output.model = event.data.model;
              }
              break;
            }

            case "session.error": {
              output.stopReason = "error";
              output.errorMessage = event.data.message;
              stream.push({ type: "error", reason: "error", error: output });
              stream.end();
              break;
            }

            default:
              // Ignore other events (tool execution, session lifecycle, etc.)
              break;
          }
        });

        // Send the prompt and wait for idle
        await session.sendAndWait(
          { prompt },
          options?.signal ? undefined : 5 * 60 * 1000, // 5 min default timeout
        );

        // Finalize
        if (output.stopReason !== "error") {
          const reason = output.stopReason === "toolUse" ? "toolUse" : "stop";
          output.stopReason = reason;
          stream.push({ type: "done", reason, message: output });
        }
        stream.end();
      } catch (err) {
        output.stopReason = "error";
        output.errorMessage = err instanceof Error ? err.message : String(err);
        stream.push({ type: "error", reason: "error", error: output });
        stream.end();
      } finally {
        // Destroy the session to free resources — OpenClaw manages its own sessions.
        if (session) {
          session.destroy().catch(() => {});
        }
      }
    })();

    return stream;
  };
}
