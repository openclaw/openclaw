// Gateway HTTP session history endpoint.
// Serves JSON and SSE history snapshots backed by session transcripts.
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import { parseStrictPositiveInteger } from "@openclaw/normalization-core/number-coercion";
import { err, ok, type Result } from "@openclaw/normalization-core/result";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import {
  GATEWAY_CLIENT_IDS,
  GATEWAY_CLIENT_MODES,
} from "../../packages/gateway-protocol/src/client-info.js";
import { PROTOCOL_VERSION } from "../../packages/gateway-protocol/src/index.js";
import { getRuntimeConfig } from "../config/io.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { normalizeAgentId } from "../routing/session-key.js";
import {
  onInternalSessionTranscriptUpdate,
  readSessionTranscriptUpdateVersion,
} from "../sessions/transcript-events.js";
import type { AuthRateLimiter } from "./auth-rate-limit.js";
import type { ResolvedGatewayAuth } from "./auth.js";
import { DEFAULT_CHAT_HISTORY_TEXT_MAX_CHARS } from "./chat-display-projection.js";
import {
  sendInvalidRequest,
  sendJson,
  sendMethodNotAllowed,
  setSseHeaders,
  SSE_CONTENT_TYPE,
} from "./http-common.js";
import { hasExplicitAcceptableMediaRange } from "./http-media-range.js";
import {
  authorizeScopedGatewayHttpRequestOrReply,
  checkGatewayHttpRequestAuth,
  getHeader,
  resolveSharedSecretHttpOperatorScopes,
  type AuthorizedGatewayHttpRequest,
} from "./http-utils.js";
import { authorizeOperatorScopesForMethod } from "./method-scopes.js";
import type { GatewayClient } from "./server-methods/shared-types.js";
import { resolveSessionHistoryUnavailableMessage } from "./session-history-error.js";
import { resolveCursorSeq } from "./session-history-snapshot.js";
import {
  readSessionHistorySnapshotAsync,
  SessionHistorySseState,
} from "./session-history-state.js";
import { createSessionListEntryFilter, resolveSessionSharingTarget } from "./session-sharing.js";
import { resolveSessionStoreKey } from "./session-store-key.js";
import {
  resolveTranscriptPathForComparison,
  resolveTranscriptUpdatePathForComparison,
} from "./session-transcript-path.js";
import {
  resolveCanonicalSessionEntryFromStoreKeys,
  resolveGatewaySessionStoreTargetWithStore,
  resolveSessionTranscriptCandidates,
} from "./session-utils.js";

const log = createSubsystemLogger("gateway/sessions-history-sse");

const MAX_SESSION_HISTORY_LIMIT = 1000;

// Route misses must remain distinct from matched-invalid keys so fallback
// stages cannot claim malformed session-history requests.
type SessionHistoryPathResolution =
  | { matched: false }
  | { error: "invalid-session-key"; matched: true }
  | { matched: true; sessionKey: string };

function resolveSessionHistoryPath(url: URL): SessionHistoryPathResolution {
  const match = url.pathname.match(/^\/sessions\/([^/]+)\/history$/);
  if (!match) {
    return { matched: false };
  }
  try {
    const sessionKey = normalizeOptionalString(decodeURIComponent(match[1] ?? ""));
    return sessionKey
      ? { matched: true, sessionKey }
      : { error: "invalid-session-key", matched: true };
  } catch {
    return { error: "invalid-session-key", matched: true };
  }
}

function shouldStreamSse(req: IncomingMessage): boolean {
  return hasExplicitAcceptableMediaRange(getHeader(req, "accept"), SSE_CONTENT_TYPE);
}

function resolveLimit(url: URL): Result<number | undefined, string> {
  const raw = url.searchParams.get("limit");
  if (raw == null) {
    return ok(undefined);
  }
  const trimmed = raw.trim();
  const value = parseStrictPositiveInteger(trimmed);
  if (value !== undefined) {
    return ok(Math.min(MAX_SESSION_HISTORY_LIMIT, value));
  }
  if (/^\d+$/.test(trimmed) && /[1-9]/.test(trimmed)) {
    return ok(MAX_SESSION_HISTORY_LIMIT);
  }
  return err("limit must be a positive integer");
}

function sseWrite(res: ServerResponse, event: string, payload: unknown): void {
  res.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`);
}

function resolveSessionHistoryHttpClient(
  requestAuth: AuthorizedGatewayHttpRequest,
  scopes: string[],
): GatewayClient | null {
  if (!requestAuth.authenticatedUserProfile) {
    return null;
  }
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
      scopes,
    },
    authenticatedUserProfile: requestAuth.authenticatedUserProfile,
  };
}

/** Handle `/sessions/:sessionKey/history` JSON/SSE requests. */
export async function handleSessionHistoryHttpRequest(
  req: IncomingMessage,
  res: ServerResponse,
  opts: {
    auth: ResolvedGatewayAuth;
    getResolvedAuth?: () => ResolvedGatewayAuth;
    trustedProxies?: string[];
    allowRealIpFallback?: boolean;
    rateLimiter?: AuthRateLimiter;
  },
): Promise<boolean> {
  const url = new URL(req.url ?? "/", "http://localhost");
  const sessionKeyResolution = resolveSessionHistoryPath(url);
  if (!sessionKeyResolution.matched) {
    return false;
  }
  if ("error" in sessionKeyResolution) {
    sendInvalidRequest(res, "invalid session key");
    return true;
  }
  const { sessionKey } = sessionKeyResolution;
  if (req.method !== "GET") {
    sendMethodNotAllowed(res, "GET");
    return true;
  }

  // Session history intentionally uses the shared-secret HTTP trust model:
  // token/password bearer auth grants default operator scopes so simple API key
  // callers can read their own history without a scope header.
  const authResult = await authorizeScopedGatewayHttpRequestOrReply({
    req,
    res,
    auth: opts.auth,
    trustedProxies: opts.trustedProxies,
    allowRealIpFallback: opts.allowRealIpFallback,
    rateLimiter: opts.rateLimiter,
    operatorMethod: "chat.history",
    resolveOperatorScopes: resolveSharedSecretHttpOperatorScopes,
  });
  if (!authResult) {
    return true;
  }
  const { cfg, requestAuth, operatorScopes } = authResult;

  let target: ReturnType<typeof resolveGatewaySessionStoreTargetWithStore>;
  let entry: ReturnType<typeof resolveCanonicalSessionEntryFromStoreKeys>;
  try {
    target = resolveGatewaySessionStoreTargetWithStore({
      cfg,
      key: sessionKey,
      exactRead: true,
      // Preserve configured-store initialization; retired and incognito targets stay read-only.
      readOnly: false,
    });
    entry = resolveCanonicalSessionEntryFromStoreKeys(target.store, target.storeKeys);
  } catch (error) {
    if ((error as { code?: unknown })?.code !== "SESSION_CANONICAL_KEY_MIGRATION_REQUIRED") {
      throw error;
    }
    sendJson(res, 409, {
      ok: false,
      error: {
        type: "migration_required",
        message: error instanceof Error ? error.message : String(error),
      },
    });
    return true;
  }
  const sendSessionNotFound = () =>
    sendJson(res, 404, {
      ok: false,
      error: {
        type: "not_found",
        message: `Session not found: ${sessionKey}`,
      },
    });
  const historyClient = resolveSessionHistoryHttpClient(requestAuth, operatorScopes);
  if (
    !entry?.sessionId ||
    createSessionListEntryFilter({ cfg, client: historyClient })?.(target.canonicalKey, entry) ===
      false
  ) {
    sendSessionNotFound();
    return true;
  }
  const limitResult = resolveLimit(url);
  if (!limitResult.ok) {
    sendInvalidRequest(res, limitResult.error);
    return true;
  }
  const limit = limitResult.value;
  const cursor = normalizeOptionalString(url.searchParams.get("cursor"));
  if (cursor !== undefined && resolveCursorSeq(cursor) === undefined) {
    sendInvalidRequest(res, "cursor must be a positive integer");
    return true;
  }
  const effectiveMaxChars = DEFAULT_CHAT_HISTORY_TEXT_MAX_CHARS;
  const historyTarget = {
    agentId: target.agentId,
    sessionEntry: entry,
    sessionId: entry.sessionId,
    sessionKey: target.canonicalKey,
    storePath: target.storePath,
  };
  const publishAuthorizedHistory = async (publish: () => void): Promise<boolean> => {
    const cfgLocal = getRuntimeConfig();
    const currentRequestAuth = await checkGatewayHttpRequestAuth({
      req,
      auth: opts.getResolvedAuth?.() ?? opts.auth,
      trustedProxies: cfgLocal.gateway?.trustedProxies,
      allowRealIpFallback: cfgLocal.gateway?.allowRealIpFallback,
      rateLimiter: opts.rateLimiter,
      cfg: cfgLocal,
    });
    if (!currentRequestAuth.ok) {
      return false;
    }
    if (
      currentRequestAuth.requestAuth.authenticatedUserProfile?.profileId !==
      requestAuth.authenticatedUserProfile?.profileId
    ) {
      return false;
    }
    const requestedScopes = resolveSharedSecretHttpOperatorScopes(
      req,
      currentRequestAuth.requestAuth,
    );
    if (!authorizeOperatorScopesForMethod("chat.history", requestedScopes).allowed) {
      return false;
    }
    const currentClient = resolveSessionHistoryHttpClient(
      currentRequestAuth.requestAuth,
      requestedScopes,
    );
    const currentConfig = getRuntimeConfig();
    const currentTarget = resolveSessionSharingTarget({
      cfg: currentConfig,
      sessionKey: target.canonicalKey,
      agentId: target.agentId,
    });
    if (
      currentTarget === null ||
      currentTarget.agentId !== historyTarget.agentId ||
      currentTarget.canonicalKey !== historyTarget.sessionKey ||
      currentTarget.storePath !== historyTarget.storePath ||
      currentTarget.entry.sessionId !== historyTarget.sessionId ||
      currentTarget.entry.lifecycleRevision !== entry.lifecycleRevision ||
      (entry.sessionStartedAt !== undefined &&
        currentTarget.entry.sessionStartedAt !== entry.sessionStartedAt) ||
      createSessionListEntryFilter({ cfg: currentConfig, client: currentClient })?.(
        currentTarget.canonicalKey,
        currentTarget.entry,
      ) === false
    ) {
      return false;
    }
    // Keep the final owner check and publication in the same synchronous continuation.
    publish();
    return true;
  };

  const snapshotVersion = readSessionTranscriptUpdateVersion();
  let historySnapshot: Awaited<ReturnType<typeof readSessionHistorySnapshotAsync>>;
  try {
    historySnapshot = await readSessionHistorySnapshotAsync({
      cursor,
      target: historyTarget,
      limit,
      maxChars: effectiveMaxChars,
    });
  } catch (error) {
    const unavailableMessage = resolveSessionHistoryUnavailableMessage(error);
    if (unavailableMessage === undefined) {
      throw error;
    }
    res.setHeader("Retry-After", "1");
    sendJson(res, 503, {
      ok: false,
      error: {
        type: "unavailable",
        message: unavailableMessage,
        retryable: true,
      },
    });
    return true;
  }
  const stream = shouldStreamSse(req);
  if (
    !(await publishAuthorizedHistory(() => {
      if (!stream) {
        sendJson(res, 200, {
          sessionKey: target.canonicalKey,
          ...historySnapshot.history,
        });
      }
    }))
  ) {
    sendSessionNotFound();
    return true;
  }
  if (!stream) {
    return true;
  }

  // Legacy selectors map lexically to SQLite; following a JSON symlink could merge owners.
  const historyStorePath = path.resolve(target.storePath);
  const historyLifecycleRevision = normalizeOptionalString(entry.lifecycleRevision);
  const historyDatabasePath = resolveTranscriptPathForComparison(target.readSource?.path);
  const transcriptCandidates = new Set(
    resolveSessionTranscriptCandidates(
      historyTarget.sessionId,
      target.storePath,
      undefined,
      target.agentId,
    )
      .map((candidate) => resolveTranscriptPathForComparison(candidate))
      .filter((candidate): candidate is string => typeof candidate === "string"),
  );

  const sseState = SessionHistorySseState.fromSnapshot({
    target: historyTarget,
    maxChars: effectiveMaxChars,
    limit,
    cursor,
    snapshot: historySnapshot,
  });
  let streamStopped = false;
  let streamQueue = Promise.resolve();
  let pendingRefresh: (() => Promise<void>) | undefined;
  const streamResources: {
    heartbeat?: ReturnType<typeof setInterval>;
    unsubscribe?: () => void;
  } = {};

  function writeStreamHistory(snapshot: ReturnType<SessionHistorySseState["snapshot"]>) {
    sseWrite(res, "history", {
      sessionKey: target.canonicalKey,
      ...snapshot,
    });
    // Send the entire requested page before bounding private live state.
    // Cursor refreshes reread SQLite, so their next page remains complete.
    sseState.retainRecentMessages(MAX_SESSION_HISTORY_LIMIT);
  }

  async function publishStream(publish: () => void) {
    const authorized = await publishAuthorizedHistory(() => {
      if (!isStreamClosed()) {
        publish();
      }
    });
    if (!authorized) {
      closeStream();
    }
  }

  function releaseStreamResources() {
    if (streamStopped) {
      return;
    }
    streamStopped = true;
    if (streamResources.heartbeat) {
      clearInterval(streamResources.heartbeat);
    }
    if (streamResources.unsubscribe) {
      streamResources.unsubscribe();
    }
  }

  function detachStreamListeners() {
    req.off("close", handleRequestStreamClose);
    req.off("error", handleRequestStreamError);
    res.off("close", handleResponseStreamClose);
    res.off("finish", handleResponseStreamFinish);
    res.off("error", handleResponseStreamError);
  }

  function closeStream() {
    releaseStreamResources();
    if (!res.writableEnded && !res.destroyed) {
      res.end();
    }
  }

  function handleRequestStreamClose() {
    releaseStreamResources();
    req.off("close", handleRequestStreamClose);
    req.off("error", handleRequestStreamError);
  }

  function handleRequestStreamError(error: Error) {
    // Node HTTP streams emit process-fatal `error` events without listeners.
    // Request-side failures mean the SSE owner should release and end locally.
    log.warn("session history SSE request stream errored; closing stream", { error });
    closeStream();
  }

  function handleResponseStreamFinish() {
    releaseStreamResources();
    // `finish` only means Node handed the response bytes to the OS. Keep the
    // error listener until `close` so a late flush failure stays stream-local.
    res.off("finish", handleResponseStreamFinish);
  }

  function handleResponseStreamClose() {
    releaseStreamResources();
    detachStreamListeners();
  }

  function handleResponseStreamError(error: Error) {
    // The response stream is already failing, so only release local resources;
    // writing an end frame here can re-enter the errored ServerResponse.
    log.warn("session history SSE response stream errored; cleaning up stream", { error });
    releaseStreamResources();
  }
  const isStreamClosed = () => streamStopped || res.writableEnded || res.destroyed;

  req.on("close", handleRequestStreamClose);
  req.on("error", handleRequestStreamError);
  res.on("close", handleResponseStreamClose);
  res.on("finish", handleResponseStreamFinish);
  res.on("error", handleResponseStreamError);

  setSseHeaders(res);
  res.write("retry: 1000\n\n");
  if (isStreamClosed()) {
    return true;
  }
  const queueStreamWork = (work: () => Promise<void>) => {
    streamQueue = streamQueue
      .then(() => (isStreamClosed() ? undefined : work()))
      .catch((error: unknown) => {
        // Surface the underlying error so operators can distinguish transient
        // infrastructure failures (for example a `getRuntimeConfig()` read error
        // inside the reauth path) from deliberate revocation, then fail closed.
        log.warn("session history SSE stream work failed; closing stream", { error });
        closeStream();
      });
  };

  const queueStreamRefresh = () => {
    if (pendingRefresh) {
      return;
    }
    const refresh = async () => {
      await publishStream(() => {
        // Updates after this read starts need one trailing refresh.
        if (pendingRefresh === refresh) {
          pendingRefresh = undefined;
        }
      });
      if (!isStreamClosed()) {
        const snapshot = await sseState.refreshAsync();
        await publishStream(() => writeStreamHistory(snapshot));
      }
    };
    pendingRefresh = refresh;
    queueStreamWork(refresh);
  };

  // The listener is installed before this queued delivery runs. Refresh once if a
  // commit crossed the initial read; subsequent updates queue behind this snapshot.
  queueStreamWork(async () => {
    if (snapshotVersion !== readSessionTranscriptUpdateVersion()) {
      await sseState.refreshAsync();
    }
    await publishStream(() => writeStreamHistory(sseState.snapshot()));
  });

  streamResources.heartbeat = setInterval(() => {
    queueStreamWork(() => publishStream(() => res.write(": keepalive\n\n")));
  }, 15_000);

  streamResources.unsubscribe = onInternalSessionTranscriptUpdate((update) => {
    // Filter the global fan-out before retaining messages or scheduling async work.
    const updateTarget = update.target;
    const updateMatchesIdentity =
      updateTarget?.sessionId === historyTarget.sessionId &&
      normalizeAgentId(updateTarget.agentId) === normalizeAgentId(target.agentId) &&
      (updateTarget.sessionKey === historyTarget.sessionKey ||
        resolveSessionStoreKey({
          cfg: getRuntimeConfig(),
          sessionKey: updateTarget.sessionKey,
          storeAgentId: target.agentId,
        }) === historyTarget.sessionKey);
    const updateLifecycleRevision = normalizeOptionalString(update.lifecycleRevision);
    if (updateTarget && !updateMatchesIdentity) {
      return;
    }
    const updatePath = resolveTranscriptUpdatePathForComparison(update);
    if (!updateMatchesIdentity && (!updatePath || !transcriptCandidates.has(updatePath))) {
      return;
    }
    if (
      updateLifecycleRevision !== historyLifecycleRevision ||
      update.message === undefined ||
      limit !== undefined ||
      cursor !== undefined
    ) {
      queueStreamRefresh();
      return;
    }
    const updateStorePath = updateTarget?.storePath
      ? path.resolve(updateTarget.storePath)
      : undefined;
    const updateMatchesStore = updateStorePath?.endsWith(".sqlite")
      ? historyDatabasePath !== undefined &&
        resolveTranscriptUpdatePathForComparison(update, "storePath") === historyDatabasePath
      : updateStorePath === historyStorePath;
    if (updateTarget?.sessionKey !== historyTarget.sessionKey || !updateMatchesStore) {
      // Legacy notifications and unfamiliar aliases can invalidate canonical history,
      // but their carried payload does not establish physical or lifecycle ownership.
      queueStreamRefresh();
      return;
    }
    // Inline delivery is an ordering barrier: a later invalidation must still
    // repair this append even if an earlier refresh already contains its row.
    pendingRefresh = undefined;
    queueStreamWork(async () => {
      let refresh = false;
      await publishStream(() => {
        refresh = sseState.shouldRefreshForTranscriptPath(updatePath);
        if (refresh) {
          return;
        }
        const nextEvent = sseState.appendInlineMessage({
          message: update.message,
          messageId: update.messageId,
          messageSeq: update.messageSeq,
        });
        refresh = nextEvent?.shouldRefresh === true;
        if (refresh || nextEvent?.message === undefined) {
          return;
        }
        sseState.retainRecentMessages(MAX_SESSION_HISTORY_LIMIT);
        sseWrite(res, "message", {
          sessionKey: target.canonicalKey,
          message: nextEvent.message,
          ...(typeof update.messageId === "string" ? { messageId: update.messageId } : {}),
          messageSeq: nextEvent.messageSeq,
        });
      });
      if (refresh && !isStreamClosed()) {
        const snapshot = await sseState.refreshAsync();
        await publishStream(() => writeStreamHistory(snapshot));
      }
    });
  });
  return true;
}
