import { assertSessionEntryCreationPublication } from "../config/sessions/session-accessor.sqlite-entry-cache-publication.js";
import type { SessionEntryCreationOperation } from "../config/sessions/session-accessor.sqlite-entry-cache.types.js";
import type { IncognitoSessionBinding } from "../config/sessions/session-incognito-binding.js";
import type { PreparedSessionMutationFacts } from "./session-sharing-policy.js";

export class SessionMutationFactsUnavailableError extends Error {
  constructor(options?: ErrorOptions) {
    super("Session access facts are unavailable; retry after session storage is ready.", options);
    this.name = "SessionMutationFactsUnavailableError";
  }
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
      const target: NonNullable<PreparedSessionMutationFacts["target"]> = {
        agentId: actor.agentId,
        canonicalKey,
        storeKey: canonicalKey,
        storeKeys: [canonicalKey],
        storePath: actor.path,
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
