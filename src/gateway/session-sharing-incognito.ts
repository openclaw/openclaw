import { assertSessionEntryCreationPublication } from "../config/sessions/session-accessor.sqlite-entry-cache-publication.js";
import type { SessionEntryCreationOperation } from "../config/sessions/session-accessor.sqlite-entry-cache.types.js";
import {
  captureSessionActorStorageOwner,
  getSessionActorStorageBinding,
  type SessionActorStorageBinding,
} from "../config/sessions/session-actor-storage-binding.js";
import {
  captureIncognitoSessionBinding,
  type IncognitoSessionBinding,
} from "../config/sessions/session-incognito-binding.js";
import { isIncognitoSessionKey } from "../routing/session-key.js";

export type IncognitoSessionSharingTarget = {
  agentId?: string;
  sessionKey: string;
  resolved: { readSource?: { path: string }; storePath: string } | null;
  absentTarget?: { storePath: string };
};

export function captureSessionSharingIncognitoBinding(target: IncognitoSessionSharingTarget) {
  return captureIncognitoSessionBinding({
    agentId: target.agentId,
    sessionKey: target.sessionKey,
    storePath:
      target.resolved?.readSource?.path ??
      target.resolved?.storePath ??
      target.absentTarget?.storePath,
  });
}

export function captureSessionSharingActorBinding(target: IncognitoSessionSharingTarget) {
  return isIncognitoSessionKey(target.sessionKey) ? getSessionActorStorageBinding({}) : undefined;
}

/** Production incognito stays native until acquisition supplies its explicit binding. */
export function hasNativeIncognitoSessionSharingSource(
  targets: readonly IncognitoSessionSharingTarget[],
): boolean {
  return targets.some(
    (target) =>
      isIncognitoSessionKey(target.sessionKey) &&
      !captureSessionSharingActorBinding(target) &&
      !captureSessionSharingIncognitoBinding(target),
  );
}

export class SessionMutationFactsUnavailableError extends Error {
  constructor(options?: ErrorOptions) {
    super("Session access facts are unavailable; retry after session storage is ready.", options);
    this.name = "SessionMutationFactsUnavailableError";
  }
}

/** Current actor facts authorize effects; no native owner or creation grant is retained. */
export function captureSessionActorMutationFacts(
  binding: SessionActorStorageBinding,
  canonicalKey: string,
  allowMissing: boolean,
  storePath?: string,
) {
  const { actor, authority } = binding;
  const sibling =
    actor.target.sessionKey === canonicalKey
      ? undefined
      : captureSessionActorStorageOwner({
          sessionActor: binding,
          sessionKey: canonicalKey,
          storePath,
        });
  const selected =
    sibling ??
    getSessionActorStorageBinding({ sessionActor: binding, sessionKey: canonicalKey, storePath });
  const database = sibling ? sibling.owner?.identity : actor.target.database;
  if ((database && database.kind !== "memory") || !selected) {
    throw new SessionMutationFactsUnavailableError();
  }
  const { agentId, path } = selected;
  const location = { agentId, path };
  const source = database && { ...location, databaseIdentity: database.incarnation };
  const readCurrent = () => {
    if (sibling) {
      actor.assertReadable();
      if (!sibling.owner) {
        authority.assertCurrent();
      }
    }
    const current = sibling
      ? sibling.owner?.readSession(canonicalKey, authority)
      : actor.snapshot(authority);
    if (!current?.entry || !source) {
      if (!allowMissing) {
        throw new SessionMutationFactsUnavailableError();
      }
      return { target: null, members: [], membership: new Set<string>() };
    }
    return {
      sourcePath: path,
      sourceAgentId: agentId,
      target: {
        agentId,
        canonicalKey,
        storeKey: canonicalKey,
        storeKeys: [canonicalKey],
        storePath: path,
        readSource: source,
        entry: current.entry,
      },
      members: current.members,
      membership: new Set(current.members.map((member) => member.identityId)),
    };
  };
  return {
    location,
    source,
    assertCurrent(this: void) {
      if (sibling) {
        readCurrent();
      } else {
        actor.assertReadable();
        authority.assertCurrent();
      }
    },
    readCurrent,
  };
}

/** Capture generation before storage readiness; later checks use only this actor's facts. */
export function captureIncognitoSessionMutationFacts(
  binding: IncognitoSessionBinding,
  canonicalKey: string,
  allowMissing: boolean,
) {
  const { actor, admissionSignal } = binding;
  const claim = actor.sessions.captureCurrent(canonicalKey);
  const initial = actor.sessions.readSharing(canonicalKey)?.entry;
  let creation: SessionEntryCreationOperation | undefined;
  const readSharing = () => {
    if (creation) {
      assertSessionEntryCreationPublication(creation, {
        agentId: actor.agentId,
        sessionKey: canonicalKey,
        paths: new Set([actor.path]),
        databaseIdentity: actor.identity.incarnation,
      });
      actor.assertCurrent();
      const granted = actor.sessions.readCreationGrant(canonicalKey, creation);
      if (granted) {
        const current = granted.sharing?.entry;
        if (
          current?.sessionId !== initial?.sessionId ||
          current?.lifecycleRevision !== initial?.lifecycleRevision
        ) {
          throw new SessionMutationFactsUnavailableError();
        }
        return granted.sharing;
      }
    } else {
      admissionSignal?.throwIfAborted();
      actor.assertReadable();
    }
    claim.assertCurrent();
    return actor.sessions.readSharing(canonicalKey);
  };
  return {
    assertCurrent(this: void) {
      readSharing();
    },
    bindCreation(operation: SessionEntryCreationOperation) {
      creation = operation;
    },
    readCurrent(this: void) {
      const current = readSharing();
      if (!current?.entry) {
        if (!allowMissing) {
          throw new SessionMutationFactsUnavailableError();
        }
        return { target: null, membership: new Set<string>() };
      }
      const target = {
        agentId: actor.agentId,
        canonicalKey,
        storeKey: canonicalKey,
        storeKeys: [canonicalKey],
        storePath: actor.path,
        readSource: {
          agentId: actor.agentId,
          path: actor.path,
          databaseIdentity: actor.identity.incarnation,
        },
        entry: current.entry,
      };
      return {
        sourcePath: actor.path,
        sourceAgentId: actor.agentId,
        target,
        membership: current.membership,
      };
    },
  };
}
