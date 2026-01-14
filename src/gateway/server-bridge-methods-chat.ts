import { randomUUID } from "node:crypto";
import { resolveThinkingDefault } from "../agents/model-selection.js";
import { resolveAgentTimeoutMs } from "../agents/timeout.js";
import { agentCommand } from "../commands/agent.js";
import { mergeSessionEntry, saveSessionStore } from "../config/sessions.js";
import { registerAgentRunContext } from "../infra/agent-events.js";
import { defaultRuntime } from "../runtime.js";
import {
  abortChatRunById,
  abortChatRunsForSessionKey,
  isChatStopCommandText,
  resolveChatRunExpiresAtMs,
} from "./chat-abort.js";
import { type ChatImageContent, parseMessageWithAttachments } from "./chat-attachments.js";
import {
  ErrorCodes,
  errorShape,
  formatValidationErrors,
  validateChatAbortParams,
  validateChatHistoryParams,
  validateChatSendParams,
} from "./protocol/index.js";
import type { BridgeMethodHandler } from "./server-bridge-types.js";
import { MAX_CHAT_HISTORY_MESSAGES_BYTES } from "./server-constants.js";
import {
  capArrayByJsonBytes,
  loadSessionEntry,
  readSessionMessages,
  resolveSessionModelRef,
} from "./session-utils.js";

export const handleChatBridgeMethods: BridgeMethodHandler = async (ctx, nodeId, method, params) => {
  switch (method) {
    case "chat.history": {
      if (!validateChatHistoryParams(params)) {
        return {
          ok: false,
          error: {
            code: ErrorCodes.INVALID_REQUEST,
            message: `invalid chat.history params: ${formatValidationErrors(validateChatHistoryParams.errors)}`,
          },
        };
      }
      const { sessionKey, limit } = params as {
        sessionKey: string;
        limit?: number;
      };
      const { cfg, storePath, entry } = loadSessionEntry(sessionKey);
      const sessionId = entry?.sessionId;
      const rawMessages =
        sessionId && storePath ? readSessionMessages(sessionId, storePath, entry?.sessionFile) : [];
      const max = typeof limit === "number" ? limit : 200;
      const sliced = rawMessages.length > max ? rawMessages.slice(-max) : rawMessages;
      const capped = capArrayByJsonBytes(sliced, MAX_CHAT_HISTORY_MESSAGES_BYTES).items;
      let thinkingLevel = entry?.thinkingLevel;
      if (!thinkingLevel) {
        const configured = cfg.agents?.defaults?.thinkingDefault;
        if (configured) {
          thinkingLevel = configured;
        } else {
          const { provider, model } = resolveSessionModelRef(cfg, entry);
          const catalog = await ctx.loadGatewayModelCatalog();
          thinkingLevel = resolveThinkingDefault({
            cfg,
            provider,
            model,
            catalog,
          });
        }
      }
      return {
        ok: true,
        payloadJSON: JSON.stringify({
          sessionKey,
          sessionId,
          messages: capped,
          thinkingLevel,
        }),
      };
    }
    case "chat.abort": {
      if (!validateChatAbortParams(params)) {
        return {
          ok: false,
          error: {
            code: ErrorCodes.INVALID_REQUEST,
            message: `invalid chat.abort params: ${formatValidationErrors(validateChatAbortParams.errors)}`,
          },
        };
      }

      const { sessionKey, runId } = params as {
        sessionKey: string;
        runId?: string;
      };
      const ops = {
        chatAbortControllers: ctx.chatAbortControllers,
        chatRunBuffers: ctx.chatRunBuffers,
        chatDeltaSentAt: ctx.chatDeltaSentAt,
        chatAbortedRuns: ctx.chatAbortedRuns,
        removeChatRun: ctx.removeChatRun,
        agentRunSeq: ctx.agentRunSeq,
        broadcast: ctx.broadcast,
        bridgeSendToSession: ctx.bridgeSendToSession,
      };
      if (!runId) {
        const res = abortChatRunsForSessionKey(ops, {
          sessionKey,
          stopReason: "rpc",
        });
        return {
          ok: true,
          payloadJSON: JSON.stringify({
            ok: true,
            aborted: res.aborted,
            runIds: res.runIds,
          }),
        };
      }
      const active = ctx.chatAbortControllers.get(runId);
      if (!active) {
        return {
          ok: true,
          payloadJSON: JSON.stringify({
            ok: true,
            aborted: false,
            runIds: [],
          }),
        };
      }
      if (active.sessionKey !== sessionKey) {
        return {
          ok: false,
          error: {
            code: ErrorCodes.INVALID_REQUEST,
            message: "runId does not match sessionKey",
          },
        };
      }
      const res = abortChatRunById(ops, {
        runId,
        sessionKey,
        stopReason: "rpc",
      });
      return {
        ok: true,
        payloadJSON: JSON.stringify({
          ok: true,
          aborted: res.aborted,
          runIds: res.aborted ? [runId] : [],
        }),
      };
    }
    case "chat.send": {
      if (!validateChatSendParams(params)) {
        return {
          ok: false,
          error: {
            code: ErrorCodes.INVALID_REQUEST,
            message: `invalid chat.send params: ${formatValidationErrors(validateChatSendParams.errors)}`,
          },
        };
      }

      const p = params as {
        sessionKey: string;
        message: string;
        thinking?: string;
        deliver?: boolean;
        attachments?: Array<{
          type?: string;
          mimeType?: string;
          fileName?: string;
          content?: unknown;
        }>;
        timeoutMs?: number;
        idempotencyKey: string;
      };
      const stopCommand = isChatStopCommandText(p.message);
      const normalizedAttachments =
        p.attachments
          ?.map((a) => ({
            type: typeof a?.type === "string" ? a.type : undefined,
            mimeType: typeof a?.mimeType === "string" ? a.mimeType : undefined,
            fileName: typeof a?.fileName === "string" ? a.fileName : undefined,
            content:
              typeof a?.content === "string"
                ? a.content
                : ArrayBuffer.isView(a?.content)
                  ? Buffer.from(
                      a.content.buffer,
                      a.content.byteOffset,
                      a.content.byteLength,
                    ).toString("base64")
                  : undefined,
          }))
          .filter((a) => a.content) ?? [];

      let parsedMessage = p.message;
      let parsedImages: ChatImageContent[] = [];
      if (normalizedAttachments.length > 0) {
        try {
          const parsed = await parseMessageWithAttachments(p.message, normalizedAttachments, {
            maxBytes: 5_000_000,
            log: ctx.logBridge,
          });
          parsedMessage = parsed.message;
          parsedImages = parsed.images;
        } catch (err) {
          return {
            ok: false,
            error: {
              code: ErrorCodes.INVALID_REQUEST,
              message: String(err),
            },
          };
        }
      }

      const { cfg, storePath, store, entry, canonicalKey } = loadSessionEntry(p.sessionKey);
      const timeoutMs = resolveAgentTimeoutMs({
        cfg,
        overrideMs: p.timeoutMs,
      });
      const now = Date.now();
      const sessionId = entry?.sessionId ?? randomUUID();
      const sessionEntry = mergeSessionEntry(entry, {
        sessionId,
        updatedAt: now,
      });
      const clientRunId = p.idempotencyKey;
      registerAgentRunContext(clientRunId, { sessionKey: p.sessionKey });

      if (stopCommand) {
        const res = abortChatRunsForSessionKey(
          {
            chatAbortControllers: ctx.chatAbortControllers,
            chatRunBuffers: ctx.chatRunBuffers,
            chatDeltaSentAt: ctx.chatDeltaSentAt,
            chatAbortedRuns: ctx.chatAbortedRuns,
            removeChatRun: ctx.removeChatRun,
            agentRunSeq: ctx.agentRunSeq,
            broadcast: ctx.broadcast,
            bridgeSendToSession: ctx.bridgeSendToSession,
          },
          { sessionKey: p.sessionKey, stopReason: "stop" },
        );
        return {
          ok: true,
          payloadJSON: JSON.stringify({
            ok: true,
            aborted: res.aborted,
            runIds: res.runIds,
          }),
        };
      }

      const cached = ctx.dedupe.get(`chat:${clientRunId}`);
      if (cached) {
        if (cached.ok) {
          return { ok: true, payloadJSON: JSON.stringify(cached.payload) };
        }
        return {
          ok: false,
          error: cached.error ?? {
            code: ErrorCodes.UNAVAILABLE,
            message: "request failed",
          },
        };
      }

      const activeExisting = ctx.chatAbortControllers.get(clientRunId);
      if (activeExisting) {
        return {
          ok: true,
          payloadJSON: JSON.stringify({
            runId: clientRunId,
            status: "in_flight",
          }),
        };
      }

      try {
        const abortController = new AbortController();
        ctx.chatAbortControllers.set(clientRunId, {
          controller: abortController,
          sessionId,
          sessionKey: p.sessionKey,
          startedAtMs: now,
          expiresAtMs: resolveChatRunExpiresAtMs({ now, timeoutMs }),
        });
        ctx.addChatRun(clientRunId, {
          sessionKey: p.sessionKey,
          clientRunId,
        });

        if (store) {
          store[canonicalKey] = sessionEntry;
          if (storePath) {
            await saveSessionStore(storePath, store);
          }
        }

        const ackPayload = {
          runId: clientRunId,
          status: "started" as const,
        };
        void agentCommand(
          {
            message: parsedMessage,
            images: parsedImages.length > 0 ? parsedImages : undefined,
            sessionId,
            sessionKey: p.sessionKey,
            runId: clientRunId,
            thinking: p.thinking,
            deliver: p.deliver,
            timeout: Math.ceil(timeoutMs / 1000).toString(),
            messageChannel: `node(${nodeId})`,
            abortSignal: abortController.signal,
          },
          defaultRuntime,
          ctx.deps,
        )
          .then(() => {
            ctx.dedupe.set(`chat:${clientRunId}`, {
              ts: Date.now(),
              ok: true,
              payload: { runId: clientRunId, status: "ok" as const },
            });
          })
          .catch((err) => {
            const error = errorShape(ErrorCodes.UNAVAILABLE, String(err));
            ctx.dedupe.set(`chat:${clientRunId}`, {
              ts: Date.now(),
              ok: false,
              payload: {
                runId: clientRunId,
                status: "error" as const,
                summary: String(err),
              },
              error,
            });
          })
          .finally(() => {
            ctx.chatAbortControllers.delete(clientRunId);
          });

        return { ok: true, payloadJSON: JSON.stringify(ackPayload) };
      } catch (err) {
        const error = errorShape(ErrorCodes.UNAVAILABLE, String(err));
        const payload = {
          runId: clientRunId,
          status: "error" as const,
          summary: String(err),
        };
        ctx.dedupe.set(`chat:${clientRunId}`, {
          ts: Date.now(),
          ok: false,
          payload,
          error,
        });
        return {
          ok: false,
          error: error ?? {
            code: ErrorCodes.UNAVAILABLE,
            message: String(err),
          },
        };
      }
    }
    default:
      return null;
  }
};
