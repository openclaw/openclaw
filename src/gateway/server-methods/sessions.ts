import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { CURRENT_SESSION_VERSION } from "@mariozechner/pi-coding-agent";
import {
  bm25RankToScore,
  buildFtsQuery,
} from "../../../extensions/memory-core/src/memory/hybrid.js";
import {
  searchKeyword,
  type SearchRowResult,
} from "../../../extensions/memory-core/src/memory/manager-search.js";
import { resolveDefaultAgentId } from "../../agents/agent-scope.js";
import { resolveMemorySearchConfig } from "../../agents/memory-search.js";
import {
  abortEmbeddedPiRun,
  isEmbeddedPiRunActive,
  waitForEmbeddedPiRunEnd,
} from "../../agents/pi-embedded-runner/runs.js";
import {
  classifySessionKind,
  resolveMainSessionAlias,
} from "../../agents/tools/sessions-helpers.js";
import { resolveVisibleSessionKeys } from "../../agents/tools/sessions-visible-keys.js";
import { clearSessionQueues } from "../../auto-reply/reply/queue/cleanup.js";
import { loadConfig } from "../../config/config.js";
import {
  loadSessionStore,
  resolveMainSessionKey,
  resolveSessionFilePath,
  resolveSessionFilePathOptions,
  type SessionEntry,
  updateSessionStore,
} from "../../config/sessions.js";
import {
  hasInternalHookListeners,
  triggerInternalHook,
  type SessionPatchHookContext,
  type SessionPatchHookEvent,
} from "../../hooks/internal-hooks.js";
import { redactSensitiveText } from "../../logging/redact.js";
import {
  normalizeAgentId,
  parseAgentSessionKey,
  resolveAgentIdFromSessionKey,
} from "../../routing/session-key.js";
import { GATEWAY_CLIENT_IDS } from "../protocol/client-info.js";
import {
  ErrorCodes,
  errorShape,
  validateSessionsAbortParams,
  validateSessionsCompactParams,
  validateSessionsCreateParams,
  validateSessionsDeleteParams,
  validateSessionsListParams,
  validateSessionsMessagesSubscribeParams,
  validateSessionsMessagesUnsubscribeParams,
  validateSessionsPatchParams,
  validateSessionsPreviewParams,
  validateSessionsResetParams,
  validateSessionsRecallParams,
  validateSessionsResolveParams,
  validateSessionsSearchParams,
  validateSessionsSendParams,
} from "../protocol/index.js";
import {
  archiveSessionTranscriptsForSession,
  cleanupSessionBeforeMutation,
  emitSessionUnboundLifecycleEvent,
  performGatewaySessionReset,
} from "../session-reset-service.js";
import { reactivateCompletedSubagentSession } from "../session-subagent-reactivation.js";
import {
  archiveFileOnDisk,
  listSessionsFromStore,
  loadCombinedSessionStoreForGateway,
  loadGatewaySessionRow,
  loadSessionEntry,
  migrateAndPruneGatewaySessionStoreKey,
  readSessionPreviewItemsFromTranscript,
  resolveFreshestSessionEntryFromStoreKeys,
  resolveGatewaySessionStoreTarget,
  resolveSessionModelRef,
  resolveSessionTranscriptCandidates,
  type SessionsPatchResult,
  type SessionsPreviewEntry,
  type SessionsPreviewResult,
  readSessionMessages,
} from "../session-utils.js";
import { applySessionsPatchToStore } from "../sessions-patch.js";
import { resolveSessionKeyFromResolveParams } from "../sessions-resolve.js";
import { chatHandlers } from "./chat.js";
import type {
  GatewayClient,
  GatewayRequestContext,
  GatewayRequestHandlerOptions,
  GatewayRequestHandlers,
  RespondFn,
} from "./types.js";
import { assertValidParams } from "./validation.js";

const SESSION_SEARCH_FTS_TABLE = "chunks_fts";
const SESSIONS_RECALL_MAX_EVIDENCE_CHARS_PER_HIT = 700;
const SESSIONS_RECALL_MAX_EVIDENCE_CHARS_TOTAL = 4_000;

/** Gateway `sessions.list` row kinds (`classifySessionKey`). */
const GATEWAY_SESSION_ROW_KINDS = new Set(["direct", "group", "global", "unknown"]);

function normalizeSessionsSearchKinds(kinds: string[] | undefined): Set<string> | undefined {
  if (!kinds?.length) {
    return undefined;
  }
  const next = new Set<string>();
  for (const raw of kinds) {
    if (typeof raw !== "string") {
      continue;
    }
    const trimmed = raw.trim().toLowerCase();
    if (trimmed) {
      next.add(trimmed);
    }
  }
  return next.size > 0 ? next : undefined;
}

/**
 * `sessions.search` accepts either gateway row kinds (`direct`, …) or the same tool-facing labels as
 * `sessions_list` (`main`, `group`, `cron`, …). If the request mixes both, prefer tool semantics so
 * `main`/`cron`/… are not misread as gateway kinds.
 */
function useToolFacingKindFilter(normalizedKinds: Set<string>): boolean {
  const hasToolOnly = [...normalizedKinds].some((k) => !GATEWAY_SESSION_ROW_KINDS.has(k));
  const hasGatewayOnly = [...normalizedKinds].some((k) => GATEWAY_SESSION_ROW_KINDS.has(k));
  if (hasToolOnly && hasGatewayOnly) {
    return true;
  }
  return hasToolOnly;
}

/**
 * Session FTS (`sessions.search` / `sessions.recall`):
 *
 * Session transcript chunks are indexed into **per-agent** SQLite memory stores. Path resolution is
 * `resolveMemorySearchConfig(cfg, agentId).store.path` → `resolveStorePath` in `memory-search.ts`
 * (default: `{stateDir}/memory/{agentId}.sqlite`, or a user path with `{agentId}` substituted).
 *
 * A gateway-visible session list can span **multiple** agent ids (`resolveAgentIdFromSessionKey`).
 * Correct search must therefore query **each distinct agent memory DB** that backs at least one
 * visible session (dedupe by resolved `store.path` when configs collide), merge hits, then apply
 * the existing `allowedPaths` filter and global `limit`. Opening **only**
 * `resolveMemorySearchConfig(cfg, resolveDefaultAgentId(cfg))` misses chunks for non-default agents.
 */

type SessionSearchResultRow = {
  sessionKey: string;
  sessionId: string;
  snippet: string;
  score: number;
  startLine: number;
  endLine: number;
};

type SessionRecallCitation = {
  sessionKey: string;
  sessionId: string;
  lineRange: [number, number];
  source: string;
  evidenceId?: string;
};

type SessionRecallEvidence = {
  text: string;
  citation: SessionRecallCitation;
};

async function searchSessionsViaFts(params: {
  query: string;
  limit: number;
  cfg: ReturnType<typeof loadConfig>;
  requesterSessionKey?: string;
  sandboxed?: boolean;
  activeMinutes?: number;
  kinds?: string[];
  requestedKeys?: string[];
}): Promise<{ count: number; results: SessionSearchResultRow[] }> {
  const visibleKeys = await resolveVisibleSessionKeys({
    cfg: params.cfg,
    agentSessionKey: params.requesterSessionKey,
    sandboxed: params.sandboxed,
  });

  const { mainKey, alias } = resolveMainSessionAlias(params.cfg);
  const { storePath, store } = loadCombinedSessionStoreForGateway(params.cfg);
  const listed = listSessionsFromStore({
    cfg: params.cfg,
    storePath,
    store,
    opts: {
      includeGlobal: false,
      includeUnknown: false,
      ...(typeof params.activeMinutes === "number" ? { activeMinutes: params.activeMinutes } : {}),
    },
  });
  const normalizedKinds = normalizeSessionsSearchKinds(params.kinds);
  const toolFacingKindFilter =
    normalizedKinds !== undefined ? useToolFacingKindFilter(normalizedKinds) : false;
  const requestedKeys = params.requestedKeys?.length ? new Set(params.requestedKeys) : undefined;
  const allowedPaths = new Set<string>();
  const pathToSession = new Map<string, { sessionKey: string; sessionId: string }>();
  const distinctAgentIds = new Set<string>();
  for (const row of listed.sessions) {
    const key = typeof row.key === "string" ? row.key : "";
    const sessionId = typeof row.sessionId === "string" ? row.sessionId : "";
    if (!key || !sessionId) {
      continue;
    }
    if (visibleKeys && !visibleKeys.has(key)) {
      continue;
    }
    if (normalizedKinds) {
      if (toolFacingKindFilter) {
        const toolKind = classifySessionKind({
          key,
          gatewayKind: typeof row.kind === "string" ? row.kind : undefined,
          alias,
          mainKey,
        });
        if (!normalizedKinds.has(toolKind)) {
          continue;
        }
      } else {
        const gk = typeof row.kind === "string" ? row.kind.trim().toLowerCase() : "";
        if (!gk || !normalizedKinds.has(gk)) {
          continue;
        }
      }
    }
    if (requestedKeys && !requestedKeys.has(key)) {
      continue;
    }
    distinctAgentIds.add(normalizeAgentId(resolveAgentIdFromSessionKey(key)));
    const storedSessionFile = loadSessionEntry(key).entry?.sessionFile;
    const transcriptCandidates = resolveSessionTranscriptCandidates(
      sessionId,
      storePath,
      storedSessionFile,
      resolveAgentIdFromSessionKey(key),
    );
    for (const candidate of transcriptCandidates) {
      const relPath = path.relative(storePath, candidate).replace(/\\/g, "/");
      if (!relPath) {
        continue;
      }
      allowedPaths.add(relPath);
      pathToSession.set(relPath, { sessionKey: key, sessionId });
    }
  }
  if (allowedPaths.size === 0 && visibleKeys !== null) {
    return { count: 0, results: [] };
  }

  const storePathsSeen = new Set<string>();
  const memoryDbPaths: string[] = [];
  for (const agentId of distinctAgentIds) {
    const memCfg = resolveMemorySearchConfig(params.cfg, agentId);
    if (!memCfg) {
      continue;
    }
    const storeFilePath = memCfg.store.path;
    if (storePathsSeen.has(storeFilePath)) {
      continue;
    }
    storePathsSeen.add(storeFilePath);
    memoryDbPaths.push(storeFilePath);
  }
  if (memoryDbPaths.length === 0) {
    return { count: 0, results: [] };
  }

  const perDbLimit = Math.max(1, params.limit * 3);
  const mergedHits: Array<SearchRowResult & { textScore: number }> = [];
  for (const dbPath of memoryDbPaths) {
    let db: DatabaseSync;
    try {
      db = new DatabaseSync(dbPath);
    } catch {
      continue;
    }
    try {
      const hits = await searchKeyword({
        db,
        ftsTable: SESSION_SEARCH_FTS_TABLE,
        providerModel: undefined,
        query: params.query,
        limit: perDbLimit,
        snippetMaxChars: 500,
        sourceFilter: { sql: " AND source = ?", params: ["sessions"] },
        buildFtsQuery,
        bm25RankToScore,
      });
      mergedHits.push(...hits);
    } catch {
      // Missing table / corrupt DB — skip this store (same resilience as single-DB path).
    } finally {
      db.close();
    }
  }
  mergedHits.sort((a, b) => b.score - a.score);

  const rows: SessionSearchResultRow[] = [];
  for (const hit of mergedHits) {
    const relPath = hit.path.replace(/\\/g, "/");
    if (allowedPaths.size > 0 && !allowedPaths.has(relPath)) {
      continue;
    }
    const session = pathToSession.get(relPath);
    if (!session) {
      continue;
    }
    rows.push({
      sessionKey: session.sessionKey,
      sessionId: session.sessionId,
      snippet: hit.snippet,
      score: hit.score,
      startLine: hit.startLine,
      endLine: hit.endLine,
    });
    if (rows.length >= params.limit) {
      break;
    }
  }
  return { count: rows.length, results: rows };
}

function extractSessionMessageText(message: unknown): string {
  if (!message || typeof message !== "object") {
    return "";
  }
  const entry = message as Record<string, unknown>;
  const content = entry.content;
  if (typeof content === "string") {
    return content.trim();
  }
  if (Array.isArray(content)) {
    return content
      .map((block) => {
        if (!block || typeof block !== "object") {
          return "";
        }
        const blockText = (block as { text?: unknown }).text;
        return typeof blockText === "string" ? blockText.trim() : "";
      })
      .filter(Boolean)
      .join("\n")
      .trim();
  }
  const text = entry.text;
  return typeof text === "string" ? text.trim() : "";
}

function buildSessionRecallEvidence(params: {
  sessionKey: string;
  sessionId: string;
  storePath: string;
  sessionFile?: string;
  startLine: number;
  endLine: number;
}): SessionRecallEvidence | null {
  const transcriptPath = resolveSessionTranscriptCandidates(
    params.sessionId,
    params.storePath,
    params.sessionFile,
  ).find((candidate) => fs.existsSync(candidate));
  if (!transcriptPath) {
    return null;
  }
  const lines = fs.readFileSync(transcriptPath, "utf-8").split(/\r?\n/);
  const blocks: string[] = [];
  let hasStableId = false;
  let stableId: string | undefined;
  const fromLine = Math.max(1, params.startLine);
  const toLine = Math.max(fromLine, params.endLine);
  for (let index = fromLine - 1; index < lines.length && index <= toLine - 1; index += 1) {
    const line = lines[index];
    if (!line?.trim()) {
      continue;
    }
    try {
      const parsed = JSON.parse(line) as { id?: unknown; message?: unknown };
      const text = extractSessionMessageText(parsed?.message);
      if (!text) {
        continue;
      }
      const redacted = redactSensitiveText(text);
      if (!redacted.trim()) {
        continue;
      }
      blocks.push(redacted.trim());
      if (!hasStableId && typeof parsed.id === "string" && parsed.id.trim().length > 0) {
        hasStableId = true;
        stableId = parsed.id;
      }
    } catch {
      continue;
    }
  }
  if (blocks.length === 0) {
    return null;
  }
  const joined = blocks.join("\n");
  const text =
    joined.length > SESSIONS_RECALL_MAX_EVIDENCE_CHARS_PER_HIT
      ? `${joined.slice(0, SESSIONS_RECALL_MAX_EVIDENCE_CHARS_PER_HIT)}\n…(truncated)…`
      : joined;
  const source = `session:${params.sessionKey}#L${fromLine}-L${toLine}`;
  return {
    text,
    citation: {
      sessionKey: params.sessionKey,
      sessionId: params.sessionId,
      lineRange: [fromLine, toLine],
      source,
      ...(stableId ? { evidenceId: stableId } : {}),
    },
  };
}

function buildSessionRecallSummary(params: {
  query: string;
  evidences: SessionRecallEvidence[];
  maxTokens: number;
}): string {
  if (params.evidences.length === 0) {
    return "No relevant prior sessions found.";
  }
  const approxCharBudget = Math.max(800, params.maxTokens * 4);
  const bullets: string[] = [];
  let used = 0;
  for (const evidence of params.evidences) {
    const head = evidence.text.replace(/\s+/g, " ").trim();
    const fragment = `- ${head} (Source: ${evidence.citation.source})`;
    if (used + fragment.length > approxCharBudget) {
      break;
    }
    bullets.push(fragment);
    used += fragment.length;
    if (bullets.length >= 4) {
      break;
    }
  }
  if (bullets.length === 0) {
    return "No relevant prior sessions found.";
  }
  return [`Recall for: ${params.query}`, ...bullets].join("\n");
}

function requireSessionKey(key: unknown, respond: RespondFn): string | null {
  const raw =
    typeof key === "string"
      ? key
      : typeof key === "number"
        ? String(key)
        : typeof key === "bigint"
          ? String(key)
          : "";
  const normalized = raw.trim();
  if (!normalized) {
    respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "key required"));
    return null;
  }
  return normalized;
}

function resolveGatewaySessionTargetFromKey(key: string) {
  const cfg = loadConfig();
  const target = resolveGatewaySessionStoreTarget({ cfg, key });
  return { cfg, target, storePath: target.storePath };
}

function resolveOptionalInitialSessionMessage(params: {
  task?: unknown;
  message?: unknown;
}): string | undefined {
  if (typeof params.task === "string" && params.task.trim()) {
    return params.task;
  }
  if (typeof params.message === "string" && params.message.trim()) {
    return params.message;
  }
  return undefined;
}

function shouldAttachPendingMessageSeq(params: { payload: unknown; cached?: boolean }): boolean {
  if (params.cached) {
    return false;
  }
  const status =
    params.payload && typeof params.payload === "object"
      ? (params.payload as { status?: unknown }).status
      : undefined;
  return status === "started";
}

function emitSessionsChanged(
  context: Pick<GatewayRequestContext, "broadcastToConnIds" | "getSessionEventSubscriberConnIds">,
  payload: { sessionKey?: string; reason: string; compacted?: boolean },
) {
  const connIds = context.getSessionEventSubscriberConnIds();
  if (connIds.size === 0) {
    return;
  }
  const sessionRow = payload.sessionKey ? loadGatewaySessionRow(payload.sessionKey) : null;
  context.broadcastToConnIds(
    "sessions.changed",
    {
      ...payload,
      ts: Date.now(),
      ...(sessionRow
        ? {
            updatedAt: sessionRow.updatedAt ?? undefined,
            sessionId: sessionRow.sessionId,
            kind: sessionRow.kind,
            channel: sessionRow.channel,
            subject: sessionRow.subject,
            groupChannel: sessionRow.groupChannel,
            space: sessionRow.space,
            chatType: sessionRow.chatType,
            origin: sessionRow.origin,
            spawnedBy: sessionRow.spawnedBy,
            spawnedWorkspaceDir: sessionRow.spawnedWorkspaceDir,
            forkedFromParent: sessionRow.forkedFromParent,
            spawnDepth: sessionRow.spawnDepth,
            subagentRole: sessionRow.subagentRole,
            subagentControlScope: sessionRow.subagentControlScope,
            label: sessionRow.label,
            displayName: sessionRow.displayName,
            deliveryContext: sessionRow.deliveryContext,
            parentSessionKey: sessionRow.parentSessionKey,
            childSessions: sessionRow.childSessions,
            thinkingLevel: sessionRow.thinkingLevel,
            fastMode: sessionRow.fastMode,
            verboseLevel: sessionRow.verboseLevel,
            reasoningLevel: sessionRow.reasoningLevel,
            elevatedLevel: sessionRow.elevatedLevel,
            sendPolicy: sessionRow.sendPolicy,
            systemSent: sessionRow.systemSent,
            abortedLastRun: sessionRow.abortedLastRun,
            inputTokens: sessionRow.inputTokens,
            outputTokens: sessionRow.outputTokens,
            lastChannel: sessionRow.lastChannel,
            lastTo: sessionRow.lastTo,
            lastAccountId: sessionRow.lastAccountId,
            lastThreadId: sessionRow.lastThreadId,
            totalTokens: sessionRow.totalTokens,
            totalTokensFresh: sessionRow.totalTokensFresh,
            contextTokens: sessionRow.contextTokens,
            estimatedCostUsd: sessionRow.estimatedCostUsd,
            responseUsage: sessionRow.responseUsage,
            modelProvider: sessionRow.modelProvider,
            model: sessionRow.model,
            status: sessionRow.status,
            startedAt: sessionRow.startedAt,
            endedAt: sessionRow.endedAt,
            runtimeMs: sessionRow.runtimeMs,
          }
        : {}),
    },
    connIds,
    { dropIfSlow: true },
  );
}

function rejectWebchatSessionMutation(params: {
  action: "patch" | "delete";
  client: GatewayClient | null;
  isWebchatConnect: (params: GatewayClient["connect"] | null | undefined) => boolean;
  respond: RespondFn;
}): boolean {
  if (!params.client?.connect || !params.isWebchatConnect(params.client.connect)) {
    return false;
  }
  if (params.client.connect.client.id === GATEWAY_CLIENT_IDS.CONTROL_UI) {
    return false;
  }
  params.respond(
    false,
    undefined,
    errorShape(
      ErrorCodes.INVALID_REQUEST,
      `webchat clients cannot ${params.action} sessions; use chat.send for session-scoped updates`,
    ),
  );
  return true;
}

function buildDashboardSessionKey(agentId: string): string {
  return `agent:${agentId}:dashboard:${randomUUID()}`;
}

function ensureSessionTranscriptFile(params: {
  sessionId: string;
  storePath: string;
  sessionFile?: string;
  agentId: string;
}): { ok: true; transcriptPath: string } | { ok: false; error: string } {
  try {
    const transcriptPath = resolveSessionFilePath(
      params.sessionId,
      params.sessionFile ? { sessionFile: params.sessionFile } : undefined,
      resolveSessionFilePathOptions({
        storePath: params.storePath,
        agentId: params.agentId,
      }),
    );
    if (!fs.existsSync(transcriptPath)) {
      fs.mkdirSync(path.dirname(transcriptPath), { recursive: true });
      const header = {
        type: "session",
        version: CURRENT_SESSION_VERSION,
        id: params.sessionId,
        timestamp: new Date().toISOString(),
        cwd: process.cwd(),
      };
      fs.writeFileSync(transcriptPath, `${JSON.stringify(header)}\n`, {
        encoding: "utf-8",
        mode: 0o600,
      });
    }
    return { ok: true, transcriptPath };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

function resolveAbortSessionKey(params: {
  context: Pick<GatewayRequestContext, "chatAbortControllers">;
  requestedKey: string;
  canonicalKey: string;
  runId?: string;
}): string {
  const activeRunKey =
    typeof params.runId === "string"
      ? params.context.chatAbortControllers.get(params.runId)?.sessionKey
      : undefined;
  if (activeRunKey) {
    return activeRunKey;
  }
  for (const active of params.context.chatAbortControllers.values()) {
    if (active.sessionKey === params.canonicalKey) {
      return params.canonicalKey;
    }
    if (active.sessionKey === params.requestedKey) {
      return params.requestedKey;
    }
  }
  return params.requestedKey;
}

function hasTrackedActiveSessionRun(params: {
  context: Pick<GatewayRequestContext, "chatAbortControllers">;
  requestedKey: string;
  canonicalKey: string;
}): boolean {
  for (const active of params.context.chatAbortControllers.values()) {
    if (active.sessionKey === params.canonicalKey || active.sessionKey === params.requestedKey) {
      return true;
    }
  }
  return false;
}

async function interruptSessionRunIfActive(params: {
  req: GatewayRequestHandlerOptions["req"];
  context: GatewayRequestContext;
  client: GatewayClient | null;
  isWebchatConnect: GatewayRequestHandlerOptions["isWebchatConnect"];
  requestedKey: string;
  canonicalKey: string;
  sessionId?: string;
}): Promise<{ interrupted: boolean; error?: ReturnType<typeof errorShape> }> {
  const hasTrackedRun = hasTrackedActiveSessionRun({
    context: params.context,
    requestedKey: params.requestedKey,
    canonicalKey: params.canonicalKey,
  });
  const hasEmbeddedRun =
    typeof params.sessionId === "string" && params.sessionId
      ? isEmbeddedPiRunActive(params.sessionId)
      : false;

  if (!hasTrackedRun && !hasEmbeddedRun) {
    return { interrupted: false };
  }

  if (hasTrackedRun) {
    let abortOk = true;
    let abortError: ReturnType<typeof errorShape> | undefined;
    const abortSessionKey = resolveAbortSessionKey({
      context: params.context,
      requestedKey: params.requestedKey,
      canonicalKey: params.canonicalKey,
    });

    await chatHandlers["chat.abort"]({
      req: params.req,
      params: {
        sessionKey: abortSessionKey,
      },
      respond: (ok, _payload, error) => {
        abortOk = ok;
        abortError = error;
      },
      context: params.context,
      client: params.client,
      isWebchatConnect: params.isWebchatConnect,
    });

    if (!abortOk) {
      return {
        interrupted: true,
        error:
          abortError ?? errorShape(ErrorCodes.UNAVAILABLE, "failed to interrupt active session"),
      };
    }
  }

  if (hasEmbeddedRun && params.sessionId) {
    abortEmbeddedPiRun(params.sessionId);
  }

  clearSessionQueues([params.requestedKey, params.canonicalKey, params.sessionId]);

  if (hasEmbeddedRun && params.sessionId) {
    const ended = await waitForEmbeddedPiRunEnd(params.sessionId, 15_000);
    if (!ended) {
      return {
        interrupted: true,
        error: errorShape(
          ErrorCodes.UNAVAILABLE,
          `Session ${params.requestedKey} is still active; try again in a moment.`,
        ),
      };
    }
  }

  return { interrupted: true };
}

async function handleSessionSend(params: {
  method: "sessions.send" | "sessions.steer";
  req: GatewayRequestHandlerOptions["req"];
  params: Record<string, unknown>;
  respond: RespondFn;
  context: GatewayRequestContext;
  client: GatewayClient | null;
  isWebchatConnect: GatewayRequestHandlerOptions["isWebchatConnect"];
  interruptIfActive: boolean;
}) {
  if (
    !assertValidParams(params.params, validateSessionsSendParams, params.method, params.respond)
  ) {
    return;
  }
  const p = params.params;
  const key = requireSessionKey((p as { key?: unknown }).key, params.respond);
  if (!key) {
    return;
  }
  const { entry, canonicalKey, storePath } = loadSessionEntry(key);
  if (!entry?.sessionId) {
    params.respond(
      false,
      undefined,
      errorShape(ErrorCodes.INVALID_REQUEST, `session not found: ${key}`),
    );
    return;
  }

  let interruptedActiveRun = false;
  if (params.interruptIfActive) {
    const interruptResult = await interruptSessionRunIfActive({
      req: params.req,
      context: params.context,
      client: params.client,
      isWebchatConnect: params.isWebchatConnect,
      requestedKey: key,
      canonicalKey,
      sessionId: entry.sessionId,
    });
    if (interruptResult.error) {
      params.respond(false, undefined, interruptResult.error);
      return;
    }
    interruptedActiveRun = interruptResult.interrupted;
  }

  const messageSeq = readSessionMessages(entry.sessionId, storePath, entry.sessionFile).length + 1;
  let sendAcked = false;
  let sendPayload: unknown;
  let sendCached = false;
  let startedRunId: string | undefined;
  const rawIdempotencyKey = (p as { idempotencyKey?: string }).idempotencyKey;
  const idempotencyKey =
    typeof rawIdempotencyKey === "string" && rawIdempotencyKey.trim()
      ? rawIdempotencyKey.trim()
      : randomUUID();
  await chatHandlers["chat.send"]({
    req: params.req,
    params: {
      sessionKey: canonicalKey,
      message: (p as { message: string }).message,
      thinking: (p as { thinking?: string }).thinking,
      attachments: (p as { attachments?: unknown[] }).attachments,
      timeoutMs: (p as { timeoutMs?: number }).timeoutMs,
      idempotencyKey,
    },
    respond: (ok, payload, error, meta) => {
      sendAcked = ok;
      sendPayload = payload;
      sendCached = meta?.cached === true;
      startedRunId =
        payload &&
        typeof payload === "object" &&
        typeof (payload as { runId?: unknown }).runId === "string"
          ? (payload as { runId: string }).runId
          : undefined;
      if (ok && shouldAttachPendingMessageSeq({ payload, cached: meta?.cached === true })) {
        params.respond(
          true,
          {
            ...(payload && typeof payload === "object" ? payload : {}),
            messageSeq,
            ...(interruptedActiveRun ? { interruptedActiveRun: true } : {}),
          },
          undefined,
          meta,
        );
        return;
      }
      params.respond(
        ok,
        ok && payload && typeof payload === "object"
          ? {
              ...payload,
              ...(interruptedActiveRun ? { interruptedActiveRun: true } : {}),
            }
          : payload,
        error,
        meta,
      );
    },
    context: params.context,
    client: params.client,
    isWebchatConnect: params.isWebchatConnect,
  });
  if (sendAcked) {
    if (shouldAttachPendingMessageSeq({ payload: sendPayload, cached: sendCached })) {
      await reactivateCompletedSubagentSession({
        sessionKey: canonicalKey,
        runId: startedRunId,
      });
    }
    emitSessionsChanged(params.context, {
      sessionKey: canonicalKey,
      reason: interruptedActiveRun ? "steer" : "send",
    });
  }
}
export const sessionsHandlers: GatewayRequestHandlers = {
  "sessions.list": ({ params, respond }) => {
    if (!assertValidParams(params, validateSessionsListParams, "sessions.list", respond)) {
      return;
    }
    const p = params;
    const cfg = loadConfig();
    const { storePath, store } = loadCombinedSessionStoreForGateway(cfg);
    const result = listSessionsFromStore({
      cfg,
      storePath,
      store,
      opts: p,
    });
    respond(true, result, undefined);
  },
  "sessions.search": async ({ params, respond }) => {
    if (!assertValidParams(params, validateSessionsSearchParams, "sessions.search", respond)) {
      return;
    }
    const p = params;
    const query = typeof p.query === "string" ? p.query.trim() : "";
    if (!query) {
      respond(true, { count: 0, results: [] }, undefined);
      return;
    }
    const limit =
      typeof p.limit === "number" && Number.isFinite(p.limit)
        ? Math.min(50, Math.max(1, Math.floor(p.limit)))
        : 10;
    const activeMinutes =
      typeof p.activeMinutes === "number" && Number.isFinite(p.activeMinutes)
        ? Math.max(1, Math.floor(p.activeMinutes))
        : undefined;
    const kinds = Array.isArray(p.kinds)
      ? p.kinds.filter(
          (value): value is string => typeof value === "string" && value.trim().length > 0,
        )
      : undefined;
    const requestedKeys = Array.isArray(p.keys)
      ? p.keys.filter(
          (value): value is string => typeof value === "string" && value.trim().length > 0,
        )
      : undefined;
    const cfg = loadConfig();
    const requesterSessionKey =
      typeof p.requesterSessionKey === "string" && p.requesterSessionKey.trim()
        ? p.requesterSessionKey.trim()
        : undefined;
    const searchResult = await searchSessionsViaFts({
      cfg,
      query,
      limit,
      requesterSessionKey,
      sandboxed: p.sandboxed === true,
      activeMinutes,
      kinds,
      requestedKeys,
    });
    respond(true, searchResult, undefined);
  },
  "sessions.recall": async ({ params, respond }) => {
    if (!assertValidParams(params, validateSessionsRecallParams, "sessions.recall", respond)) {
      return;
    }
    const p = params;
    const query = typeof p.query === "string" ? p.query.trim() : "";
    if (!query) {
      respond(
        true,
        { summary: "No relevant prior sessions found.", citations: [], cached: false },
        undefined,
      );
      return;
    }
    const limit =
      typeof p.limit === "number" && Number.isFinite(p.limit)
        ? Math.min(20, Math.max(1, Math.floor(p.limit)))
        : 8;
    const maxTokens =
      typeof p.maxTokens === "number" && Number.isFinite(p.maxTokens)
        ? Math.min(4000, Math.max(256, Math.floor(p.maxTokens)))
        : 2000;
    const activeMinutes = p.scope === "recent" ? 60 * 24 * 14 : undefined;
    const cfg = loadConfig();
    const requesterSessionKey =
      typeof p.requesterSessionKey === "string" && p.requesterSessionKey.trim()
        ? p.requesterSessionKey.trim()
        : undefined;
    const searchResult = await searchSessionsViaFts({
      cfg,
      query,
      limit,
      requesterSessionKey,
      sandboxed: p.sandboxed === true,
      activeMinutes,
    });
    if (!Array.isArray(searchResult.results) || searchResult.results.length === 0) {
      respond(
        true,
        { summary: "No relevant prior sessions found.", citations: [], cached: false },
        undefined,
      );
      return;
    }
    const recalls: SessionRecallEvidence[] = [];
    let totalChars = 0;
    for (const hit of searchResult.results) {
      const session = loadSessionEntry(hit.sessionKey);
      const evidence = session.entry?.sessionId
        ? buildSessionRecallEvidence({
            sessionKey: hit.sessionKey,
            sessionId: hit.sessionId,
            storePath: session.storePath,
            sessionFile: session.entry.sessionFile,
            startLine: hit.startLine,
            endLine: hit.endLine,
          })
        : null;
      if (!evidence) {
        continue;
      }
      const cost = evidence.text.length;
      if (totalChars + cost > SESSIONS_RECALL_MAX_EVIDENCE_CHARS_TOTAL) {
        break;
      }
      recalls.push(evidence);
      totalChars += cost;
    }
    const citations = recalls.map((entry) => entry.citation);
    const summary = buildSessionRecallSummary({
      query,
      evidences: recalls,
      maxTokens,
    });
    respond(
      true,
      {
        summary,
        citations,
        cached: false,
      },
      undefined,
    );
  },
  "sessions.subscribe": ({ client, context, respond }) => {
    const connId = client?.connId?.trim();
    if (connId) {
      context.subscribeSessionEvents(connId);
    }
    respond(true, { subscribed: Boolean(connId) }, undefined);
  },
  "sessions.unsubscribe": ({ client, context, respond }) => {
    const connId = client?.connId?.trim();
    if (connId) {
      context.unsubscribeSessionEvents(connId);
    }
    respond(true, { subscribed: false }, undefined);
  },
  "sessions.messages.subscribe": ({ params, client, context, respond }) => {
    if (
      !assertValidParams(
        params,
        validateSessionsMessagesSubscribeParams,
        "sessions.messages.subscribe",
        respond,
      )
    ) {
      return;
    }
    const connId = client?.connId?.trim();
    const key = requireSessionKey((params as { key?: unknown }).key, respond);
    if (!key) {
      return;
    }
    const { canonicalKey } = loadSessionEntry(key);
    if (connId) {
      context.subscribeSessionMessageEvents(connId, canonicalKey);
      respond(true, { subscribed: true, key: canonicalKey }, undefined);
      return;
    }
    respond(true, { subscribed: false, key: canonicalKey }, undefined);
  },
  "sessions.messages.unsubscribe": ({ params, client, context, respond }) => {
    if (
      !assertValidParams(
        params,
        validateSessionsMessagesUnsubscribeParams,
        "sessions.messages.unsubscribe",
        respond,
      )
    ) {
      return;
    }
    const connId = client?.connId?.trim();
    const key = requireSessionKey((params as { key?: unknown }).key, respond);
    if (!key) {
      return;
    }
    const { canonicalKey } = loadSessionEntry(key);
    if (connId) {
      context.unsubscribeSessionMessageEvents(connId, canonicalKey);
    }
    respond(true, { subscribed: false, key: canonicalKey }, undefined);
  },
  "sessions.preview": ({ params, respond }) => {
    if (!assertValidParams(params, validateSessionsPreviewParams, "sessions.preview", respond)) {
      return;
    }
    const p = params;
    const keysRaw = Array.isArray(p.keys) ? p.keys : [];
    const keys = keysRaw
      .map((key) => String(key ?? "").trim())
      .filter(Boolean)
      .slice(0, 64);
    const limit =
      typeof p.limit === "number" && Number.isFinite(p.limit) ? Math.max(1, p.limit) : 12;
    const maxChars =
      typeof p.maxChars === "number" && Number.isFinite(p.maxChars)
        ? Math.max(20, p.maxChars)
        : 240;

    if (keys.length === 0) {
      respond(true, { ts: Date.now(), previews: [] } satisfies SessionsPreviewResult, undefined);
      return;
    }

    const cfg = loadConfig();
    const storeCache = new Map<string, Record<string, SessionEntry>>();
    const previews: SessionsPreviewEntry[] = [];

    for (const key of keys) {
      try {
        const storeTarget = resolveGatewaySessionStoreTarget({ cfg, key, scanLegacyKeys: false });
        const store =
          storeCache.get(storeTarget.storePath) ?? loadSessionStore(storeTarget.storePath);
        storeCache.set(storeTarget.storePath, store);
        const target = resolveGatewaySessionStoreTarget({
          cfg,
          key,
          store,
        });
        const entry = resolveFreshestSessionEntryFromStoreKeys(store, target.storeKeys);
        if (!entry?.sessionId) {
          previews.push({ key, status: "missing", items: [] });
          continue;
        }
        const items = readSessionPreviewItemsFromTranscript(
          entry.sessionId,
          target.storePath,
          entry.sessionFile,
          target.agentId,
          limit,
          maxChars,
        );
        previews.push({
          key,
          status: items.length > 0 ? "ok" : "empty",
          items,
        });
      } catch {
        previews.push({ key, status: "error", items: [] });
      }
    }

    respond(true, { ts: Date.now(), previews } satisfies SessionsPreviewResult, undefined);
  },
  "sessions.resolve": async ({ params, respond }) => {
    if (!assertValidParams(params, validateSessionsResolveParams, "sessions.resolve", respond)) {
      return;
    }
    const p = params;
    const cfg = loadConfig();

    const resolved = await resolveSessionKeyFromResolveParams({ cfg, p });
    if (!resolved.ok) {
      respond(false, undefined, resolved.error);
      return;
    }
    respond(true, { ok: true, key: resolved.key }, undefined);
  },
  "sessions.create": async ({ req, params, respond, context, client, isWebchatConnect }) => {
    if (!assertValidParams(params, validateSessionsCreateParams, "sessions.create", respond)) {
      return;
    }
    const p = params;
    const cfg = loadConfig();
    const requestedKey = typeof p.key === "string" && p.key.trim() ? p.key.trim() : undefined;
    const agentId = normalizeAgentId(
      typeof p.agentId === "string" && p.agentId.trim() ? p.agentId : resolveDefaultAgentId(cfg),
    );
    if (requestedKey) {
      const requestedAgentId = parseAgentSessionKey(requestedKey)?.agentId;
      if (
        requestedAgentId &&
        requestedAgentId !== agentId &&
        typeof p.agentId === "string" &&
        p.agentId.trim()
      ) {
        respond(
          false,
          undefined,
          errorShape(
            ErrorCodes.INVALID_REQUEST,
            `sessions.create key agent (${requestedAgentId}) does not match agentId (${agentId})`,
          ),
        );
        return;
      }
    }
    const parentSessionKey =
      typeof p.parentSessionKey === "string" && p.parentSessionKey.trim()
        ? p.parentSessionKey.trim()
        : undefined;
    let canonicalParentSessionKey: string | undefined;
    if (parentSessionKey) {
      const parent = loadSessionEntry(parentSessionKey);
      if (!parent.entry?.sessionId) {
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.INVALID_REQUEST, `unknown parent session: ${parentSessionKey}`),
        );
        return;
      }
      canonicalParentSessionKey = parent.canonicalKey;
    }
    const key = requestedKey ?? buildDashboardSessionKey(agentId);
    const target = resolveGatewaySessionStoreTarget({ cfg, key });
    const targetAgentId = resolveAgentIdFromSessionKey(target.canonicalKey);
    const created = await updateSessionStore(target.storePath, async (store) => {
      const patched = await applySessionsPatchToStore({
        cfg,
        store,
        storeKey: target.canonicalKey,
        patch: {
          key: target.canonicalKey,
          label: typeof p.label === "string" ? p.label.trim() : undefined,
          model: typeof p.model === "string" ? p.model.trim() : undefined,
        },
        loadGatewayModelCatalog: context.loadGatewayModelCatalog,
      });
      if (!patched.ok || !canonicalParentSessionKey) {
        return patched;
      }
      const nextEntry: SessionEntry = {
        ...patched.entry,
        parentSessionKey: canonicalParentSessionKey,
      };
      store[target.canonicalKey] = nextEntry;
      return {
        ...patched,
        entry: nextEntry,
      };
    });
    if (!created.ok) {
      respond(false, undefined, created.error);
      return;
    }
    const ensured = ensureSessionTranscriptFile({
      sessionId: created.entry.sessionId,
      storePath: target.storePath,
      sessionFile: created.entry.sessionFile,
      agentId: targetAgentId,
    });
    if (!ensured.ok) {
      await updateSessionStore(target.storePath, (store) => {
        delete store[target.canonicalKey];
      });
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.UNAVAILABLE, `failed to create session transcript: ${ensured.error}`),
      );
      return;
    }

    const createdEntry =
      created.entry.sessionFile === ensured.transcriptPath
        ? created.entry
        : {
            ...created.entry,
            sessionFile: ensured.transcriptPath,
          };
    if (createdEntry !== created.entry) {
      await updateSessionStore(target.storePath, (store) => {
        const existing = store[target.canonicalKey];
        if (existing) {
          store[target.canonicalKey] = {
            ...existing,
            sessionFile: ensured.transcriptPath,
          };
        }
      });
    }

    const initialMessage = resolveOptionalInitialSessionMessage(p);
    let runPayload: Record<string, unknown> | undefined;
    let runError: unknown;
    let runMeta: Record<string, unknown> | undefined;
    const messageSeq = initialMessage
      ? readSessionMessages(createdEntry.sessionId, target.storePath, createdEntry.sessionFile)
          .length + 1
      : undefined;

    if (initialMessage) {
      await chatHandlers["chat.send"]({
        req,
        params: {
          sessionKey: target.canonicalKey,
          message: initialMessage,
          idempotencyKey: randomUUID(),
        },
        respond: (ok, payload, error, meta) => {
          if (ok && payload && typeof payload === "object") {
            runPayload = payload as Record<string, unknown>;
          } else {
            runError = error;
          }
          runMeta = meta;
        },
        context,
        client,
        isWebchatConnect,
      });
    }

    const runStarted =
      runPayload !== undefined &&
      shouldAttachPendingMessageSeq({
        payload: runPayload,
        cached: runMeta?.cached === true,
      });

    respond(
      true,
      {
        ok: true,
        key: target.canonicalKey,
        sessionId: createdEntry.sessionId,
        entry: createdEntry,
        runStarted,
        ...(runPayload ? runPayload : {}),
        ...(runStarted && typeof messageSeq === "number" ? { messageSeq } : {}),
        ...(runError ? { runError } : {}),
      },
      undefined,
    );
    emitSessionsChanged(context, {
      sessionKey: target.canonicalKey,
      reason: "create",
    });
    if (runStarted) {
      emitSessionsChanged(context, {
        sessionKey: target.canonicalKey,
        reason: "send",
      });
    }
  },
  "sessions.send": async ({ req, params, respond, context, client, isWebchatConnect }) => {
    await handleSessionSend({
      method: "sessions.send",
      req,
      params,
      respond,
      context,
      client,
      isWebchatConnect,
      interruptIfActive: false,
    });
  },
  "sessions.steer": async ({ req, params, respond, context, client, isWebchatConnect }) => {
    await handleSessionSend({
      method: "sessions.steer",
      req,
      params,
      respond,
      context,
      client,
      isWebchatConnect,
      interruptIfActive: true,
    });
  },
  "sessions.abort": async ({ req, params, respond, context, client, isWebchatConnect }) => {
    if (!assertValidParams(params, validateSessionsAbortParams, "sessions.abort", respond)) {
      return;
    }
    const p = params;
    const key = requireSessionKey(p.key, respond);
    if (!key) {
      return;
    }
    const { canonicalKey } = loadSessionEntry(key);
    const abortSessionKey = resolveAbortSessionKey({
      context,
      requestedKey: key,
      canonicalKey,
      runId: typeof p.runId === "string" ? p.runId : undefined,
    });
    let abortedRunId: string | null = null;
    await chatHandlers["chat.abort"]({
      req,
      params: {
        sessionKey: abortSessionKey,
        runId: typeof p.runId === "string" ? p.runId : undefined,
      },
      respond: (ok, payload, error, meta) => {
        if (!ok) {
          respond(ok, payload, error, meta);
          return;
        }
        const runIds =
          payload &&
          typeof payload === "object" &&
          Array.isArray((payload as { runIds?: unknown[] }).runIds)
            ? (payload as { runIds: unknown[] }).runIds.filter(
                (value): value is string => typeof value === "string" && value.trim().length > 0,
              )
            : [];
        abortedRunId = runIds[0] ?? null;
        respond(
          true,
          {
            ok: true,
            abortedRunId,
            status: abortedRunId ? "aborted" : "no-active-run",
          },
          undefined,
          meta,
        );
      },
      context,
      client,
      isWebchatConnect,
    });
    if (abortedRunId) {
      emitSessionsChanged(context, {
        sessionKey: canonicalKey,
        reason: "abort",
      });
    }
  },
  "sessions.patch": async ({ params, respond, context, client, isWebchatConnect }) => {
    if (!assertValidParams(params, validateSessionsPatchParams, "sessions.patch", respond)) {
      return;
    }
    const p = params;
    const key = requireSessionKey(p.key, respond);
    if (!key) {
      return;
    }
    if (rejectWebchatSessionMutation({ action: "patch", client, isWebchatConnect, respond })) {
      return;
    }

    const { cfg, target, storePath } = resolveGatewaySessionTargetFromKey(key);
    const applied = await updateSessionStore(storePath, async (store) => {
      const { primaryKey } = migrateAndPruneGatewaySessionStoreKey({ cfg, key, store });
      return await applySessionsPatchToStore({
        cfg,
        store,
        storeKey: primaryKey,
        patch: p,
        loadGatewayModelCatalog: context.loadGatewayModelCatalog,
      });
    });
    if (!applied.ok) {
      respond(false, undefined, applied.error);
      return;
    }

    if (hasInternalHookListeners("session", "patch")) {
      const hookContext: SessionPatchHookContext = structuredClone({
        sessionEntry: applied.entry,
        patch: p,
        cfg,
      });
      const hookEvent: SessionPatchHookEvent = {
        type: "session",
        action: "patch",
        sessionKey: target.canonicalKey ?? key,
        context: hookContext,
        timestamp: new Date(),
        messages: [],
      };
      void triggerInternalHook(hookEvent);
    }

    const parsed = parseAgentSessionKey(target.canonicalKey ?? key);
    const agentId = normalizeAgentId(parsed?.agentId ?? resolveDefaultAgentId(cfg));
    const resolved = resolveSessionModelRef(cfg, applied.entry, agentId);
    const result: SessionsPatchResult = {
      ok: true,
      path: storePath,
      key: target.canonicalKey,
      entry: applied.entry,
      resolved: {
        modelProvider: resolved.provider,
        model: resolved.model,
      },
    };
    respond(true, result, undefined);
    emitSessionsChanged(context, {
      sessionKey: target.canonicalKey,
      reason: "patch",
    });
  },
  "sessions.reset": async ({ params, respond, context }) => {
    if (!assertValidParams(params, validateSessionsResetParams, "sessions.reset", respond)) {
      return;
    }
    const p = params;
    const key = requireSessionKey(p.key, respond);
    if (!key) {
      return;
    }

    const reason = p.reason === "new" ? "new" : "reset";
    const result = await performGatewaySessionReset({
      key,
      reason,
      commandSource: "gateway:sessions.reset",
    });
    if (!result.ok) {
      respond(false, undefined, result.error);
      return;
    }
    respond(true, { ok: true, key: result.key, entry: result.entry }, undefined);
    emitSessionsChanged(context, {
      sessionKey: result.key,
      reason,
    });
  },
  "sessions.delete": async ({ params, respond, client, isWebchatConnect, context }) => {
    if (!assertValidParams(params, validateSessionsDeleteParams, "sessions.delete", respond)) {
      return;
    }
    const p = params;
    const key = requireSessionKey(p.key, respond);
    if (!key) {
      return;
    }
    if (rejectWebchatSessionMutation({ action: "delete", client, isWebchatConnect, respond })) {
      return;
    }

    const { cfg, target, storePath } = resolveGatewaySessionTargetFromKey(key);
    const mainKey = resolveMainSessionKey(cfg);
    if (target.canonicalKey === mainKey) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, `Cannot delete the main session (${mainKey}).`),
      );
      return;
    }

    const deleteTranscript = typeof p.deleteTranscript === "boolean" ? p.deleteTranscript : true;

    const { entry, legacyKey, canonicalKey } = loadSessionEntry(key);
    const mutationCleanupError = await cleanupSessionBeforeMutation({
      cfg,
      key,
      target,
      entry,
      legacyKey,
      canonicalKey,
      reason: "session-delete",
    });
    if (mutationCleanupError) {
      respond(false, undefined, mutationCleanupError);
      return;
    }
    const sessionId = entry?.sessionId;
    const deleted = await updateSessionStore(storePath, (store) => {
      const { primaryKey } = migrateAndPruneGatewaySessionStoreKey({ cfg, key, store });
      const hadEntry = Boolean(store[primaryKey]);
      if (hadEntry) {
        delete store[primaryKey];
      }
      return hadEntry;
    });

    const archived =
      deleted && deleteTranscript
        ? archiveSessionTranscriptsForSession({
            sessionId,
            storePath,
            sessionFile: entry?.sessionFile,
            agentId: target.agentId,
            reason: "deleted",
          })
        : [];
    if (deleted) {
      const emitLifecycleHooks = p.emitLifecycleHooks !== false;
      await emitSessionUnboundLifecycleEvent({
        targetSessionKey: target.canonicalKey ?? key,
        reason: "session-delete",
        emitHooks: emitLifecycleHooks,
      });
    }

    respond(true, { ok: true, key: target.canonicalKey, deleted, archived }, undefined);
    if (deleted) {
      emitSessionsChanged(context, {
        sessionKey: target.canonicalKey,
        reason: "delete",
      });
    }
  },
  "sessions.get": ({ params, respond }) => {
    const p = params;
    const key = requireSessionKey(p.key ?? p.sessionKey, respond);
    if (!key) {
      return;
    }
    const limit =
      typeof p.limit === "number" && Number.isFinite(p.limit)
        ? Math.max(1, Math.floor(p.limit))
        : 200;

    const { target, storePath } = resolveGatewaySessionTargetFromKey(key);
    const store = loadSessionStore(storePath);
    const entry = resolveFreshestSessionEntryFromStoreKeys(store, target.storeKeys);
    if (!entry?.sessionId) {
      respond(true, { messages: [] }, undefined);
      return;
    }
    const allMessages = readSessionMessages(entry.sessionId, storePath, entry.sessionFile);
    const messages = limit < allMessages.length ? allMessages.slice(-limit) : allMessages;
    respond(true, { messages }, undefined);
  },
  "sessions.compact": async ({ params, respond, context }) => {
    if (!assertValidParams(params, validateSessionsCompactParams, "sessions.compact", respond)) {
      return;
    }
    const p = params;
    const key = requireSessionKey(p.key, respond);
    if (!key) {
      return;
    }

    const maxLines =
      typeof p.maxLines === "number" && Number.isFinite(p.maxLines)
        ? Math.max(1, Math.floor(p.maxLines))
        : 400;

    const { cfg, target, storePath } = resolveGatewaySessionTargetFromKey(key);
    // Lock + read in a short critical section; transcript work happens outside.
    const compactTarget = await updateSessionStore(storePath, (store) => {
      const { entry, primaryKey } = migrateAndPruneGatewaySessionStoreKey({ cfg, key, store });
      return { entry, primaryKey };
    });
    const entry = compactTarget.entry;
    const sessionId = entry?.sessionId;
    if (!sessionId) {
      respond(
        true,
        {
          ok: true,
          key: target.canonicalKey,
          compacted: false,
          reason: "no sessionId",
        },
        undefined,
      );
      return;
    }

    const filePath = resolveSessionTranscriptCandidates(
      sessionId,
      storePath,
      entry?.sessionFile,
      target.agentId,
    ).find((candidate) => fs.existsSync(candidate));
    if (!filePath) {
      respond(
        true,
        {
          ok: true,
          key: target.canonicalKey,
          compacted: false,
          reason: "no transcript",
        },
        undefined,
      );
      return;
    }

    const raw = fs.readFileSync(filePath, "utf-8");
    const lines = raw.split(/\r?\n/).filter((l) => l.trim().length > 0);
    if (lines.length <= maxLines) {
      respond(
        true,
        {
          ok: true,
          key: target.canonicalKey,
          compacted: false,
          kept: lines.length,
        },
        undefined,
      );
      return;
    }

    const archived = archiveFileOnDisk(filePath, "bak");
    const keptLines = lines.slice(-maxLines);
    fs.writeFileSync(filePath, `${keptLines.join("\n")}\n`, "utf-8");

    await updateSessionStore(storePath, (store) => {
      const entryKey = compactTarget.primaryKey;
      const entryToUpdate = store[entryKey];
      if (!entryToUpdate) {
        return;
      }
      delete entryToUpdate.inputTokens;
      delete entryToUpdate.outputTokens;
      delete entryToUpdate.totalTokens;
      delete entryToUpdate.totalTokensFresh;
      entryToUpdate.updatedAt = Date.now();
    });

    respond(
      true,
      {
        ok: true,
        key: target.canonicalKey,
        compacted: true,
        archived,
        kept: keptLines.length,
      },
      undefined,
    );
    emitSessionsChanged(context, {
      sessionKey: target.canonicalKey,
      reason: "compact",
      compacted: true,
    });
  },
};
