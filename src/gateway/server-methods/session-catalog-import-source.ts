import { isDeepStrictEqual } from "node:util";
import type { SessionEntry } from "../../config/sessions.js";
import {
  readPreparedSessionEntryChange,
  readPreparedSessionEntryPublicationSource,
} from "../../config/sessions/session-accessor.sqlite-entry-cache-publication.js";
import {
  observeSessionSourceEffects,
  observePendingSessionSourceEffects,
  type SessionSourceCommittedEffect,
} from "../../config/sessions/session-source-effects.js";
import { readPreparedSessionTranscriptChange } from "../../config/sessions/session-transcript-authority.js";
import { sessionChanges, type SessionRowChange } from "../../sessions/session-row-changes.js";
import type { AgentDatabaseRegistryChange } from "../../state/openclaw-agent-db-contract.js";
import {
  readAgentDatabaseRegistrationChange,
  readAgentDatabaseRegistrationPublication,
} from "../../state/openclaw-agent-db-registration-provenance.js";
import {
  getSessionRowProjection,
  requireSessionRowProjection,
} from "../session-row-projection-access.js";
import { isSessionRowProjectionActive } from "../session-row-projection-lifetime.js";
import { hasSessionReadAccessChanged } from "../session-sharing-policy.js";
import type { GatewayRequestContext } from "./types.js";

/** Unbound native source authority survives only this import's certified destination effects. */
export function retainCatalogImportSource(params: {
  context: GatewayRequestContext;
  agentId: string;
  key: string;
  creator: SessionEntry["createdActor"];
  isAuthorityCurrent: () => boolean;
  sourceMatchesEntry?: (entry: SessionEntry, complete: boolean) => boolean | undefined;
}) {
  const projection = requireSessionRowProjection(params.context);
  const selected = projection.sharingTargetState({ key: params.key, agentId: params.agentId });
  let destination =
    selected.status === "ready" ? structuredClone(selected.target.entry) : undefined;
  let databaseIdentity: string | undefined;
  let bootstrap: { operation: symbol; path: string } | undefined;
  let storePath = selected.status === "ready" ? selected.target.storePath : undefined;
  const pending = new Set<SessionRowChange>();
  const registrations = new Set<AgentDatabaseRegistryChange>();
  let active = true;
  let rejected = false;
  let stopEffects: (() => void) | undefined;
  let stopPending: (() => void) | undefined;
  const pendingOwners = new Set<object>();
  const stopFacts = sessionChanges.subscribeFacts((change) => {
    const registration = readAgentDatabaseRegistrationPublication(change);
    if (registration && registrations.delete(registration)) {
      return;
    }
    // Runtime-only activity cannot adopt a native thread or change its stored ACL.
    if (!("all" in change) && (change.scope === "runtime" || change.scope === "automation")) {
      return;
    }
    if ("sessionKey" in change && change.sessionKey !== params.key && !change.factsInvalidated) {
      const transcript = readPreparedSessionTranscriptChange(change);
      if (
        change.scope === "transcript" &&
        change.facts?.kind === "unchanged" &&
        transcript &&
        transcript.kind !== "unknown"
      ) {
        return;
      }
      const metadata = readPreparedSessionEntryChange(change, change.sessionKey);
      if (
        metadata?.entry &&
        params.sourceMatchesEntry?.(
          metadata.fullEntry ?? metadata.entry,
          metadata.fullEntry !== undefined,
        ) === false
      ) {
        return;
      }
    }
    pending.add(change);
  });
  const accept = (effect: SessionSourceCommittedEffect) => {
    if (!active || rejected || effect.agentId !== params.agentId) {
      return;
    }
    const changes = effect.changes.filter((change) => pending.has(change));
    if (!changes.length) {
      return;
    }
    if (
      (databaseIdentity && databaseIdentity !== effect.databaseIdentity) ||
      (storePath && storePath !== effect.storePath)
    ) {
      rejected = true;
      return;
    }
    let next = destination;
    for (const change of changes) {
      if (
        !("sessionKey" in change) ||
        change.sessionKey !== params.key ||
        change.factsInvalidated ||
        (change.agentId !== undefined && change.agentId !== params.agentId) ||
        readPreparedSessionEntryPublicationSource(change).identity !== effect.databaseIdentity
      ) {
        rejected = true;
        return;
      }
      const metadata = readPreparedSessionEntryChange(change, params.key);
      const committedSource = readPreparedSessionEntryPublicationSource(change);
      if (
        bootstrap &&
        committedSource.canonicalPath &&
        bootstrap.path !== committedSource.canonicalPath
      ) {
        rejected = true;
        return;
      }
      const entry = metadata?.entry;
      if (entry) {
        if (
          metadata.source.identity !== effect.databaseIdentity ||
          entry.pluginOwnerId ||
          metadata.fullEntry?.acp ||
          metadata.fullEntry?.pluginExtensions ||
          metadata.fullEntry?.cliSessionBindings ||
          (next
            ? hasSessionReadAccessChanged(next, entry) ||
              !isDeepStrictEqual(next.createdActor, entry.createdActor)
            : !isDeepStrictEqual(params.creator, entry.createdActor))
        ) {
          rejected = true;
          return;
        }
        next = structuredClone(entry);
      } else {
        const transcript = readPreparedSessionTranscriptChange(change);
        if (
          !next ||
          (transcript
            ? transcript.kind !== "postimage" || transcript.value.sessionId !== next.sessionId
            : change.facts?.kind !== "member")
        ) {
          rejected = true;
          return;
        }
      }
    }
    destination = next;
    if (changes.length) {
      databaseIdentity = effect.databaseIdentity;
      storePath = effect.storePath;
    }
    // Consume exact objects issued by this caller-bound canonical writer, never a key match.
    for (const change of changes) {
      pending.delete(change);
    }
  };
  return {
    followRegistration(
      target: { agentId?: string; sessionKey: string },
      change: AgentDatabaseRegistryChange,
    ) {
      const receipt = readAgentDatabaseRegistrationChange(change);
      const sources = receipt?.mutation?.sources;
      const source = sources?.length === 1 ? sources[0] : undefined;
      if (
        target.agentId !== params.agentId ||
        target.sessionKey !== params.key ||
        receipt?.mutation?.kind !== "upsert" ||
        source?.agentId !== params.agentId
      ) {
        rejected = true;
        return;
      }
      if (source.identity.startsWith("file:")) {
        const identity = source.identity.slice("file:".length);
        if (
          (databaseIdentity && identity !== databaseIdentity) ||
          (bootstrap && bootstrap.path !== source.physicalPath)
        ) {
          rejected = true;
          return;
        }
        databaseIdentity = identity;
      } else {
        // A captured absent path admits preparation, never a fabricated committed file identity.
        const preparing = source.identity === "path:" + source.physicalPath;
        const ownBootstrap = bootstrap
          ? bootstrap.operation === receipt.operation && bootstrap.path === source.physicalPath
          : !destination && !databaseIdentity && receipt.phase === "begin";
        if (!preparing || !ownBootstrap) {
          rejected = true;
          return;
        }
        bootstrap ??= { operation: receipt.operation, path: source.physicalPath };
      }
      // The registry owner's physical preparation certified this exact transition object.
      registrations.add(change);
    },
    observe(assertion: () => void) {
      if (stopEffects) {
        throw new Error("Import source already has an effect owner");
      }
      const observer = (effect: SessionSourceCommittedEffect) => {
        try {
          accept(effect);
        } catch {
          rejected = true;
        }
      };
      stopEffects = observeSessionSourceEffects(assertion, observer);
      stopPending = observePendingSessionSourceEffects(observer, (effect, own, acquiring) => {
        if (!acquiring) {
          pendingOwners.delete(effect.owner);
          return;
        }
        const ownDestination =
          own &&
          effect.agentId === params.agentId &&
          (!databaseIdentity || databaseIdentity === effect.databaseIdentity) &&
          (!storePath || storePath === effect.storePath) &&
          effect.keys.length > 0 &&
          effect.keys.every((key) => key === params.key);
        if (ownDestination) {
          return;
        }
        const disjoint =
          effect.keys.length > 0 &&
          effect.keys.every((key) => {
            if (key === params.key) {
              return false;
            }
            const full = effect.fullEntries?.get(key);
            const entry = full ?? effect.entries?.get(key);
            return entry && params.sourceMatchesEntry?.(entry, full !== undefined) === false;
          });
        if (!disjoint) {
          pendingOwners.add(effect.owner);
        }
      });
    },
    isCurrent: () => {
      const current =
        active &&
        !rejected &&
        !pending.size &&
        !pendingOwners.size &&
        getSessionRowProjection(params.context) === projection &&
        isSessionRowProjectionActive(projection) &&
        params.isAuthorityCurrent();
      return current;
    },
    [Symbol.dispose]() {
      active = false;
      stopFacts();
      stopEffects?.();
      stopPending?.();
      pendingOwners.clear();
      pending.clear();
      registrations.clear();
      destination = undefined;
      bootstrap = undefined;
    },
  };
}
