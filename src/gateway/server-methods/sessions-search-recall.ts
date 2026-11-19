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
import {
  resolveConfiguredSessionStoreTargets,
  type SessionStoreTarget,
} from "../../config/sessions/targets.js";
import { createAgentToAgentPolicy } from "../../plugin-sdk/session-visibility.js";
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
  const targets = await withReadySessionRows(
    projection,
    () => [],
    (read) => {
      const scope = projection.state.scope({});
      const configured = resolveConfiguredSessionStoreTargets(read.state.cfg, process.env);
      // Shared stores retain each configured logical agent; discovery belongs to topology admission.
      return [
        ...configured,
        ...scope.targets.filter((target) => !scope.ownerAgentIds.has(target.agentId)),
      ].filter((target) =>
        read.physicalPaths(target.storePath, target.agentId).some((path) => scope.paths.has(path)),
      );
    },
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
        const restrictToSpawned = context.restrictToSpawned || recall.restrictToSpawned;
        const guards = [
          context,
          ...(recall.visibility
            ? [
                {
                  ...context,
                  sessionVisibility: recall.visibility,
                  mainSessionKey: recall.mainSessionKey,
                  a2aPolicy: createAgentToAgentPolicy({
                    tools: { agentToAgent: recall.agentToAgent },
                  }),
                },
              ]
            : []),
        ].map((policy) =>
          createSessionVisibilityRowChecker({
            action: "history",
            defaultAgentId: recall.requesterAgentId,
            requesterAgentId: recall.requesterAgentId,
            requesterSessionKey: context.effectiveRequesterKey,
            mainSessionKey: policy.mainSessionKey,
            visibility: policy.sessionVisibility,
            a2aPolicy: policy.a2aPolicy,
          }),
        );
        const now = Date.now();
        const subagentRuns = read.state.rowContext.subagentRuns.atTime(now);
        // Share list selection and presentation across this admitted candidate batch.
        const { prepared, presentation, filters } = prepareProjectedSessionList({
          projection,
          candidateKeys: new Set(keys),
          now,
          client: params.client,
          opts: { archived: "all", includeGlobal: true },
        });
        const visibleKeys = new Set(filterSessionEntries(filters).entries.map(([key]) => key));
        return keys.map((key) => {
          if (isIncognitoSessionKey(key) || key === "unknown") {
            return false;
          }
          if (!parseAgentSessionKey(key)) {
            const owner = resolvePersistedSessionStoreOwnerForKey(cfg, key);
            if (
              key !== "global" ||
              target.agentId !== recall.requesterAgentId ||
              restrictToSpawned ||
              (owner.kind !== "none" &&
                (owner.kind !== "configured" || owner.agentId !== target.agentId))
            ) {
              return false;
            }
          }
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
              : !visibleKeys.has(key)
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
            restrictToSpawned &&
            key !== context.effectiveRequesterKey &&
            !childOwnerSessionKeys.includes(context.effectiveRequesterKey)
          ) {
            return false;
          }
          return guards.every(
            (guard) => guard.check({ key, agentId: row.agentId, childOwnerSessionKeys }).allowed,
          );
        });
      },
    );
  const limit = params.limit ?? 10;
  const pages = [];
  for (const target of targets) {
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
