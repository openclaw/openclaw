import { randomUUID } from "node:crypto";
import type { loadConfig } from "../config/config.js";
import { loadOpenClawPlugins } from "../plugins/loader.js";
import { getPluginRuntimeGatewayRequestScope } from "../plugins/runtime/gateway-request-scope.js";
import type {
  PluginAgentInvokeReplyTagMetadata,
  PluginAgentInvokeRuntimeResult,
  PluginRuntime,
} from "../plugins/runtime/types.js";
import { parseInlineDirectives } from "../utils/directive-tags.js";
import { GATEWAY_CLIENT_IDS, GATEWAY_CLIENT_MODES } from "./protocol/client-info.js";
import type { ErrorShape } from "./protocol/index.js";
import { PROTOCOL_VERSION } from "./protocol/index.js";
import { handleGatewayRequest } from "./server-methods.js";
import type {
  GatewayRequestContext,
  GatewayRequestHandler,
  GatewayRequestOptions,
} from "./server-methods/types.js";

// ── Fallback gateway context for non-WS paths (Telegram, WhatsApp, etc.) ──
// The WS path sets a per-request scope via AsyncLocalStorage, but channel
// adapters (Telegram polling, etc.) invoke the agent directly without going
// through handleGatewayRequest. We store the gateway context at startup so
// dispatchGatewayMethod can use it as a fallback.

const FALLBACK_GATEWAY_CONTEXT_STATE_KEY: unique symbol = Symbol.for(
  "openclaw.fallbackGatewayContextState",
);

type FallbackGatewayContextState = {
  context: GatewayRequestContext | undefined;
};

const fallbackGatewayContextState = (() => {
  const globalState = globalThis as typeof globalThis & {
    [FALLBACK_GATEWAY_CONTEXT_STATE_KEY]?: FallbackGatewayContextState;
  };
  const existing = globalState[FALLBACK_GATEWAY_CONTEXT_STATE_KEY];
  if (existing) {
    return existing;
  }
  const created: FallbackGatewayContextState = { context: undefined };
  globalState[FALLBACK_GATEWAY_CONTEXT_STATE_KEY] = created;
  return created;
})();

export function setFallbackGatewayContext(ctx: GatewayRequestContext): void {
  // TODO: This startup snapshot can become stale if runtime config/context changes.
  fallbackGatewayContextState.context = ctx;
}

// ── Internal gateway dispatch for plugin runtime ────────────────────

function createSyntheticOperatorClient(): GatewayRequestOptions["client"] {
  return {
    connect: {
      minProtocol: PROTOCOL_VERSION,
      maxProtocol: PROTOCOL_VERSION,
      client: {
        id: GATEWAY_CLIENT_IDS.GATEWAY_CLIENT,
        version: "internal",
        platform: "node",
        mode: GATEWAY_CLIENT_MODES.BACKEND,
      },
      role: "operator",
      scopes: ["operator.admin", "operator.approvals", "operator.pairing"],
    },
  };
}

async function dispatchGatewayMethod<T>(
  method: string,
  params: Record<string, unknown>,
): Promise<T> {
  const scope = getPluginRuntimeGatewayRequestScope();
  const context = scope?.context ?? fallbackGatewayContextState.context;
  const isWebchatConnect = scope?.isWebchatConnect ?? (() => false);
  if (!context) {
    throw new Error(
      `Plugin subagent dispatch requires a gateway request scope (method: ${method}). No scope set and no fallback context available.`,
    );
  }

  let result: { ok: boolean; payload?: unknown; error?: ErrorShape } | undefined;
  await handleGatewayRequest({
    req: {
      type: "req",
      id: `plugin-subagent-${randomUUID()}`,
      method,
      params,
    },
    client: createSyntheticOperatorClient(),
    isWebchatConnect,
    respond: (ok, payload, error) => {
      if (!result) {
        result = { ok, payload, error };
      }
    },
    context,
  });

  if (!result) {
    throw new Error(`Gateway method "${method}" completed without a response.`);
  }
  if (!result.ok) {
    throw new Error(result.error?.message ?? `Gateway method "${method}" failed.`);
  }
  return result.payload as T;
}

function createGatewaySubagentRuntime(): PluginRuntime["subagent"] {
  const getSessionMessages: PluginRuntime["subagent"]["getSessionMessages"] = async (params) => {
    const payload = await dispatchGatewayMethod<{ messages?: unknown[] }>("sessions.get", {
      key: params.sessionKey,
      ...(params.limit != null && { limit: params.limit }),
    });
    return { messages: Array.isArray(payload?.messages) ? payload.messages : [] };
  };

  /**
   * Convert messages array to a single prompt string for the subagent.
   */
  const messagesToPrompt = (messages?: Array<{ role: string; content: string }>): string => {
    if (!messages || messages.length === 0) {
      return "";
    }
    const userMsg = messages.find((m) => m.role === "user");
    if (userMsg) {
      return userMsg.content;
    }
    return messages.map((m) => `${m.role}: ${m.content}`).join("\n");
  };

  const toAgentScopedSessionKey = (agentId: string, sessionKey?: string): string | undefined => {
    const raw = sessionKey?.trim();
    if (!raw) {
      return undefined;
    }
    if (raw.startsWith("agent:")) {
      return raw;
    }
    return `agent:${agentId}:${raw}`;
  };

  const ensureInvokeSessionKey = (
    agentId: string,
    sessionKey: string | undefined,
    idempotencyKey: string,
  ): string => {
    const scoped = toAgentScopedSessionKey(agentId, sessionKey);
    if (scoped) {
      return scoped;
    }
    return `agent:${agentId}:plugin-invoke:${idempotencyKey}`;
  };

  const normalizeMessageContent = (content: unknown): string => {
    if (typeof content === "string") {
      return content;
    }
    if (Array.isArray(content)) {
      return content
        .map((block) => {
          if (typeof block === "string") {
            return block;
          }
          if (!block || typeof block !== "object") {
            return "";
          }
          const record = block as Record<string, unknown>;
          if (record.type === "text" && typeof record.text === "string") {
            return record.text;
          }
          if (typeof record.text === "string") {
            return record.text;
          }
          if (typeof record.content === "string") {
            return record.content;
          }
          return "";
        })
        .filter(Boolean)
        .join("\n");
    }
    if (content == null) {
      return "";
    }
    try {
      return JSON.stringify(content);
    } catch {
      return "";
    }
  };

  const extractReplyTagMetadata = (
    text: string,
  ): { content: string; replyTag: PluginAgentInvokeReplyTagMetadata } => {
    const parsed = parseInlineDirectives(text, {
      stripReplyTags: true,
      stripAudioTag: false,
    });
    return {
      content: parsed.text,
      replyTag: {
        hasReplyTag: parsed.hasReplyTag,
        replyToId: parsed.replyToId,
        replyToCurrent: parsed.replyToCurrent,
      },
    };
  };

  const extractContentFromMessages = (
    messages: unknown[],
  ): { content: string; replyTag: PluginAgentInvokeReplyTagMetadata } => {
    if (!messages || messages.length === 0) {
      return {
        content: "",
        replyTag: { hasReplyTag: false, replyToCurrent: false },
      };
    }
    const asRecords = messages as Array<Record<string, unknown>>;
    const assistantMsgs = asRecords.filter((m) => m?.role === "assistant" || m?.role === "agent");
    if (assistantMsgs.length > 0) {
      const lastAssistant = assistantMsgs[assistantMsgs.length - 1];
      return extractReplyTagMetadata(normalizeMessageContent(lastAssistant?.content));
    }
    const lastMsg = asRecords[asRecords.length - 1];
    return extractReplyTagMetadata(normalizeMessageContent(lastMsg?.content));
  };

  return {
    async run(params) {
      const payload = await dispatchGatewayMethod<{ runId?: string }>("agent", {
        sessionKey: params.sessionKey,
        message: params.message,
        deliver: params.deliver ?? false,
        ...(params.extraSystemPrompt && { extraSystemPrompt: params.extraSystemPrompt }),
        ...(params.lane && { lane: params.lane }),
        ...(params.idempotencyKey && { idempotencyKey: params.idempotencyKey }),
      });
      const runId = payload?.runId;
      if (typeof runId !== "string" || !runId) {
        throw new Error("Gateway agent method returned an invalid runId.");
      }
      return { runId };
    },
    async waitForRun(params) {
      const payload = await dispatchGatewayMethod<{ status?: string; error?: string }>(
        "agent.wait",
        {
          runId: params.runId,
          ...(params.timeoutMs != null && { timeoutMs: params.timeoutMs }),
        },
      );
      const status = payload?.status;
      if (status !== "ok" && status !== "error" && status !== "timeout") {
        throw new Error(`Gateway agent.wait returned unexpected status: ${status}`);
      }
      return {
        status,
        ...(typeof payload?.error === "string" && payload.error && { error: payload.error }),
      };
    },
    getSessionMessages,
    async getSession(params) {
      return getSessionMessages(params);
    },
    async deleteSession(params) {
      await dispatchGatewayMethod("sessions.delete", {
        key: params.sessionKey,
        deleteTranscript: params.deleteTranscript ?? true,
      });
    },
    /**
     * Invoke an agent directly (non-streaming) via the plugin API.
     * Uses the gateway's agent method with deliver=false to avoid channel ambiguity.
     */
    async invokeAgent(params): Promise<PluginAgentInvokeRuntimeResult> {
      const agentId = params.agentId?.trim() || "kiki";
      const message = params.prompt || messagesToPrompt(params.messages);
      const timeoutMs = params.timeoutSeconds ? params.timeoutSeconds * 1000 : undefined;
      const idempotencyKey = params.idempotencyKey || `plugin-invoke:${randomUUID()}`;
      const sessionKey = ensureInvokeSessionKey(agentId, params.sessionKey, idempotencyKey);

      if (!message) {
        return { success: false, error: "No message or prompt provided" };
      }

      try {
        // Use the agent gateway method with deliver=false
        const runPayload = await dispatchGatewayMethod<{ runId?: string; sessionKey?: string }>(
          "agent",
          {
            sessionKey,
            message,
            agentId,
            idempotencyKey,
            deliver: false, // Avoid channel ambiguity
          },
        );

        const runId = runPayload?.runId;
        const resultSessionKey = runPayload?.sessionKey || sessionKey;

        if (!runId) {
          return { success: false, error: "Failed to get runId from agent invocation" };
        }

        // Wait for the agent to complete
        const waitPayload = await dispatchGatewayMethod<{ status?: string; error?: string }>(
          "agent.wait",
          {
            runId,
            timeoutMs,
          },
        );

        if (waitPayload?.status === "error") {
          return {
            success: false,
            error: waitPayload.error || "Agent execution failed",
            sessionKey: resultSessionKey,
          };
        }

        if (waitPayload?.status === "timeout") {
          return {
            success: false,
            error: "Agent execution timed out",
            sessionKey: resultSessionKey,
          };
        }

        // Get the session messages to extract the response
        const sessionMsgs = await getSessionMessages({
          sessionKey: resultSessionKey,
          limit: 20,
        });

        const { content, replyTag } = extractContentFromMessages(sessionMsgs.messages || []);

        return {
          success: true,
          content,
          messages: sessionMsgs.messages,
          sessionKey: resultSessionKey,
          replyTag,
        };
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        return { success: false, error: `Agent invocation failed: ${error}` };
      }
    },
    /**
     * Invoke an agent with streaming response via the plugin API.
     * Returns a ReadableStream that emits SSE-compatible chunks.
     */
    async invokeAgentStream(params): Promise<ReadableStream<Uint8Array>> {
      const encoder = new TextEncoder();
      let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
      let cancelled = false;

      const stream = new ReadableStream<Uint8Array>({
        start(c) {
          controller = c;
        },
        cancel() {
          cancelled = true;
        },
      });

      // Run the invocation asynchronously
      void (async () => {
        let streamController = controller;
        try {
          const agentId = params.agentId?.trim() || "kiki";
          const message = params.prompt || messagesToPrompt(params.messages);
          const timeoutMs = params.timeoutSeconds ? params.timeoutSeconds * 1000 : undefined;
          const idempotencyKey = params.idempotencyKey || `plugin-invoke:${randomUUID()}`;
          const sessionKey = ensureInvokeSessionKey(agentId, params.sessionKey, idempotencyKey);

          if (!message) {
            const errorChunk = encoder.encode(
              `data: ${JSON.stringify({ error: { message: "No message or prompt provided" } })}\n\n`,
            );
            streamController?.enqueue(errorChunk);
            streamController?.close();
            return;
          }

          // Use session mode to allow polling for updates
          const runPayload = await dispatchGatewayMethod<{
            runId?: string;
            sessionKey?: string;
          }>("agent", {
            sessionKey,
            message,
            agentId,
            idempotencyKey,
            deliver: false, // Avoid channel ambiguity
          });

          if (!runPayload?.runId) {
            const errorChunk = encoder.encode(
              `data: ${JSON.stringify({ error: { message: "Failed to start agent" } })}\n\n`,
            );
            streamController?.enqueue(errorChunk);
            streamController?.close();
            return;
          }

          const resultSessionKey = runPayload.sessionKey || sessionKey;

          // Poll for session messages and stream them
          const pollInterval = 500;
          const maxPolls = Math.ceil((timeoutMs || 60000) / pollInterval);
          let polls = 0;
          let lastContent = "";

          while (polls < maxPolls && !cancelled) {
            await new Promise((resolve) => setTimeout(resolve, pollInterval));
            polls++;

            const sessionMsgs = await getSessionMessages({
              sessionKey: resultSessionKey,
              limit: 20,
            });

            if (sessionMsgs.messages && sessionMsgs.messages.length > 0) {
              const assistantMsgs = (sessionMsgs.messages as Array<Record<string, unknown>>).filter(
                (m) => m?.role === "assistant" || m?.role === "agent",
              );

              if (assistantMsgs.length > 0) {
                const latestMsg = assistantMsgs[assistantMsgs.length - 1];
                const { content: newContent } = extractReplyTagMetadata(
                  normalizeMessageContent(latestMsg?.content),
                );

                if (newContent !== lastContent) {
                  const delta = newContent.slice(lastContent.length);
                  if (delta) {
                    const chunk = encoder.encode(
                      `data: ${JSON.stringify({ choices: [{ delta: { content: delta } }] })}\n\n`,
                    );
                    streamController?.enqueue(chunk);
                  }
                  lastContent = newContent;
                }
              }

              // Check if we're done
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              const lastMsg = sessionMsgs.messages[sessionMsgs.messages.length - 1] as any;
              if (lastMsg?.role === "assistant" || lastMsg?.role === "agent") {
                // Give it a bit more time, then finish
                await new Promise((resolve) => setTimeout(resolve, 1000));
                const finalMsgs = await getSessionMessages({
                  sessionKey: resultSessionKey,
                  limit: 20,
                });
                const finalList = finalMsgs.messages as Array<Record<string, unknown>>;
                const finalMsg = finalList[finalList.length - 1];
                const { content: finalContent, replyTag } = extractReplyTagMetadata(
                  normalizeMessageContent(finalMsg?.content) || lastContent,
                );

                if (finalContent === lastContent) {
                  const finishChunk = encoder.encode(
                    `data: ${JSON.stringify({
                      choices: [{ delta: { finish_reason: "stop" } }],
                      ...(replyTag.hasReplyTag ? { replyTag } : {}),
                    })}\n\n`,
                  );
                  streamController?.enqueue(finishChunk);
                  streamController?.close();
                  return;
                }
              }
            }
          }

          if (cancelled) {
            return;
          }

          // Send final content
          if (lastContent) {
            const { replyTag } = extractReplyTagMetadata(lastContent);
            const chunk = encoder.encode(
              `data: ${JSON.stringify({
                choices: [{ delta: { content: lastContent, finish_reason: "stop" } }],
                ...(replyTag.hasReplyTag ? { replyTag } : {}),
              })}\n\n`,
            );
            streamController?.enqueue(chunk);
          }
          streamController?.close();
        } catch (err) {
          const error = err instanceof Error ? err.message : String(err);
          const errorChunk = encoder.encode(
            `data: ${JSON.stringify({ error: { message: `Agent invocation failed: ${error}` } })}\n\n`,
          );
          streamController?.enqueue(errorChunk);
          streamController?.close();
        }
      })();

      return stream;
    },
  };
}

// ── Plugin loading ──────────────────────────────────────────────────

export function loadGatewayPlugins(params: {
  cfg: ReturnType<typeof loadConfig>;
  workspaceDir: string;
  log: {
    info: (msg: string) => void;
    warn: (msg: string) => void;
    error: (msg: string) => void;
    debug: (msg: string) => void;
  };
  coreGatewayHandlers: Record<string, GatewayRequestHandler>;
  baseMethods: string[];
}) {
  const pluginRegistry = loadOpenClawPlugins({
    config: params.cfg,
    workspaceDir: params.workspaceDir,
    logger: {
      info: (msg) => params.log.info(msg),
      warn: (msg) => params.log.warn(msg),
      error: (msg) => params.log.error(msg),
      debug: (msg) => params.log.debug(msg),
    },
    coreGatewayHandlers: params.coreGatewayHandlers,
    runtimeOptions: {
      subagent: createGatewaySubagentRuntime(),
    },
  });
  const pluginMethods = Object.keys(pluginRegistry.gatewayHandlers);
  const gatewayMethods = Array.from(new Set([...params.baseMethods, ...pluginMethods]));
  if (pluginRegistry.diagnostics.length > 0) {
    for (const diag of pluginRegistry.diagnostics) {
      const details = [
        diag.pluginId ? `plugin=${diag.pluginId}` : null,
        diag.source ? `source=${diag.source}` : null,
      ]
        .filter((entry): entry is string => Boolean(entry))
        .join(", ");
      const message = details
        ? `[plugins] ${diag.message} (${details})`
        : `[plugins] ${diag.message}`;
      if (diag.level === "error") {
        params.log.error(message);
      } else {
        params.log.info(message);
      }
    }
  }
  return { pluginRegistry, gatewayMethods };
}
