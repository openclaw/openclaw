import { CURRENT_SESSION_VERSION } from "@mariozechner/pi-coding-agent";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { OpenClawConfig } from "../config/config.js";
import type { SubsystemLogger } from "../logging/subsystem.js";
import { resolveDefaultAgentId } from "../agents/agent-scope.js";
import { resolveEffectiveMessagesConfig, resolveIdentityName } from "../agents/identity.js";
import { dispatchInboundMessage } from "../auto-reply/dispatch.js";
import { createReplyDispatcher } from "../auto-reply/reply/reply-dispatcher.js";
import {
  extractShortModelName,
  type ResponsePrefixContext,
} from "../auto-reply/reply/response-prefix-template.js";
import { type MsgContext } from "../auto-reply/templating.js";
import { DEFAULT_HEARTBEAT_ACK_MAX_CHARS, stripHeartbeatToken } from "../auto-reply/heartbeat.js";
import { normalizeVerboseLevel } from "../auto-reply/thinking.js";
import { isSilentReplyText, SILENT_REPLY_TOKEN } from "../auto-reply/tokens.js";
import { loadConfig } from "../config/config.js";
import { updateSessionStore } from "../config/sessions.js";
import { type AgentEventPayload, getAgentRunContext } from "../infra/agent-events.js";
import { resolveHeartbeatVisibility } from "../infra/heartbeat-visibility.js";
import { ChannelMessage } from "./server-channels.js";
import { injectTimestamp, timestampOptsFromConfig } from "./server-methods/agent-timestamp.js";
import {
  loadSessionEntry,
  resolveGatewaySessionStoreTarget,
  getSessionDefaults,
} from "./session-utils.js";
import { formatForLog } from "./ws-log.js";

function resolveHeartbeatAckMaxChars(): number {
  try {
    const cfg = loadConfig();
    return Math.max(
      0,
      cfg.agents?.defaults?.heartbeat?.ackMaxChars ?? DEFAULT_HEARTBEAT_ACK_MAX_CHARS,
    );
  } catch {
    return DEFAULT_HEARTBEAT_ACK_MAX_CHARS;
  }
}

function resolveHeartbeatContext(runId: string, sourceRunId?: string) {
  const primary = getAgentRunContext(runId);
  if (primary?.isHeartbeat) {
    return primary;
  }
  if (sourceRunId && sourceRunId !== runId) {
    const source = getAgentRunContext(sourceRunId);
    if (source?.isHeartbeat) {
      return source;
    }
  }
  return primary;
}

/**
 * Check if heartbeat ACK/noise should be hidden from interactive chat surfaces.
 */
function shouldHideHeartbeatChatOutput(runId: string, sourceRunId?: string): boolean {
  const runContext = resolveHeartbeatContext(runId, sourceRunId);
  if (!runContext?.isHeartbeat) {
    return false;
  }

  try {
    const cfg = loadConfig();
    const visibility = resolveHeartbeatVisibility({ cfg, channel: "webchat" });
    return !visibility.showOk;
  } catch {
    // Default to suppressing if we can't load config
    return true;
  }
}

function normalizeHeartbeatChatFinalText(params: {
  runId: string;
  sourceRunId?: string;
  text: string;
}): { suppress: boolean; text: string } {
  if (!shouldHideHeartbeatChatOutput(params.runId, params.sourceRunId)) {
    return { suppress: false, text: params.text };
  }

  const stripped = stripHeartbeatToken(params.text, {
    mode: "heartbeat",
    maxAckChars: resolveHeartbeatAckMaxChars(),
  });
  if (!stripped.didStrip) {
    return { suppress: false, text: params.text };
  }
  if (stripped.shouldSkip) {
    return { suppress: true, text: "" };
  }
  return { suppress: false, text: stripped.text };
}

export type ChatRunEntry = {
  sessionKey: string;
  clientRunId: string;
};

export type ChatRunRegistry = {
  add: (sessionId: string, entry: ChatRunEntry) => void;
  peek: (sessionId: string) => ChatRunEntry | undefined;
  shift: (sessionId: string) => ChatRunEntry | undefined;
  remove: (sessionId: string, clientRunId: string, sessionKey?: string) => ChatRunEntry | undefined;
  clear: () => void;
};

export function createChatRunRegistry(): ChatRunRegistry {
  const chatRunSessions = new Map<string, ChatRunEntry[]>();

  const add = (sessionId: string, entry: ChatRunEntry) => {
    const queue = chatRunSessions.get(sessionId);
    if (queue) {
      queue.push(entry);
    } else {
      chatRunSessions.set(sessionId, [entry]);
    }
  };

  const peek = (sessionId: string) => chatRunSessions.get(sessionId)?.[0];

  const shift = (sessionId: string) => {
    const queue = chatRunSessions.get(sessionId);
    if (!queue || queue.length === 0) {
      return undefined;
    }
    const entry = queue.shift();
    if (!queue.length) {
      chatRunSessions.delete(sessionId);
    }
    return entry;
  };

  const remove = (sessionId: string, clientRunId: string, sessionKey?: string) => {
    const queue = chatRunSessions.get(sessionId);
    if (!queue || queue.length === 0) {
      return undefined;
    }
    const idx = queue.findIndex(
      (entry) =>
        entry.clientRunId === clientRunId && (sessionKey ? entry.sessionKey === sessionKey : true),
    );
    if (idx < 0) {
      return undefined;
    }
    const [entry] = queue.splice(idx, 1);
    if (!queue.length) {
      chatRunSessions.delete(sessionId);
    }
    return entry;
  };

  const clear = () => {
    chatRunSessions.clear();
  };

  return { add, peek, shift, remove, clear };
}

export type ChatRunState = {
  registry: ChatRunRegistry;
  buffers: Map<string, string>;
  deltaSentAt: Map<string, number>;
  abortedRuns: Map<string, number>;
  clear: () => void;
};

export function createChatRunState(): ChatRunState {
  const registry = createChatRunRegistry();
  const buffers = new Map<string, string>();
  const deltaSentAt = new Map<string, number>();
  const abortedRuns = new Map<string, number>();

  const clear = () => {
    registry.clear();
    buffers.clear();
    deltaSentAt.clear();
    abortedRuns.clear();
  };

  return {
    registry,
    buffers,
    deltaSentAt,
    abortedRuns,
    clear,
  };
}

export type ToolEventRecipientRegistry = {
  add: (runId: string, connId: string) => void;
  get: (runId: string) => ReadonlySet<string> | undefined;
  markFinal: (runId: string) => void;
};

type ToolRecipientEntry = {
  connIds: Set<string>;
  updatedAt: number;
  finalizedAt?: number;
};

const TOOL_EVENT_RECIPIENT_TTL_MS = 10 * 60 * 1000;
const TOOL_EVENT_RECIPIENT_FINAL_GRACE_MS = 30 * 1000;

export function createToolEventRecipientRegistry(): ToolEventRecipientRegistry {
  const recipients = new Map<string, ToolRecipientEntry>();

  const prune = () => {
    if (recipients.size === 0) {
      return;
    }
    const now = Date.now();
    for (const [runId, entry] of recipients) {
      const cutoff = entry.finalizedAt
        ? entry.finalizedAt + TOOL_EVENT_RECIPIENT_FINAL_GRACE_MS
        : entry.updatedAt + TOOL_EVENT_RECIPIENT_TTL_MS;
      if (now >= cutoff) {
        recipients.delete(runId);
      }
    }
  };

  const add = (runId: string, connId: string) => {
    if (!runId || !connId) {
      return;
    }
    const now = Date.now();
    const existing = recipients.get(runId);
    if (existing) {
      existing.connIds.add(connId);
      existing.updatedAt = now;
    } else {
      recipients.set(runId, {
        connIds: new Set([connId]),
        updatedAt: now,
      });
    }
    prune();
  };

  const get = (runId: string) => {
    const entry = recipients.get(runId);
    if (!entry) {
      return undefined;
    }
    entry.updatedAt = Date.now();
    prune();
    return entry.connIds;
  };

  const markFinal = (runId: string) => {
    const entry = recipients.get(runId);
    if (!entry) {
      return;
    }
    entry.finalizedAt = Date.now();
    prune();
  };

  return { add, get, markFinal };
}

export type ChatEventBroadcast = (
  event: string,
  payload: unknown,
  opts?: { dropIfSlow?: boolean },
) => void;

export type NodeSendToSession = (sessionKey: string, event: string, payload: unknown) => void;

export type AgentEventHandlerOptions = {
  broadcast: ChatEventBroadcast;
  broadcastToConnIds: (
    event: string,
    payload: unknown,
    connIds: ReadonlySet<string>,
    opts?: { dropIfSlow?: boolean },
  ) => void;
  nodeSendToSession: NodeSendToSession;
  agentRunSeq: Map<string, number>;
  chatRunState: ChatRunState;
  resolveSessionKeyForRun: (runId: string) => string | undefined;
  clearAgentRunContext: (runId: string) => void;
  toolEventRecipients: ToolEventRecipientRegistry;
};

export function createAgentEventHandler({
  broadcast,
  broadcastToConnIds,
  nodeSendToSession,
  agentRunSeq,
  chatRunState,
  resolveSessionKeyForRun,
  clearAgentRunContext,
  toolEventRecipients,
}: AgentEventHandlerOptions) {
  const emitChatDelta = (
    sessionKey: string,
    clientRunId: string,
    sourceRunId: string,
    seq: number,
    text: string,
  ) => {
    if (isSilentReplyText(text, SILENT_REPLY_TOKEN)) {
      return;
    }
    chatRunState.buffers.set(clientRunId, text);
    if (shouldHideHeartbeatChatOutput(clientRunId, sourceRunId)) {
      return;
    }
    const now = Date.now();
    const last = chatRunState.deltaSentAt.get(clientRunId) ?? 0;
    if (now - last < 150) {
      return;
    }
    chatRunState.deltaSentAt.set(clientRunId, now);
    const payload = {
      runId: clientRunId,
      sessionKey,
      seq,
      state: "delta" as const,
      message: {
        role: "assistant",
        content: [{ type: "text", text }],
        timestamp: now,
      },
    };
    broadcast("chat", payload, { dropIfSlow: true });
    nodeSendToSession(sessionKey, "chat", payload);
  };

  const emitChatFinal = (
    sessionKey: string,
    clientRunId: string,
    sourceRunId: string,
    seq: number,
    jobState: "done" | "error",
    error?: unknown,
  ) => {
    const bufferedText = chatRunState.buffers.get(clientRunId)?.trim() ?? "";
    const normalizedHeartbeatText = normalizeHeartbeatChatFinalText({
      runId: clientRunId,
      sourceRunId,
      text: bufferedText,
    });
    const text = normalizedHeartbeatText.text.trim();
    const shouldSuppressSilent =
      normalizedHeartbeatText.suppress || isSilentReplyText(text, SILENT_REPLY_TOKEN);
    chatRunState.buffers.delete(clientRunId);
    chatRunState.deltaSentAt.delete(clientRunId);
    if (jobState === "done") {
      const payload = {
        runId: clientRunId,
        sessionKey,
        seq,
        state: "final" as const,
        message:
          text && !shouldSuppressSilent
            ? {
                role: "assistant",
                content: [{ type: "text", text }],
                timestamp: Date.now(),
              }
            : undefined,
      };
      broadcast("chat", payload);
      nodeSendToSession(sessionKey, "chat", payload);
      return;
    }
    const payload = {
      runId: clientRunId,
      sessionKey,
      seq,
      state: "error" as const,
      errorMessage: error ? formatForLog(error) : undefined,
    };
    broadcast("chat", payload);
    nodeSendToSession(sessionKey, "chat", payload);
  };

  const resolveToolVerboseLevel = (runId: string, sessionKey?: string) => {
    const runContext = getAgentRunContext(runId);
    const runVerbose = normalizeVerboseLevel(runContext?.verboseLevel);
    if (runVerbose) {
      return runVerbose;
    }
    if (!sessionKey) {
      return "off";
    }
    try {
      const { cfg, entry } = loadSessionEntry(sessionKey);
      const sessionVerbose = normalizeVerboseLevel(entry?.verboseLevel);
      if (sessionVerbose) {
        return sessionVerbose;
      }
      const defaultVerbose = normalizeVerboseLevel(cfg.agents?.defaults?.verboseDefault);
      return defaultVerbose ?? "off";
    } catch {
      return "off";
    }
  };

  return (evt: AgentEventPayload) => {
    const chatLink = chatRunState.registry.peek(evt.runId);
    const eventSessionKey =
      typeof evt.sessionKey === "string" && evt.sessionKey.trim() ? evt.sessionKey : undefined;
    const sessionKey =
      chatLink?.sessionKey ?? eventSessionKey ?? resolveSessionKeyForRun(evt.runId);
    const clientRunId = chatLink?.clientRunId ?? evt.runId;
    const eventRunId = chatLink?.clientRunId ?? evt.runId;
    const eventForClients = chatLink ? { ...evt, runId: eventRunId } : evt;
    const isAborted =
      chatRunState.abortedRuns.has(clientRunId) || chatRunState.abortedRuns.has(evt.runId);
    // Include sessionKey so Control UI can filter tool streams per session.
    const agentPayload = sessionKey ? { ...eventForClients, sessionKey } : eventForClients;
    const last = agentRunSeq.get(evt.runId) ?? 0;
    const isToolEvent = evt.stream === "tool";
    const toolVerbose = isToolEvent ? resolveToolVerboseLevel(evt.runId, sessionKey) : "off";
    // Build tool payload: strip result/partialResult unless verbose=full
    const toolPayload =
      isToolEvent && toolVerbose !== "full"
        ? (() => {
            const data = evt.data ? { ...evt.data } : {};
            delete data.result;
            delete data.partialResult;
            return sessionKey
              ? { ...eventForClients, sessionKey, data }
              : { ...eventForClients, data };
          })()
        : agentPayload;
    if (evt.seq !== last + 1) {
      broadcast("agent", {
        runId: eventRunId,
        stream: "error",
        ts: Date.now(),
        sessionKey,
        data: {
          reason: "seq gap",
          expected: last + 1,
          received: evt.seq,
        },
      });
    }
    agentRunSeq.set(evt.runId, evt.seq);
    if (isToolEvent) {
      // Always broadcast tool events to registered WS recipients with
      // tool-events capability, regardless of verboseLevel. The verbose
      // setting only controls whether tool details are sent as channel
      // messages to messaging surfaces (Telegram, Discord, etc.).
      const recipients = toolEventRecipients.get(evt.runId);
      if (recipients && recipients.size > 0) {
        broadcastToConnIds("agent", toolPayload, recipients);
      }
    } else {
      broadcast("agent", agentPayload);
    }

    const lifecyclePhase =
      evt.stream === "lifecycle" && typeof evt.data?.phase === "string" ? evt.data.phase : null;

    if (sessionKey) {
      // Send tool events to node/channel subscribers only when verbose is enabled;
      // WS clients already received the event above via broadcastToConnIds.
      if (!isToolEvent || toolVerbose !== "off") {
        nodeSendToSession(sessionKey, "agent", isToolEvent ? toolPayload : agentPayload);
      }
      if (!isAborted && evt.stream === "assistant" && typeof evt.data?.text === "string") {
        emitChatDelta(sessionKey, clientRunId, evt.runId, evt.seq, evt.data.text);
      } else if (!isAborted && (lifecyclePhase === "end" || lifecyclePhase === "error")) {
        if (chatLink) {
          const finished = chatRunState.registry.shift(evt.runId);
          if (!finished) {
            clearAgentRunContext(evt.runId);
            return;
          }
          emitChatFinal(
            finished.sessionKey,
            finished.clientRunId,
            evt.runId,
            evt.seq,
            lifecyclePhase === "error" ? "error" : "done",
            evt.data?.error,
          );
        } else {
          emitChatFinal(
            sessionKey,
            eventRunId,
            evt.runId,
            evt.seq,
            lifecyclePhase === "error" ? "error" : "done",
            evt.data?.error,
          );
        }
      } else if (isAborted && (lifecyclePhase === "end" || lifecyclePhase === "error")) {
        chatRunState.abortedRuns.delete(clientRunId);
        chatRunState.abortedRuns.delete(evt.runId);
        chatRunState.buffers.delete(clientRunId);
        chatRunState.deltaSentAt.delete(clientRunId);
        if (chatLink) {
          chatRunState.registry.remove(evt.runId, clientRunId, sessionKey);
        }
      }
    }

    if (lifecyclePhase === "end" || lifecyclePhase === "error") {
      toolEventRecipients.markFinal(evt.runId);
      clearAgentRunContext(evt.runId);
      agentRunSeq.delete(evt.runId);
      agentRunSeq.delete(clientRunId);
    }
  };
}

function ensureTranscriptFile(params: { transcriptPath: string; sessionId: string }): {
  ok: boolean;
  error?: string;
} {
  if (fs.existsSync(params.transcriptPath)) {
    return { ok: true };
  }
  try {
    fs.mkdirSync(path.dirname(params.transcriptPath), { recursive: true });
    const header = {
      type: "session",
      version: CURRENT_SESSION_VERSION,
      id: params.sessionId,
      timestamp: new Date().toISOString(),
      cwd: process.cwd(),
    };
    fs.writeFileSync(params.transcriptPath, `${JSON.stringify(header)}\n`, "utf-8");
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

function appendTranscriptMessage(params: {
  role: "user" | "assistant";
  message: string;
  sessionId: string;
  storePath: string | undefined;
  sessionFile?: string;
}): { ok: boolean; message?: Record<string, unknown>; error?: string } {
  if (!params.storePath) {
    return { ok: false, error: "store path missing" };
  }

  const transcriptPath = params.sessionFile
    ? params.sessionFile
    : path.join(path.dirname(params.storePath), `${params.sessionId}.jsonl`);

  if (!fs.existsSync(transcriptPath)) {
    const ensured = ensureTranscriptFile({ transcriptPath, sessionId: params.sessionId });
    if (!ensured.ok) {
      return { ok: false, error: ensured.error };
    }
  }

  const now = Date.now();
  const messageId = randomUUID().slice(0, 8);
  const messageBody: Record<string, unknown> = {
    role: params.role,
    content: [{ type: "text", text: params.message }],
    timestamp: now,
    stopReason: params.role === "assistant" ? "injected" : undefined,
  };

  const transcriptEntry = {
    type: "message",
    id: messageId,
    timestamp: new Date(now).toISOString(),
    message: messageBody,
  };

  try {
    fs.appendFileSync(transcriptPath, `${JSON.stringify(transcriptEntry)}\n`, "utf-8");
    return { ok: true, message: messageBody };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}

// Helper to handle inbound messages from channels (like Spixi, Telegram, etc)
export function createChannelMessageHandler(deps: {
  loadConfig: () => OpenClawConfig;
  log: SubsystemLogger;
  agentRunSeq: Map<string, number>;
  chatRunState: ChatRunState;
  nodeSendToSession: NodeSendToSession;
  broadcast: ChatEventBroadcast;
  // We need to resolve session key from channel ID + sender ID
  // Since we don't have a DB for channel->session mapping yet, we use a deterministic key or "headless" mode?
  // Current chat.send uses explicit sessionKey.
  // For external channels, we need to map (channel, account, from) -> sessionKey.
  // For now, let's auto-generate a deterministic session key if one doesn't exist?
  // Or check if there's a convention.
  // In v1, we used "channel:id:from".
  resolveSessionKey: (channel: string, from: string) => string;
  onReply?: (channelId: string, accountId: string, to: string, text: string) => Promise<void>;
}) {
  return async (channelId: string, accountId: string, msg: ChannelMessage) => {
    const cfg = deps.loadConfig();
    const sessionKey = deps.resolveSessionKey(channelId, msg.from);

    deps.log.info(
      `[${channelId}:${accountId}] Inbound message from ${msg.from} to session ${sessionKey}`,
    );

    // EXPLICITLY ENSURE SESSION EXISTS
    const target = resolveGatewaySessionStoreTarget({ cfg, key: sessionKey });

    let sessionId: string | undefined;
    let storePath = target.storePath;
    let sessionFile: string | undefined;

    if (!storePath) {
      deps.log.error(`[${channelId}] Cannot resolve storePath for sessionKey: ${sessionKey}`);
      return;
    }

    await updateSessionStore(storePath, (store) => {
      const primaryKey = target.storeKeys[0] ?? sessionKey;
      const existingKey = target.storeKeys.find((candidate) => store[candidate]);

      let entry = existingKey ? store[existingKey] : undefined;
      const forceAllow = cfg.channels?.forceAllowSendPolicy === true;
      if (!entry) {
        // Create new session entry
        const defaults = getSessionDefaults(cfg);
        deps.log.info(
          `[${channelId}] Initializing new session ${sessionKey} with defaults: model=${defaults.model}, provider=${defaults.modelProvider}`,
        );

        entry = {
          sessionId: randomUUID(),
          updatedAt: Date.now(),
          systemSent: false,
          abortedLastRun: false,
          inputTokens: 0,
          outputTokens: 0,
          totalTokens: 0,
          label: `Channel ${msg.from}`,
          origin: {},
          lastChannel: channelId,
          lastTo: msg.from,
          // Only force allow if config option is set
          ...(forceAllow ? { sendPolicy: "allow" } : {}),
          contextTokens: defaults.contextTokens ?? undefined,
          model: defaults.model ?? undefined,
          modelProvider: defaults.modelProvider ?? undefined,
        };
        store[primaryKey] = entry;
        deps.log.info(
          `[${channelId}] Created new session entry for ${sessionKey} (si=${entry.sessionId})`,
        );
      } else {
        // Update entry
        entry.updatedAt = Date.now();
        entry.lastChannel = channelId;
        entry.lastTo = msg.from;
        // Only force allow if config option is set
        if (forceAllow && (!entry.sendPolicy || (entry.sendPolicy as unknown) === "auto")) {
          entry.sendPolicy = "allow";
        }
      }
      sessionId = entry.sessionId;
      sessionFile = entry.sessionFile;
      // Don't return anything to imply "no structural change" other than in-place mutation which updateSessionStore handles
      return undefined;
    });

    if (!sessionId) {
      deps.log.error(`[${channelId}] Failed to resolve sessionId for ${sessionKey}`);
      return;
    }

    // APPEND USER MESSAGE TO TRANSCRIPT
    appendTranscriptMessage({
      role: "user",
      message: msg.text,
      sessionId,
      storePath,
      sessionFile,
    });

    const clientRunId = msg.id || `msg-${Date.now()}-${Math.random().toString(36).slice(2)}`;

    // Create abort controller for run
    const abortController = new AbortController();

    const stampedMessage = injectTimestamp(msg.text, timestampOptsFromConfig(cfg));

    const ctx: MsgContext = {
      Body: msg.text,
      BodyForAgent: stampedMessage,
      BodyForCommands: msg.text,
      RawBody: msg.text,
      CommandBody: msg.text,
      SessionKey: sessionKey,
      Provider: channelId,
      Surface: channelId,
      OriginatingChannel: channelId,
      ChatType: "direct",
      CommandAuthorized: true,
      MessageSid: clientRunId,
      SenderId: msg.from,
      SenderName: msg.from,
      SenderUsername: msg.from,
    };

    const agentId = resolveDefaultAgentId(cfg);
    let prefixContext: ResponsePrefixContext = {
      identityName: resolveIdentityName(cfg, agentId),
    };

    const finalReplyParts: string[] = [];
    const dispatcher = createReplyDispatcher({
      responsePrefix: resolveEffectiveMessagesConfig(cfg, agentId).responsePrefix,
      responsePrefixContextProvider: () => prefixContext,
      onError: (err) => {
        deps.log.warn(`[${channelId}] dispatch failed: ${formatForLog(err)}`);
      },
      deliver: async (payload, info) => {
        if (info.kind !== "final") {
          return;
        }
        const text = payload.text?.trim() ?? "";
        if (text) {
          finalReplyParts.push(text);
        }
      },
    });

    try {
      await dispatchInboundMessage({
        ctx,
        cfg,
        dispatcher,
        replyOptions: {
          runId: clientRunId,
          abortSignal: abortController.signal,
          disableBlockStreaming: true,
          onModelSelected: (ctx) => {
            prefixContext.provider = ctx.provider;
            prefixContext.model = extractShortModelName(ctx.model);
            prefixContext.modelFull = `${ctx.provider}/${ctx.model}`;
            prefixContext.thinkingLevel = ctx.thinkLevel ?? "off";
          },
        },
      });

      // Send reply back to channel?
      // dispatchInboundMessage handles "reply" via dispatcher.deliver
      // But dispatcher.deliver pushes to finalReplyParts.
      // We need to sending these parts BACK to the channel.
      // The channel plugin should have "outbound" capability.
      // But wait, the Agent (via tools) sends messages.
      // Or specific auto-reply logic?
      // In webchat, we just broadcast the reply to the UI.
      // For CHANNELS, the agent should used "sendMessage" tool OR the system should auto-reply if it's a "chat" response.

      // If the agent used "sendMessage" tool, that's handled by tool execution.
      // If the agent just "spoke" (text content), that goes to dispatcher.
      // We need to route dispatcher output back to the channel's `sendText` method.

      // This requires access to the channel runtime to call `sendText`.
      // BUT we are in gateway server code.
      // We can use `deps` to get access to sending mechanism?
      // Or we assume the agent uses tools?
      // Usually, standard "chat" response should be sent back.

      if (finalReplyParts.length > 0) {
        const replyText = finalReplyParts.join("\n\n");
        deps.log.info(`[${channelId}] Agent reply: ${replyText}`);
        if (deps.onReply) {
          await deps.onReply(channelId, accountId, msg.from, replyText);
        }
      }
    } catch (err) {
      deps.log.error(`[${channelId}] dispatch error: ${formatForLog(err)}`);
    }
  };
}
