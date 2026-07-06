/**
 * sessions_search built-in tool.
 *
 * Searches bounded, redacted transcript snippets after session visibility filtering.
 */
import { Type } from "typebox";
import { getRuntimeConfig } from "../../config/config.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { callGateway } from "../../gateway/call.js";
import { optionalPositiveIntegerSchema } from "../schema/typebox.js";
import {
  describeSessionsSearchTool,
  SESSIONS_SEARCH_TOOL_DISPLAY_SUMMARY,
} from "../tool-description-presets.js";
import type { AnyAgentTool } from "./common.js";
import { jsonResult, readPositiveIntegerParam, readStringParam, ToolInputError } from "./common.js";
import {
  createAgentToAgentPolicy,
  createSessionVisibilityGuard,
  createSessionVisibilityRowChecker,
  resolveDisplaySessionKey,
  resolveEffectiveSessionToolsVisibility,
  resolveSandboxedSessionToolContext,
  resolveSessionReference,
  resolveVisibleSessionReference,
  type SessionListRow,
} from "./sessions-helpers.js";

const SessionsSearchToolSchema = Type.Object({
  query: Type.String({ minLength: 1 }),
  sessionKey: Type.Optional(Type.String({ minLength: 1 })),
  limit: optionalPositiveIntegerSchema(),
});

const SESSIONS_SEARCH_TOOL_MAX_LIMIT = 20;
const SESSIONS_SEARCH_LIST_LIMIT = 200;

type GatewayCaller = typeof callGateway;

type SessionsSearchHit = {
  sessionKey: string;
  sessionId: string;
  agentId: string;
  seq: number;
  role: "user" | "assistant";
  snippet: string;
  timestampMs?: number;
  messageId?: string;
};

type SessionsSearchResult = {
  query?: string;
  hits?: SessionsSearchHit[];
  indexedSessions?: number;
  searchedSessions?: number;
};

function readSessionsSearchLimit(params: Record<string, unknown>): number | undefined {
  return readPositiveIntegerParam(params, "limit", {
    max: SESSIONS_SEARCH_TOOL_MAX_LIMIT,
    message: `limit must be a positive integer no greater than ${SESSIONS_SEARCH_TOOL_MAX_LIMIT}`,
  });
}

function isSessionSearchHit(hit: unknown): hit is SessionsSearchHit {
  if (!hit || typeof hit !== "object" || Array.isArray(hit)) {
    return false;
  }
  const record = hit as Partial<SessionsSearchHit>;
  return (
    typeof record.sessionKey === "string" &&
    typeof record.sessionId === "string" &&
    typeof record.agentId === "string" &&
    typeof record.seq === "number" &&
    (record.role === "user" || record.role === "assistant") &&
    typeof record.snippet === "string"
  );
}

async function resolveSingleSearchKey(params: {
  cfg: OpenClawConfig;
  sessionKey: string;
  alias: string;
  mainKey: string;
  effectiveRequesterKey: string;
  restrictToSpawned: boolean;
  sandboxed: boolean;
}): Promise<
  { ok: true; key: string; displayKey: string } | { ok: false; status: string; error: string }
> {
  const resolvedSession = await resolveSessionReference({
    sessionKey: params.sessionKey,
    alias: params.alias,
    mainKey: params.mainKey,
    requesterInternalKey: params.effectiveRequesterKey,
    restrictToSpawned: params.restrictToSpawned,
  });
  if (!resolvedSession.ok) {
    return resolvedSession;
  }
  const visibleSession = await resolveVisibleSessionReference({
    resolvedSession,
    requesterSessionKey: params.effectiveRequesterKey,
    restrictToSpawned: params.restrictToSpawned,
    visibilitySessionKey: params.sessionKey,
  });
  if (!visibleSession.ok) {
    return visibleSession;
  }
  const a2aPolicy = createAgentToAgentPolicy(params.cfg);
  const visibility = resolveEffectiveSessionToolsVisibility({
    cfg: params.cfg,
    sandboxed: params.sandboxed,
  });
  const visibilityGuard = await createSessionVisibilityGuard({
    action: "history",
    requesterSessionKey: params.effectiveRequesterKey,
    visibility,
    a2aPolicy,
  });
  const access = visibilityGuard.check(visibleSession.key);
  if (!access.allowed) {
    return { ok: false, status: access.status, error: access.error };
  }
  return { ok: true, key: visibleSession.key, displayKey: visibleSession.displayKey };
}

async function resolveVisibleSearchKeys(params: {
  cfg: OpenClawConfig;
  gatewayCall: GatewayCaller;
  alias: string;
  mainKey: string;
  effectiveRequesterKey: string;
  restrictToSpawned: boolean;
  sandboxed: boolean;
}): Promise<{ keys: string[]; displayKeyByKey: Map<string, string> }> {
  const list = await params.gatewayCall<{ sessions?: SessionListRow[] }>({
    method: "sessions.list",
    params: {
      limit: SESSIONS_SEARCH_LIST_LIMIT,
      includeDerivedTitles: false,
      includeLastMessage: false,
      includeGlobal: !params.restrictToSpawned,
      includeUnknown: false,
      spawnedBy: params.restrictToSpawned ? params.effectiveRequesterKey : undefined,
    },
  });
  const sessions = Array.isArray(list?.sessions) ? list.sessions : [];
  const a2aPolicy = createAgentToAgentPolicy(params.cfg);
  const visibility = resolveEffectiveSessionToolsVisibility({
    cfg: params.cfg,
    sandboxed: params.sandboxed,
  });
  const visibilityGuard = createSessionVisibilityRowChecker({
    action: "history",
    requesterSessionKey: params.effectiveRequesterKey,
    visibility,
    a2aPolicy,
  });
  const keys: string[] = [];
  const displayKeyByKey = new Map<string, string>();
  for (const row of sessions) {
    const key = typeof row.key === "string" ? row.key : "";
    if (!key || key === "unknown") {
      continue;
    }
    const access = visibilityGuard.check({
      key,
      agentId: typeof row.agentId === "string" ? row.agentId : undefined,
      ownerSessionKey:
        typeof (row as { ownerSessionKey?: unknown }).ownerSessionKey === "string"
          ? (row as { ownerSessionKey?: string }).ownerSessionKey
          : undefined,
      spawnedBy: typeof row.spawnedBy === "string" ? row.spawnedBy : undefined,
      parentSessionKey: typeof row.parentSessionKey === "string" ? row.parentSessionKey : undefined,
    });
    if (!access.allowed) {
      continue;
    }
    keys.push(key);
    displayKeyByKey.set(
      key,
      resolveDisplaySessionKey({
        key,
        alias: params.alias,
        mainKey: params.mainKey,
      }),
    );
  }
  return { keys: Array.from(new Set(keys)), displayKeyByKey };
}

export function createSessionsSearchTool(opts?: {
  agentSessionKey?: string;
  sandboxed?: boolean;
  config?: OpenClawConfig;
  callGateway?: GatewayCaller;
}): AnyAgentTool {
  return {
    label: "Session Search",
    name: "sessions_search",
    displaySummary: SESSIONS_SEARCH_TOOL_DISPLAY_SUMMARY,
    description: describeSessionsSearchTool(),
    parameters: SessionsSearchToolSchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const query = readStringParam(params, "query", { required: true });
      if (!query.trim()) {
        throw new ToolInputError("query required");
      }
      const limit = readSessionsSearchLimit(params);
      const requestedSessionKey = readStringParam(params, "sessionKey");
      const cfg = opts?.config ?? getRuntimeConfig();
      const gatewayCall = opts?.callGateway ?? callGateway;
      const { mainKey, alias, effectiveRequesterKey, restrictToSpawned } =
        resolveSandboxedSessionToolContext({
          cfg,
          agentSessionKey: opts?.agentSessionKey,
          sandboxed: opts?.sandboxed,
        });
      let sessionKeys: string[];
      let displayKeyByKey = new Map<string, string>();
      if (requestedSessionKey) {
        const resolved = await resolveSingleSearchKey({
          cfg,
          sessionKey: requestedSessionKey,
          alias,
          mainKey,
          effectiveRequesterKey,
          restrictToSpawned,
          sandboxed: opts?.sandboxed === true,
        });
        if (!resolved.ok) {
          return jsonResult({ status: resolved.status, error: resolved.error });
        }
        sessionKeys = [resolved.key];
        displayKeyByKey = new Map([[resolved.key, resolved.displayKey]]);
      } else {
        const visible = await resolveVisibleSearchKeys({
          cfg,
          gatewayCall,
          alias,
          mainKey,
          effectiveRequesterKey,
          restrictToSpawned,
          sandboxed: opts?.sandboxed === true,
        });
        sessionKeys = visible.keys;
        displayKeyByKey = visible.displayKeyByKey;
      }
      if (sessionKeys.length === 0) {
        return jsonResult({
          query,
          hits: [],
          indexedSessions: 0,
          searchedSessions: 0,
        });
      }
      const result = await gatewayCall<SessionsSearchResult>({
        method: "sessions.search",
        params: {
          query,
          sessionKeys,
          ...(limit !== undefined ? { limit } : {}),
        },
      });
      const hits = Array.isArray(result?.hits) ? result.hits.filter(isSessionSearchHit) : [];
      return jsonResult({
        query: result.query ?? query,
        hits: hits.map((hit) => {
          const sessionKey = displayKeyByKey.get(hit.sessionKey) ?? hit.sessionKey;
          return {
            sessionKey,
            sessionId: hit.sessionId,
            agentId: hit.agentId,
            seq: hit.seq,
            role: hit.role,
            snippet: hit.snippet,
            timestampMs: hit.timestampMs,
            messageId: hit.messageId,
          };
        }),
        indexedSessions: result.indexedSessions ?? 0,
        searchedSessions: result.searchedSessions ?? sessionKeys.length,
      });
    },
  };
}
