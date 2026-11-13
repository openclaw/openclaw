import { isDeepStrictEqual } from "node:util";
import {
  GATEWAY_OWNER_PROFILE_ID,
  type SessionCatalogHost,
  type SessionCatalogSession,
} from "../../../packages/gateway-protocol/src/index.js";
import type { SessionEntry } from "../../config/sessions.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { retainSessionCatalogSourceScope } from "../../plugins/session-catalog-source-scope.js";
import type {
  SessionCatalogListProviderParams,
  SessionCatalogProvider,
} from "../../plugins/session-catalog.js";
import { isIncognitoSessionKey, resolveAgentIdFromSessionKey } from "../../routing/session-key.js";
import {
  hasMultipleResidentSessionSharingIdentities,
  readResidentUserProfileAliases,
} from "../../state/user-profile-list.js";
import { ADMIN_SCOPE, authorizeOperatorScopesForRequiredScope } from "../method-scopes.js";
import {
  operatorSessionCap,
  resolveGatewayOperatorRoleActor,
  authorizeCurrentOperatorRoleScopes,
  resolveOperatorRoleAgents,
} from "../operator-role-policy.js";
import { prepareSessionCreatorProfile } from "../session-creator.js";
import { requireSessionRowProjection } from "../session-row-projection-access.js";
import { sharingIdentity } from "../session-sharing-policy.js";
import { resolveSessionSharingRole, resolveSessionSharingTargetAsync } from "../session-sharing.js";
import { createSessionCatalogRequestEntrySnapshot } from "./session-catalog-entry-snapshot.js";
import type { GatewayClient, GatewayRequestContext } from "./types.js";

type SessionCatalogVisibility = { cacheKey: string } & (
  | {
      kind: "unrestricted";
      isAdmin: boolean;
      isCreator: ReturnType<typeof prepareSessionCreatorProfile>;
    }
  | { kind: "restricted-unprofiled" }
  | {
      kind: "restricted-owner";
      others: "none" | undefined;
      isCreator: ReturnType<typeof prepareSessionCreatorProfile>;
    }
  | {
      kind: "restricted-shared";
      others: "view" | "suggest" | "write";
      isCreator: ReturnType<typeof prepareSessionCreatorProfile>;
    }
  | {
      kind: "restricted-invited";
      others: "invited";
      profileId: string;
      isCreator: ReturnType<typeof prepareSessionCreatorProfile>;
    }
);

export function resolveSessionCatalogVisibility(
  client: GatewayClient | null,
  config: OpenClawConfig,
): SessionCatalogVisibility {
  const scopes = client?.connect.scopes ?? [];
  const admin = authorizeOperatorScopesForRequiredScope(ADMIN_SCOPE, scopes).allowed;
  const multipleIdentities = !admin && hasMultipleResidentSessionSharingIdentities();
  const attachedProfileId = client?.authenticatedUserProfile?.profileId;
  const profileId = attachedProfileId === GATEWAY_OWNER_PROFILE_ID ? undefined : attachedProfileId;
  const others = admin ? undefined : operatorSessionCap(client, config);
  const profileAliases = profileId ? readResidentUserProfileAliases(profileId) : undefined;
  const cacheKey = JSON.stringify({
    admin,
    multipleIdentities,
    profileId: profileId ?? null,
    profileAliases: profileAliases ? [...profileAliases].toSorted() : [],
    others: others ?? null,
  });
  const isCreator = profileId
    ? prepareSessionCreatorProfile(profileId, profileAliases)
    : () => false;
  if (admin || (!multipleIdentities && !others)) {
    return { cacheKey, kind: "unrestricted", isAdmin: admin, isCreator };
  }
  if (!profileId) {
    return { cacheKey, kind: "restricted-unprofiled" };
  }
  // The cache key and this synchronous publication use the same identity facts.
  if (others === "invited") {
    return { cacheKey, kind: "restricted-invited", others, profileId, isCreator };
  }
  return others && others !== "none"
    ? { cacheKey, kind: "restricted-shared", others, isCreator }
    : { cacheKey, kind: "restricted-owner", others, isCreator };
}

export function isPublishedCatalogVisible(visibility: SessionCatalogVisibility): boolean {
  // No role cap keeps adopted catalogs owner-only, but does not restrict publications.
  return (
    visibility.kind === "unrestricted" ||
    visibility.kind === "restricted-shared" ||
    (visibility.kind === "restricted-owner" && visibility.others === undefined)
  );
}

function visibleCatalogSessionEntry(params: {
  session: Pick<SessionCatalogSession, "sessionKey"> & { createdActor?: { id?: string } };
  requestEntries: ReturnType<typeof createSessionCatalogRequestEntrySnapshot>;
  visibility: Extract<
    SessionCatalogVisibility,
    { kind: "restricted-shared" | "restricted-owner" | "restricted-invited" }
  >;
}): SessionEntry | undefined {
  const sessionKey = params.session.sessionKey;
  if (!params.session.createdActor?.id || !sessionKey || isIncognitoSessionKey(sessionKey)) {
    return undefined;
  }
  const entry = params.requestEntries.entryForSession(sessionKey);
  // Provider rows omit privacy flags; only the request-owned canonical session snapshot can
  // prove a foreign adopted thread is neither a draft nor incognito.
  return entry !== undefined &&
    entry.incognito !== true &&
    params.requestEntries.canReadAccess(sessionKey, params.visibility.isCreator) &&
    (params.visibility.isCreator(entry.createdActor) ||
      (entry.visibility !== "draft" &&
        (params.visibility.kind === "restricted-shared" ||
          (params.visibility.kind === "restricted-invited" &&
            params.requestEntries.isMember(sessionKey, params.visibility.profileId)))))
    ? entry
    : undefined;
}

function unrestrictedCatalogEntryVisible(
  entry: SessionEntry,
  key: string,
  requestEntries: ReturnType<typeof createSessionCatalogRequestEntrySnapshot>,
  visibility: Extract<SessionCatalogVisibility, { kind: "unrestricted" }>,
): boolean {
  return (
    !entry.incognito &&
    (entry.access === undefined ||
      entry.visibility !== "draft" ||
      visibility.isCreator(entry.createdActor)) &&
    requestEntries.canReadAccess(key, visibility.isCreator)
  );
}

function unrestrictedCatalogSessionVisible(
  session: SessionCatalogSession,
  requestEntries: ReturnType<typeof createSessionCatalogRequestEntrySnapshot>,
  visibility: Extract<SessionCatalogVisibility, { kind: "unrestricted" }>,
): boolean {
  const key = requestEntries.sourceKeyForSession(session);
  if (!key) {
    return true; // Unadopted legacy native files keep their existing operator-read contract.
  }
  const entry = requestEntries.entryForSession(key);
  return Boolean(
    session.sessionKey === key &&
    entry &&
    unrestrictedCatalogEntryVisible(entry, key, requestEntries, visibility),
  );
}

export function filterSessionCatalogHost(
  host: SessionCatalogHost,
  visibility: SessionCatalogVisibility,
  params: {
    audience?: SessionCatalogProvider["audience"];
    requestEntries: ReturnType<typeof createSessionCatalogRequestEntrySnapshot>;
  },
): SessionCatalogHost {
  if (params.audience === "gateway-operators") {
    return host;
  }
  if (params.audience === "session-viewers") {
    return isPublishedCatalogVisible(visibility) ? host : { ...host, sessions: [] };
  }
  if (visibility.kind === "unrestricted") {
    return visibility.isAdmin
      ? host
      : {
          ...host,
          sessions: host.sessions.filter((session) =>
            unrestrictedCatalogSessionVisible(session, params.requestEntries, visibility),
          ),
        };
  }
  if (visibility.kind === "restricted-unprofiled") {
    return { ...host, sessions: [] };
  }
  return {
    ...host,
    sessions: host.sessions.filter(
      (session) => visibleCatalogSessionEntry({ ...params, session, visibility }) !== undefined,
    ),
  };
}

export type SessionCatalogThreadVisibility = {
  visibility: SessionCatalogVisibility;
  source?: { sessionKey: string; entry: SessionEntry };
  sourceMatchesEntry?: (entry: SessionEntry, complete: boolean) => boolean | undefined;
};

export async function resolveSessionCatalogThreadVisibility(params: {
  access: "read" | "mutate";
  allowProcessHomeFallback: boolean;
  audience?: SessionCatalogProvider["audience"];
  client: GatewayClient | null;
  context: GatewayRequestContext;
  fallbackAgentId: string;
  hostId: string;
  list: SessionCatalogProvider["list"];
  listNodes: NonNullable<SessionCatalogListProviderParams["listNodes"]>;
  sourceHomeId?: string;
  threadId: string;
}): Promise<SessionCatalogThreadVisibility | null> {
  const projection = requireSessionRowProjection(params.context);
  while (projection.needsSelectionPreparation()) {
    await projection.prepareSelection();
  }
  await projection.prepareMembership();
  let config = params.context.getRuntimeConfig();
  let visibility = resolveSessionCatalogVisibility(params.client, config);
  if (visibility.kind === "unrestricted" && visibility.isAdmin) {
    return { visibility };
  }
  if (params.audience === "session-viewers" && params.access === "read") {
    return isPublishedCatalogVisible(visibility) ? { visibility } : null;
  }
  if (visibility.kind === "restricted-unprofiled" && params.audience !== "gateway-operators") {
    return null;
  }
  const planningEntries = createSessionCatalogRequestEntrySnapshot({
    cfg: config,
    fallbackAgentId: params.fallbackAgentId,
    projection,
  });
  planningEntries.freeze();
  const seenCursors = new Set<string>();
  let cursor: string | undefined;
  while (true) {
    const hosts = await params.list({
      agentId: params.fallbackAgentId,
      allowProcessHomeFallback: params.allowProcessHomeFallback,
      hostIds: [params.hostId],
      ...(cursor ? { cursors: { [params.hostId]: cursor } } : {}),
      sessionEntries: planningEntries.sessionEntries,
      listNodes: params.listNodes,
    });
    const host = hosts.find((candidate) => candidate.hostId === params.hostId);
    if (!host) {
      return null;
    }
    // Providers may populate planning entries before awaiting IO. Re-read privacy and caller
    // policy after enumeration, before granting read or mutation authority.
    while (projection.needsSelectionPreparation()) {
      await projection.prepareSelection();
    }
    await projection.prepareMembership();
    config = params.context.getRuntimeConfig();
    visibility = resolveSessionCatalogVisibility(params.client, config);
    if (visibility.kind === "unrestricted" && visibility.isAdmin) {
      return { visibility };
    }
    if (visibility.kind === "restricted-unprofiled" && params.audience !== "gateway-operators") {
      return null;
    }
    const requestEntries = createSessionCatalogRequestEntrySnapshot({
      cfg: config,
      fallbackAgentId: params.fallbackAgentId,
      projection,
      sessionKeys: host.sessions.flatMap(({ sessionKey }) => (sessionKey ? [sessionKey] : [])),
    });
    const instances = new Map();
    planningEntries.captureHostInstances(host, instances);
    const projected = requestEntries.projectHostSessions(host, instances, params.audience);
    const session = projected.sessions.find(
      (candidate) =>
        candidate.threadId === params.threadId &&
        (!params.sourceHomeId || candidate.sourceHomeId === params.sourceHomeId),
    );
    if (session) {
      // Gateway-hosted catalogs already live inside this Gateway's trust domain.
      // Method scopes and creation policy remain the read/mutation authority.
      if (params.audience === "gateway-operators") {
        return { visibility };
      }
      if (visibility.kind === "unrestricted") {
        if (!unrestrictedCatalogSessionVisible(session, requestEntries, visibility)) {
          return null;
        }
        const key = requestEntries.sourceKeyForSession(session);
        const entry = key ? requestEntries.entryForSession(key) : undefined;
        return {
          visibility,
          ...(key && entry
            ? { source: { sessionKey: key, entry } }
            : {
                sourceMatchesEntry: retainSessionCatalogSourceScope(
                  planningEntries.sessionEntries,
                  params.hostId,
                  params.threadId,
                ),
              }),
        };
      }
      if (visibility.kind === "restricted-unprofiled") {
        return null;
      }
      const visibleEntry = visibleCatalogSessionEntry({
        session,
        requestEntries,
        visibility,
      });
      if (!visibleEntry || !session.sessionKey) {
        return null;
      }
      if (
        params.access === "read" ||
        visibility.kind === "restricted-owner" ||
        visibility.others === "write" ||
        visibility.isCreator(visibleEntry.createdActor)
      ) {
        return { visibility, source: { sessionKey: session.sessionKey, entry: visibleEntry } };
      }
      const target = await resolveSessionSharingTargetAsync({
        cfg: config,
        sessionKey: session.sessionKey,
      });
      const identity = sharingIdentity(
        params.client,
        resolveGatewayOperatorRoleActor(params.client),
      );
      return target !== null &&
        resolveSessionSharingRole({
          cfg: params.context.getRuntimeConfig(),
          client: params.client,
          target,
          isMember: Boolean(
            identity && projection.hasMembership(target.storePath, target.storeKey, identity.id),
          ),
        }) === "member"
        ? { visibility, source: { sessionKey: target.canonicalKey, entry: visibleEntry } }
        : null;
    }
    const nextCursor = host.nextCursor;
    if (!nextCursor || seenCursors.has(nextCursor)) {
      return null;
    }
    seenCursors.add(nextCursor);
    cursor = nextCursor;
  }
}

/** Revalidate retained native output synchronously, without trusting provider planning or cached hosts. */
export function isSessionCatalogThreadVisibilityCurrent(params: {
  captured: SessionCatalogThreadVisibility;
  audience?: SessionCatalogProvider["audience"];
  client: GatewayClient | null;
  context: GatewayRequestContext;
  fallbackAgentId: string;
  unboundSnapshot?: {
    projection: ReturnType<typeof requireSessionRowProjection>;
    sharingRevision: unknown;
    selectionRevision: unknown;
  };
}): boolean {
  try {
    if (params.client?.invalidated || params.client?.connectionSignal?.aborted) {
      return false;
    }
    if (params.unboundSnapshot) {
      const projection = requireSessionRowProjection(params.context);
      if (
        projection !== params.unboundSnapshot.projection ||
        projection.sharingRevision !== params.unboundSnapshot.sharingRevision ||
        projection.state.revision !== params.unboundSnapshot.selectionRevision ||
        projection.needsSelectionPreparation({ metadataOnly: true })
      ) {
        return false;
      }
    }
    const cfg = params.context.getRuntimeConfig();
    if (
      params.client &&
      (!authorizeOperatorScopesForRequiredScope("operator.read", params.client.connect.scopes ?? [])
        .allowed ||
        authorizeCurrentOperatorRoleScopes(params.client, cfg))
    ) {
      return false;
    }
    const sourceAgent = params.captured.source
      ? resolveAgentIdFromSessionKey(params.captured.source.sessionKey, params.fallbackAgentId)
      : params.fallbackAgentId;
    const agents = resolveOperatorRoleAgents(params.client, cfg);
    if (agents && !agents.includes(sourceAgent)) {
      return false;
    }
    const visibility = resolveSessionCatalogVisibility(params.client, cfg);
    if (params.audience === "gateway-operators") {
      return true;
    }
    if (params.audience === "session-viewers") {
      return isPublishedCatalogVisible(visibility);
    }
    const source = params.captured.source;
    if (!source) {
      return visibility.kind === "unrestricted";
    }
    const projection = requireSessionRowProjection(params.context);
    if (projection.needsSelectionPreparation({ metadataOnly: true })) {
      return false;
    }
    const requestEntries = createSessionCatalogRequestEntrySnapshot({
      cfg,
      projection,
      fallbackAgentId: params.fallbackAgentId,
      sessionKeys: [source.sessionKey],
    });
    const entry = requestEntries.entryForSession(source.sessionKey);
    if (
      !entry ||
      entry.initializationPending ||
      entry.incognito ||
      entry.sessionId !== source.entry.sessionId ||
      entry.lifecycleRevision !== source.entry.lifecycleRevision ||
      entry.pluginOwnerId !== source.entry.pluginOwnerId ||
      !isDeepStrictEqual(entry.createdActor, source.entry.createdActor)
    ) {
      return false;
    }
    if (visibility.kind === "unrestricted") {
      return (
        visibility.isAdmin ||
        unrestrictedCatalogEntryVisible(entry, source.sessionKey, requestEntries, visibility)
      );
    }
    if (visibility.kind === "restricted-unprofiled") {
      return false;
    }
    return (
      visibleCatalogSessionEntry({
        session: {
          sessionKey: source.sessionKey,
          createdActor: { id: source.entry.createdActor?.id ?? "" },
        },
        requestEntries,
        visibility,
      }) !== undefined
    );
  } catch {
    return false;
  }
}
