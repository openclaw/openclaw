import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import {
  GATEWAY_CLIENT_CAPS,
  hasGatewayClientCap,
} from "../../../packages/gateway-protocol/src/client-info.js";
import {
  ErrorCodes,
  errorShape,
  validateSessionsUsageParams,
} from "../../../packages/gateway-protocol/src/index.js";
import { sessionCreatorProfileId } from "../../config/sessions/session-entry-provenance.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { resolveUsageCostWorkerDayBucket } from "../../infra/session-cost-usage-worker-runtime.js";
import { loadSessionLogs, loadSessionUsageTimeSeries } from "../../infra/session-cost-usage.js";
import { normalizeAgentId } from "../../routing/session-key.js";
import { readSessionRowChangeRevision } from "../../sessions/session-row-changes.js";
import {
  AsyncWorkScope,
  getAsyncWorkSignal,
  trackAsyncWork,
} from "../../shared/async-work-scope.js";
import {
  createUsageAggregateAccumulator,
  UNKNOWN_USAGE_CREATOR_KEY,
} from "../../shared/usage-aggregates.js";
import { buildUsageOverview, selectUsageOverviewPage } from "../../shared/usage-overview.js";
import { extractQueryTerms } from "../../shared/usage-query.js";
import type {
  SessionUsageEntry,
  SessionUsageCreator,
  SessionsUsageAggregates,
  SessionsUsageResult,
  UsageOverviewOptions,
} from "../../shared/usage-types.js";
import {
  sessionDeliveryChannel,
  sessionDeliveryOrigin,
} from "../../utils/delivery-context.read.js";
import { readGatewayAccessRevision } from "../gateway-access-revision.js";
import { operatorSessionCap } from "../operator-role-policy.js";
import { projectSessionActor } from "../session-identity-projection.js";
import { resolveRequestedSessionAgentId } from "../session-request-agent.js";
import { getSessionRowProjection } from "../session-row-projection-access.js";
import {
  prepareSessionMutationFacts,
  SessionMutationFactsUnavailableError,
} from "../session-sharing-preparation.js";
import {
  prepareProjectedSessionSharing,
  prepareSessionSharingProfiles,
} from "../session-sharing-read.js";
import { createSessionListEntryFilter, isGatewayAdmin } from "../session-sharing.js";
import { gatewayClientSessionCreator } from "./gateway-client-identity.js";
import { loadUsageStatusStaleWhileRevalidate } from "./models-auth-status-usage-cache.js";
import type { GatewayRequestHandlers, RespondFn } from "./types.js";
import {
  formatDateLabel,
  resolveDateInterpretation,
  resolveDateRange,
  resolveDayBucket,
  type DateInterpretation,
  type DateRange,
} from "./usage-date-range.js";
import {
  loadCostUsageSummaryCached,
  loadSessionsUsageSnapshotCached,
} from "./usage-result-cache.js";
import { loadUsageSessionSummaries } from "./usage-session-loading.js";
import {
  loadUsageSessionContext,
  resolveSessionUsageTarget,
  selectUsageSessions,
  UsageSessionInvalidRequestError,
  type UsageGroupingMode,
  type UsageSessionSelection,
} from "./usage-session-selection.js";
import { assertValidParams } from "./validation.js";

async function resolveSessionUsageFileOrRespond(
  params: { key?: unknown; agentId?: unknown } | undefined,
  detail: "timeseries" | "logs",
  respond: RespondFn,
  config: OpenClawConfig,
) {
  const key = normalizeOptionalString(params?.key);
  if (!key) {
    respond(
      false,
      undefined,
      errorShape(ErrorCodes.INVALID_REQUEST, `key is required for ${detail}`),
    );
    return null;
  }
  const sessionOwner = resolveRequestedSessionAgentId(
    config,
    key,
    normalizeOptionalString(params?.agentId),
  );
  if (!sessionOwner.ok) {
    respond(false, undefined, sessionOwner.error);
    return null;
  }
  let resolved: Awaited<ReturnType<typeof resolveSessionUsageTarget>>;
  try {
    resolved = await resolveSessionUsageTarget(key, config, sessionOwner.agentId);
  } catch {
    getAsyncWorkSignal()?.throwIfAborted();
    resolved = undefined;
  }
  if (!resolved) {
    respond(
      false,
      undefined,
      errorShape(ErrorCodes.INVALID_REQUEST, `Invalid session key: ${key}`),
    );
    return null;
  }
  return { config, key, ...resolved };
}

function resolveUsageDateRangeOrRespond(
  params: Parameters<typeof resolveDateRange>[0],
  respond: RespondFn,
): { interpretation: DateInterpretation; range: DateRange } | null {
  const interpretation = resolveDateInterpretation(params);
  if (!interpretation.ok) {
    respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, interpretation.error));
    return null;
  }

  const range = resolveDateRange(params, interpretation.value);
  if (!range.ok) {
    respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, range.error));
    return null;
  }
  return { interpretation: interpretation.value, range: range.value };
}

export type { SessionUsageEntry, SessionsUsageAggregates, SessionsUsageResult };

function projectUsageCreator(
  session: UsageSessionSelection,
  profiles: Parameters<typeof projectSessionActor>[1],
  config: OpenClawConfig,
): SessionUsageCreator {
  const entry = session.storeEntry ?? session.creatorEntry;
  const actor = entry?.createdActor;
  if (!actor) {
    return { key: UNKNOWN_USAGE_CREATOR_KEY };
  }
  const projected = projectSessionActor(
    actor,
    profiles,
    config,
    Boolean(sessionCreatorProfileId(actor)),
  );
  if (!projected?.id && actor.type !== "system") {
    return { key: UNKNOWN_USAGE_CREATOR_KEY };
  }
  const identity = projected?.identity;
  const origin = sessionDeliveryOrigin(entry);
  const channel = sessionDeliveryChannel(entry);
  if (actor.type === "human" && actor.source !== "profile" && !channel) {
    return { key: UNKNOWN_USAGE_CREATOR_KEY };
  }
  const key =
    identity?.type === "profile"
      ? JSON.stringify(["profile", identity.id])
      : actor.type === "human"
        ? JSON.stringify([
            "human",
            actor.source,
            session.agentId,
            channel ?? null,
            origin?.accountId ?? null,
            projected?.id,
          ])
        : actor.type === "agent"
          ? JSON.stringify([identity?.type ?? "agent", identity?.id ?? projected?.id])
          : JSON.stringify(["system", projected?.id ?? null]);
  return { key, ...(projected ? { actor: projected } : {}) };
}

function withUsageRequestBudget(
  handler: GatewayRequestHandlers[string],
): GatewayRequestHandlers[string] {
  return async (request) => {
    const parent = AbortSignal.any(
      [getAsyncWorkSignal(), request.signal].filter(
        (signal): signal is AbortSignal => signal !== undefined,
      ),
    );
    const work = new AsyncWorkScope();
    const cancel = () => work.beginClose(parent?.reason);
    const timer = setTimeout(
      () =>
        work.beginClose(
          new Error(
            "Usage request exceeded its 15-second budget; narrow the date range or select a session.",
          ),
        ),
      15_000,
    );
    timer.unref?.();
    parent?.addEventListener("abort", cancel, { once: true });
    if (parent?.aborted) {
      cancel();
    }
    try {
      await trackAsyncWork(() => work.track(() => handler(request)));
    } finally {
      clearTimeout(timer);
      // Refreshes already queued by this read keep their original connection lifetime.
      void trackAsyncWork(() =>
        AsyncWorkScope.runWhenAllIdle(
          () => [work],
          () => work.drain(),
        ),
      ).finally(() => parent?.removeEventListener("abort", cancel));
    }
  };
}

export const usageHandlers: GatewayRequestHandlers = {
  "usage.status": async ({ respond, context, client }) => {
    // Only clients with bounded retry machinery may receive an incomplete cold result.
    // In-process dispatch reuses the originating request's client, capabilities
    // included, so a plugin proxying this method inside a capable UI request
    // would inherit the marker without any way to converge it. Such a caller
    // must pass a capless client, the way board bindings force `client: null`.
    const coldRead = hasGatewayClientCap(
      client?.connect?.caps,
      GATEWAY_CLIENT_CAPS.USAGE_REFRESHING,
    )
      ? ("refresh-marker" as const)
      : undefined;
    const summary = await loadUsageStatusStaleWhileRevalidate({
      config: context.getRuntimeConfig(),
      coldRead,
    });
    respond(true, summary, undefined);
  },
  "usage.cost": async ({ respond, params, context, client }) => {
    const dateRange = resolveUsageDateRangeOrRespond(params ?? {}, respond);
    if (!dateRange) {
      return;
    }
    const { interpretation: dateInterpretation, range } = dateRange;
    const config = context.getRuntimeConfig();
    if (!isGatewayAdmin(client ?? null) && operatorSessionCap(client ?? null, config) === "none") {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.FORBIDDEN,
          "Aggregate usage includes sessions hidden by your operator role; ask an administrator to review Gateway-wide usage.",
        ),
      );
      return;
    }
    const { startMs, endMs } = range;
    const agentId = normalizeOptionalString(params?.agentId);
    if (params?.agentScope === "all" && agentId) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "agentScope=all cannot be combined with agentId"),
      );
      return;
    }
    const agentScope = params?.agentScope === "all" ? "all" : undefined;
    let effectiveAgentId = agentId;
    if (!agentScope && !effectiveAgentId) {
      const requestedAgent = resolveRequestedSessionAgentId(config, "main");
      if (!requestedAgent.ok) {
        respond(false, undefined, requestedAgent.error);
        return;
      }
      effectiveAgentId = requestedAgent.agentId;
    }
    const summary = await loadCostUsageSummaryCached({
      startMs,
      endMs,
      dayBucket: resolveDayBucket(dateInterpretation),
      config,
      agentId: effectiveAgentId,
      agentScope,
    });
    respond(true, summary, undefined);
  },
  "sessions.usage": withUsageRequestBudget(async ({ respond, params, context, client }) => {
    if (!assertValidParams(params, validateSessionsUsageParams, "sessions.usage", respond)) {
      return;
    }

    const p = params;
    const dateRange = resolveUsageDateRangeOrRespond(p, respond);
    if (!dateRange) {
      return;
    }
    const { interpretation: dateInterpretation, range } = dateRange;
    const config = context.getRuntimeConfig();
    const sessionCap = operatorSessionCap(client ?? null, config);
    const visibilityFilter =
      sessionCap === "none"
        ? createSessionListEntryFilter({ client: client ?? null, cfg: config })
        : undefined;
    const profileId = gatewayClientSessionCreator(client ?? null)?.id;
    const visibilityIdentity = sessionCap && profileId ? `${profileId}:${sessionCap}` : undefined;
    const { startMs, endMs, includeUntimestamped } = range;
    const dayBucket = resolveDayBucket(dateInterpretation);
    const limit = p.projection === "overview" ? 50 : (p.limit ?? 50);
    const hasOverviewOptions =
      p.projection === "overview" ||
      p.query !== undefined ||
      p.selectedDays !== undefined ||
      p.selectedHours !== undefined ||
      p.selectedSessions !== undefined ||
      p.recentKeys !== undefined ||
      p.sort !== undefined ||
      p.sortDirection !== undefined ||
      p.offset !== undefined;
    const overviewOptions: UsageOverviewOptions | undefined = hasOverviewOptions
      ? {
          limit,
          offset: p.offset,
          query: p.query,
          selectedDays: p.selectedDays,
          selectedHours: p.selectedHours,
          selectedSessions: p.selectedSessions,
          recentKeys: p.recentKeys,
          sort: p.sort,
          sortDirection: p.sortDirection,
        }
      : undefined;
    const includeContextWeight = p.includeContextWeight ?? false;
    const creatorKey = normalizeOptionalString(p.creatorKey);
    const specificKey = normalizeOptionalString(p.key) ?? null;
    const requestedAgentId = normalizeOptionalString(p.agentId);
    const requestedAllAgents = p.agentScope === "all";
    if (requestedAllAgents && (requestedAgentId || specificKey)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          "agentScope=all cannot be combined with key or agentId",
        ),
      );
      return;
    }
    const specificSessionOwner = specificKey
      ? resolveRequestedSessionAgentId(config, specificKey, requestedAgentId)
      : undefined;
    if (specificSessionOwner && !specificSessionOwner.ok) {
      respond(false, undefined, specificSessionOwner.error);
      return;
    }
    const implicitAgent =
      !requestedAllAgents && !specificSessionOwner?.agentId && !requestedAgentId
        ? resolveRequestedSessionAgentId(config, "main")
        : undefined;
    if (implicitAgent && !implicitAgent.ok) {
      respond(false, undefined, implicitAgent.error);
      return;
    }
    const effectiveAgentId = requestedAllAgents
      ? undefined
      : normalizeAgentId(
          specificSessionOwner?.agentId ?? requestedAgentId ?? implicitAgent?.agentId,
        );
    const groupingMode: UsageGroupingMode =
      p.groupBy === "family" || p.includeHistorical === true ? "family" : "instance";

    let result: Awaited<ReturnType<typeof loadSessionsUsageSnapshotCached>>;
    try {
      result = await loadSessionsUsageSnapshotCached({
        configRef: config,
        ...(effectiveAgentId ? { agentId: effectiveAgentId } : { agentScope: "all" }),
        startMs,
        endMs,
        includeUntimestamped,
        dayBucket,
        limit,
        groupingMode,
        specificKey,
        includeContextWeight,
        creatorKey,
        ...(overviewOptions
          ? { overviewKey: JSON.stringify([p.projection, overviewOptions]) }
          : {}),
        ...(visibilityIdentity ? { visibilityIdentity } : {}),
        load: async () => {
          const now = Date.now();
          const loadedAccessRevision = readGatewayAccessRevision();
          const loadedSessionRevision = readSessionRowChangeRevision();
          const visibleEntries = await selectUsageSessions({
            config,
            agentId: effectiveAgentId,
            specificKey,
            groupingMode,
            startMs,
            endMs,
            visibilityFilter,
          });
          const profiles: Parameters<typeof projectSessionActor>[1] = new Map();
          const matchedEntries = visibleEntries.map((entry) => ({
            entry,
            creator: projectUsageCreator(entry, profiles, config),
          }));
          const mergedEntries = matchedEntries
            .filter(({ creator }) => !creatorKey || creator.key === creatorKey)
            .map(({ entry }) => entry);
          if (mergedEntries.reduce((count, entry) => count + entry.instances.length, 0) > 20_000) {
            throw new UsageSessionInvalidRequestError(
              "Usage includes more than 20,000 session instances; narrow the date range or select a session.",
            );
          }

          // Context queries need the saved report for every candidate; ordinary reads hydrate the page.
          if (
            extractQueryTerms(overviewOptions?.query ?? "").some(
              (term) => term.key?.toLowerCase() === "has" && term.value.toLowerCase() === "context",
            )
          ) {
            await loadUsageSessionContext(mergedEntries, visibilityFilter);
          }
          const sessions: SessionUsageEntry[] = [];
          const { summaries, computing, cacheStatus } = await loadUsageSessionSummaries({
            entries: mergedEntries,
            config,
            startMs,
            endMs,
            includeUntimestamped,
            dayBucket,
          });

          const usageByEntry = new Map(
            mergedEntries.map((entry, index) => [
              entry,
              { usage: summaries[index], computing: computing[index] },
            ]),
          );
          for (const { entry: merged, creator } of matchedEntries) {
            const loaded = usageByEntry.get(merged);
            const usage = loaded?.usage ?? null;
            const channel = sessionDeliveryChannel(merged.storeEntry);
            const origin = sessionDeliveryOrigin(merged.storeEntry);
            sessions.push({
              key: merged.key,
              label: merged.label,
              sessionId: merged.sessionId,
              scope: merged.scope ?? "instance",
              sessionFamilyKey: merged.sessionFamilyKey,
              currentSessionId: merged.currentSessionId,
              includedSessionIds: merged.includedSessionIds,
              historicalInstanceCount: merged.includedSessionIds?.length,
              updatedAt: merged.updatedAt,
              agentId: merged.agentId,
              creatorKey: creator.key,
              createdActor: creator.actor,
              channel,
              chatType: merged.storeEntry?.chatType ?? origin?.chatType,
              origin,
              modelOverride: merged.storeEntry?.modelOverride,
              providerOverride: merged.storeEntry?.providerOverride,
              modelProvider: merged.storeEntry?.modelProvider,
              model: merged.storeEntry?.model,
              usage,
              ...(!usage || loaded?.computing ? { computing: true } : {}),
              hasContextWeight: Boolean(merged.contextWeight),
              contextWeight: includeContextWeight ? (merged.contextWeight ?? null) : undefined,
            });
          }

          return {
            updatedAt: now,
            sessions,
            cacheStatus,
            sources: visibleEntries,
            accessRevision: loadedAccessRevision,
            sessionRevision: loadedSessionRevision,
          };
        },
      });
    } catch (err) {
      if (err instanceof UsageSessionInvalidRequestError) {
        respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, err.message));
        return;
      }
      throw err;
    }
    const sourcesByAgent = new Map<string, Map<string, UsageSessionSelection>>();
    for (const source of result.sources) {
      const sources =
        sourcesByAgent.get(source.agentId) ?? new Map<string, UsageSessionSelection>();
      sources.set(source.key, source);
      sourcesByAgent.set(source.agentId, sources);
    }
    const contextReads = new Map<
      UsageSessionSelection,
      Awaited<ReturnType<typeof prepareSessionMutationFacts>> | undefined
    >();
    const hydratedSources = new Set<UsageSessionSelection>();
    const sourceFor = ({ agentId, key }: SessionUsageEntry) =>
      agentId === undefined ? undefined : sourcesByAgent.get(agentId)?.get(key);
    const committedEntry = (source: UsageSessionSelection) =>
      source.contextTarget && !source.storeEntry?.incognito
        ? getSessionRowProjection(context)?.readCapabilityEntry({
            agentId: source.agentId,
            storePath: source.contextTarget.storeTarget.storePath,
            key: source.key,
          })
        : undefined;
    const snapshotIsCurrent = () =>
      result.sessionRevision === readSessionRowChangeRevision() &&
      result.accessRevision === readGatewayAccessRevision() &&
      config === context.getRuntimeConfig();
    try {
      const profiles = await prepareSessionSharingProfiles(client ?? null);
      const prepareUnavailableSources = async () => {
        for (const session of result.sessions) {
          const source = sourceFor(session);
          if (
            !source ||
            !session.agentId ||
            contextReads.has(source) ||
            (!session.hasContextWeight && snapshotIsCurrent()) ||
            committedEntry(source) !== undefined
          ) {
            continue;
          }
          contextReads.set(source, undefined);
          try {
            const prepared = await prepareSessionMutationFacts({
              cfg: context.getRuntimeConfig(),
              sessionKey: session.key,
              agentId: session.agentId,
            });
            contextReads.set(source, prepared);
          } catch (error) {
            if (!(error instanceof SessionMutationFactsUnavailableError)) {
              throw error;
            }
          }
        }
      };
      const readVisibleRows = () => {
        const currentConfig = context.getRuntimeConfig();
        const { entryFilter: currentFilter, sessionCap: currentSessionCap } =
          prepareProjectedSessionSharing({
            cfg: currentConfig,
            client: client ?? null,
            profiles,
            isMember: () => false,
          });
        return result.sessions.flatMap((session): SessionUsageEntry[] => {
          const source = sourceFor(session);
          const committed = source && committedEntry(source);
          let current = committed?.entry;
          if (committed === undefined && source) {
            const prepared = contextReads.get(source);
            if (prepared) {
              try {
                current = prepared.readCurrent(currentConfig).target?.entry;
              } catch (error) {
                if (!(error instanceof SessionMutationFactsUnavailableError)) {
                  throw error;
                }
              }
            } else if (!contextReads.has(source) && snapshotIsCurrent()) {
              current = source.storeEntry;
            }
          }
          // Cached reports are data; current receipt metadata owns publication authority.
          if (
            source?.storeEntry
              ? !current || (currentFilter && !currentFilter(session.key, current))
              : currentSessionCap === "none"
          ) {
            return [];
          }
          return session.hasContextWeight && current?.sessionId !== session.sessionId
            ? [
                {
                  ...session,
                  hasContextWeight: false,
                  contextWeight: includeContextWeight ? null : undefined,
                },
              ]
            : [session];
        });
      };
      // Refill once after an access change. Continued churn may shorten the page, never extend the scan.
      let visible: SessionUsageEntry[] | undefined;
      for (let attempt = 0; attempt < 2; attempt += 1) {
        await prepareUnavailableSources();
        visible = readVisibleRows();
        const selected = visible.filter((row) => !creatorKey || row.creatorKey === creatorKey);
        const pageSources = (
          overviewOptions
            ? selectUsageOverviewPage({
                rows: selected,
                options: overviewOptions,
                dayBucket: resolveUsageCostWorkerDayBucket(dayBucket),
              })
            : selected.slice(0, limit)
        ).flatMap((row) => {
          const source = sourceFor(row);
          return source && !hydratedSources.has(source) ? [source] : [];
        });
        if (pageSources.length === 0) {
          break;
        }
        visible = undefined;
        await loadUsageSessionContext(pageSources, visibilityFilter);
        pageSources.forEach((source) => hydratedSources.add(source));
        result = {
          ...result,
          sessions: result.sessions.map((row) => {
            const source = sourceFor(row);
            return source && hydratedSources.has(source)
              ? {
                  ...row,
                  hasContextWeight: Boolean(source.contextWeight),
                  contextWeight: includeContextWeight ? (source.contextWeight ?? null) : undefined,
                }
              : row;
          }),
        };
      }
      if (!visible) {
        await prepareUnavailableSources();
        visible = readVisibleRows();
      }
      const creatorOptions = new Map<string, SessionUsageCreator>();
      for (const row of visible) {
        if (row.creatorKey) {
          creatorOptions.set(row.creatorKey, { key: row.creatorKey, actor: row.createdActor });
        }
      }
      const selected = visible.filter((row) => !creatorKey || row.creatorKey === creatorKey);
      const accumulator = createUsageAggregateAccumulator();
      if (!overviewOptions) {
        selected.forEach((row) => accumulator.add(row));
      }
      const slice = overviewOptions
        ? buildUsageOverview({
            rows: selected,
            options: overviewOptions,
            dayBucket: resolveUsageCostWorkerDayBucket(dayBucket),
            compact: p.projection === "overview",
          })
        : {
            sessions: selected.slice(0, limit),
            totals: accumulator.totals,
            aggregates: accumulator.finish(),
          };
      getAsyncWorkSignal()?.throwIfAborted();
      respond(
        true,
        {
          ...slice,
          sessions: slice.sessions.filter((row) => {
            const source = sourceFor(row);
            return source && hydratedSources.has(source);
          }),
          updatedAt: result.updatedAt,
          startDate: formatDateLabel(startMs, dateInterpretation),
          endDate: formatDateLabel(endMs, dateInterpretation),
          creatorOptions: [...creatorOptions.values()],
          cacheStatus: result.cacheStatus,
        },
        undefined,
      );
    } finally {
      contextReads.forEach((read) => read?.release());
    }
  }),
  "sessions.usage.timeseries": async ({ respond, params, context }) => {
    const resolved = await resolveSessionUsageFileOrRespond(
      params,
      "timeseries",
      respond,
      context.getRuntimeConfig(),
    );
    if (!resolved) {
      return;
    }
    const timeseries = await loadSessionUsageTimeSeries({
      ...resolved,
      maxPoints: 200,
    });

    if (!timeseries) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, `No transcript found for session: ${resolved.key}`),
      );
      return;
    }

    respond(true, timeseries, undefined);
  },
  "sessions.usage.logs": async ({ respond, params, context }) => {
    const limit =
      typeof params?.limit === "number" && Number.isFinite(params.limit)
        ? Math.min(params.limit, 1000)
        : 200;

    const resolved = await resolveSessionUsageFileOrRespond(
      params,
      "logs",
      respond,
      context.getRuntimeConfig(),
    );
    if (!resolved) {
      return;
    }
    const logs = await loadSessionLogs({ ...resolved, limit });

    respond(true, { logs: logs ?? [] }, undefined);
  },
};
