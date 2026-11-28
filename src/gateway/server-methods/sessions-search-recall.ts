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
import type { SessionEntry } from "../../config/sessions/types.js";
import { resolveSessionChannelScope } from "../../plugin-sdk/session-visibility-internal.js";
import { createAgentToAgentPolicy } from "../../plugin-sdk/session-visibility.js";
import { isIncognitoSessionKey, parseAgentSessionKey } from "../../routing/session-key.js";
import {
  deliveryContextFromSession,
  sessionDeliveryOrigin,
} from "../../utils/delivery-context.read.js";
import {
  toProjectedSessionSharingTarget,
  withReadySessionRows,
  type SessionRowReadView,
} from "../session-row-prepared-read.js";
import type { SessionRowProjection } from "../session-row-projection.js";
import { selectUniqueSessionRow } from "../session-row-selection.js";
import { prepareProjectedSessionSharing } from "../session-sharing.js";
import { resolveSessionChildOwners } from "../session-utils-core.js";
import type { GatewayClient } from "./types.js";

/** Recall searches transcript indexes first; current owners authorize only matching keys. */
export async function searchRecallSessionTranscripts(params: {
  query: string;
  limit?: number;
  recall: NonNullable<SessionsSearchParams["recall"]>;
  projection: SessionRowProjection;
  client?: GatewayClient | null;
  onResult: (result: SessionsSearchResult) => void;
}): Promise<void> {
  const { projection, recall } = params;
  const channelScopeFor = (row: {
    key: string;
    entry: Pick<SessionEntry, "chatType" | "space" | "delivery">;
  }) =>
    resolveSessionChannelScope({
      key: row.key,
      chatType: row.entry.chatType,
      space: row.entry.space,
      origin: sessionDeliveryOrigin(row.entry),
      deliveryContext: deliveryContextFromSession(row.entry),
    });
  const prepareTargets = () =>
    withReadySessionRows(
      projection,
      () => [],
      (read) => {
        const scope = projection.state.scope({});
        const configured = resolveConfiguredSessionStoreTargets(read.state.cfg, process.env);
        // Shared stores retain each configured logical agent; discovery belongs to topology admission.
        const targets = [
          ...configured,
          ...scope.targets.filter((target) => !scope.ownerAgentIds.has(target.agentId)),
        ].filter((target) =>
          read
            .physicalPaths(target.storePath, target.agentId)
            .some((path) => scope.paths.has(path)),
        );
        const requester = read.describe({
          agentId: recall.requesterAgentId,
          key: recall.requesterSessionKey,
        });
        return {
          targets,
          revision: projection.sharingRevision,
          requester: requester
            ? { sessionId: requester.entry.sessionId, channelScope: channelScopeFor(requester) }
            : undefined,
        };
      },
    );
  const authorize = (
    target: SessionStoreTarget,
    keys: string[],
    read: SessionRowReadView,
    requesterChannelScope?: ReturnType<typeof resolveSessionChannelScope>,
  ) => {
    const { cfg, policyConfig, rowContext } = read.state;
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
        requesterChannelScope,
      }),
    );
    const now = Date.now();
    const subagentRuns = rowContext.subagentRuns.atTime(now);
    const scope = projection.state.scope({});
    const sharing =
      params.client === undefined
        ? undefined
        : prepareProjectedSessionSharing({
            cfg: policyConfig,
            client: params.client,
            isMember: ({ agentId, storePath, storeKey }, id) =>
              read.hasMembership(storePath, storeKey, id, agentId),
          });
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
      const row =
        key === "global"
          ? read.describe({ ...target, key })
          : selectUniqueSessionRow(cfg, scope, projection.selectEntries({ key, sortBy: null }));
      if (
        !row ||
        row.entry.incognito ||
        row.selection.isPhantom ||
        row.selection.isCronRun ||
        sharing?.canReadTarget(toProjectedSessionSharingTarget(row)) === false
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
        (guard) =>
          guard.check({
            key,
            agentId: row.agentId,
            childOwnerSessionKeys,
            channelScope: channelScopeFor(row),
          }).allowed,
      );
    });
  };
  const targetIdentity = (target: SessionStoreTarget, key: string) =>
    JSON.stringify([target.agentId, target.storePath, key]);
  const limit = params.limit ?? 10;
  for (let attempt = 0; attempt < 2; attempt++) {
    const { targets, revision, requester } = await prepareTargets();
    const admittedSessionIds = new Map<string, string>();
    const filter = (target: SessionStoreTarget, keys: string[]) =>
      withReadySessionRows(
        projection,
        () => keys.map((key) => ({ ...target, key })),
        (read) => {
          const allowed = authorize(target, keys, read, requester?.channelScope);
          if (recall.visibility === "channel") {
            for (const [index, key] of keys.entries()) {
              if (!allowed[index]) {
                continue;
              }
              const row = read.describe({ ...target, key });
              if (row) {
                admittedSessionIds.set(targetIdentity(target, key), row.entry.sessionId);
              }
            }
          }
          return allowed;
        },
      );
    const pages: Array<{
      target: SessionStoreTarget;
      page: Awaited<ReturnType<typeof searchSessionTranscripts>>;
    }> = [];
    for (const target of targets) {
      const page = await searchSessionTranscripts(
        { ...target, query: params.query, limit },
        undefined,
        (keys) => filter(target, keys),
      );
      pages.push({ target, page });
    }
    const published = await withReadySessionRows(
      projection,
      () =>
        pages.flatMap(({ target, page }) =>
          page.hits
            .filter((hit) => !isIncognitoSessionKey(hit.sessionKey) && hit.sessionKey !== "unknown")
            .map((hit) => ({
              agentId: target.agentId,
              storePath: target.storePath,
              key: hit.sessionKey,
            })),
        ),
      (read) => {
        // Worker pages and their counts belong to the same disclosure facts as the response.
        if (revision !== projection.sharingRevision) {
          return false;
        }
        const liveRequester =
          recall.visibility === "channel"
            ? read.describe({ agentId: recall.requesterAgentId, key: recall.requesterSessionKey })
            : undefined;
        const requesterCurrent =
          recall.visibility !== "channel" ||
          (liveRequester !== undefined && liveRequester.entry.sessionId === requester?.sessionId);
        const current = requesterCurrent
          ? pages.filter(({ target, page }) =>
              recall.visibility === "channel"
                ? page.hits.every((hit) => {
                    const expected = admittedSessionIds.get(targetIdentity(target, hit.sessionKey));
                    const row = read.describe({ ...target, key: hit.sessionKey });
                    if (!row || expected === undefined || row.entry.sessionId !== expected) {
                      return false;
                    }
                    return true;
                  })
                : authorize(
                    target,
                    page.hits.map((hit) => hit.sessionKey),
                    read,
                  ).every(Boolean),
            )
          : [];
        if (revision !== projection.sharingRevision) {
          return false;
        }
        const results = current
          .flatMap(({ page }) => page.hits)
          .toSorted(compareSessionTranscriptSearchHits);
        const seen = new Set<string>();
        const unique = results.filter((hit) => {
          const key = JSON.stringify([hit.sessionKey, hit.sessionId, hit.messageId]);
          if (seen.has(key)) {
            return false;
          }
          seen.add(key);
          return true;
        });
        const archivedTranscriptsExcluded = current.reduce(
          (sum, { page }) => sum + (page.archivedTranscriptsExcluded ?? 0),
          0,
        );
        params.onResult({
          results: unique.slice(0, limit),
          ...(current.some(({ page }) => page.indexing) ? { indexing: true } : {}),
          ...(archivedTranscriptsExcluded ? { archivedTranscriptsExcluded } : {}),
          ...(unique.length > limit || current.some(({ page }) => page.truncated)
            ? { truncated: true }
            : {}),
        });
        return true;
      },
    );
    if (published) {
      return;
    }
  }
  throw new Error("Session search scope changed while reading; retry the request");
}
