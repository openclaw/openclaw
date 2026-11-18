import type { SessionRow } from "../../../packages/gateway-protocol/src/schema/sessions-row.js";
import { expandSessionRowFacts } from "../../../packages/gateway-protocol/src/session-row-fields.js";
import { resolvePersistedSessionStoreOwnerForKey } from "../../config/sessions/session-store-owner.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { isGatewayClientRequestError } from "../../gateway/call.js";
import { parseAgentSessionKey } from "../../routing/session-key.js";
import type { AgentToolGatewayRequestCaller as GatewayCaller } from "./in-process-gateway.js";
import type { createSessionVisibilityRowChecker } from "./sessions-helpers.js";

export type SearchSessionCandidate = {
  key: string;
  agentId?: string;
  expectedSessionId?: string;
};

export async function listVisibleSearchSessions(params: {
  cfg: OpenClawConfig;
  unscopedAgentId: string;
  effectiveRequesterAgentId?: string;
  effectiveRequesterKey: string;
  gatewayCall: GatewayCaller;
  rowGuard: Pick<ReturnType<typeof createSessionVisibilityRowChecker>, "check">;
  rowMode: "sidebar" | "dashboard";
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
      ...(params.effectiveRequesterAgentId ? { agentId: params.effectiveRequesterAgentId } : {}),
    } satisfies SearchSessionCandidate;
    candidates.set(candidateId(requesterCandidate), requesterCandidate);
  }
  type VisibilityRow = Parameters<typeof params.rowGuard.check>[0];
  const add = (row: VisibilityRow) => {
    if (params.rowGuard.check(row).allowed) {
      candidates.set(candidateId(row), { key: row.key, agentId: row.agentId });
    }
  };
  let offset = 0;
  while (true) {
    const page = await params.gatewayCall<{
      sessions: SessionRow[];
      sharedFacts?: Partial<SessionRow>[];
      hasMore?: boolean;
      nextOffset?: number;
    }>({
      method: "sessions.list",
      params: {
        source: "sessions-search",
        rowMode: params.rowMode,
        limit: 200,
        offset,
        archived: "all",
        includeGlobal: !params.restrictToSpawned,
        includeUnknown: false,
        ...(params.restrictToSpawned ? { spawnedBy: params.effectiveRequesterKey } : {}),
      },
    });
    for (const row of expandSessionRowFacts(page.sessions, page.sharedFacts)) {
      if (parseAgentSessionKey(row.key) || row.agentId === params.unscopedAgentId) {
        add(row);
      }
    }
    if (page.hasMore !== true || typeof page.nextOffset !== "number" || page.nextOffset <= offset) {
      break;
    }
    offset = page.nextOffset;
  }
  const globalOwner = resolvePersistedSessionStoreOwnerForKey(params.cfg, "global");
  if (
    !params.restrictToSpawned &&
    !candidates.has(candidateId({ key: "global", agentId: params.unscopedAgentId })) &&
    (globalOwner.kind === "none" ||
      (globalOwner.kind === "configured" && globalOwner.agentId === params.unscopedAgentId))
  ) {
    // Canonical stores contain only scoped keys and global/unknown sentinels. A foreign
    // global may win the combined listing; resolve ours exactly instead of rescanning it.
    const { session } = await params
      .gatewayCall<{ session: VisibilityRow | null }>({
        method: "sessions.describe",
        params: {
          key: "global",
          agentId: params.unscopedAgentId,
          includeDerivedTitles: false,
          includeLastMessage: false,
        },
      })
      .catch((error: unknown) => {
        // Describe hides an unreadable sentinel as not-found; listing simply omits it.
        if (
          isGatewayClientRequestError(error) &&
          error.gatewayCode === "INVALID_REQUEST" &&
          error.message === 'Session "global" was not found.'
        ) {
          return { session: null };
        }
        throw error;
      });
    if (session) {
      add(session);
    }
  }
  return [...candidates.values()].toSorted((left, right) => left.key.localeCompare(right.key));
}

export function createSearchHitMatcher(agentId: string, candidates: SearchSessionCandidate[]) {
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
