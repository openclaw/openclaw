import type {
  SessionsSearchParams,
  SessionsSearchResult,
} from "../../../packages/gateway-protocol/src/index.js";
import {
  createSessionVisibilityRowChecker,
  resolveSessionToolContext,
} from "../../agents/tools/sessions-helpers.js";
import { resolvePersistedSessionStoreOwnerForKey } from "../../config/sessions/session-store-owner.js";
import { compareSessionTranscriptSearchHits } from "../../config/sessions/session-transcript-search-policy.js";
import { searchSessionTranscripts } from "../../config/sessions/session-transcript-search.js";
import { resolveAllAgentSessionStoreTargetsAsync } from "../../config/sessions/targets-runtime.js";
import {
  resolveConfiguredSessionStoreTargets,
  type SessionStoreTarget,
} from "../../config/sessions/targets.js";
import { isIncognitoSessionKey, parseAgentSessionKey } from "../../routing/session-key.js";
import { filterSessionEntries } from "../session-list-filters.js";
import {
  toProjectedSessionSharingTarget,
  withReadySessionRows,
} from "../session-row-prepared-read.js";
import type { SessionRowProjection } from "../session-row-projection.js";
import { resolveSessionChildOwners } from "../session-utils-core.js";
import { prepareProjectedSessionList } from "../session-utils-list.js";
import type { GatewayClient } from "./types.js";

/** Recall searches transcript indexes first; current owners authorize only matching keys. */
export async function searchRecallSessionTranscripts(params: {
  query: string;
  limit?: number;
  recall: NonNullable<SessionsSearchParams["recall"]>;
  projection: SessionRowProjection;
  client?: GatewayClient | null;
}): Promise<SessionsSearchResult> {
  const { projection, recall } = params;
  const config = await withReadySessionRows(
    projection,
    () => [],
    (read) => read.state.cfg,
  );
  const configured = resolveConfiguredSessionStoreTargets(config, process.env);
  const configuredAgents = new Set(configured.map((target) => target.agentId));
  const targets = [
    ...configured,
    ...(await resolveAllAgentSessionStoreTargetsAsync(config)).filter(
      (target) => !configuredAgents.has(target.agentId),
    ),
  ];
  const selectedPaths = projection.state.scope({}).paths;
  const selectedTargets = targets.filter((target) =>
    projection
      .physicalPaths(target.storePath, target.agentId)
      .some((path) => selectedPaths.has(path)),
  );
  const filter = (target: SessionStoreTarget, keys: string[]) =>
    withReadySessionRows(
      projection,
      () => keys.map((key) => ({ ...target, key })),
      (read) => {
        const cfg = read.state.cfg;
        const context = resolveSessionToolContext({
          config: cfg,
          agentId: recall.requesterAgentId,
          agentSessionKey: recall.requesterSessionKey,
          sandboxed: recall.sandboxed,
        });
        const guard = createSessionVisibilityRowChecker({
          action: "history",
          defaultAgentId: recall.requesterAgentId,
          requesterAgentId: recall.requesterAgentId,
          requesterSessionKey: context.effectiveRequesterKey,
          mainSessionKey: context.mainSessionKey,
          visibility: context.sessionVisibility,
          a2aPolicy: context.a2aPolicy,
        });
        const now = Date.now();
        const subagentRuns = read.state.rowContext.subagentRuns.atTime(now);
        return keys.map((key) => {
          if (isIncognitoSessionKey(key) || key === "unknown") {
            return false;
          }
          if (!parseAgentSessionKey(key)) {
            const owner = resolvePersistedSessionStoreOwnerForKey(cfg, key);
            if (
              key !== "global" ||
              target.agentId !== recall.requesterAgentId ||
              context.restrictToSpawned ||
              (owner.kind !== "none" &&
                (owner.kind !== "configured" || owner.agentId !== target.agentId))
            ) {
              return false;
            }
          }
          // The list owner applies sharing, federation, cron and phantom exclusions to this key only.
          const { prepared, presentation, filters } = prepareProjectedSessionList({
            projection,
            key,
            now,
            client: params.client,
            opts: {
              archived: "all",
              includeGlobal: true,
              ...(key === "global" ? { agentId: target.agentId } : {}),
            },
          });
          // Global has no agent prefix: authorize the physical transcript owner, not
          // another store's federated copy of the same sentinel.
          const globalRow = key === "global" ? read.describe({ ...target, key }) : undefined;
          const row = key === "global" ? globalRow : prepared.getTarget(key);
          if (!row || row.entry.incognito || row.selection.isPhantom) {
            return false;
          }
          if (
            globalRow
              ? params.client !== undefined &&
                !presentation.sharing.canReadTarget(toProjectedSessionSharingTarget(globalRow))
              : filterSessionEntries(filters).entries.length === 0
          ) {
            return false;
          }
          const childOwnerSessionKeys = resolveSessionChildOwners({
            key,
            entry: row.entry,
            now,
            subagentRuns,
          });
          if (
            context.restrictToSpawned &&
            key !== context.effectiveRequesterKey &&
            !childOwnerSessionKeys.includes(context.effectiveRequesterKey)
          ) {
            return false;
          }
          return guard.check({ key, agentId: row.agentId, childOwnerSessionKeys }).allowed;
        });
      },
    );
  const limit = params.limit ?? 10;
  const pages = [];
  for (const target of selectedTargets) {
    const page = await searchSessionTranscripts(
      { ...target, query: params.query, limit },
      undefined,
      (keys) => filter(target, keys),
    );
    pages.push(page);
  }
  const results = pages.flatMap((page) => page.hits).toSorted(compareSessionTranscriptSearchHits);
  const seen = new Set<string>();
  const unique = results.filter((hit) => {
    const key = JSON.stringify([hit.sessionKey, hit.sessionId, hit.messageId]);
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
  const archivedTranscriptsExcluded = pages.reduce(
    (sum, page) => sum + (page.archivedTranscriptsExcluded ?? 0),
    0,
  );
  return {
    results: unique.slice(0, limit),
    ...(pages.some((page) => page.indexing) ? { indexing: true } : {}),
    ...(archivedTranscriptsExcluded ? { archivedTranscriptsExcluded } : {}),
    ...(unique.length > limit || pages.some((page) => page.truncated) ? { truncated: true } : {}),
  };
}
