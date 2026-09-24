// Read-only session queries.
import { setImmediate as yieldToEventLoop } from "node:timers/promises";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import {
  ErrorCodes,
  errorShape,
  type SessionsListParams,
  validateSessionsListParams,
  validateSessionsPreviewParams,
  validateSessionsResolveParams,
  validateSessionsSearchParams,
} from "../../../packages/gateway-protocol/src/index.js";
import {
  resolveExistingAgentSessionStoreTargetsSync,
  resolveSessionStorePathCore,
} from "../../config/sessions.js";
import {
  listSessionEntriesReadOnly,
  withSessionEntryReadOnlyScope,
} from "../../config/sessions/session-accessor.js";
import { SessionTranscriptColdError } from "../../config/sessions/session-cold-storage-state.js";
import { searchSessionTranscripts } from "../../config/sessions/session-transcript-search.js";
import { formatErrorMessage } from "../../infra/errors.js";
import {
  isIncognitoSessionKey,
  normalizeAgentId,
  parseAgentSessionKey,
} from "../../routing/session-key.js";
import { hasOperatorBoundary } from "../operator-role-policy.js";
import { SessionMutationAuthorizationChangedError } from "../session-mutation-authorization-error.js";
import { resolveRequestedSessionAgentId as resolveRequestedGlobalAgentId } from "../session-request-agent.js";
import type { SessionRowReadView } from "../session-row-prepared-read.js";
import { getSessionRowProjection } from "../session-row-projection-access.js";
import type { MaterializedRow } from "../session-row-projection-record.js";
import {
  canAccessIncognitoSession,
  createSessionListEntryFilter,
  isGatewayAdmin,
  prepareSessionSharingTargets,
  resolveSessionSharingTarget,
} from "../session-sharing.js";
import { resolveSessionStoreAgentId } from "../session-store-key.js";
import { readSessionPreviewItemsFromTranscriptAsync } from "../session-transcript-preview.js";
import type { GatewaySessionStoreDiscoveryCache } from "../session-utils-store-lookup.js";
import {
  listProjectedSessions,
  type SessionsPreviewEntry,
  type SessionsPreviewResult,
} from "../session-utils.js";
import { resolveSessionKeyFromResolveParams } from "../sessions-resolve.js";
import { gatewayClientSessionCreator } from "./gateway-client-identity.js";
import { withSessionListDiagnostics } from "./sessions-list-diagnostics.js";
import { sessionMaintenanceHandlers } from "./sessions-maintenance.js";
import { sessionByKeyReadHandlers } from "./sessions-read-by-key.js";
import { searchProjectedSessionTranscripts } from "./sessions-search-projected.js";
import { resolveSessionSearchScope } from "./sessions-search-scope.js";
import type { GatewayRequestHandlers } from "./types.js";
import { assertValidParams } from "./validation.js";

export const sessionReadHandlers: GatewayRequestHandlers = {
  "sessions.search": async ({ params, respond, context, client, sessionMutationAuthorization }) => {
    if (!assertValidParams(params, validateSessionsSearchParams, "sessions.search", respond)) {
      return;
    }
    const query = params.query.trim();
    if (!query) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "query must not be empty"));
      return;
    }
    if (params.scope !== undefined) {
      try {
        await searchProjectedSessionTranscripts({
          query,
          limit: params.limit,
          scope: params.scope,
          context,
          client: client ?? null,
          onResult: (result) => {
            sessionMutationAuthorization?.assertCurrent();
            respond(true, result);
          },
        });
      } catch (error) {
        if (error instanceof SessionMutationAuthorizationChangedError) {
          throw error;
        }
        respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, formatErrorMessage(error)));
      }
      return;
    }
    const prepareSearch = () => {
      sessionMutationAuthorization?.assertCurrent();
      const cfg = context.getRuntimeConfig();
      const policyConfig = context.getCommittedRuntimeConfig?.() ?? cfg;
      const scope = resolveSessionSearchScope(cfg, params);
      if (!scope.ok) {
        respond(false, undefined, scope.error);
        return undefined;
      }
      const { agentId, configured, requestedAgentId, sessionKeys } = scope;
      const restrictIncognito =
        Boolean(gatewayClientSessionCreator(client)) && !isGatewayAdmin(client);
      const roleVisibilityFilter = hasOperatorBoundary(client, policyConfig)
        ? createSessionListEntryFilter({ client, cfg: policyConfig })
        : undefined;
      const restrictVisibility = restrictIncognito || Boolean(roleVisibilityFilter);
      const targetDiscoveryCache: GatewaySessionStoreDiscoveryCache = new Map();
      const canSearchSessionKey = (
        sessionKey: string,
        prepared?: ReturnType<typeof prepareSessionSharingTargets>[number],
      ) => {
        if (
          isIncognitoSessionKey(sessionKey) &&
          !canAccessIncognitoSession({ cfg, client: client ?? null, sessionKey, agentId })
        ) {
          return false;
        }
        if (!roleVisibilityFilter) {
          return true;
        }
        if (prepared && !prepared.ok) {
          throw prepared.error;
        }
        const target = prepared
          ? prepared.value
          : resolveSessionSharingTarget({ cfg, sessionKey, agentId, targetDiscoveryCache });
        return Boolean(target && roleVisibilityFilter(target.storeKey, target.entry));
      };
      if (requestedAgentId && !params.sessionKeys && configured) {
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.INVALID_REQUEST, "agentId requires sessionKeys"),
        );
        return undefined;
      }
      const scopedSessionKeys = (
        configured
          ? sessionKeys
          : sessionKeys?.filter((sessionKey) => {
              const sessionAgentId =
                requestedAgentId && (sessionKey === "global" || sessionKey === "unknown")
                  ? requestedAgentId
                  : resolveSessionStoreAgentId(cfg, sessionKey);
              return sessionAgentId === agentId;
            })
      )?.filter((sessionKey) => canSearchSessionKey(sessionKey));
      const searchTargets = configured
        ? [{ agentId, storePath: resolveSessionStorePathCore(cfg.session?.store, { agentId }) }]
        : resolveExistingAgentSessionStoreTargetsSync(cfg, agentId);
      if (!configured && (searchTargets.length === 0 || scopedSessionKeys?.length === 0)) {
        respond(true, { results: [] }, undefined);
        return undefined;
      }
      return searchTargets.flatMap((target) => {
        const targetSessionKeys =
          scopedSessionKeys ??
          (restrictVisibility
            ? withSessionEntryReadOnlyScope(target, () => {
                const keys = listSessionEntriesReadOnly({
                  agentId: target.agentId,
                  storePath: target.storePath,
                  projection: "list",
                  clone: false,
                })
                  .map((entry) => entry.sessionKey)
                  .filter((sessionKey) => {
                    // A shared physical store can include rows owned by another agent.
                    const parsed = parseAgentSessionKey(sessionKey);
                    return !parsed || normalizeAgentId(parsed.agentId) === agentId;
                  });
                const prepared = roleVisibilityFilter
                  ? prepareSessionSharingTargets({
                      cfg,
                      targets: keys
                        .filter((sessionKey) => !isIncognitoSessionKey(sessionKey))
                        .map((sessionKey) => ({ sessionKey, agentId })),
                    })
                  : [];
                let ordinal = 0;
                return keys.filter((sessionKey) => {
                  // Incognito checks retain their scalar lookup and place in the error order.
                  const sharing =
                    roleVisibilityFilter && !isIncognitoSessionKey(sessionKey)
                      ? prepared[ordinal++]
                      : undefined;
                  return canSearchSessionKey(sessionKey, sharing);
                });
              })
            : undefined);
        if (targetSessionKeys?.length === 0) {
          return [];
        }
        return [
          {
            ...target,
            query,
            // Over-fetch retired multi-store searches so deduplication can still fill the caller's
            // requested page when the same transcript was copied during a store migration.
            limit: configured ? params.limit : 25,
            ...(targetSessionKeys ? { sessionKeys: targetSessionKeys } : {}),
          },
        ];
      });
    };
    try {
      for (let attempt = 0; attempt < 2; attempt++) {
        const requests = prepareSearch();
        if (!requests) {
          return;
        }
        const targetResults = await Promise.all(
          requests.map((request) => searchSessionTranscripts(request)),
        );
        // Current configuration, identity, and sharing must authorize the whole result page.
        const current = prepareSearch();
        if (!current) {
          return;
        }
        if (JSON.stringify(current) !== JSON.stringify(requests)) {
          continue;
        }
        const archivedTranscriptsExcluded = targetResults.reduce(
          (count, result) => count + (result.archivedTranscriptsExcluded ?? 0),
          0,
        );
        const limit = params.limit ?? 10;
        const sortedHits = targetResults
          .flatMap((result) => result.hits)
          .toSorted(
            (left, right) =>
              right.score - left.score ||
              right.timestamp - left.timestamp ||
              left.messageId.localeCompare(right.messageId),
          );
        const seenHits = new Set<string>();
        const hits = sortedHits.filter((hit) => {
          const identity = `${hit.sessionKey}\u0000${hit.sessionId}\u0000${hit.messageId}`;
          if (seenHits.has(identity)) {
            return false;
          }
          seenHits.add(identity);
          return true;
        });
        respond(true, {
          results: hits.slice(0, limit),
          ...(archivedTranscriptsExcluded ? { archivedTranscriptsExcluded } : {}),
          ...(targetResults.some((result) => result.indexing) ? { indexing: true } : {}),
          ...(targetResults.some((result) => result.truncated) || hits.length > limit
            ? { truncated: true }
            : {}),
        });
        return;
      }
      throw new Error("Session search scope changed while reading; retry the request");
    } catch (error) {
      if (error instanceof SessionMutationAuthorizationChangedError) {
        throw error;
      }
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, formatErrorMessage(error)));
    }
  },
  "sessions.list": withSessionListDiagnostics(async (args, diagnostics) => {
    const { params, respond, client, context } = args;
    if (!assertValidParams(params, validateSessionsListParams, "sessions.list", respond)) {
      return;
    }
    const projection = getSessionRowProjection(context);
    if (!projection) {
      throw new Error("Session projection is unavailable before Gateway startup completes");
    }
    await listProjectedSessions({
      projection,
      opts: params as SessionsListParams,
      context,
      client,
      diagnostics,
      onResult: (result) => {
        args.sessionMutationAuthorization?.assertCurrent();
        respond(true, result);
      },
    });
  }),
  "sessions.preview": async ({
    params,
    respond,
    context,
    client,
    sessionMutationAuthorization,
  }) => {
    if (!assertValidParams(params, validateSessionsPreviewParams, "sessions.preview", respond)) {
      return;
    }
    const keys = (Array.isArray(params.keys) ? params.keys : [])
      .map((key) => normalizeOptionalString(key ?? ""))
      .filter((key): key is string => Boolean(key))
      .slice(0, 64);
    const limit = params.limit ?? 12;
    const maxChars = params.maxChars ?? 240;

    if (keys.length === 0) {
      respond(true, { ts: Date.now(), previews: [] } satisfies SessionsPreviewResult, undefined);
      return;
    }

    const projection = getSessionRowProjection(context);
    if (!projection) {
      throw new Error("Session projection is unavailable before Gateway startup completes");
    }
    const withPreviewRows = async <T>(
      requestedKeys: readonly string[],
      consume: (read: SessionRowReadView) => T,
    ): Promise<T> => {
      while (true) {
        const prepared = await projection.withPreparedExactRows(
          (cfg) =>
            requestedKeys.flatMap((key) => {
              const agent = resolveRequestedGlobalAgentId(cfg, key);
              return agent.ok ? [{ key, agentId: agent.agentId }] : [];
            }),
          consume,
        );
        if (prepared.kind === "complete") {
          return prepared.value;
        }
        const { certifySessionCanonicalValidationPending } =
          await import("../../config/sessions/session-canonical-validation-readiness.js");
        await certifySessionCanonicalValidationPending(prepared.database);
      }
    };
    const previews: SessionsPreviewEntry[] = [];
    const buffered: Array<{
      preview: SessionsPreviewEntry;
      record: MaterializedRow;
      generation: MaterializedRow["generation"];
      sessionId: string;
      lifecycleRevision?: string;
    }> = [];

    for (const key of keys) {
      if (previews.length > 0) {
        await yieldToEventLoop();
      }
      const requestedAgent = resolveRequestedGlobalAgentId(context.getRuntimeConfig(), key);
      if (!requestedAgent.ok) {
        respond(false, undefined, requestedAgent.error);
        return;
      }
      const preview: SessionsPreviewEntry = { key, status: "missing", items: [] };
      previews.push(preview);
      try {
        const record = await withPreviewRows([key], (read) => {
          sessionMutationAuthorization?.assertCurrent();
          const { cfg, policyConfig } = read.state;
          const currentAgent = resolveRequestedGlobalAgentId(cfg, key);
          if (!currentAgent.ok) {
            return undefined;
          }
          const current = read.describe({ key, agentId: currentAgent.agentId });
          const visibilityFilter = hasOperatorBoundary(client, policyConfig)
            ? createSessionListEntryFilter({ client, cfg: policyConfig })
            : undefined;
          return current?.entry.sessionId &&
            visibilityFilter?.(current.key, current.entry) !== false
            ? current
            : undefined;
        });
        if (!record) {
          continue;
        }
        buffered.push({
          preview,
          record,
          generation: record.generation,
          sessionId: record.entry.sessionId,
          lifecycleRevision: record.entry.lifecycleRevision,
        });
        preview.items = await readSessionPreviewItemsFromTranscriptAsync(
          {
            agentId: record.agentId,
            sessionEntry: record.entry,
            sessionId: record.entry.sessionId,
            sessionKey: record.key,
            storePath: record.storeTarget.storePath,
          },
          limit,
          maxChars,
        );
        preview.status = preview.items.length > 0 ? "ok" : "empty";
      } catch (error) {
        if (error instanceof SessionMutationAuthorizationChangedError) {
          throw error;
        }
        preview.status = error instanceof SessionTranscriptColdError ? "cold" : "error";
      }
    }

    // Later keys yield after earlier previews are buffered. Reauthorize the exact
    // incarnations together, without another await before publishing their content.
    await withPreviewRows(
      buffered.map(({ preview }) => preview.key),
      (read) => {
        sessionMutationAuthorization?.assertCurrent();
        const { cfg, policyConfig } = read.state;
        const visibilityFilter = hasOperatorBoundary(client, policyConfig)
          ? createSessionListEntryFilter({ client, cfg: policyConfig })
          : undefined;
        for (const previous of buffered) {
          const agent = resolveRequestedGlobalAgentId(cfg, previous.preview.key);
          const current = agent.ok
            ? read.describe({ key: previous.preview.key, agentId: agent.agentId }, previous.record)
            : undefined;
          if (
            !current ||
            current.agentId !== previous.record.agentId ||
            current.key !== previous.record.key ||
            current.storeTarget.storePath !== previous.record.storeTarget.storePath ||
            current.generation !== previous.generation ||
            current.entry.sessionId !== previous.sessionId ||
            current.entry.lifecycleRevision !== previous.lifecycleRevision ||
            visibilityFilter?.(current.key, current.entry) === false
          ) {
            previous.preview.status = "missing";
            previous.preview.items = [];
          }
        }
        respond(true, { ts: Date.now(), previews } satisfies SessionsPreviewResult, undefined);
      },
    );
  },
  "sessions.resolve": ({ params, respond, context, client }) => {
    if (!assertValidParams(params, validateSessionsResolveParams, "sessions.resolve", respond)) {
      return;
    }
    const projection = getSessionRowProjection(context);
    if (!projection) {
      throw new Error("Session projection is unavailable before Gateway startup completes");
    }
    const resolved = resolveSessionKeyFromResolveParams({
      projection,
      client,
      p: params,
    });
    if (!resolved.ok) {
      respond(false, undefined, resolved.error);
      return;
    }
    if ("missing" in resolved) {
      respond(true, { ok: false }, undefined);
      return;
    }
    if ("ambiguous" in resolved) {
      respond(true, { ok: false, candidates: resolved.candidates }, undefined);
      return;
    }
    respond(true, resolved, undefined);
  },
  ...sessionByKeyReadHandlers,
  ...sessionMaintenanceHandlers,
};

export const sessionsListHandler = sessionReadHandlers["sessions.list"]!;
