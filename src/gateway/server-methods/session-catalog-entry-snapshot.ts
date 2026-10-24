import { isDeepStrictEqual } from "node:util";
import {
  normalizeSessionColorValue,
  type SessionCatalogHost,
  type SessionCatalogSession,
} from "../../../packages/gateway-protocol/src/index.js";
import { listAgentIds } from "../../agents/agent-scope.js";
import type { SessionEntry } from "../../config/sessions.js";
import type { SessionEntrySummary } from "../../config/sessions/session-accessor.js";
import {
  resolveSessionCreatorActor,
  sessionCreatorProfileId,
} from "../../config/sessions/session-entry-provenance.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type {
  SessionCatalogEntrySnapshot,
  SessionCatalogProvider,
} from "../../plugins/session-catalog.js";
import {
  normalizeAgentId,
  parseAgentSessionKey,
  resolveAgentIdFromSessionKey,
} from "../../routing/session-key.js";
import { freezeJsonSnapshot } from "../../shared/immutable-data.js";
import { projectSessionActor } from "../session-identity-projection.js";
import { tryResolveSessionCompatibilityOwnerAgentId } from "../session-request-agent.js";
import type { SessionRowProjection } from "../session-row-projection.js";
import { resolveStoredSessionKeyForAgentStore } from "../session-store-key.js";
import type { SessionActorProfileIdentity } from "../session-utils-contracts.js";
import { prepareSessionRowSelection } from "../session-utils-list.js";

export type SessionCatalogInstances = Map<
  string,
  Pick<SessionEntry, "sessionId" | "pluginOwnerId" | "createdActor">
>;

type SessionCatalogRequestEntrySnapshot = {
  sessionEntries: SessionCatalogEntrySnapshot;
  freeze: () => void;
  captureHostInstances: (host: SessionCatalogHost, instances: SessionCatalogInstances) => void;
  entryForSession: (sessionKey: string) => SessionEntry | undefined;
  projectHostSessions: (
    host: SessionCatalogHost,
    instances: SessionCatalogInstances,
    audience?: SessionCatalogProvider["audience"],
  ) => SessionCatalogHost;
};

type PlanningEntries = {
  revision: object;
  entriesByAgentId: Map<string, readonly SessionEntrySummary[]>;
  entryIndexByAgentId: Map<string, ReadonlyMap<string, SessionEntry>>;
  catalogEntries: ReturnType<NonNullable<SessionCatalogEntrySnapshot["entriesForCatalog"]>>;
};

// Selection revisions retire metadata on row, generation, and topology changes.
// Delivery keeps its own actor/profile cache and rechecks current adoption identities.
const planningEntriesByRevision = new WeakMap<
  object,
  WeakMap<OpenClawConfig, Map<string, PlanningEntries>>
>();

// Retain neutral displays within the row owner's lifetime; visibility is applied afterward.
const projectedHosts = new WeakMap<
  SessionRowProjection,
  Map<
    string,
    {
      revision: object | undefined;
      identityRevision: object | undefined;
      cfg: OpenClawConfig;
      fallbackAgentId: string;
      adoptionRevision: object | undefined;
      audience: SessionCatalogProvider["audience"];
      source: string;
      host: SessionCatalogHost;
    }
  >
>();
const adoptionRevisions = new WeakMap<SessionCatalogInstances, object>();

export function createSessionCatalogRequestEntrySnapshot(params: {
  cfg: OpenClawConfig;
  fallbackAgentId: string;
  projection: SessionRowProjection;
  /** Bound one delivery's lookups; provider planning retains the full snapshot. */
  sessionKeys?: readonly string[];
}): SessionCatalogRequestEntrySnapshot {
  if (params.projection.needsSelectionPreparation({ metadataOnly: true })) {
    throw new Error("Prepare current session metadata before capturing catalog entries");
  }
  const selectionRevision = params.projection.state.revision;
  const cachedPlanning =
    params.sessionKeys === undefined
      ? planningEntriesByRevision
          .get(params.projection.state.revision)
          ?.get(params.cfg)
          ?.get(params.fallbackAgentId)
      : undefined;
  const entriesByAgentId =
    cachedPlanning?.entriesByAgentId ?? new Map<string, readonly SessionEntrySummary[]>();
  const entryIndexByAgentId =
    cachedPlanning?.entryIndexByAgentId ?? new Map<string, ReadonlyMap<string, SessionEntry>>();
  const actorBySessionKey = new Map<string, SessionCatalogSession["createdActor"]>();
  let frozen = false;
  // Hosts share human identities within this request; a new snapshot must see profile edits.
  const userProfileIdentityById = new Map<string, SessionActorProfileIdentity | undefined>();
  let catalogEntries:
    | ReturnType<NonNullable<SessionCatalogEntrySnapshot["entriesForCatalog"]>>
    | undefined = cachedPlanning?.catalogEntries;
  const entryAgentId = (sessionKey: string) => {
    const parsed = parseAgentSessionKey(sessionKey);
    if (parsed?.agentId) {
      return normalizeAgentId(parsed.agentId);
    }
    return resolveAgentIdFromSessionKey(
      sessionKey,
      tryResolveSessionCompatibilityOwnerAgentId(params.cfg, sessionKey) ?? params.fallbackAgentId,
    );
  };
  let selectedKeysByAgentId: Map<string, Set<string>> | undefined;

  const entriesForAgent = (rawAgentId: string): readonly SessionEntrySummary[] => {
    const agentId = normalizeAgentId(rawAgentId);
    if (!entriesByAgentId.has(agentId)) {
      if (frozen) {
        return [];
      }
      if (params.sessionKeys && !selectedKeysByAgentId) {
        selectedKeysByAgentId = new Map();
        for (const sessionKey of params.sessionKeys) {
          const owner = entryAgentId(sessionKey);
          let keys = selectedKeysByAgentId.get(owner);
          if (!keys) {
            keys = new Set();
            selectedKeysByAgentId.set(owner, keys);
          }
          keys.add(sessionKey);
          keys.add(
            resolveStoredSessionKeyForAgentStore({ cfg: params.cfg, agentId: owner, sessionKey }),
          );
        }
      }
      const entries = prepareSessionRowSelection(
        params.projection,
        { agentId },
        {
          metadataPrepared: true,
          // An empty canonical alias must not become an unscoped projection query.
          candidateKeys: selectedKeysByAgentId
            ? new Set([...(selectedKeysByAgentId.get(agentId) ?? [])].filter(Boolean))
            : undefined,
        },
      ).entries("all");
      entriesByAgentId.set(
        agentId,
        Object.freeze(entries.map(([sessionKey, entry]) => Object.freeze({ sessionKey, entry }))),
      );
    }
    return entriesByAgentId.get(agentId) ?? [];
  };

  const entriesForCatalog: NonNullable<SessionCatalogEntrySnapshot["entriesForCatalog"]> = () => {
    if (catalogEntries) {
      return catalogEntries;
    }
    const agentIds = [
      params.fallbackAgentId,
      ...listAgentIds(params.cfg).filter((agentId) => agentId !== params.fallbackAgentId),
    ];
    catalogEntries = agentIds.flatMap((agentId) =>
      entriesForAgent(agentId).map((entry) => Object.freeze({ ...entry, agentId })),
    );
    Object.freeze(catalogEntries);
    return catalogEntries;
  };

  const entryIndexForAgent = (agentId: string): ReadonlyMap<string, SessionEntry> => {
    const normalizedAgentId = normalizeAgentId(agentId);
    const cached = entryIndexByAgentId.get(normalizedAgentId);
    if (cached) {
      return cached;
    }
    const index = new Map(
      entriesForAgent(normalizedAgentId).map(({ sessionKey, entry }) => [sessionKey, entry]),
    );
    entryIndexByAgentId.set(normalizedAgentId, index);
    return index;
  };

  const entryForSession = (sessionKey: string): SessionEntry | undefined => {
    const agentId = entryAgentId(sessionKey);
    const index = entryIndexForAgent(agentId);
    const canonicalKey = resolveStoredSessionKeyForAgentStore({
      cfg: params.cfg,
      agentId,
      sessionKey,
    });
    const requested = index.get(sessionKey);
    const canonical = index.get(canonicalKey);
    return canonical && (!requested || (canonical.updatedAt ?? 0) > (requested.updatedAt ?? 0))
      ? canonical
      : requested;
  };

  const createdActorForSession = (sessionKey: string): SessionCatalogSession["createdActor"] => {
    if (actorBySessionKey.has(sessionKey)) {
      return actorBySessionKey.get(sessionKey);
    }
    const entry = entryForSession(sessionKey);
    const actor = projectSessionActor(
      resolveSessionCreatorActor(entry?.createdActor),
      userProfileIdentityById,
      params.cfg,
      Boolean(sessionCreatorProfileId(entry?.createdActor)),
    );
    actorBySessionKey.set(sessionKey, actor);
    return actor;
  };

  const sessionEntries: SessionCatalogEntrySnapshot = { entriesForAgent, entriesForCatalog };
  return {
    sessionEntries,
    freeze: () => {
      // Capture before provider admission/IO, even when a provider first reads after awaiting.
      // A key first resolved after deletion/recreation cannot prove the original adoption.
      const entries = entriesForCatalog();
      if (params.sessionKeys === undefined) {
        // Selection retains current metadata independently of display materialization.
        const revision = params.projection.state.revision;
        let configs = planningEntriesByRevision.get(revision);
        if (!configs) {
          configs = new WeakMap();
          planningEntriesByRevision.set(revision, configs);
        }
        let agents = configs.get(params.cfg);
        if (!agents) {
          agents = new Map();
          configs.set(params.cfg, agents);
        }
        const planning = cachedPlanning ?? {
          revision: {},
          entriesByAgentId,
          entryIndexByAgentId,
          catalogEntries: entries,
        };
        agents.set(params.fallbackAgentId, planning);
        sessionEntries.revision = planning.revision;
      }
      frozen = true;
    },
    captureHostInstances: (host, instances) => {
      adoptionRevisions.set(instances, selectionRevision);
      for (const session of host.sessions) {
        if (!session.sessionKey) {
          continue;
        }
        const entry = entryForSession(session.sessionKey);
        if (entry) {
          const { sessionId, pluginOwnerId, createdActor } = entry;
          instances.set(session.sessionKey, { sessionId, pluginOwnerId, createdActor });
        }
      }
    },
    entryForSession,
    projectHostSessions: (host, instances, audience) => {
      const source = JSON.stringify(host);
      const revision = params.projection.sharingRevision;
      const identityRevision = params.projection.state.rowContext.identityProjection?.revision;
      const adoptionRevision = adoptionRevisions.get(instances);
      let hosts = projectedHosts.get(params.projection);
      const cached = hosts?.get(host.hostId);
      if (
        revision &&
        adoptionRevision &&
        cached?.revision === revision &&
        cached.identityRevision === identityRevision &&
        cached.cfg === params.cfg &&
        cached.fallbackAgentId === params.fallbackAgentId &&
        cached.adoptionRevision === adoptionRevision &&
        cached.audience === audience &&
        cached.source === source
      ) {
        return cached.host;
      }
      // Providers can update returned objects in place; detach only changed publications.
      const snapshot: SessionCatalogHost = JSON.parse(source);
      for (const session of snapshot.sessions) {
        const { sessionKey, color: rawColor } = session;
        delete session.sessionKey;
        delete session.color;
        const color = typeof rawColor === "string" ? normalizeSessionColorValue(rawColor) : null;
        if (color) {
          session.color = color;
        }
        if (audience === "session-viewers") {
          // Publication attribution belongs to the provider, not a local adoption claim.
          continue;
        }
        delete session.createdActor;
        const original = sessionKey ? instances.get(sessionKey) : undefined;
        const current = sessionKey ? entryForSession(sessionKey) : undefined;
        // Never attach a reusable key's new creator to the previous provider instance.
        if (
          !original ||
          !current ||
          original.sessionId !== current.sessionId ||
          original.pluginOwnerId !== current.pluginOwnerId ||
          current.initializationPending === true ||
          !isDeepStrictEqual(original.createdActor, current.createdActor)
        ) {
          continue;
        }
        session.sessionKey = sessionKey;
        const createdActor = sessionKey ? createdActorForSession(sessionKey) : undefined;
        if (createdActor) {
          session.createdActor = createdActor;
        }
      }
      const projected = freezeJsonSnapshot(snapshot);
      if (!hosts) {
        hosts = new Map();
        projectedHosts.set(params.projection, hosts);
      }
      hosts.delete(host.hostId);
      hosts.set(host.hostId, {
        revision,
        identityRevision,
        cfg: params.cfg,
        fallbackAgentId: params.fallbackAgentId,
        adoptionRevision,
        audience,
        source,
        host: projected,
      });
      if (hosts.size > 128) {
        hosts.delete(hosts.keys().next().value!);
      }
      return projected;
    },
  };
}
