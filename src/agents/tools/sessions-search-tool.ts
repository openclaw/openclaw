import { Type, type Static } from "typebox";
import { GatewayProtocolRequestTimeoutError } from "../../../packages/gateway-client/src/protocol-request.js";
import { compareSessionTranscriptSearchHits } from "../../config/sessions/session-transcript-search-policy.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { isGatewayTransportError } from "../../gateway/transport-error.js";
import { jsonUtf8Bytes } from "../../infra/json-utf8-bytes.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { isIncognitoSessionKey, parseAgentSessionKey } from "../../routing/session-key.js";
import { truncateUtf16Safe } from "../../utils.js";
import { resolveSessionAgentId } from "../agent-scope.js";
import { optionalPositiveIntegerSchema, requesterProfileSchema } from "../schema/typebox.js";
import {
  describeSessionLinkRule,
  describeSessionsSearchTool,
  SESSION_LINK_RULE_DESCRIPTION,
  SESSIONS_SEARCH_TOOL_DISPLAY_SUMMARY,
} from "../tool-description-presets.js";
import type { AnyAgentTool } from "./common.js";
import {
  jsonResult,
  readPositiveIntegerParam,
  readToolStringParam,
  ToolInputError,
} from "./common.js";
import { wrapGatewayPersonalToolExecution } from "./gateway-caller-context.js";
import {
  callAgentToolGatewayRequest,
  type AgentToolGatewayRequestCaller as GatewayCaller,
} from "./in-process-gateway.js";
import {
  resolveSessionToolTargetAgentId,
  runWithScopedSessionAccess,
} from "./scoped-session-access.js";
import {
  formatSessionToolAccessDenial,
  isSessionToolMainAlias,
  resolveDisplaySessionKey,
  resolveSessionReference,
  resolveSessionToolAccess,
  resolveSessionToolContext,
  resolveVisibleSessionReference,
} from "./sessions-helpers.js";

const SESSIONS_SEARCH_DEFAULT_LIMIT = 10;
const SESSIONS_SEARCH_MAX_LIMIT = 25;
// Bounds FTS token expansion on the synchronous gateway path while leaving ample query context.
const SESSIONS_SEARCH_MAX_QUERY_CHARS = 4096;
const SESSIONS_SEARCH_MAX_BYTES = 32 * 1024;
const SESSIONS_SEARCH_SNIPPET_MAX_CHARS = 300;
const SESSIONS_SEARCH_INDEXING_WARNING =
  "Search completeness could not be confirmed; results may be incomplete. Retry sessions_search shortly.";

const log = createSubsystemLogger("agents/sessions-search");

async function measureSessionsSearch<T>(
  callGateway: GatewayCaller,
  run: (gatewayCall: GatewayCaller) => Promise<T>,
): Promise<T> {
  const started = performance.now();
  let searchMs = 0;
  const measuredCall: GatewayCaller = async (request) => {
    const before = performance.now();
    try {
      return await callGateway(request);
    } finally {
      const elapsed = performance.now() - before;
      if (request.method === "sessions.search") {
        searchMs += elapsed;
      }
    }
  };
  try {
    return await run(measuredCall);
  } finally {
    const elapsedMs = performance.now() - started;
    if (elapsedMs >= 5_000) {
      try {
        log.warn("slow sessions search", {
          elapsedMs: Math.round(elapsedMs),
          searchMs: Math.round(searchMs),
        });
      } catch {
        // Diagnostics cannot replace the tool result or its original error.
      }
    }
  }
}

const SessionsSearchToolSchema = Type.Object({
  user: requesterProfileSchema({ defaultToTurnOwner: true }),
  query: Type.String({
    minLength: 1,
    maxLength: SESSIONS_SEARCH_MAX_QUERY_CHARS,
    description: "Required non-empty keywords to match in past user and assistant text.",
  }),
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
      sessionLinkRule: Type.Optional(Type.String({ description: SESSION_LINK_RULE_DESCRIPTION })),
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

type SanitizedSearchHit = Static<typeof SessionsSearchHitSchema>;
type GatewaySearchHit = Partial<Record<keyof SanitizedSearchHit, unknown>>;

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
  const snippet =
    hit.snippet.length > SESSIONS_SEARCH_SNIPPET_MAX_CHARS
      ? `${truncateUtf16Safe(hit.snippet, SESSIONS_SEARCH_SNIPPET_MAX_CHARS)}…`
      : hit.snippet;
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

export function createSessionsSearchTool(opts?: {
  agentId?: string;
  agentSessionKey?: string;
  sessionReadScopeKey?: string;
  sandboxed?: boolean;
  config?: OpenClawConfig;
  callGateway?: GatewayCaller;
  sessionLinkBase?: string;
}): AnyAgentTool {
  const callGateway = opts?.callGateway ?? callAgentToolGatewayRequest;
  return {
    label: "Sessions Search",
    name: "sessions_search",
    displaySummary: SESSIONS_SEARCH_TOOL_DISPLAY_SUMMARY,
    description: describeSessionsSearchTool({ sessionLinkBase: opts?.sessionLinkBase }),
    parameters: SessionsSearchToolSchema,
    outputSchema: SessionsSearchOutputSchema,
    execute: wrapGatewayPersonalToolExecution(async (_toolCallId, args) =>
      measureSessionsSearch(callGateway, async (gatewayCall) => {
        const params = args as Record<string, unknown>;
        const query = readToolStringParam(params, "query") ?? "";
        if (!query) {
          throw new ToolInputError(
            "query must not be empty; retry with non-empty keywords to match in past session text",
          );
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
        // Host-bound and self scopes already identify the complete search universe.
        // Reuse targeted authorization instead of enumerating unrelated sessions.
        const requestedSessionKey =
          readToolStringParam(params, "sessionKey") ||
          opts?.sessionReadScopeKey ||
          (visibility === "self" ? "current" : undefined);
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
              : isSessionToolMainAlias(normalizedRequestedKey, { mainKey, alias }) ||
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
        const runSearch = () =>
          gatewayCall<{
            results?: GatewaySearchHit[];
            indexing?: boolean;
            archivedTranscriptsExcluded?: number;
            truncated?: boolean;
          }>({
            method: "sessions.search",
            timeoutMs: 90_000,
            params: {
              query,
              limit: SESSIONS_SEARCH_MAX_LIMIT,
              ...(sessionTarget
                ? {
                    agentId: sessionTarget.agentId,
                    sessionKeys: [sessionTarget.key],
                  }
                : {
                    recall: {
                      requesterAgentId,
                      requesterSessionKey: effectiveRequesterKey,
                      ...(opts?.sandboxed ? { sandboxed: true } : {}),
                    },
                  }),
            },
          });
        let result: Awaited<ReturnType<typeof runSearch>>;
        try {
          result = sessionTarget?.expectedSessionId
            ? await runWithScopedSessionAccess({
                cfg,
                agentId: sessionTarget.agentId,
                expectedSessionId: sessionTarget.expectedSessionId,
                targetSessionKey: sessionTarget.key,
                run: runSearch,
              })
            : await runSearch();
        } catch (error) {
          if (
            error instanceof GatewayProtocolRequestTimeoutError ||
            (isGatewayTransportError(error) &&
              error.kind === "timeout" &&
              error.requestDispatched === true)
          ) {
            throw new Error(
              "Chat history search timed out. Retry sessions_search with a sessionKey to search one session or more specific query keywords. A timeout does not mean that no matching conversation exists.",
              { cause: error },
            );
          }
          throw error;
        }
        const indexing = result.indexing === true;
        const archivedTranscriptsExcluded = result.archivedTranscriptsExcluded ?? 0;
        const backendTruncated = result.truncated === true;
        const visibleHits: SanitizedSearchHit[] = [];
        for (const hit of Array.isArray(result.results) ? result.results : []) {
          if (typeof hit.sessionKey !== "string" || isIncognitoSessionKey(hit.sessionKey)) {
            continue;
          }
          if (sessionTarget && hit.sessionKey !== sessionTarget.key) {
            const parsed = parseAgentSessionKey(hit.sessionKey);
            if (
              parseAgentSessionKey(sessionTarget.key) ||
              parsed?.agentId !== sessionTarget.agentId ||
              parsed.rest !== sessionTarget.key.trim()
            ) {
              continue;
            }
          }
          const sanitized = sanitizeHit({
            alias,
            mainKey,
            hit: sessionTarget ? { ...hit, sessionKey: sessionTarget.key } : hit,
          });
          if (sanitized) {
            visibleHits.push(sanitized);
          }
        }
        visibleHits.sort(compareSessionTranscriptSearchHits);
        const limited = visibleHits.slice(0, limit);
        const capped = capSearchHits(limited);
        const warnings = [
          indexing ? SESSIONS_SEARCH_INDEXING_WARNING : undefined,
          archivedTranscriptsExcluded > 0
            ? `Search excludes ${archivedTranscriptsExcluded} archived chats. Restore a chat to include it in search.`
            : undefined,
        ].filter(Boolean);
        return jsonResult({
          results: capped.items,
          ...(opts?.sessionLinkBase
            ? { sessionLinkRule: describeSessionLinkRule(opts.sessionLinkBase) }
            : {}),
          ...(indexing ? { indexing: true } : {}),
          ...(archivedTranscriptsExcluded > 0 ? { archivedTranscriptsExcluded } : {}),
          ...(warnings.length ? { warning: warnings.join(" ") } : {}),
          ...(backendTruncated || visibleHits.length > limit || capped.truncated
            ? { truncated: true }
            : {}),
        });
      }),
    ),
  };
}
