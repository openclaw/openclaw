import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { resolveSessionAgentId, resolveAgentWorkspaceDir } from "../../agents/agent-scope.js";
import { resolveThinkingDefault } from "../../agents/model-selection.js";
import { resolveAgentTimeoutMs } from "../../agents/timeout.js";
import { ensureAgentWorkspace } from "../../agents/workspace.js";
import { isControlCommandMessage } from "../../auto-reply/command-detection.js";
import { normalizeCommandBody } from "../../auto-reply/commands-registry.js";
import { formatInboundEnvelope, resolveEnvelopeFormatOptions } from "../../auto-reply/envelope.js";
import { buildCommandContext, handleCommands } from "../../auto-reply/reply/commands.js";
import { parseInlineDirectives } from "../../auto-reply/reply/directive-handling.js";
import { defaultGroupActivation } from "../../auto-reply/reply/groups.js";
import { resolveContextTokens } from "../../auto-reply/reply/model-selection.js";
import { resolveElevatedPermissions } from "../../auto-reply/reply/reply-elevated.js";
import {
  normalizeElevatedLevel,
  normalizeReasoningLevel,
  normalizeThinkLevel,
  normalizeVerboseLevel,
} from "../../auto-reply/thinking.js";
import type { MsgContext } from "../../auto-reply/templating.js";
import { agentCommand } from "../../commands/agent.js";
import { mergeSessionEntry, updateSessionStore } from "../../config/sessions.js";
import { registerAgentRunContext } from "../../infra/agent-events.js";
import { isAcpSessionKey } from "../../routing/session-key.js";
import { defaultRuntime } from "../../runtime.js";
import { resolveSendPolicy } from "../../sessions/send-policy.js";
import { INTERNAL_MESSAGE_CHANNEL } from "../../utils/message-channel.js";
import {
  abortChatRunById,
  abortChatRunsForSessionKey,
  isChatStopCommandText,
  resolveChatRunExpiresAtMs,
} from "../chat-abort.js";
import { type ChatImageContent, parseMessageWithAttachments } from "../chat-attachments.js";
import {
  ErrorCodes,
  errorShape,
  formatValidationErrors,
  validateChatAbortParams,
  validateChatHistoryParams,
  validateChatInjectParams,
  validateChatSendParams,
} from "../protocol/index.js";
import { getMaxChatHistoryMessagesBytes } from "../server-constants.js";
import {
  capArrayByJsonBytes,
  loadSessionEntry,
  readSessionMessages,
  resolveSessionModelRef,
} from "../session-utils.js";
import { stripEnvelopeFromMessages } from "../chat-sanitize.js";
import { formatForLog } from "../ws-log.js";
import type { GatewayRequestHandlers } from "./types.js";

export const chatHandlers: GatewayRequestHandlers = {
  "chat.history": async ({ params, respond, context }) => {
    if (!validateChatHistoryParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid chat.history params: ${formatValidationErrors(validateChatHistoryParams.errors)}`,
        ),
      );
      return;
    }
    const { sessionKey, limit } = params as {
      sessionKey: string;
      limit?: number;
    };
    const { cfg, storePath, entry } = loadSessionEntry(sessionKey);
    const sessionId = entry?.sessionId;
    const rawMessages =
      sessionId && storePath ? readSessionMessages(sessionId, storePath, entry?.sessionFile) : [];
    const hardMax = 1000;
    const defaultLimit = 200;
    const requested = typeof limit === "number" ? limit : defaultLimit;
    const max = Math.min(hardMax, requested);
    const sliced = rawMessages.length > max ? rawMessages.slice(-max) : rawMessages;
    const sanitized = stripEnvelopeFromMessages(sliced);
    const capped = capArrayByJsonBytes(sanitized, getMaxChatHistoryMessagesBytes()).items;
    let thinkingLevel = entry?.thinkingLevel;
    if (!thinkingLevel) {
      const configured = cfg.agents?.defaults?.thinkingDefault;
      if (configured) {
        thinkingLevel = configured;
      } else {
        const { provider, model } = resolveSessionModelRef(cfg, entry);
        const catalog = await context.loadGatewayModelCatalog();
        thinkingLevel = resolveThinkingDefault({
          cfg,
          provider,
          model,
          catalog,
        });
      }
    }
    respond(true, {
      sessionKey,
      sessionId,
      messages: capped,
      thinkingLevel,
    });
  },
  "chat.abort": ({ params, respond, context }) => {
    if (!validateChatAbortParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid chat.abort params: ${formatValidationErrors(validateChatAbortParams.errors)}`,
        ),
      );
      return;
    }
    const { sessionKey, runId } = params as {
      sessionKey: string;
      runId?: string;
    };

    const ops = {
      chatAbortControllers: context.chatAbortControllers,
      chatRunBuffers: context.chatRunBuffers,
      chatDeltaSentAt: context.chatDeltaSentAt,
      chatAbortedRuns: context.chatAbortedRuns,
      removeChatRun: context.removeChatRun,
      agentRunSeq: context.agentRunSeq,
      broadcast: context.broadcast,
      nodeSendToSession: context.nodeSendToSession,
    };

    if (!runId) {
      const res = abortChatRunsForSessionKey(ops, {
        sessionKey,
        stopReason: "rpc",
      });
      respond(true, { ok: true, aborted: res.aborted, runIds: res.runIds });
      return;
    }

    const active = context.chatAbortControllers.get(runId);
    if (!active) {
      respond(true, { ok: true, aborted: false, runIds: [] });
      return;
    }
    if (active.sessionKey !== sessionKey) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "runId does not match sessionKey"),
      );
      return;
    }

    const res = abortChatRunById(ops, {
      runId,
      sessionKey,
      stopReason: "rpc",
    });
    respond(true, {
      ok: true,
      aborted: res.aborted,
      runIds: res.aborted ? [runId] : [],
    });
  },
  "chat.send": async ({ params, respond, context }) => {
    if (!validateChatSendParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid chat.send params: ${formatValidationErrors(validateChatSendParams.errors)}`,
        ),
      );
      return;
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
          log: context.logGateway,
        });
        parsedMessage = parsed.message;
        parsedImages = parsed.images;
      } catch (err) {
        respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, String(err)));
        return;
      }
    }
    const { cfg, storePath, entry, canonicalKey, store } = loadSessionEntry(p.sessionKey);
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
    store[canonicalKey] = sessionEntry;
    const clientRunId = p.idempotencyKey;
    registerAgentRunContext(clientRunId, { sessionKey: p.sessionKey });

    const sendPolicy = resolveSendPolicy({
      cfg,
      entry,
      sessionKey: p.sessionKey,
      channel: entry?.channel,
      chatType: entry?.chatType,
    });
    if (sendPolicy === "deny") {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "send blocked by session policy"),
      );
      return;
    }

    if (stopCommand) {
      const res = abortChatRunsForSessionKey(
        {
          chatAbortControllers: context.chatAbortControllers,
          chatRunBuffers: context.chatRunBuffers,
          chatDeltaSentAt: context.chatDeltaSentAt,
          chatAbortedRuns: context.chatAbortedRuns,
          removeChatRun: context.removeChatRun,
          agentRunSeq: context.agentRunSeq,
          broadcast: context.broadcast,
          nodeSendToSession: context.nodeSendToSession,
        },
        { sessionKey: p.sessionKey, stopReason: "stop" },
      );
      respond(true, { ok: true, aborted: res.aborted, runIds: res.runIds });
      return;
    }

    const cached = context.dedupe.get(`chat:${clientRunId}`);
    if (cached) {
      respond(cached.ok, cached.payload, cached.error, {
        cached: true,
      });
      return;
    }

    const activeExisting = context.chatAbortControllers.get(clientRunId);
    if (activeExisting) {
      respond(true, { runId: clientRunId, status: "in_flight" as const }, undefined, {
        cached: true,
        runId: clientRunId,
      });
      return;
    }

    try {
      const abortController = new AbortController();
      context.chatAbortControllers.set(clientRunId, {
        controller: abortController,
        sessionId,
        sessionKey: p.sessionKey,
        startedAtMs: now,
        expiresAtMs: resolveChatRunExpiresAtMs({ now, timeoutMs }),
      });
      context.addChatRun(clientRunId, {
        sessionKey: p.sessionKey,
        clientRunId,
      });

      if (storePath) {
        await updateSessionStore(storePath, (store) => {
          store[canonicalKey] = sessionEntry;
        });
      }

      const ackPayload = {
        runId: clientRunId,
        status: "started" as const,
      };
      respond(true, ackPayload, undefined, { runId: clientRunId });

      if (isControlCommandMessage(parsedMessage, cfg)) {
        try {
          const isFastTestEnv = process.env.CLAWDBOT_TEST_FAST === "1";
          const agentId = resolveSessionAgentId({ sessionKey: p.sessionKey, config: cfg });
          const agentCfg = cfg.agents?.defaults;
          const workspaceDir = resolveAgentWorkspaceDir(cfg, agentId);
          const workspace = await ensureAgentWorkspace({
            dir: workspaceDir,
            ensureBootstrapFiles: !agentCfg?.skipBootstrap && !isFastTestEnv,
          });
          const ctx: MsgContext = {
            Body: parsedMessage,
            CommandBody: parsedMessage,
            BodyForCommands: parsedMessage,
            CommandSource: "text",
            CommandAuthorized: true,
            Provider: INTERNAL_MESSAGE_CHANNEL,
            Surface: "tui",
            From: p.sessionKey,
            To: INTERNAL_MESSAGE_CHANNEL,
            SessionKey: p.sessionKey,
            ChatType: "direct",
          };
          const command = buildCommandContext({
            ctx,
            cfg,
            agentId,
            sessionKey: p.sessionKey,
            isGroup: false,
            triggerBodyNormalized: normalizeCommandBody(parsedMessage),
            commandAuthorized: true,
          });
          const directives = parseInlineDirectives(parsedMessage);
          const { provider, model } = resolveSessionModelRef(cfg, sessionEntry);
          const contextTokens = resolveContextTokens({ agentCfg, model });
          const resolveDefaultThinkingLevel = async () => {
            const configured = agentCfg?.thinkingDefault;
            if (configured) return configured;
            const catalog = await context.loadGatewayModelCatalog();
            return resolveThinkingDefault({ cfg, provider, model, catalog });
          };
          const resolvedThinkLevel =
            normalizeThinkLevel(sessionEntry?.thinkingLevel ?? agentCfg?.thinkingDefault) ??
            (await resolveDefaultThinkingLevel());
          const resolvedVerboseLevel =
            normalizeVerboseLevel(sessionEntry?.verboseLevel ?? agentCfg?.verboseDefault) ?? "off";
          const resolvedReasoningLevel =
            normalizeReasoningLevel(sessionEntry?.reasoningLevel) ?? "off";
          const resolvedElevatedLevel = normalizeElevatedLevel(
            sessionEntry?.elevatedLevel ?? agentCfg?.elevatedDefault,
          );
          const elevated = resolveElevatedPermissions({
            cfg,
            agentId,
            ctx,
            provider: INTERNAL_MESSAGE_CHANNEL,
          });
          const commandResult = await handleCommands({
            ctx,
            cfg,
            command,
            agentId,
            directives,
            elevated,
            sessionEntry,
            previousSessionEntry: entry,
            sessionStore: store,
            sessionKey: p.sessionKey,
            storePath,
            sessionScope: (cfg.session?.scope ?? "per-sender") as "per-sender" | "global",
            workspaceDir: workspace.dir,
            defaultGroupActivation: () => defaultGroupActivation(true),
            resolvedThinkLevel,
            resolvedVerboseLevel,
            resolvedReasoningLevel,
            resolvedElevatedLevel,
            resolveDefaultThinkingLevel,
            provider,
            model,
            contextTokens,
            isGroup: false,
          });
          if (!commandResult.shouldContinue) {
            const text = commandResult.reply?.text ?? "";
            const message = {
              role: "assistant",
              content: text.trim() ? [{ type: "text", text }] : [],
              timestamp: Date.now(),
              command: true,
            };
            const payload = {
              runId: clientRunId,
              sessionKey: p.sessionKey,
              seq: 0,
              state: "final" as const,
              message,
            };
            context.broadcast("chat", payload);
            context.nodeSendToSession(p.sessionKey, "chat", payload);
            context.dedupe.set(`chat:${clientRunId}`, {
              ts: Date.now(),
              ok: true,
              payload: { runId: clientRunId, status: "ok" as const },
            });
            context.chatAbortControllers.delete(clientRunId);
            context.removeChatRun(clientRunId, clientRunId, p.sessionKey);
            return;
          }
        } catch (err) {
          const payload = {
            runId: clientRunId,
            sessionKey: p.sessionKey,
            seq: 0,
            state: "error" as const,
            errorMessage: formatForLog(err),
          };
          const error = errorShape(ErrorCodes.UNAVAILABLE, String(err));
          context.broadcast("chat", payload);
          context.nodeSendToSession(p.sessionKey, "chat", payload);
          context.dedupe.set(`chat:${clientRunId}`, {
            ts: Date.now(),
            ok: false,
            payload: {
              runId: clientRunId,
              status: "error" as const,
              summary: String(err),
            },
            error,
          });
          context.chatAbortControllers.delete(clientRunId);
          context.removeChatRun(clientRunId, clientRunId, p.sessionKey);
          return;
        }
      }

      const envelopeOptions = resolveEnvelopeFormatOptions(cfg);
      const envelopedMessage = formatInboundEnvelope({
        channel: "WebChat",
        from: p.sessionKey,
        timestamp: now,
        body: parsedMessage,
        chatType: "direct",
        previousTimestamp: entry?.updatedAt,
        envelope: envelopeOptions,
      });
      const lane = isAcpSessionKey(p.sessionKey) ? p.sessionKey : undefined;
      void agentCommand(
        {
          message: envelopedMessage,
          images: parsedImages.length > 0 ? parsedImages : undefined,
          sessionId,
          sessionKey: p.sessionKey,
          runId: clientRunId,
          thinking: p.thinking,
          deliver: p.deliver,
          timeout: Math.ceil(timeoutMs / 1000).toString(),
          messageChannel: INTERNAL_MESSAGE_CHANNEL,
          abortSignal: abortController.signal,
          lane,
        },
        defaultRuntime,
        context.deps,
      )
        .then(() => {
          context.dedupe.set(`chat:${clientRunId}`, {
            ts: Date.now(),
            ok: true,
            payload: { runId: clientRunId, status: "ok" as const },
          });
        })
        .catch((err) => {
          const error = errorShape(ErrorCodes.UNAVAILABLE, String(err));
          context.dedupe.set(`chat:${clientRunId}`, {
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
          context.chatAbortControllers.delete(clientRunId);
        });
    } catch (err) {
      const error = errorShape(ErrorCodes.UNAVAILABLE, String(err));
      const payload = {
        runId: clientRunId,
        status: "error" as const,
        summary: String(err),
      };
      context.dedupe.set(`chat:${clientRunId}`, {
        ts: Date.now(),
        ok: false,
        payload,
        error,
      });
      respond(false, payload, error, {
        runId: clientRunId,
        error: formatForLog(err),
      });
    }
  },
  "chat.inject": async ({ params, respond, context }) => {
    if (!validateChatInjectParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid chat.inject params: ${formatValidationErrors(validateChatInjectParams.errors)}`,
        ),
      );
      return;
    }
    const p = params as {
      sessionKey: string;
      message: string;
      label?: string;
    };

    // Load session to find transcript file
    const { storePath, entry } = loadSessionEntry(p.sessionKey);
    const sessionId = entry?.sessionId;
    if (!sessionId || !storePath) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "session not found"));
      return;
    }

    // Resolve transcript path
    const transcriptPath = entry?.sessionFile
      ? entry.sessionFile
      : path.join(path.dirname(storePath), `${sessionId}.jsonl`);

    if (!fs.existsSync(transcriptPath)) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "transcript file not found"),
      );
      return;
    }

    // Build transcript entry
    const now = Date.now();
    const messageId = randomUUID().slice(0, 8);
    const labelPrefix = p.label ? `[${p.label}]\n\n` : "";
    const messageBody: Record<string, unknown> = {
      role: "assistant",
      content: [{ type: "text", text: `${labelPrefix}${p.message}` }],
      timestamp: now,
      stopReason: "injected",
      usage: { input: 0, output: 0, totalTokens: 0 },
    };
    const transcriptEntry = {
      type: "message",
      id: messageId,
      timestamp: new Date(now).toISOString(),
      message: messageBody,
    };

    // Append to transcript file
    try {
      fs.appendFileSync(transcriptPath, `${JSON.stringify(transcriptEntry)}\n`, "utf-8");
    } catch (err) {
      const errMessage = err instanceof Error ? err.message : String(err);
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.UNAVAILABLE, `failed to write transcript: ${errMessage}`),
      );
      return;
    }

    // Broadcast to webchat for immediate UI update
    const chatPayload = {
      runId: `inject-${messageId}`,
      sessionKey: p.sessionKey,
      seq: 0,
      state: "final" as const,
      message: transcriptEntry.message,
    };
    context.broadcast("chat", chatPayload);
    context.nodeSendToSession(p.sessionKey, "chat", chatPayload);

    respond(true, { ok: true, messageId });
  },
};
