/**
 * Embedded-mode Gateway method stub.
 *
 * Implements only the Gateway calls needed by session tools and rejects unsupported methods.
 */
import type {
  SessionsListParams,
  SessionsResolveParams,
} from "../../../packages/gateway-protocol/src/index.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { CallGatewayOptions } from "../../gateway/call.js";
import type {
  ReadSessionMessagesAsyncOptions,
  SessionTranscriptReadScope,
} from "../../gateway/session-transcript-readers.js";
import type { SessionsListResult } from "../../gateway/session-utils.types.js";
import type { SessionsResolveResult } from "../../gateway/sessions-resolve.js";
import {
  normalizeFastMode,
  type FastMode,
} from "@openclaw/normalization-core/string-coerce";
import { parseAgentSessionKey } from "../../routing/session-key.js";
import { readPositiveIntegerParam } from "./common.js";

type EmbeddedCallGateway = <T = Record<string, unknown>>(opts: CallGatewayOptions) => Promise<T>;

interface EmbeddedGatewayRuntime {
  resolveSessionAgentId: (opts: {
    sessionKey: string;
    config: OpenClawConfig;
    agentId?: string;
  }) => string;
  getRuntimeConfig: () => OpenClawConfig;
  augmentChatHistoryWithCliSessionImports: (opts: {
    entry: unknown;
    provider: string | undefined;
    localMessages: unknown[];
  }) => unknown[];
  getMaxChatHistoryMessagesBytes: () => number;
  augmentChatHistoryWithCanvasBlocks: (msgs: unknown[]) => unknown[];
  CHAT_HISTORY_MAX_SINGLE_MESSAGE_BYTES: number;
  enforceChatHistoryFinalBudget: (opts: { messages: unknown[]; maxBytes: number }) => {
    messages: unknown[];
  };
  replaceOversizedChatHistoryMessages: (opts: {
    messages: unknown[];
    maxSingleMessageBytes: number;
  }) => { messages: unknown[] };
  resolveEffectiveChatHistoryMaxChars: (cfg: OpenClawConfig) => number;
  projectChatDisplayMessage: (
    message: unknown,
    opts?: { maxChars?: number },
  ) => Record<string, unknown> | undefined;
  projectRecentChatDisplayMessages: (
    msgs: unknown[],
    opts?: { maxChars?: number; maxMessages?: number },
  ) => unknown[];
  capArrayByJsonBytes: (items: unknown[], maxBytes: number) => { items: unknown[] };
  listSessionsFromStoreAsync: (opts: {
    cfg: OpenClawConfig;
    storePath: string;
    store: unknown;
    opts: SessionsListParams;
  }) => Promise<SessionsListResult>;
  loadCombinedSessionStoreForGateway: (
    cfg: OpenClawConfig,
    opts?: { agentId?: string },
  ) => {
    storePath: string;
    store: unknown;
  };
  resolveSessionKeyFromResolveParams: (opts: {
    cfg: OpenClawConfig;
    p: SessionsResolveParams;
  }) => Promise<SessionsResolveResult>;
  loadSessionEntry: (
    sessionKey: string,
    opts?: { agentId?: string },
  ) => {
    cfg: OpenClawConfig;
    storePath: string | undefined;
    entry: Record<string, unknown> | undefined;
  };
  readSessionMessagesAsync: (
    scope: SessionTranscriptReadScope,
    opts: ReadSessionMessagesAsyncOptions,
  ) => Promise<unknown[]>;
  resolveSessionModelRef: (
    cfg: OpenClawConfig,
    entry: unknown,
    sessionAgentId: string,
  ) => { provider: string | undefined };
}

let runtimeMod: EmbeddedGatewayRuntime | undefined;

async function getRuntime(): Promise<EmbeddedGatewayRuntime> {
  if (!runtimeMod) {
    // Lazy import keeps embedded tools cheap and gives tests a single mock boundary.
    runtimeMod = (await import("./embedded-gateway-stub.runtime.js")) as EmbeddedGatewayRuntime;
  }
  return runtimeMod;
}

async function handleSessionsList(params: Record<string, unknown>) {
  const rt = await getRuntime();
  const cfg = rt.getRuntimeConfig();
  const opts = params as SessionsListParams;
  const { storePath, store } = rt.loadCombinedSessionStoreForGateway(cfg, {
    agentId: opts.agentId,
  });
  return rt.listSessionsFromStoreAsync({
    cfg,
    storePath,
    store,
    opts,
  });
}

async function handleSessionsResolve(params: Record<string, unknown>) {
  const rt = await getRuntime();
  const cfg = rt.getRuntimeConfig();
  const resolved = await rt.resolveSessionKeyFromResolveParams({
    cfg,
    p: params as SessionsResolveParams,
  });
  if (!resolved.ok) {
    throw new Error(resolved.error.message);
  }
  if ("missing" in resolved) {
    return { ok: false };
  }
  return { ok: true, key: resolved.key };
}

function readChatHistoryMessageId(message: unknown): string | undefined {
  if (!message || typeof message !== "object") {
    return undefined;
  }
  const metadata = (message as Record<string, unknown>)["__openclaw"];
  if (!metadata || typeof metadata !== "object") {
    return undefined;
  }
  const id = (metadata as { id?: unknown }).id;
  return typeof id === "string" ? id : undefined;
}

function readRequestedAgentId(
  params: Record<string, unknown>,
  sessionKey: string,
): string | undefined {
  const agentId = typeof params.agentId === "string" ? params.agentId : undefined;
  return agentId ?? parseAgentSessionKey(sessionKey)?.agentId;
}

function historyMessageCacheKey(
  sessionKey: string,
  requestedAgentId: string | undefined,
  messageId: string,
): string {
  return `${sessionKey}\u0000${requestedAgentId ?? ""}\u0000${messageId}`;
}

function cacheExposedHistoryMessages(
  historyMessageCache: Map<string, unknown>,
  sessionKey: string,
  requestedAgentId: string | undefined,
  rawMessages: unknown[],
  exposedMessages: unknown[],
): void {
  const prefix = `${sessionKey}\u0000${requestedAgentId ?? ""}\u0000`;
  for (const key of historyMessageCache.keys()) {
    if (key.startsWith(prefix)) {
      historyMessageCache.delete(key);
    }
  }
  const rawById = new Map<string, unknown>();
  for (const message of rawMessages) {
    const id = readChatHistoryMessageId(message);
    if (id) {
      rawById.set(id, message);
    }
  }
  for (const message of exposedMessages) {
    const id = readChatHistoryMessageId(message);
    const raw = id ? rawById.get(id) : undefined;
    if (id && raw) {
      historyMessageCache.set(historyMessageCacheKey(sessionKey, requestedAgentId, id), raw);
    }
  }
}

async function handleChatHistory(
  params: Record<string, unknown>,
  historyMessageCache: Map<string, unknown>,
): Promise<{
  sessionKey: string;
  sessionId: string | undefined;
  messages: unknown[];
  thinkingLevel?: string;
  fastMode?: FastMode;
  verboseLevel?: string;
}> {
  const rt = await getRuntime();

  const sessionKey = typeof params.sessionKey === "string" ? params.sessionKey : "";
  const requestedAgentId = readRequestedAgentId(params, sessionKey);
  const limit = readPositiveIntegerParam(params, "limit");

  const sessionLoadOptions = requestedAgentId ? { agentId: requestedAgentId } : undefined;
  const { cfg, storePath, entry } = rt.loadSessionEntry(sessionKey, sessionLoadOptions);
  const sessionId = entry?.sessionId as string | undefined;
  const sessionAgentId = rt.resolveSessionAgentId({
    sessionKey,
    config: cfg,
    agentId: requestedAgentId,
  });
  const resolvedSessionModel = rt.resolveSessionModelRef(cfg, entry, sessionAgentId);
  const hardMax = 1000;
  const defaultLimit = 200;
  const requested = typeof limit === "number" ? limit : defaultLimit;
  const max = Math.min(hardMax, requested);
  const maxHistoryBytes = rt.getMaxChatHistoryMessagesBytes();
  const sessionEntry =
    typeof entry?.sessionId === "string"
      ? {
          sessionId: entry.sessionId,
          ...(typeof entry.sessionFile === "string" ? { sessionFile: entry.sessionFile } : {}),
        }
      : undefined;

  const localMessages =
    sessionId && storePath
      ? await rt.readSessionMessagesAsync(
          {
            agentId: sessionAgentId,
            sessionEntry,
            sessionId,
            sessionKey,
            storePath,
          },
          {
            mode: "recent",
            maxMessages: max,
            maxBytes: Math.max(maxHistoryBytes * 2, 1024 * 1024),
            allowResetArchiveFallback: true,
          },
        )
      : [];

  const rawMessages = rt.augmentChatHistoryWithCliSessionImports({
    entry,
    provider: resolvedSessionModel.provider,
    localMessages,
  });

  const effectiveMaxChars = rt.resolveEffectiveChatHistoryMaxChars(cfg);

  // Mirror Gateway chat.history trimming so embedded mode has the same byte ceilings.
  const normalized = rt.augmentChatHistoryWithCanvasBlocks(
    rt.projectRecentChatDisplayMessages(rawMessages, {
      maxChars: effectiveMaxChars,
      maxMessages: max,
    }),
  );

  const perMessageHardCap = Math.min(rt.CHAT_HISTORY_MAX_SINGLE_MESSAGE_BYTES, maxHistoryBytes);
  const replaced = rt.replaceOversizedChatHistoryMessages({
    messages: normalized,
    maxSingleMessageBytes: perMessageHardCap,
  });
  const capped = rt.capArrayByJsonBytes(replaced.messages, maxHistoryBytes).items;
  const bounded = rt.enforceChatHistoryFinalBudget({ messages: capped, maxBytes: maxHistoryBytes });
  cacheExposedHistoryMessages(
    historyMessageCache,
    sessionKey,
    requestedAgentId,
    rawMessages,
    bounded.messages,
  );

  return {
    sessionKey,
    sessionId,
    messages: bounded.messages,
    thinkingLevel: entry?.thinkingLevel as string | undefined,
    fastMode: normalizeFastMode(entry?.fastMode),
    verboseLevel: entry?.verboseLevel as string | undefined,
  };
}

async function handleChatMessageGet(
  params: Record<string, unknown>,
  historyMessageCache: Map<string, unknown>,
): Promise<{ ok: boolean; message?: unknown; unavailableReason?: "not_found" | "not_visible" }> {
  const sessionKey = typeof params.sessionKey === "string" ? params.sessionKey : "";
  const messageId = typeof params.messageId === "string" ? params.messageId : "";
  const requestedAgentId = readRequestedAgentId(params, sessionKey);
  const source = historyMessageCache.get(
    historyMessageCacheKey(sessionKey, requestedAgentId, messageId),
  );
  if (!source) {
    return { ok: false, unavailableReason: "not_found" };
  }
  const maxChars = readPositiveIntegerParam(params, "maxChars") ?? 1_000_000;
  const rt = await getRuntime();
  const projected = rt.projectChatDisplayMessage(source, { maxChars });
  if (!projected) {
    return { ok: false, unavailableReason: "not_visible" };
  }
  return {
    ok: true,
    message: rt.augmentChatHistoryWithCanvasBlocks([projected])[0],
  };
}

/** Creates a local callGateway replacement for supported session methods. */
export function createEmbeddedCallGateway(): EmbeddedCallGateway {
  const historyMessageCache = new Map<string, unknown>();
  return async <T = Record<string, unknown>>(opts: CallGatewayOptions): Promise<T> => {
    const method = opts.method?.trim();
    const params = (opts.params ?? {}) as Record<string, unknown>;

    switch (method) {
      case "sessions.list":
        return (await handleSessionsList(params)) as T;
      case "sessions.resolve":
        return (await handleSessionsResolve(params)) as T;
      case "chat.history":
        return (await handleChatHistory(params, historyMessageCache)) as T;
      case "chat.message.get":
        return (await handleChatMessageGet(params, historyMessageCache)) as T;
      default:
        throw new Error(
          `Method "${method}" requires a running gateway (unavailable in local embedded mode).`,
        );
    }
  };
}
