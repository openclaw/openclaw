import { setImmediate as yieldToEventLoop } from "node:timers/promises";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import {
  GATEWAY_CLIENT_CAPS,
  hasGatewayClientCap,
} from "../../../packages/gateway-protocol/src/client-info.js";
import {
  ErrorCodes,
  errorShape,
  validateSessionsListParams,
  validateSessionsPreviewParams,
  validateSessionsResolveParams,
  validateSessionsSearchParams,
} from "../../../packages/gateway-protocol/src/index.js";
import { resolveSessionStorePathCore } from "../../config/sessions.js";
import { canonicalSessionKeyMigrationRequiredError } from "../../config/sessions/session-canonical-key.js";
import { SessionTranscriptColdError } from "../../config/sessions/session-cold-storage-state.js";
import {
  readSessionEntriesFromStoreInWorker,
  readSessionEntrySummariesInWorker,
} from "../../config/sessions/session-entry-read-runtime.js";
import { searchSessionTranscripts } from "../../config/sessions/session-transcript-search.js";
import { resolveExistingAgentSessionStoreTargetsAsync } from "../../config/sessions/targets-runtime.js";
import type { SessionStoreTarget } from "../../config/sessions/targets.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import { formatErrorMessage } from "../../infra/errors.js";
import {
  isIncognitoSessionKey,
  normalizeAgentId,
  parseAgentSessionKey,
} from "../../routing/session-key.js";
import { errorShapeFromError } from "../error-shape.js";
import { hasOperatorBoundary, operatorSessionCap } from "../operator-role-policy.js";
import { SessionMutationAuthorizationChangedError } from "../session-mutation-authorization-error.js";
import { resolveRequestedSessionAgentId as resolveRequestedGlobalAgentId } from "../session-request-agent.js";
import { withReadySessionRows, type SessionRowReadView } from "../session-row-prepared-read.js";
import {
  getSessionRowProjection,
  requireSessionRowProjection,
} from "../session-row-projection-access.js";
import type { MaterializedRow } from "../session-row-projection-record.js";
import { hasSessionReadAccessChanged } from "../session-sharing-policy.js";
import {
  authorizeIncognitoSessionTarget,
  createSessionListEntryFilter,
  isGatewayAdmin,
} from "../session-sharing.js";
import { resolveSessionStoreAgentId } from "../session-store-key.js";
import { readSessionPreviewItemsFromTranscriptAsync } from "../session-transcript-preview.js";
import {
  listProjectedSessions,
  type SessionsPreviewEntry,
  type SessionsPreviewResult,
} from "../session-utils.js";
import { withPreparedSessionResolve } from "../sessions-resolve.js";
import { gatewayClientSessionCreator } from "./gateway-client-identity.js";
import { createPreparedReadHandler } from "./prepared-read.js";
import { startSessionListDiagnostics } from "./sessions-list-diagnostics.js";
import { sessionMaintenanceHandlers } from "./sessions-maintenance.js";
import { sessionByKeyReadHandlers } from "./sessions-read-by-key.js";
import { searchProjectedSessionTranscripts } from "./sessions-search-projected.js";
import { resolveSessionSearchScope } from "./sessions-search-scope.js";
import type { GatewayRequestHandlers } from "./types.js";
import { assertValidParams, defineValidatedGatewayHandler } from "./validation.js";

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
        respond(
          false,
          undefined,
          errorShapeFromError(ErrorCodes.UNAVAILABLE, error, {
            message: formatErrorMessage(error),
          }),
        );
      }
      return;
    }
    const discoveredTargets = new Map<string, Promise<readonly SessionStoreTarget[]>>();
    const prepareSearch = async () => {
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
      const restrictRoleVisibility =
        hasOperatorBoundary(client, policyConfig) &&
        Boolean(createSessionListEntryFilter({ client, cfg: policyConfig }));
      const membershipProjection =
        operatorSessionCap(client, policyConfig) === "invited"
          ? requireSessionRowProjection(context)
          : undefined;
      if (membershipProjection) {
        await membershipProjection.prepareSelection();
        await membershipProjection.prepareMembership();
      }
      const restrictVisibility = restrictIncognito || restrictRoleVisibility;
      if (requestedAgentId && !params.sessionKeys && configured) {
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.INVALID_REQUEST, "agentId requires sessionKeys"),
        );
        return undefined;
      }
      const scopedSessionKeys = configured
        ? sessionKeys
        : sessionKeys?.filter((sessionKey) => {
            const sessionAgentId =
              requestedAgentId && (sessionKey === "global" || sessionKey === "unknown")
                ? requestedAgentId
                : resolveSessionStoreAgentId(cfg, sessionKey);
            return sessionAgentId === agentId;
          });
      const discoveryKey = JSON.stringify([agentId, cfg.session?.store]);
      let discovery = discoveredTargets.get(discoveryKey);
      if (!configured && !discovery) {
        discovery = resolveExistingAgentSessionStoreTargetsAsync(cfg, agentId);
        discoveredTargets.set(discoveryKey, discovery);
      }
      const searchTargets = configured
        ? [{ agentId, storePath: resolveSessionStorePathCore(cfg.session?.store, { agentId }) }]
        : await discovery!;
      if (!configured && (searchTargets.length === 0 || scopedSessionKeys?.length === 0)) {
        respond(true, { results: [] }, undefined);
        return undefined;
      }
      const entriesByTarget = restrictVisibility
        ? await Promise.all(
            searchTargets.map(async (target) =>
              scopedSessionKeys
                ? (
                    await readSessionEntriesFromStoreInWorker({
                      ...target,
                      sessionKeys: scopedSessionKeys,
                      projection: "list",
                    })
                  ).entries
                : readSessionEntrySummariesInWorker(target),
            ),
          )
        : undefined;
      // Selection runs in the caller's synchronous publication frame, after all worker waits.
      return () => {
        const currentPolicyConfig =
          context.getCommittedRuntimeConfig?.() ?? context.getRuntimeConfig();
        const roleVisibilityFilter = hasOperatorBoundary(client, currentPolicyConfig)
          ? createSessionListEntryFilter({ client, cfg: currentPolicyConfig })
          : undefined;
        const entries = new Map<string, SessionEntry>();
        // Role checks need one canonical metadata row. Unrestricted retired-store
        // searches retain copied-transcript deduplication below.
        if (roleVisibilityFilter) {
          for (const rows of entriesByTarget ?? []) {
            for (const { sessionKey, entry } of rows) {
              const parsed = parseAgentSessionKey(sessionKey);
              if (
                isIncognitoSessionKey(sessionKey) ||
                (parsed && normalizeAgentId(parsed.agentId) !== agentId)
              ) {
                continue;
              }
              if (entries.has(sessionKey)) {
                throw canonicalSessionKeyMigrationRequiredError(
                  `duplicate rows resolve to canonical session key ${sessionKey}`,
                );
              }
              entries.set(sessionKey, entry);
            }
          }
        }
        const profileId = gatewayClientSessionCreator(client)?.id;
        const canSearchSessionKey = (
          sessionKey: string,
          entry: SessionEntry | undefined,
          target: SessionStoreTarget,
        ) => {
          if (
            isIncognitoSessionKey(sessionKey) &&
            authorizeIncognitoSessionTarget({
              client: client ?? null,
              sessionKey,
              target: null,
            }) !== null
          ) {
            return false;
          }
          if (!roleVisibilityFilter) {
            return true;
          }
          const lookup = { key: sessionKey, agentId: target.agentId, storePath: target.storePath };
          // Worker results can predate a committed visibility or incarnation change.
          if (membershipProjection) {
            const current = membershipProjection.sharingTargetState(lookup);
            if (
              current.status !== "ready" ||
              hasSessionReadAccessChanged(entry, current.target.entry)
            ) {
              return false;
            }
          }
          const membership = membershipProjection?.readMembership(lookup);
          return Boolean(
            entry &&
            roleVisibilityFilter(
              sessionKey,
              entry,
              Boolean(profileId && membership?.has(profileId)),
            ),
          );
        };
        return searchTargets.flatMap((target, index) => {
          const candidateKeys =
            scopedSessionKeys ?? entriesByTarget?.[index]?.map(({ sessionKey }) => sessionKey);
          const targetSessionKeys = candidateKeys?.filter((sessionKey) => {
            // A shared physical store can include rows owned by another agent.
            const parsed = parseAgentSessionKey(sessionKey);
            return (
              (!parsed || normalizeAgentId(parsed.agentId) === agentId) &&
              canSearchSessionKey(sessionKey, entries.get(sessionKey), target)
            );
          });
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
    };
    try {
      for (let attempt = 0; attempt < 2; attempt++) {
        const selectRequests = await prepareSearch();
        if (!selectRequests) {
          return;
        }
        const requests = selectRequests();
        const targetResults = await Promise.all(
          requests.map((request) => searchSessionTranscripts(request)),
        );
        // Current configuration, identity, and sharing must authorize the whole result page.
        const selectCurrent = await prepareSearch();
        if (!selectCurrent) {
          return;
        }
        const current = selectCurrent();
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
          // oxlint-disable-next-line unicorn/no-array-sort -- flatMap returns a fresh, private array.
          .sort(
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
        sessionMutationAuthorization?.assertCurrent();
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
      respond(
        false,
        undefined,
        errorShapeFromError(ErrorCodes.UNAVAILABLE, error, { message: formatErrorMessage(error) }),
      );
    }
  },
  "sessions.list": createPreparedReadHandler((args) => {
    const { params, client, context } = args;
    const diagnostics = startSessionListDiagnostics(
      args.respond,
      args.req.method === "sessions.subscribe" ? "sessions.subscribe" : "sessions.list",
      params,
    );
    const respondToCaller = diagnostics?.respond ?? args.respond;
    try {
      if (
        !assertValidParams(params, validateSessionsListParams, "sessions.list", respondToCaller)
      ) {
        diagnostics?.finish("returned");
        return undefined;
      }
      const projection = requireSessionRowProjection(context);
      const assertCurrent = () => args.sessionMutationAuthorization?.assertCurrent();
      return {
        respond: respondToCaller,
        assertCurrent,
        beforeRespond: () => {
          // Legacy receipts belong to admitted roster rows; delta clients retain socket baselines.
          if (
            client?.connId &&
            !hasGatewayClientCap(client.connect.caps, GATEWAY_CLIENT_CAPS.SESSION_ROW_DELTAS)
          ) {
            context.forgetConnectionAncestors(client.connId);
          }
        },
        release: (outcome) => diagnostics?.finish(outcome),
        run: async (respond) => {
          await listProjectedSessions({
            projection,
            opts: params,
            context,
            client,
            acceptsSerializedJson: args.acceptsSerializedJson,
            diagnostics,
            onResult: (result) => {
              assertCurrent();
              respond(true, result);
            },
          });
        },
      };
    } catch (error) {
      diagnostics?.finish("threw");
      throw error;
    }
  }),
  "sessions.preview": defineValidatedGatewayHandler(
    "sessions.preview",
    validateSessionsPreviewParams,
    async ({ params, respond, context, client, sessionMutationAuthorization }) => {
      const keys = params.keys
        .map((key) => normalizeOptionalString(key))
        .filter((key): key is string => Boolean(key))
        .slice(0, 64);
      const limit = params.limit ?? 12;
      const maxChars = params.maxChars ?? 240;

      if (keys.length === 0) {
        respond(true, { ts: Date.now(), previews: [] } satisfies SessionsPreviewResult, undefined);
        return;
      }

      const projection = requireSessionRowProjection(context);
      const withPreviewRows = <T>(
        requestedKeys: readonly string[],
        consume: (read: SessionRowReadView) => T,
      ): Promise<T> =>
        withReadySessionRows(
          projection,
          (cfg) =>
            requestedKeys.flatMap((key) => {
              const agent = resolveRequestedGlobalAgentId(cfg, key, undefined, "read");
              return agent.ok ? [{ key, agentId: agent.agentId }] : [];
            }),
          consume,
        );
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
        const requestedAgent = resolveRequestedGlobalAgentId(
          context.getRuntimeConfig(),
          key,
          undefined,
          "read",
        );
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
            const currentAgent = resolveRequestedGlobalAgentId(cfg, key, undefined, "read");
            if (!currentAgent.ok) {
              return undefined;
            }
            const current = read.describe({ key, agentId: currentAgent.agentId });
            const visibilityFilter = hasOperatorBoundary(client, policyConfig)
              ? createSessionListEntryFilter({
                  client,
                  cfg: policyConfig,
                  membership: current?.membership,
                })
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
          for (const previous of buffered) {
            const agent = resolveRequestedGlobalAgentId(
              cfg,
              previous.preview.key,
              undefined,
              "read",
            );
            const current = agent.ok
              ? read.describe(
                  { key: previous.preview.key, agentId: agent.agentId },
                  previous.record,
                )
              : undefined;
            const visibilityFilter = hasOperatorBoundary(client, policyConfig)
              ? createSessionListEntryFilter({
                  client,
                  cfg: policyConfig,
                  membership: current?.membership,
                })
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
  ),
  "sessions.resolve": defineValidatedGatewayHandler(
    "sessions.resolve",
    validateSessionsResolveParams,
    async ({ params, respond, context, client, sessionMutationAuthorization }) => {
      const projection = requireSessionRowProjection(context);
      await withPreparedSessionResolve(
        {
          projection,
          client,
          p: params,
          isCurrent: () => getSessionRowProjection(context) === projection,
        },
        (resolved) => {
          sessionMutationAuthorization?.assertCurrent();
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
      );
    },
  ),
  ...sessionByKeyReadHandlers,
  ...sessionMaintenanceHandlers,
};

export const sessionsListHandler = sessionReadHandlers["sessions.list"]!;
