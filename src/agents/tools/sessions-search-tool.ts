/** Full-text search over visible session transcripts. */
import { Type, type Static } from "typebox";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { jsonUtf8Bytes } from "../../infra/json-utf8-bytes.js";
import { redactToolPayloadText } from "../../logging/redact.js";
import { isIncognitoSessionKey, parseAgentSessionKey } from "../../routing/session-key.js";
import { truncateUtf16Safe } from "../../utils.js";
import { resolveSessionAgentId } from "../agent-scope.js";
import { optionalPositiveIntegerSchema } from "../schema/typebox.js";
import {
  describeSessionLinkRule,
  describeSessionsSearchTool,
  SESSIONS_SEARCH_TOOL_DISPLAY_SUMMARY,
} from "../tool-description-presets.js";
import type { AnyAgentTool } from "./common.js";
import {
  jsonResult,
  readPositiveIntegerParam,
  readToolStringParam,
  ToolInputError,
} from "./common.js";
import {
  callAgentToolGatewayRequest,
  type AgentToolGatewayRequestCaller,
} from "./in-process-gateway.js";
import {
  resolveSessionToolTargetAgentId,
  runWithScopedSessionAccess,
} from "./scoped-session-access.js";
import {
  createSessionVisibilityRowChecker,
  formatSessionToolAccessDenial,
  resolveDisplaySessionKey,
  resolveSessionReference,
  resolveSessionToolAccess,
  resolveSessionToolContext,
  resolveVisibleSessionReference,
} from "./sessions-helpers.js";

const SESSIONS_SEARCH_DEFAULT_LIMIT = 10;
const SESSIONS_SEARCH_MAX_LIMIT = 25;
const SESSIONS_SEARCH_MAX_SESSION_KEYS = 200;
// Bounds FTS token expansion on the synchronous gateway path while leaving ample query context.
const SESSIONS_SEARCH_MAX_QUERY_CHARS = 4096;
const SESSIONS_SEARCH_MAX_BYTES = 32 * 1024;
const SESSIONS_SEARCH_SNIPPET_MAX_CHARS = 300;
const SESSIONS_SEARCH_INDEXING_WARNING =
  "Transcript indexing is in progress; results may be incomplete. Retry sessions_search shortly.";

const SessionsSearchToolSchema = Type.Object({
  query: Type.String({ maxLength: SESSIONS_SEARCH_MAX_QUERY_CHARS }),
  sessionKey: Type.Optional(Type.String()),
  limit: optionalPositiveIntegerSchema({
    maximum: SESSIONS_SEARCH_MAX_LIMIT,
    description: `Maximum search results: ${SESSIONS_SEARCH_MAX_LIMIT}. Defaults to ${SESSIONS_SEARCH_DEFAULT_LIMIT}.`,
  }),
});

const SessionsSearchHitSchema = Type.Object(
  {
    sessionKey: Type.String(),
    timestamp: Type.Number(),
    role: Type.Union([Type.Literal("assistant"), Type.Literal("user")]),
    snippet: Type.String(),
    score: Type.Number(),
    sessionId: Type.Optional(Type.String()),
    messageId: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

const SessionsSearchOutputSchema = Type.Union([
  Type.Object(
    {
      results: Type.Array(SessionsSearchHitSchema),
      sessionLinkRule: Type.Optional(
        Type.String({
          description: "How to build Control UI URLs for sessionKey values in this result.",
        }),
      ),
      indexing: Type.Optional(Type.Literal(true)),
      archivedTranscriptsExcluded: Type.Optional(Type.Integer({ minimum: 1 })),
      warning: Type.Optional(Type.String()),
      truncated: Type.Optional(Type.Literal(true)),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      status: Type.Union([Type.Literal("error"), Type.Literal("forbidden")]),
      error: Type.String(),
    },
    { additionalProperties: false },
  ),
]);

type GatewayCaller = AgentToolGatewayRequestCaller;

type GatewaySearchHit = {
  sessionKey?: unknown;
  sessionId?: unknown;
  messageId?: unknown;
  role?: unknown;
  timestamp?: unknown;
  snippet?: unknown;
  score?: unknown;
};

type SanitizedSearchHit = Static<typeof SessionsSearchHitSchema>;

type SearchSessionCandidate = {
  key: string;
  access: "authorized" | "row";
  agentId?: string;
  expectedSessionId?: string;
  ownerSessionKey?: string;
  parentSessionKey?: string;
  spawnedBy?: string;
};

function sanitizeHit(params: {
  alias: string;
  hit: GatewaySearchHit;
  mainKey: string;
}): SanitizedSearchHit | undefined {
  const { hit } = params;
  if (
    typeof hit.sessionKey !== "string" ||
    (hit.role !== "user" && hit.role !== "assistant") ||
    typeof hit.timestamp !== "number" ||
    typeof hit.snippet !== "string" ||
    typeof hit.score !== "number"
  ) {
    return undefined;
  }
  const sanitized = redactToolPayloadText(hit.snippet);
  const snippet =
    sanitized.length > SESSIONS_SEARCH_SNIPPET_MAX_CHARS
      ? `${truncateUtf16Safe(sanitized, SESSIONS_SEARCH_SNIPPET_MAX_CHARS)}…`
      : sanitized;
  return {
    sessionKey: resolveDisplaySessionKey({
      key: hit.sessionKey,
      alias: params.alias,
      mainKey: params.mainKey,
    }),
    timestamp: hit.timestamp,
    role: hit.role,
    snippet,
    score: hit.score,
    ...(typeof hit.sessionId === "string" ? { sessionId: hit.sessionId } : {}),
    ...(typeof hit.messageId === "string" ? { messageId: hit.messageId } : {}),
  };
}

function capSearchHits(items: SanitizedSearchHit[]): {
  items: SanitizedSearchHit[];
  truncated: boolean;
} {
  const selected: SanitizedSearchHit[] = [];
  let bytes = 2;
  for (const item of items) {
    const itemBytes = jsonUtf8Bytes(item);
    const separatorBytes = selected.length > 0 ? 1 : 0;
    if (bytes + separatorBytes + itemBytes > SESSIONS_SEARCH_MAX_BYTES) {
      return { items: selected, truncated: true };
    }
    selected.push(item);
    bytes += separatorBytes + itemBytes;
  }
  return { items: selected, truncated: false };
}

async function listVisibleSearchSessions(params: {
  unscopedAgentId: string;
  effectiveRequesterAgentId?: string;
  effectiveRequesterKey: string;
  gatewayCall: GatewayCaller;
  rowGuard: {
    check: (row: {
      key: string;
      agentId?: string;
      ownerSessionKey?: string;
      parentSessionKey?: string;
      spawnedBy?: string;
    }) => { allowed: boolean };
  };
  restrictToSpawned: boolean;
}): Promise<SearchSessionCandidate[]> {
  const candidates = new Map<string, SearchSessionCandidate>();
  const candidateId = (candidate: Pick<SearchSessionCandidate, "agentId" | "key">) =>
    parseAgentSessionKey(candidate.key)
      ? candidate.key
      : `${candidate.agentId ?? ""}\0${candidate.key}`;
  if (
    params.rowGuard.check({
      key: params.effectiveRequesterKey,
      ...(params.effectiveRequesterAgentId ? { agentId: params.effectiveRequesterAgentId } : {}),
    }).allowed
  ) {
    const requesterCandidate = {
      key: params.effectiveRequesterKey,
      access: "row",
      ...(params.effectiveRequesterAgentId ? { agentId: params.effectiveRequesterAgentId } : {}),
    } satisfies SearchSessionCandidate;
    candidates.set(candidateId(requesterCandidate), requesterCandidate);
  }
  const listPages = async (agentId?: string) => {
    for (const archived of [false, true]) {
      let offset = 0;
      while (true) {
        const page = await params.gatewayCall<{
          sessions?: Array<{
            key?: unknown;
            agentId?: unknown;
            ownerSessionKey?: unknown;
            parentSessionKey?: unknown;
            spawnedBy?: unknown;
          }>;
          hasMore?: boolean;
          nextOffset?: number;
        }>({
          method: "sessions.list",
          params: {
            limit: 200,
            offset,
            archived,
            includeGlobal: !params.restrictToSpawned,
            includeUnknown: false,
            ...(agentId ? { agentId } : {}),
            ...(params.restrictToSpawned ? { spawnedBy: params.effectiveRequesterKey } : {}),
          },
        });
        for (const row of Array.isArray(page.sessions) ? page.sessions : []) {
          if (typeof row.key !== "string" || (!agentId && parseAgentSessionKey(row.key) === null)) {
            continue;
          }
          const visibilityRow = {
            key: row.key,
            ...(typeof row.agentId === "string"
              ? { agentId: row.agentId }
              : agentId
                ? { agentId }
                : {}),
            ...(typeof row.ownerSessionKey === "string"
              ? { ownerSessionKey: row.ownerSessionKey }
              : {}),
            ...(typeof row.parentSessionKey === "string"
              ? { parentSessionKey: row.parentSessionKey }
              : {}),
            ...(typeof row.spawnedBy === "string"
              ? { spawnedBy: row.spawnedBy }
              : params.restrictToSpawned
                ? { spawnedBy: params.effectiveRequesterKey }
                : {}),
          };
          if (params.rowGuard.check(visibilityRow).allowed) {
            const id = candidateId(visibilityRow);
            candidates.set(id, {
              ...candidates.get(id),
              ...visibilityRow,
              access: "row",
            });
          }
        }
        if (
          page.hasMore !== true ||
          typeof page.nextOffset !== "number" ||
          page.nextOffset <= offset
        ) {
          break;
        }
        offset = page.nextOffset;
      }
    }
  };
  await listPages();
  if (!params.restrictToSpawned) {
    // Unscoped keys cannot encode a foreign owner for a follow-up sessions_history call. Only the
    // requester's agent-scoped listing may contribute them; combined rows supply scoped keys.
    await listPages(params.unscopedAgentId);
  }
  return [...candidates.values()].toSorted((left, right) => left.key.localeCompare(right.key));
}

function compareSearchHits(left: SanitizedSearchHit, right: SanitizedSearchHit): number {
  return (
    right.score - left.score ||
    right.timestamp - left.timestamp ||
    left.sessionKey.localeCompare(right.sessionKey) ||
    (left.messageId ?? "").localeCompare(right.messageId ?? "")
  );
}

function createSearchHitMatcher(agentId: string, candidates: SearchSessionCandidate[]) {
  const exactKeys = new Map<string, number>();
  const aliases = new Map<string, number>();
  for (const [ordinal, candidate] of candidates.entries()) {
    if (!exactKeys.has(candidate.key)) {
      exactKeys.set(candidate.key, ordinal);
    }
    if (!parseAgentSessionKey(candidate.key)) {
      const alias = candidate.key.trim();
      if (alias && !aliases.has(alias)) {
        aliases.set(alias, ordinal);
      }
    }
  }
  return (hitKey: string): SearchSessionCandidate | undefined => {
    const exact = exactKeys.get(hitKey);
    const parsed = parseAgentSessionKey(hitKey);
    const alias = parsed?.agentId === agentId ? aliases.get(parsed.rest) : undefined;
    // An authorized alias may precede an exact key in the original candidate order.
    const ordinal = alias !== undefined && (exact === undefined || alias < exact) ? alias : exact;
    return ordinal === undefined ? undefined : candidates[ordinal];
  };
}

export function createSessionsSearchTool(opts?: {
  agentId?: string;
  agentSessionKey?: string;
  sessionReadScopeKey?: string;
  sandboxed?: boolean;
  config?: OpenClawConfig;
  callGateway?: GatewayCaller;
  sessionLinkBase?: string;
}): AnyAgentTool {
  const gatewayCall = opts?.callGateway ?? callAgentToolGatewayRequest;
  return {
    label: "Sessions Search",
    name: "sessions_search",
    displaySummary: SESSIONS_SEARCH_TOOL_DISPLAY_SUMMARY,
    description: describeSessionsSearchTool({ sessionLinkBase: opts?.sessionLinkBase }),
    parameters: SessionsSearchToolSchema,
    outputSchema: SessionsSearchOutputSchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const query = readToolStringParam(params, "query")?.trim() ?? "";
      if (!query) {
        throw new ToolInputError("query must not be empty");
      }
      if (query.length > SESSIONS_SEARCH_MAX_QUERY_CHARS) {
        throw new ToolInputError(
          `query must not exceed ${SESSIONS_SEARCH_MAX_QUERY_CHARS} characters`,
        );
      }
      const limit =
        readPositiveIntegerParam(params, "limit", {
          max: SESSIONS_SEARCH_MAX_LIMIT,
        }) ?? SESSIONS_SEARCH_DEFAULT_LIMIT;
      // The host-bound scope is already the complete search universe. Reuse the
      // targeted authorization path instead of listing every session to filter it back down.
      const requestedSessionKey =
        readToolStringParam(params, "sessionKey") || opts?.sessionReadScopeKey;
      const {
        cfg,
        mainKey,
        alias,
        effectiveRequesterKey,
        mainSessionKey,
        restrictToSpawned,
        sessionVisibility: visibility,
        a2aPolicy,
      } = resolveSessionToolContext(opts);
      const requesterAgentId = resolveSessionAgentId({
        sessionKey: effectiveRequesterKey,
        config: cfg,
        agentId: opts?.agentId,
      });

      let sessionTarget:
        | {
            agentId: string;
            key: string;
            requesterOwned: boolean;
            expectedSessionId?: string;
          }
        | undefined;
      if (requestedSessionKey) {
        const normalizedRequestedKey = requestedSessionKey.trim();
        const semanticTargetAgentId =
          normalizedRequestedKey === "current"
            ? requesterAgentId
            : normalizedRequestedKey === "main" ||
                normalizedRequestedKey === "global" ||
                normalizedRequestedKey === mainKey ||
                normalizedRequestedKey === alias ||
                Boolean(parseAgentSessionKey(normalizedRequestedKey))
              ? resolveSessionToolTargetAgentId({
                  cfg,
                  targetSessionKey: normalizedRequestedKey,
                  requesterAgentId,
                })
              : undefined;
        const resolved = await resolveSessionReference({
          action: "search",
          sessionKey: requestedSessionKey,
          keyAgentId: semanticTargetAgentId ?? requesterAgentId,
          alias,
          mainKey,
          requesterInternalKey: effectiveRequesterKey,
          restrictToSpawned,
          callGateway: gatewayCall,
        });
        if (!resolved.ok) {
          return jsonResult({ status: resolved.status, error: resolved.error });
        }
        const visible = await resolveVisibleSessionReference({
          action: "search",
          resolvedSession: resolved,
          requesterSessionKey: effectiveRequesterKey,
          requesterAgentId,
          restrictToSpawned,
          visibilitySessionKey: requestedSessionKey,
          callGateway: gatewayCall,
        });
        if (!visible.ok) {
          return jsonResult({ status: visible.status, error: visible.error });
        }
        sessionTarget = {
          key: visible.key,
          agentId: resolveSessionToolTargetAgentId({
            cfg,
            targetSessionKey: visible.key,
            resolvedAgentId: visible.agentId ?? semanticTargetAgentId,
            requesterAgentId,
          }),
          requesterOwned: visible.requesterOwned,
        };
      }

      const rowGuard = createSessionVisibilityRowChecker({
        action: "history",
        defaultAgentId: requesterAgentId,
        requesterAgentId,
        requesterSessionKey: effectiveRequesterKey,
        mainSessionKey,
        visibility,
        a2aPolicy,
      });
      if (sessionTarget) {
        const { agentId, key, requesterOwned } = sessionTarget;
        const authorizationTargetSessionKey =
          agentId !== requesterAgentId && !parseAgentSessionKey(key)
            ? `agent:${agentId}:${key}`
            : key;
        const access = await resolveSessionToolAccess({
          action: "history",
          displayAction: "search",
          requesterAgentId,
          requesterSessionKey: effectiveRequesterKey,
          sessionReadScopeKey: opts?.sessionReadScopeKey ? effectiveRequesterKey : undefined,
          mainSessionKey,
          authorizationTargetSessionKey,
          targetAgentId: agentId,
          targetSessionKey: key,
          requesterOwned,
          visibility,
          a2aPolicy,
          callGateway: gatewayCall,
        });
        if (!access.allowed) {
          return jsonResult({
            status: access.status,
            error: formatSessionToolAccessDenial(access, {
              action: "search",
              targetSessionKey: key,
            }),
          });
        }
        if (access.expectedSessionId) {
          sessionTarget.expectedSessionId = access.expectedSessionId;
        }
      }
      const searchSessions = (
        sessionTarget
          ? [
              {
                key: sessionTarget.key,
                access: "authorized" as const,
                ...(sessionTarget.expectedSessionId
                  ? { expectedSessionId: sessionTarget.expectedSessionId }
                  : {}),
                ...(!parseAgentSessionKey(sessionTarget.key)
                  ? { agentId: sessionTarget.agentId }
                  : {}),
              },
            ]
          : await listVisibleSearchSessions({
              unscopedAgentId: requesterAgentId,
              effectiveRequesterAgentId: opts?.agentId,
              effectiveRequesterKey,
              gatewayCall,
              rowGuard,
              restrictToSpawned,
            })
      )
        // Search excerpts are re-persisted in the caller transcript; incognito
        // sessions therefore stay absent even when the caller could otherwise see them.
        .filter((candidate) => !isIncognitoSessionKey(candidate.key));
      const visibleHits: SanitizedSearchHit[] = [];
      let indexing = false;
      let archivedTranscriptsExcluded = 0;
      let backendTruncated = false;
      const sessionsByAgent = new Map<string, SearchSessionCandidate[]>();
      for (const candidate of searchSessions) {
        const agentId = resolveSessionAgentId({
          sessionKey: candidate.key,
          config: cfg,
          agentId: parseAgentSessionKey(candidate.key) ? undefined : candidate.agentId,
        });
        const candidates = sessionsByAgent.get(agentId) ?? [];
        candidates.push(candidate);
        sessionsByAgent.set(agentId, candidates);
      }
      // Visibility filtering precedes result/byte caps so hidden hit counts never affect output.
      for (const [agentId, candidates] of [...sessionsByAgent].toSorted(([left], [right]) =>
        left.localeCompare(right),
      )) {
        for (
          let offset = 0;
          offset < candidates.length;
          offset += SESSIONS_SEARCH_MAX_SESSION_KEYS
        ) {
          const chunk = candidates.slice(offset, offset + SESSIONS_SEARCH_MAX_SESSION_KEYS);
          const runSearch = () =>
            gatewayCall<{
              results?: GatewaySearchHit[];
              indexing?: boolean;
              archivedTranscriptsExcluded?: number;
              truncated?: boolean;
            }>({
              method: "sessions.search",
              params: {
                agentId,
                query,
                limit: SESSIONS_SEARCH_MAX_LIMIT,
                sessionKeys: chunk.map((candidate) => candidate.key),
              },
            });
          const scopedCandidate = chunk.length === 1 ? chunk[0] : undefined;
          const result = scopedCandidate?.expectedSessionId
            ? await runWithScopedSessionAccess({
                cfg,
                agentId,
                expectedSessionId: scopedCandidate.expectedSessionId,
                targetSessionKey: scopedCandidate.key,
                run: runSearch,
              })
            : await runSearch();
          indexing ||= result.indexing === true;
          archivedTranscriptsExcluded += result.archivedTranscriptsExcluded ?? 0;
          backendTruncated ||= result.truncated === true;
          const hits = Array.isArray(result.results) ? result.results : [];
          if (hits.length === 0) {
            continue;
          }
          const matchHit = createSearchHitMatcher(agentId, chunk);
          for (const hit of hits) {
            if (typeof hit.sessionKey !== "string") {
              continue;
            }
            const candidate = matchHit(hit.sessionKey);
            if (!candidate) {
              continue;
            }
            const access =
              candidate.access === "authorized"
                ? { allowed: true as const }
                : rowGuard.check(candidate);
            if (!access.allowed) {
              continue;
            }
            const sanitized = sanitizeHit({
              alias,
              hit: { ...hit, sessionKey: candidate.key },
              mainKey,
            });
            if (sanitized) {
              visibleHits.push(sanitized);
            }
          }
        }
      }
      visibleHits.sort(compareSearchHits);
      const limited = visibleHits.slice(0, limit);
      const capped = capSearchHits(limited);
      return jsonResult({
        results: capped.items,
        ...(opts?.sessionLinkBase
          ? { sessionLinkRule: describeSessionLinkRule(opts.sessionLinkBase) }
          : {}),
        ...(indexing ? { indexing: true } : {}),
        ...(archivedTranscriptsExcluded > 0 ? { archivedTranscriptsExcluded } : {}),
        ...(indexing || archivedTranscriptsExcluded > 0
          ? {
              warning: [
                ...(indexing ? [SESSIONS_SEARCH_INDEXING_WARNING] : []),
                ...(archivedTranscriptsExcluded > 0
                  ? [
                      `Search excludes ${archivedTranscriptsExcluded} archived transcripts. Restore a transcript to include it in search.`,
                    ]
                  : []),
              ].join(" "),
            }
          : {}),
        ...(backendTruncated || visibleHits.length > limit || capped.truncated
          ? { truncated: true }
          : {}),
      });
    },
  };
}
