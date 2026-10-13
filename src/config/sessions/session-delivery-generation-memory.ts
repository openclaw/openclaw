import { assertSessionEntryCreationPublication } from "./session-accessor.sqlite-entry-cache-publication.js";
import type { SessionEntryCreationOperation } from "./session-accessor.sqlite-entry-cache.types.js";
import type { SessionActorStorageBinding } from "./session-actor-storage-binding.js";
import {
  SessionDeliveryGenerationRevokedError,
  SessionDeliveryGenerationUnavailableError,
} from "./session-delivery-generation-errors.js";
import type {
  SessionGenerationEntry,
  SessionGenerationFacts,
} from "./session-delivery-generation.types.js";

/** Actor close owns revocation; every transport effect still reads current owner-held policy. */
export function prepareMemorySessionGeneration(
  binding: SessionActorStorageBinding,
  input: SessionGenerationFacts,
  onRevoked?: (reason: unknown) => void,
) {
  const readEntry = () => {
    try {
      return binding.actor.snapshot(binding.authority)?.entry;
    } catch (cause) {
      throw new SessionDeliveryGenerationUnavailableError({ cause });
    }
  };
  const initial = readEntry();
  if ((initial?.sessionId ?? null) !== input.sessionId) {
    throw new SessionDeliveryGenerationRevokedError();
  }
  let active = true;
  let creationBound = false;
  let creationAdopted = false;
  let publishCreated: ((entry: SessionGenerationEntry) => void) | undefined;
  const readCurrent = () => {
    try {
      if (!active) {
        throw new SessionDeliveryGenerationUnavailableError();
      }
      const entry = readEntry();
      if (entry && creationBound && !creationAdopted) {
        creationAdopted = true;
        publishCreated?.(entry);
      }
      return entry;
    } catch (error) {
      onRevoked?.(error);
      throw error;
    }
  };
  const assertCurrent = () => {
    readCurrent();
  };
  return {
    assertCurrent,
    assertDeliveryCurrent: assertCurrent,
    readSessionSettings() {
      const entry = readCurrent();
      return { permissionMode: entry?.permissionMode, toolOverrides: entry?.toolOverrides };
    },
    prepareRead: () => undefined,
    release() {
      active = false;
    },
    bindCreation(
      operation: SessionEntryCreationOperation,
      publishBinding?: (
        entry: Pick<SessionGenerationEntry, "sessionId" | "lifecycleRevision">,
      ) => void,
    ) {
      if (initial || creationBound) {
        throw new Error("Session creation admission changed; retry against the current session");
      }
      const identity = binding.actor.target.database;
      if (identity.kind !== "memory") {
        throw new SessionDeliveryGenerationUnavailableError();
      }
      assertSessionEntryCreationPublication(operation, {
        agentId: binding.agentId,
        sessionKey: binding.actor.target.sessionKey,
        paths: new Set([binding.path]),
        databaseIdentity: identity.incarnation,
      });
      creationBound = true;
      publishCreated = publishBinding;
      return assertCurrent;
    },
    isCreationAdopted() {
      readCurrent();
      return creationAdopted;
    },
  };
}
