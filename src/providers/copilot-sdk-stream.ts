/**
 * Copilot SDK stream adapter for pi-ai.
 *
 * Replaces the default pi-ai streamSimple path for `github-copilot` models.
 * Instead of going through pi-ai → Anthropic/OpenAI SDK → copilot-proxy,
 * this uses the official @github/copilot-sdk which bundles the Copilot CLI.
 * The CLI handles rate-limit retries (jittered backoff, `retry-after` header
 * parsing) at the HTTP transport layer — something the higher-level SDKs
 * can't do.
 *
 * Additionally we use the SDK's onErrorOccurred hook to request automatic
 * retries for rate-limit and transient model_call errors, and the
 * session.error statusCode to surface structured failure reasons back to
 * OpenClaw's failover system.
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
let clientInitToken: string | undefined;
let clientStartPromise: Promise<void> | null = null;

async function getOrCreateClient(githubToken?: string): Promise<CopilotClient> {
  // If token changed, tear down old client.
  if (sharedClient && clientInitToken !== githubToken) {
    const oldClient = sharedClient;
    sharedClient = null;
    clientRefCount = 0;
    clientStartPromise = null;
    oldClient.stop().catch(() => {});
  }

  if (!sharedClient) {
    const isDebug =
      process.env.OPENCLAW_LOG_LEVEL === "debug" || process.env.DEBUG?.includes("copilot");
    sharedClient = new CopilotClient({
      useStdio: true,
      autoStart: false, // We manage startup explicitly for error recovery.
      autoRestart: true,
      logLevel: isDebug ? "debug" : "warning",
      ...(githubToken ? { githubToken, useLoggedInUser: false } : { useLoggedInUser: true }),
    });
    clientInitToken = githubToken;
    clientStartPromise = null;
  }

  // Ensure the client is started. If a previous start() failed, retry.
  if (!clientStartPromise) {
    clientStartPromise = sharedClient.start().catch((err) => {
      // Clear the cached promise so the next call retries.
      clientStartPromise = null;
      throw err;
    });
  }
  await clientStartPromise;

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
    clientInitToken = undefined;
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
// Rate-limit / error classification helpers
// ---------------------------------------------------------------------------

const RATE_LIMIT_PATTERNS = /rate.?limit|too many requests|quota|throttl|429|resource.?exhausted/i;
const TRANSIENT_PATTERNS =
  /timeout|timed.?out|overloaded|service.?unavailable|502|503|504|econnreset|epipe|socket hang up/i;

function isRateLimitError(message: string): boolean {
  return RATE_LIMIT_PATTERNS.test(message);
}

function isTransientError(message: string): boolean {
  return TRANSIENT_PATTERNS.test(message);
}

/**
 * Build a structured error message that OpenClaw's failover classifier can
 * parse. Includes the HTTP status code when the SDK provides one.
 */
function buildErrorMessage(message: string, statusCode?: number): string {
  if (statusCode) {
    return `${statusCode} ${message}`;
  }
  return message;
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
  // Client is started lazily inside the async IIFE (now async).
  return (model: Model<Api>, context: Context, options?: SimpleStreamOptions) => {
    const stream = new EventStreamClass();
    const output = createEmptyOutput(model);

    // Track content indices for pi-ai events
    let textContentIndex = -1;
    let thinkingContentIndex = -1;
    let currentTextContent: TextContent | null = null;
    let currentThinkingContent: ThinkingContent | null = null;
    let streamEnded = false;

    /** Guard: only push to the stream if it hasn't been ended yet. */
    function safePush(event: Parameters<typeof stream.push>[0]): void {
      if (!streamEnded) {
        stream.push(event);
      }
    }
    function safeEnd(): void {
      if (!streamEnded) {
        streamEnded = true;
        stream.end();
      }
    }

    void (async () => {
      let session: CopilotSession | null = null;
      try {
        const client = await getOrCreateClient(githubToken);

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
          // Permission handler — auto-approve everything (OpenClaw manages permissions).
          onPermissionRequest: async () => ({ kind: "approved" as const }),
          // Hook: automatic retry for rate-limit and transient model errors.
          // The SDK's CLI binary already retries at the HTTP layer, but this
          // catches higher-level errors that escape the transport retry loop.
          hooks: {
            onErrorOccurred: async (input) => {
              if (input.errorContext === "model_call") {
                if (isRateLimitError(input.error)) {
                  return {
                    errorHandling: "retry" as const,
                    retryCount: 3,
                    userNotification: "Rate limit hit — retrying...",
                  };
                }
                if (isTransientError(input.error) && input.recoverable) {
                  return {
                    errorHandling: "retry" as const,
                    retryCount: 2,
                    userNotification: "Transient error — retrying...",
                  };
                }
              }
              return undefined;
            },
          },
        });

        const prompt = contextToPrompt(context);
        if (!prompt) {
          output.stopReason = "stop";
          safePush({ type: "done", reason: "stop", message: output });
          safeEnd();
          return;
        }

        // Wire abort signal — if the caller cancels, abort the SDK session.
        if (options?.signal) {
          options.signal.addEventListener(
            "abort",
            () => {
              session?.abort().catch(() => {});
            },
            { once: true },
          );
        }

        // Emit start
        safePush({ type: "start", partial: output });

        // Subscribe to session events and translate to pi-ai events
        session.on((event: SessionEvent) => {
          switch (event.type) {
            case "assistant.message_delta": {
              // Streaming text delta
              if (!currentTextContent) {
                currentTextContent = { type: "text", text: "" };
                output.content.push(currentTextContent);
                textContentIndex = output.content.length - 1;
                safePush({
                  type: "text_start",
                  contentIndex: textContentIndex,
                  partial: output,
                });
              }
              currentTextContent.text += event.data.deltaContent;
              safePush({
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
                safePush({
                  type: "thinking_start",
                  contentIndex: thinkingContentIndex,
                  partial: output,
                });
              }
              currentThinkingContent.thinking += event.data.deltaContent;
              safePush({
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
                safePush({
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
                safePush({
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
                safePush({
                  type: "text_start",
                  contentIndex: textContentIndex,
                  partial: output,
                });
                safePush({
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
                  safePush({ type: "toolcall_start", contentIndex: idx, partial: output });
                  safePush({
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
              // Build an error message that includes the status code so
              // OpenClaw's classifyFailoverReason picks it up correctly
              // (e.g. "429 rate limit exceeded" → rate_limit).
              output.stopReason = "error";
              output.errorMessage = buildErrorMessage(event.data.message, event.data.statusCode);
              safePush({ type: "error", reason: "error", error: output });
              safeEnd();
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
          safePush({ type: "done", reason, message: output });
        }
        safeEnd();
      } catch (err) {
        output.stopReason = "error";
        output.errorMessage = err instanceof Error ? err.message : String(err);
        safePush({ type: "error", reason: "error", error: output });
        safeEnd();
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
