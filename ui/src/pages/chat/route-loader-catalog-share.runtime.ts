import {
  buildControlUiCatalogSharePath,
  isControlUiCatalogShareId,
} from "@openclaw/session-url-contract/share-build";
import type {
  SessionsCatalogContinueResult,
  SessionsCatalogListResult,
} from "../../../../packages/gateway-protocol/src/index.js";
import { waitForGatewayClient } from "../../app/gateway-readiness.ts";
import { t } from "../../i18n/index.ts";
import { registerSessionNavigationEnglish } from "../../i18n/locales/en-session-navigation.ts";
import { formatUiError } from "../../lib/format-error.ts";
import {
  buildCatalogSessionKey,
  lookupCatalogSession,
  type CatalogSessionKey,
} from "../../lib/sessions/catalog-key.ts";
import { catalogMethod } from "../../lib/sessions/catalog-read-method.ts";
import { parseAgentSessionKey, resolveUiDefaultAgentId } from "../../lib/sessions/session-key.ts";
import type { ResolvedCatalogShareRoute } from "./route-loader-catalog-share.ts";
import type { SessionRouteContext as ApplicationContext } from "./route-loader-context.ts";
import { missingSessionRouteData } from "./route-loader-session-reference.ts";
import type { ChatRouteData } from "./session-route-data.ts";

registerSessionNavigationEnglish();

function routeError(message: string): Extract<ChatRouteData, { kind: "route-error" }> {
  return { kind: "route-error", message, face: "chat" };
}

export async function loadResolvedCatalogShareRoute(
  context: ApplicationContext,
  resolved: ResolvedCatalogShareRoute,
  signal: AbortSignal,
): Promise<ChatRouteData> {
  const { target, location: sourceLocation } = resolved;
  try {
    const client = await waitForGatewayClient(context.gateway, signal);
    signal.throwIfAborted();
    const agentId = resolveUiDefaultAgentId({
      agentsList: context.agents.state.agentsList,
      hello: context.gateway.snapshot.hello,
    });
    const listed = await client.request<SessionsCatalogListResult>(
      catalogMethod(context.gateway.snapshot, target.routeSegment, "list"),
      {
        agentId,
        search: target.shortId,
        limitPerHost: 2,
      },
    );
    signal.throwIfAborted();
    const matchingCatalogs = listed.catalogs.filter(
      (candidate) => candidate.shareRoute?.routeSegment === target.routeSegment,
    );
    const catalog = matchingCatalogs.length === 1 ? matchingCatalogs[0] : undefined;
    if (!catalog?.shareRoute) {
      return routeError(t("chat.sessionRoute.catalogShareUnavailable"));
    }
    const shareRoute = catalog.shareRoute;
    if (!isControlUiCatalogShareId(shareRoute, target.shortId)) {
      return routeError(t("chat.sessionRoute.catalogShareInvalid", { catalog: catalog.label }));
    }
    if (catalog.error) {
      return routeError(catalog.error.message);
    }
    const matchingHosts = catalog.hosts.filter(
      (candidate) => candidate.hostId === shareRoute.hostId,
    );
    const host = matchingHosts.length === 1 ? matchingHosts[0] : undefined;
    if (!host) {
      return routeError(t("chat.sessionRoute.catalogShareUnavailable"));
    }
    if (host?.error) {
      return routeError(host.error.message);
    }
    const matches = host.sessions.filter(
      (session) =>
        isControlUiCatalogShareId(shareRoute, session.threadId) &&
        session.threadId.length === shareRoute.fullLength &&
        session.threadId.startsWith(target.shortId),
    );
    const pathForThread = (session: (typeof matches)[number], prefixLength: number) =>
      buildControlUiCatalogSharePath({
        shareRoute,
        threadId: session.threadId,
        displayName: session.name,
        basePath: context.basePath,
        prefixLength,
      });
    if (matches.length > 1 || host.nextCursor) {
      const candidates = matches.flatMap((session) => {
        const href = pathForThread(session, shareRoute.fullLength);
        return href
          ? [
              {
                agentId: catalog.label,
                displayName: session.name?.trim() || session.threadId,
                href,
                idPrefix: session.threadId,
              },
            ]
          : [];
      });
      return {
        kind: "ambiguous",
        shortId: target.shortId,
        candidates,
        truncated: Boolean(host.nextCursor),
        face: "chat",
      };
    }
    const session = matches[0];
    if (!session) {
      return missingSessionRouteData(context, "chat", agentId);
    }
    const pathname = pathForThread(session, target.shortId.length);
    if (!pathname) {
      return routeError(t("chat.sessionRoute.catalogShareUnavailable"));
    }
    const continued = session.sessionKey
      ? await resolveBoundCatalogConversation(
          context,
          client,
          { catalogId: catalog.id, hostId: shareRoute.hostId, threadId: session.threadId },
          agentId,
          signal,
        )
      : undefined;
    return {
      kind: "session",
      sessionKey:
        continued?.sessionKey ??
        buildCatalogSessionKey(
          { catalogId: catalog.id, hostId: shareRoute.hostId, threadId: session.threadId },
          agentId,
        ),
      agentId: continued?.agentId ?? agentId,
      draft: undefined,
      face: "chat",
      // Names can change on later uploads; the id resolves the same transcript.
      ...(pathname !== sourceLocation.pathname
        ? {
            canonicalLocation: { ...sourceLocation, pathname },
            canonicalLocationSource: sourceLocation,
          }
        : {}),
    };
  } catch (error) {
    signal.throwIfAborted();
    return routeError(formatUiError(error, t("chat.sessionRoute.catalogShareUnavailable")));
  }
}

async function resolveBoundCatalogConversation(
  context: ApplicationContext,
  client: Awaited<ReturnType<typeof waitForGatewayClient>>,
  key: CatalogSessionKey,
  agentId: string,
  signal: AbortSignal,
) {
  // A catalog pointer is discovery. Reconcile origin and destination ACLs before
  // a deleted destination could be mistaken for a new ordinary conversation.
  const result = await client.request<SessionsCatalogContinueResult | null>(
    catalogMethod(context.gateway.snapshot, key.catalogId, "resolve"),
    { ...key, agentId },
    { signal },
  );
  signal.throwIfAborted();
  if (context.gateway.snapshot.client !== client) {
    throw new Error("The Gateway connection changed while resolving the conversation.");
  }
  if (!result) return undefined;
  return {
    sessionKey: result.sessionKey,
    agentId: parseAgentSessionKey(result.sessionKey)?.agentId ?? agentId,
  };
}

export async function resolveCatalogContinuation(
  context: ApplicationContext,
  key: CatalogSessionKey,
  agentId: string,
  signal: AbortSignal,
) {
  const client = await waitForGatewayClient(context.gateway, signal);
  const lookup = await lookupCatalogSession({
    client,
    key,
    agentId,
    signal,
    isCurrent: () => !signal.aborted && context.gateway.snapshot.client === client,
    listMethod: catalogMethod(context.gateway.snapshot, key.catalogId, "list"),
  });
  signal.throwIfAborted();
  return lookup?.session?.sessionKey
    ? resolveBoundCatalogConversation(context, client, key, agentId, signal)
    : undefined;
}
