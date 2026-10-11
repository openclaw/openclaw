import type { RouteLoaderOptions, RouteLocation } from "@openclaw/uirouter";
import { notFound } from "@openclaw/uirouter";
import { INTERNAL_SESSION_PATH_PARAM } from "../../app-route-paths.ts";
import { pathForSession } from "../../app-session-path-builder.ts";
import { sessionRefFromPath, type SessionPathTarget } from "../../app-session-route-paths.ts";
import type { ApplicationContext as FullApplicationContext } from "../../app/context.ts";
import { waitForGatewayClient } from "../../app/gateway-readiness.ts";
import type { BoardFace } from "../../lib/board/settings.ts";
import {
  buildCatalogSessionKey,
  catalogSessionKeyFromSearch,
} from "../../lib/sessions/catalog-key.ts";
import { prepareSessionNavigationHandoff } from "../../lib/sessions/navigation-handoff.ts";
import {
  findUiSessionRow,
  resolveSessionPreferredFace,
  SESSION_DASHBOARD_EXPANDED_PARAM,
  SESSION_FACE_PREFERENCE_PARAM,
  SESSION_NAVIGATION_KEY_PARAM,
} from "../../lib/sessions/route-navigation.ts";
import {
  buildAgentMainSessionKey,
  isUiGlobalSessionKey,
  parseAgentSessionKey,
  resolveAgentIdFromSessionKey,
  resolveUiConfiguredMainKey,
} from "../../lib/sessions/session-key.ts";
import { draftRouteDataFromLocation, draftSearchFromLocation } from "./route-draft.ts";
import { loadCatalogShareRouteFromLocation } from "./route-loader-catalog-share.ts";
import type { SessionRouteContext as ApplicationContext } from "./route-loader-context.ts";
import {
  missingSessionRouteData,
  querySessionReference,
  uniqueShortIdPrefix,
} from "./route-loader-session-reference.ts";
import {
  findCachedShortSession,
  findLocalSessionReference,
  sessionKeyUuid,
} from "./route-loader-short-cache.ts";
import {
  resolveShortSessionReference,
  type SessionReferenceResolution,
  type SessionRoutePresentation,
} from "./route-loader-short-resolve.ts";
import type { ChatRouteData } from "./session-route-data.ts";

export type { ChatRouteData, SessionChatRouteData } from "./session-route-data.ts";

function sessionRouteHints(location: RouteLocation) {
  return {
    ...draftRouteDataFromLocation(location),
    ...(new URLSearchParams(location.search).get(SESSION_DASHBOARD_EXPANDED_PARAM) === "expanded"
      ? { dashboardExpanded: true as const }
      : {}),
  };
}

function isPreferenceDerivedFace(location: RouteLocation): boolean {
  return new URLSearchParams(location.search).get(SESSION_FACE_PREFERENCE_PARAM) === "1";
}

function locationWithoutSearchParam(location: RouteLocation, key: string): RouteLocation {
  const params = new URLSearchParams(location.search);
  params.delete(key);
  const search = params.toString();
  return { ...location, search: search ? `?${search}` : "" };
}

function locationWithoutNavigationHints(location: RouteLocation): RouteLocation {
  return locationWithoutSearchParam(
    locationWithoutSearchParam(location, SESSION_FACE_PREFERENCE_PARAM),
    SESSION_NAVIGATION_KEY_PARAM,
  );
}

function configuredMainKey(context: ApplicationContext): string {
  if (!hasConfiguredMainKey(context) && context.sessions.cachedRoutingDefaults) {
    return context.sessions.cachedRoutingDefaults.mainKey;
  }
  return (
    context.offlineSessionDefaults?.mainKey ??
    resolveUiConfiguredMainKey({
      agentsList: context.agents.state.agentsList,
      hello: context.gateway.snapshot.hello,
    })
  );
}

function hasConfiguredMainKey(context: ApplicationContext): boolean {
  return Boolean(
    context.offlineSessionDefaults?.mainKey.trim() ||
    context.agents.state.agentsList?.mainKey?.trim() ||
    (context.gateway.snapshot.phase === "connected" && context.gateway.snapshot.hello),
  );
}

function canonicalMainLocation(
  context: ApplicationContext,
  location: RouteLocation,
  face: BoardFace,
  sessionKey: string,
): RouteLocation | null {
  const parsed = parseAgentSessionKey(sessionKey);
  if (!parsed) {
    return null;
  }
  const mainKey = configuredMainKey(context).toLowerCase();
  const rest = parsed.rest.toLowerCase();
  if (rest !== mainKey) {
    return null;
  }
  const pathname = pathForSession(face, parsed.agentId, sessionKey, context.basePath, { mainKey });
  return pathname && pathname !== location.pathname
    ? { ...locationWithoutNavigationHints(location), pathname }
    : null;
}

function canonicalSessionLocation(params: {
  context: ApplicationContext;
  location: RouteLocation;
  face: BoardFace;
  row: SessionRoutePresentation;
  shortIdLength?: number;
}): RouteLocation | null | undefined {
  const face = params.face;
  const agentId = resolveAgentIdFromSessionKey(params.row.key);
  const pathname = pathForSession(face, agentId, params.row.key, params.context.basePath, {
    displayName: params.row.displayName,
    mainKey: configuredMainKey(params.context),
    shortIdLength: params.shortIdLength,
  });
  if (!pathname) {
    return undefined;
  }
  const location = locationWithoutNavigationHints(params.location);
  const changed =
    pathname !== params.location.pathname || location.search !== params.location.search;
  return changed ? { ...location, pathname } : null;
}

export function sessionRouteTargetFromLocation(
  context: ApplicationContext,
  location: RouteLocation,
) {
  const mainKey = configuredMainKey(context);
  const direct = sessionRefFromPath(location.pathname, context.basePath, mainKey);
  if (direct) {
    return { target: direct, location };
  }
  const internalPath = new URLSearchParams(location.search).get(INTERNAL_SESSION_PATH_PARAM);
  if (!internalPath) {
    return null;
  }
  const target = sessionRefFromPath(internalPath, context.basePath, mainKey);
  return target
    ? {
        target,
        location: {
          ...locationWithoutSearchParam(location, INTERNAL_SESSION_PATH_PARAM),
          pathname: internalPath,
        },
      }
    : null;
}

function mainSessionKey(
  context: ApplicationContext,
  target: Extract<SessionPathTarget, { kind: "main" }>,
): string {
  return buildAgentMainSessionKey({
    agentId: target.agentId,
    mainKey: configuredMainKey(context),
  });
}

function ambiguousSessionRouteData(
  context: ApplicationContext,
  face: BoardFace,
  resolution: Extract<SessionReferenceResolution, { kind: "ambiguous" }>,
  location: RouteLocation,
  preferenceDerived: boolean,
  shortId: string,
): Extract<ChatRouteData, { kind: "ambiguous" }> {
  const resolvedRows = resolution.sessions.flatMap((row) => {
    const uuid = sessionKeyUuid(row.key);
    return uuid ? [{ row, uuid }] : [];
  });
  const uuids = resolvedRows.map(({ uuid }) => uuid);
  const candidates = resolvedRows.flatMap(({ row, uuid }) => {
    const prefix = uniqueShortIdPrefix(uuid, uuids, resolution.truncated);
    if (!prefix) {
      return [];
    }
    const agentId = resolveAgentIdFromSessionKey(row.key);
    const candidateFace = preferenceDerived ? resolveSessionPreferredFace(row) : face;
    const href = pathForSession(candidateFace, agentId, row.key, context.basePath, {
      displayName: row.displayName,
      mainKey: configuredMainKey(context),
      shortIdLength: prefix.length,
    });
    return href
      ? [
          {
            agentId,
            displayName: row.displayName?.trim() || row.key,
            href: `${href}${draftSearchFromLocation(location)}`,
            idPrefix: prefix,
          },
        ]
      : [];
  });
  return { kind: "ambiguous", shortId, candidates, truncated: resolution.truncated, face };
}

function resolvedSessionRouteData(params: {
  context: ApplicationContext;
  location: RouteLocation;
  face: BoardFace;
  row: SessionRoutePresentation;
  preferenceDerived: boolean;
  isResolutionSourceCurrent: () => boolean;
  shortId?: string;
  mainTarget?: Extract<SessionPathTarget, { kind: "main" }>;
}): Extract<ChatRouteData, { kind: "session" }> | null {
  // The loader owns face resolution: a preference-derived open adopts the row's stored
  // face, so the page renders that board directly and replaces the URL with the matching
  // namespace instead of re-deriving a face from the path it was handed.
  const face = params.preferenceDerived ? resolveSessionPreferredFace(params.row) : params.face;
  const mainTarget = isUiGlobalSessionKey(params.row.key) ? params.mainTarget : undefined;
  const canonicalLocation = canonicalSessionLocation({
    context: params.context,
    location: params.location,
    face,
    row: mainTarget ? { key: mainSessionKey(params.context, mainTarget) } : params.row,
    ...(params.shortId ? { shortIdLength: params.shortId.length } : {}),
  });
  if (canonicalLocation === undefined) {
    return null;
  }
  if (!mainTarget && canonicalLocation && params.isResolutionSourceCurrent()) {
    // A delayed response cannot transfer its key into a replacement connection.
    prepareSessionNavigationHandoff(
      params.context.gateway,
      canonicalLocation.pathname,
      params.row.key,
    );
  }
  return {
    kind: "session",
    sessionKey: params.row.key,
    ...(mainTarget
      ? { agentId: mainTarget.agentId }
      : params.row.agentId
        ? { agentId: params.row.agentId }
        : {}),
    ...sessionRouteHints(params.location),
    face,
    ...(params.shortId && params.shortId.length > 8 ? { shortId: params.shortId } : {}),
    ...(canonicalLocation ? { canonicalLocation, canonicalLocationSource: params.location } : {}),
  };
}

export async function loadChatRoute(
  context: ApplicationContext,
  location: RouteLocation,
  face: BoardFace,
  signal: AbortSignal,
  revalidation?: { sessionKey?: string },
): Promise<ChatRouteData | ReturnType<typeof notFound>> {
  const { client, hello } = context.gateway.snapshot;
  const isResolutionSourceCurrent = () =>
    context.gateway.snapshot.phase === "connected" &&
    context.gateway.snapshot.client === client &&
    context.gateway.snapshot.hello === hello;
  const catalogShareRoute =
    face === "chat" && (await loadCatalogShareRouteFromLocation(context, location, signal));
  if (catalogShareRoute) {
    return catalogShareRoute;
  }
  const resolvedTarget = sessionRouteTargetFromLocation(context, location);
  if (!resolvedTarget || resolvedTarget.target.namespace !== face) {
    return notFound({ routeId: face });
  }
  const { target } = resolvedTarget;
  if (
    target.kind === "literal" &&
    context.sessions.cachedRoutingDefaults &&
    (!target.slugCandidate || context.sessions.cachedRoutingDefaults.scope === "per-sender")
  ) {
    // Literal keys and display-name links share the scoped roster used by short links.
    await context.sessions.whenCachedRosterSettled();
    signal.throwIfAborted();
  }
  const routeLocation = resolvedTarget.location;
  const preferenceDerived = isPreferenceDerivedFace(routeLocation);
  const presentation = {
    context,
    isResolutionSourceCurrent,
    location: routeLocation,
    face,
    preferenceDerived,
  };
  const resolveReference = (key: string, slug?: string) =>
    querySessionReference(
      context,
      { key, agentId: target.agentId, ...(slug ? { slug } : {}) },
      signal,
    );
  const revalidatedResolution =
    revalidation?.sessionKey &&
    (target.kind === "short" || (target.kind === "literal" && target.slugCandidate))
      ? await resolveReference(revalidation.sessionKey)
      : undefined;
  if (revalidatedResolution === null) {
    // A retired connection is retryable discovery, not authoritative absence.
    throw new Error("The Gateway connection changed while resolving the session.");
  }
  const defaultsUsable =
    hasConfiguredMainKey(context) &&
    (context.offlineSessionDefaults?.scope ?? context.agents.state.agentsList?.scope) !== "global";
  const catalogKey = catalogSessionKeyFromSearch(routeLocation.search);
  if (target.kind === "main" && catalogKey) {
    const sessionKey = buildCatalogSessionKey(catalogKey);
    let canonicalLocation = preferenceDerived
      ? locationWithoutNavigationHints(routeLocation)
      : null;
    let resolvedFace = face;
    if (preferenceDerived) {
      const resolution = await resolveReference(sessionKey);
      if (resolution?.kind === "unique") {
        resolvedFace = resolveSessionPreferredFace(resolution.session);
        const pathname = pathForSession(
          resolvedFace,
          target.agentId,
          mainSessionKey(context, target),
          context.basePath,
          { mainKey: configuredMainKey(context) },
        );
        if (pathname) {
          canonicalLocation = { ...locationWithoutNavigationHints(routeLocation), pathname };
        }
      }
    }
    return {
      kind: "session",
      sessionKey: buildCatalogSessionKey(catalogKey, target.agentId),
      agentId: target.agentId,
      ...sessionRouteHints(routeLocation),
      face: resolvedFace,
      // Non-null only on a preference-derived open, where it always at least drops the
      // marker from the URL.
      ...(canonicalLocation ? { canonicalLocation, canonicalLocationSource: routeLocation } : {}),
    };
  }
  if (target.kind === "main") {
    if (preferenceDerived || !defaultsUsable) {
      await waitForGatewayClient(context.gateway, signal);
    }
    const sessionKey = mainSessionKey(context, target);
    if (preferenceDerived) {
      const resolution = await resolveReference(sessionKey);
      if (resolution?.kind === "unique") {
        const resolved = resolvedSessionRouteData({
          ...presentation,
          row: resolution.session,
          mainTarget: target,
        });
        return resolved ?? notFound({ routeId: face });
      }
    }
    const canonicalLocation = preferenceDerived
      ? locationWithoutNavigationHints(routeLocation)
      : null;
    return {
      kind: "session",
      sessionKey,
      ...sessionRouteHints(routeLocation),
      face,
      ...(canonicalLocation && canonicalLocation.search !== routeLocation.search
        ? { canonicalLocation, canonicalLocationSource: routeLocation }
        : {}),
    };
  }
  if (target.kind === "literal") {
    let defaultsKnown =
      defaultsUsable ||
      context.sessions.cachedRoutingDefaults?.scope === "per-sender" ||
      (context.gateway.snapshot.phase === "connected" && hasConfiguredMainKey(context));
    const needsGatewayResolution = preferenceDerived || Boolean(target.slugCandidate);
    if (!defaultsKnown && needsGatewayResolution) {
      await waitForGatewayClient(context.gateway, signal);
      defaultsKnown = hasConfiguredMainKey(context);
      if (defaultsKnown) {
        return await loadChatRoute(context, routeLocation, face, signal, revalidation);
      }
    }
    if (needsGatewayResolution) {
      // Exact keys win over names; warm names use the same scoped lookup as short links.
      const cachedRow =
        defaultsKnown && !revalidation
          ? (findUiSessionRow(context, target.sessionKey, target.agentId) ??
            (context.sessions.state.resultCached && !preferenceDerived
              ? findLocalSessionReference(
                  context.sessions.state.result?.sessions ?? [],
                  target,
                  configuredMainKey(context),
                )
              : undefined))
          : undefined;
      const resolution =
        revalidatedResolution ??
        (cachedRow
          ? ({ kind: "unique", session: cachedRow } as const)
          : await resolveReference(target.sessionKey, target.slugCandidate));
      if (resolution?.kind === "unique") {
        const resolved = resolvedSessionRouteData({
          ...presentation,
          row: resolution.session,
        });
        return resolved
          ? { ...resolved, ...(cachedRow ? { sessionResolutionFromCache: true as const } : {}) }
          : notFound({ routeId: face });
      }
      if (target.slugCandidate) {
        if (resolution?.kind === "not-found") {
          return missingSessionRouteData(context, face, target.agentId);
        }
        if (resolution?.kind === "ambiguous") {
          return ambiguousSessionRouteData(
            context,
            face,
            resolution,
            routeLocation,
            preferenceDerived,
            target.slugCandidate,
          );
        }
      }
    }
    const canonicalLocation = defaultsKnown
      ? canonicalMainLocation(context, routeLocation, face, target.sessionKey)
      : null;
    const parsed = parseAgentSessionKey(target.sessionKey);
    const canonicalLocationReady =
      !defaultsKnown && parsed
        ? waitForGatewayClient(context.gateway, signal)
            .then(() => canonicalMainLocation(context, routeLocation, face, target.sessionKey))
            .catch(() => null)
        : undefined;
    const navigationLocation = locationWithoutNavigationHints(routeLocation);
    return {
      kind: "session",
      sessionKey: target.sessionKey,
      ...sessionRouteHints(routeLocation),
      face,
      ...(canonicalLocation
        ? { canonicalLocation, canonicalLocationSource: routeLocation }
        : navigationLocation.search !== routeLocation.search
          ? { canonicalLocation: navigationLocation, canonicalLocationSource: routeLocation }
          : {}),
      ...(canonicalLocationReady
        ? { canonicalLocationReady, canonicalLocationSource: routeLocation }
        : {}),
    };
  }
  const cached = revalidation ? undefined : findCachedShortSession(context, routeLocation, target);
  if (cached && !cached.row) {
    const canonicalLocation = locationWithoutNavigationHints(routeLocation);
    const canonicalLocationChanged = canonicalLocation.search !== routeLocation.search;
    return {
      kind: "session",
      sessionKey: cached.sessionKey,
      // The connection-bound handoff has already validated this agent scope.
      agentId: target.agentId,
      ...sessionRouteHints(routeLocation),
      face,
      ...(target.shortId.length > 8 ? { shortId: target.shortId } : {}),
      ...(canonicalLocationChanged
        ? { canonicalLocation, canonicalLocationSource: routeLocation }
        : {}),
    };
  }
  let localRow = cached?.row;
  if (!cached && !preferenceDerived && !revalidation) {
    await context.sessions.whenCachedRosterSettled();
    signal.throwIfAborted();
    // Only the pre-hello cached roster resolves a short id locally; a connected
    // load keeps the Gateway's authoritative sessions.resolve answer. Routing
    // hints belong to the same cache lifecycle, independently of agent discovery.
    if (
      context.gateway.snapshot.phase !== "connected" &&
      (defaultsUsable || context.sessions.cachedRoutingDefaults?.scope === "per-sender") &&
      context.sessions.state.resultCached
    ) {
      localRow = findLocalSessionReference(
        context.sessions.state.result?.sessions ?? [],
        target,
        configuredMainKey(context),
      );
    }
  }
  const resolution = revalidatedResolution
    ? { ...revalidatedResolution, isCurrent: isResolutionSourceCurrent }
    : localRow
      ? { kind: "unique" as const, session: localRow, isCurrent: isResolutionSourceCurrent }
      : await resolveShortSessionReference(context, target, routeLocation, signal);
  if (resolution.kind === "prepared") {
    const canonicalLocationReady = resolution.resolution
      .then((resolved) => {
        if (
          !resolution.isCurrent() ||
          resolved.kind !== "unique" ||
          resolved.session.key !== resolution.session.key ||
          (resolved.session.agentId ?? resolveAgentIdFromSessionKey(resolved.session.key)) !==
            resolution.session.agentId
        ) {
          return null;
        }
        const canonical = resolvedSessionRouteData({
          ...presentation,
          isResolutionSourceCurrent: resolution.isCurrent,
          row: resolved.session,
          preferenceDerived: false,
          shortId: target.shortId,
        });
        return canonical?.canonicalLocation ?? null;
      })
      .catch(() => null);
    return {
      kind: "session",
      sessionKey: resolution.session.key,
      agentId: resolution.session.agentId,
      face,
      routeLoadingSkeleton: true,
      ...(target.shortId.length > 8 ? { shortId: target.shortId } : {}),
      canonicalLocationReady,
      canonicalLocationSource: routeLocation,
    };
  }
  if (resolution.kind === "not-found") {
    if (revalidatedResolution) {
      return missingSessionRouteData(context, face, target.agentId);
    }
    // A mechanically composed literal, notably a full UUID, can match the short grammar.
    // Only after the authoritative short lookup misses may its exact decoded key win.
    const literalResolution = await resolveReference(target.literalSessionKey);
    if (literalResolution?.kind === "unique") {
      const literal = resolvedSessionRouteData({
        ...presentation,
        row: literalResolution.session,
      });
      return literal ?? notFound({ routeId: face });
    }
    return literalResolution?.kind === "not-found"
      ? missingSessionRouteData(context, face, target.agentId)
      : notFound({ routeId: face });
  }
  if (resolution.kind === "ambiguous") {
    return ambiguousSessionRouteData(
      context,
      face,
      resolution,
      routeLocation,
      preferenceDerived,
      target.shortId,
    );
  }
  const resolved = resolvedSessionRouteData({
    ...presentation,
    // RPC resolution owns the connection acquired after a cold route waited for hello.
    isResolutionSourceCurrent: resolution.isCurrent,
    row: resolution.session,
    shortId: target.shortId,
  });
  return resolved
    ? {
        ...resolved,
        ...(localRow
          ? { sessionResolutionFromCache: true as const }
          : { routeLoadingSkeleton: true as const }),
      }
    : notFound({ routeId: face });
}

/** Page-level revalidation and preview preparation stay with the lazy loader. */
export async function loadSessionPage(
  context: FullApplicationContext,
  face: BoardFace,
  { location, signal, cause, deps }: RouteLoaderOptions,
) {
  const current =
    cause === "revalidate"
      ? context.router
          .getState()
          .matches.find((match) => match.routeId === face && match.deps === deps)
      : undefined;
  // SAFETY: Matching this face selects only this page's loadChatRoute result.
  const data = current?.data as ChatRouteData | undefined;
  // Revalidating an established link must not adopt another session with the same prefix.
  const result = await loadChatRoute(
    context,
    location,
    face,
    signal,
    cause === "revalidate"
      ? { sessionKey: data?.kind === "session" ? data.sessionKey : undefined }
      : undefined,
  );
  const creation = context.chatSubmissions.creation;
  if ("kind" in result && result.kind === "session") {
    if (creation?.sessionKey === result.sessionKey) {
      result.creation = creation;
    }
    if (result.creation || context.placementStartup.get(result.sessionKey)?.initialTurn) {
      // Startup owns a display-only view even if an interrupted temporary session is cleaned up.
      await import("./pending-session-create.ts");
      signal.throwIfAborted();
    }
  }
  return result;
}
