import { normalizeFastMode } from "@openclaw/normalization-core/string-coerce";
import type {
  SessionsListParams,
  SessionsResolveParams,
} from "../../../packages/gateway-protocol/src/index.js";
import type { CallGatewayOptions } from "../../gateway/call.js";
import type { SessionRowProjection } from "../../gateway/session-row-projection.js";
import { parseAgentSessionKey, scopeLegacySessionKeyToAgent } from "../../routing/session-key.js";
import { createLazyPromise } from "../../shared/lazy-promise.js";
import {
  readNonNegativeIntegerParam,
  readPositiveIntegerParam,
  readToolStringParam,
} from "./common.js";

type EmbeddedCallGateway = <T = Record<string, unknown>>(opts: CallGatewayOptions) => Promise<T>;

const SESSIONS_SEARCH_MAX_QUERY_CHARS = 4096;

const getRuntime = createLazyPromise(() => import("./embedded-gateway-stub.runtime.js"));
let sessionProjection: Promise<SessionRowProjection> | undefined;

export function bindEmbeddedSessionRowProjection(projection: Promise<SessionRowProjection>) {
  sessionProjection = projection;
  return () => {
    if (sessionProjection === projection) {
      sessionProjection = undefined;
    }
  };
}

async function borrowSessionRowProjection() {
  const publication = sessionProjection;
  if (!publication) {
    throw new Error("Embedded session projection is unavailable");
  }
  const projection = await publication;
  if (sessionProjection !== publication) {
    throw new Error("Embedded session projection is unavailable");
  }
  return projection;
}

async function handleSessionsList(params: Record<string, unknown>) {
  const rt = await getRuntime();
  return rt.listProjectedSessions({
    projection: await borrowSessionRowProjection(),
    opts: params as SessionsListParams,
  });
}

async function handleSessionsResolve(params: Record<string, unknown>) {
  const rt = await getRuntime();
  const publication = sessionProjection;
  return await rt.withPreparedSessionResolve(
    {
      projection: await borrowSessionRowProjection(),
      isCurrent: () => sessionProjection === publication,
      client: null,
      p: params as SessionsResolveParams,
    },
    (resolved) => {
      if (!resolved.ok) {
        throw new Error(resolved.error.message);
      }
      if ("missing" in resolved) {
        return { ok: false };
      }
      if ("ambiguous" in resolved) {
        return { ok: false, candidates: resolved.candidates };
      }
      return { ok: true, key: resolved.key, agentId: resolved.agentId };
    },
  );
}

async function handleSessionsSearch(params: Record<string, unknown>) {
  const rt = await getRuntime();
  const cfg = rt.getRuntimeConfig();
  const query = typeof params.query === "string" ? params.query.trim() : "";
  if (!query) {
    throw new Error("query must not be empty");
  }
  if (query.length > SESSIONS_SEARCH_MAX_QUERY_CHARS) {
    throw new Error(`query must not exceed ${SESSIONS_SEARCH_MAX_QUERY_CHARS} characters`);
  }
  if (params.agentId !== undefined && params.sessionKeys === undefined) {
    throw new Error("agentId requires sessionKeys");
  }
  const requestedSessionKeys = Array.isArray(params.sessionKeys)
    ? params.sessionKeys.filter(
        (sessionKey): sessionKey is string => typeof sessionKey === "string",
      )
    : undefined;
  // Mirror the gateway protocol validator: an explicit sessionKeys filter must
  // stay non-empty, or an empty array would silently widen to an unfiltered
  // agent-wide search.
  if (params.sessionKeys !== undefined && (requestedSessionKeys?.length ?? 0) === 0) {
    throw new Error("sessionKeys must be a non-empty array of session keys");
  }
  const requestedAgentId = typeof params.agentId === "string" ? params.agentId.trim() : undefined;
  const sessionKeys = requestedSessionKeys?.map((sessionKey) =>
    requestedAgentId
      ? rt.resolveStoredSessionKeyForAgentStore({ cfg, agentId: requestedAgentId, sessionKey })
      : rt.resolveSessionStoreKey({ cfg, sessionKey }),
  );
  const agentIds = new Set(
    sessionKeys?.map((sessionKey) =>
      rt.resolveSessionAgentId({
        sessionKey,
        config: cfg,
        ...(requestedAgentId ? { agentId: requestedAgentId } : {}),
      }),
    ),
  );
  if (
    agentIds.size > 1 ||
    (requestedAgentId && [...agentIds].some((agentId) => agentId !== requestedAgentId))
  ) {
    throw new Error("sessions.search supports one agent per call");
  }
  const agentId =
    requestedAgentId ??
    agentIds.values().next().value ??
    rt.resolveSessionAgentId({ sessionKey: "main", config: cfg });
  const result = await rt.searchSessionTranscripts({
    agentId,
    storePath: rt.resolveSessionStorePathCore(cfg.session?.store, { agentId }),
    query,
    limit: readPositiveIntegerParam(params, "limit"),
    sessionKeys,
  });
  return {
    results: result.hits,
    ...(result.archivedTranscriptsExcluded
      ? { archivedTranscriptsExcluded: result.archivedTranscriptsExcluded }
      : {}),
    ...(result.indexing ? { indexing: true } : {}),
    ...(result.truncated ? { truncated: true } : {}),
  };
}

async function handleChatHistory(params: Record<string, unknown>) {
  const rt = await getRuntime();

  const sessionKey = typeof params.sessionKey === "string" ? params.sessionKey : "";
  const agentId = typeof params.agentId === "string" ? params.agentId : undefined;
  const parsedAgentId = parseAgentSessionKey(sessionKey)?.agentId;
  const requestedAgentId = agentId ?? parsedAgentId;
  const limit = readPositiveIntegerParam(params, "limit");
  const offset = readNonNegativeIntegerParam(params, "offset");
  if (params.offset !== undefined && offset === undefined) {
    throw new Error("offset must be a non-negative integer");
  }
  const wireMessageId = readToolStringParam(params, "messageId", {
    required: params.messageId !== undefined,
  });
  const wireSessionId = readToolStringParam(params, "sessionId", {
    required: params.sessionId !== undefined,
  });
  const cursor = readToolStringParam(params, "cursor", { required: params.cursor !== undefined });
  const pageCursor = rt.decodeChatHistoryPageCursor(cursor);
  if (pageCursor === null) {
    throw new Error("invalid history page cursor");
  }
  if (offset !== undefined && wireMessageId !== undefined) {
    throw new Error("offset and messageId cannot be used together");
  }
  if (cursor !== undefined && (offset !== undefined || wireMessageId !== undefined)) {
    throw new Error("cursor cannot be used with offset or messageId");
  }
  if (wireSessionId !== undefined && wireMessageId === undefined) {
    throw new Error("sessionId requires messageId");
  }
  if (cursor !== undefined && !pageCursor) {
    throw new Error("delta cursors require a running gateway");
  }
  const messageId = pageCursor?.messageId ?? wireMessageId;
  const requestedSessionId = pageCursor?.sessionId ?? wireSessionId;
  const maxBytes = readPositiveIntegerParam(params, "maxBytes");
  if (maxBytes !== undefined && maxBytes < 1024) {
    throw new Error("maxBytes must be at least 1024");
  }

  const sessionLoadOptions = requestedAgentId ? { agentId: requestedAgentId } : undefined;
  const { cfg, storePath, entry, canonicalKey } = await rt.loadGatewaySessionEntryReadOnlyInWorker({
    cfg: rt.getRuntimeConfig(),
    key: sessionKey,
    ...sessionLoadOptions,
  });
  const sessionAgentId = rt.resolveSessionAgentId({
    sessionKey,
    config: cfg,
    agentId: requestedAgentId,
  });
  if (requestedSessionId) {
    const transcriptSessionKey = rt.resolveTranscriptSessionKeyBySessionId({
      agentId: sessionAgentId,
      sessionId: requestedSessionId,
      storePath,
    });
    if (
      !transcriptSessionKey ||
      scopeLegacySessionKeyToAgent({
        sessionKey: transcriptSessionKey,
        agentId: sessionAgentId,
      }) !== scopeLegacySessionKeyToAgent({ sessionKey: canonicalKey, agentId: sessionAgentId })
    ) {
      throw new Error("sessionId does not belong to sessionKey");
    }
  }
  const sessionId = requestedSessionId ?? entry?.sessionId;
  // Reset archives share a logical key, but not the replacement's start boundary or CLI binding.
  const historyEntry =
    requestedSessionId && requestedSessionId !== entry?.sessionId ? undefined : entry;
  const resolvedSessionModel = rt.resolveSessionModelRef(cfg, entry, sessionAgentId);
  const max = Math.min(1000, limit ?? 200);
  const maxHistoryBytes = Math.min(maxBytes ?? Infinity, rt.getMaxChatHistoryMessagesBytes());
  const effectiveMaxChars = rt.resolveEffectiveChatHistoryMaxChars();
  const pageParams = {
    entry: historyEntry,
    provider: resolvedSessionModel.provider,
    sessionId,
    storePath,
    sessionAgentId,
    canonicalKey,
    max,
    maxHistoryBytes,
    responseHistoryBytes: Math.min(512 * 1024, maxHistoryBytes),
    effectiveMaxChars,
    offset,
    messageId,
    ...(pageCursor ? { pageCursor } : {}),
  };
  const page = await rt.readChatHistoryPage(pageParams);
  const {
    messagesBytes: _messagesBytes,
    responseHistoryBytes: _responseHistoryBytes,
    omission: _omission,
    ...response
  } = rt.prepareChatHistoryResponsePage(page, pageParams);
  const responseOffset = page.responseOffset ?? offset;

  return {
    sessionKey,
    sessionId,
    ...response,
    ...(page.windowReset ? { windowReset: true } : {}),
    ...(responseOffset !== undefined ? { offset: responseOffset } : {}),
    thinkingLevel: entry?.thinkingLevel,
    fastMode: normalizeFastMode(entry?.fastMode),
    verboseLevel: entry?.verboseLevel,
  };
}

/** Creates a local callGateway replacement for supported session methods. */
export function createEmbeddedCallGateway(): EmbeddedCallGateway {
  return async <T = Record<string, unknown>>(opts: CallGatewayOptions): Promise<T> => {
    const method = opts.method?.trim();
    const params = (opts.params ?? {}) as Record<string, unknown>;

    switch (method) {
      case "sessions.list":
        return (await handleSessionsList(params)) as T;
      case "sessions.resolve":
        return (await handleSessionsResolve(params)) as T;
      case "sessions.search":
        return (await handleSessionsSearch(params)) as T;
      case "chat.history":
        return (await handleChatHistory(params)) as T;
      default:
        throw new Error(
          `Method "${method}" requires a running gateway (unavailable in local embedded mode).`,
        );
    }
  };
}
