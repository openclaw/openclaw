import { isSessionMutationActive } from "../../sessions/session-controller.lifecycle.js";
import { assertSessionEntryCreationPublication } from "./session-accessor.sqlite-entry-cache-publication.js";
import type { SessionEntryCreationOperation } from "./session-accessor.sqlite-entry-cache.types.js";
import type { CapturedSessionActorStorageOwner } from "./session-actor-storage-binding.js";
import {
  SessionDeliveryGenerationRevokedError,
  SessionDeliveryGenerationUnavailableError,
} from "./session-delivery-generation-errors.js";
import type {
  SessionGenerationEntry,
  SessionGenerationFacts,
} from "./session-delivery-generation.types.js";

/**
 * A stored reference names its conversation by key alone, so it follows edits, resets and
 * compaction to the current transcript. Live-writer fences pin the transcript
 * (`exactTranscript`) or the incarnation (`exactLifecycle`). A null session id leases the
 * row's absence.
 */
export function matchesSessionGeneration(
  input: SessionGenerationFacts,
  entry: Pick<SessionGenerationEntry, "sessionId" | "lifecycleRevision"> | null | undefined,
): boolean {
  if (!entry || input.sessionId === null) {
    return Boolean(entry) !== (input.sessionId === null);
  }
  if (input.exactTranscript && entry.sessionId !== input.sessionId) {
    return false;
  }
  return (
    !(input.exactTranscript || input.exactLifecycle) ||
    (entry.lifecycleRevision ?? null) === input.lifecycleRevision
  );
}

/** Actor close owns revocation; every transport effect still reads current owner-held policy. */
export async function prepareMemorySessionGeneration(
  source: CapturedSessionActorStorageOwner,
  input: SessionGenerationFacts,
  onRevoked?: (reason: unknown) => void,
) {
  const selected = source.binding;
  const bound =
    selected?.agentId === source.agentId &&
    selected.path === source.path &&
    selected.actor.target.sessionKey === input.sessionKey
      ? selected.actor
      : undefined;
  const actor =
    bound ??
    (await source.owner?.acquireExisting(input.sessionKey, {
      assertCurrent: () => source.authority.assertCurrent(),
      assertReadable: () => source.authority.assertCurrent(),
    }));
  const releaseActor = () => {
    if (!bound) {
      void actor?.release();
    }
  };
  const readEntry = () => {
    try {
      return actor?.snapshot(source.authority)?.entry;
    } catch (cause) {
      throw new SessionDeliveryGenerationUnavailableError({ cause });
    }
  };
  let initial: SessionGenerationEntry | undefined;
  try {
    initial = readEntry();
    if (!matchesSessionGeneration(input, initial)) {
      throw new SessionDeliveryGenerationRevokedError();
    }
  } catch (error) {
    releaseActor();
    throw error;
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
    assertNativeTransactionCurrent: Object.assign(() => assertCurrent(), { nativeSource: true }),
    assertDeliveryCurrent() {
      if (isSessionMutationActive(source.path, [input.sessionKey, initial?.sessionId])) {
        throw new SessionDeliveryGenerationUnavailableError();
      }
      assertCurrent();
    },
    readSessionSettings() {
      const entry = readCurrent();
      return (
        entry && {
          sessionId: entry.sessionId,
          lifecycleRevision: entry.lifecycleRevision,
          permissionMode: entry.permissionMode,
          toolOverrides: entry.toolOverrides,
        }
      );
    },
    prepareRead: () => undefined,
    release() {
      active = false;
      releaseActor();
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
      const identity = actor?.target.database;
      if (identity?.kind !== "memory") {
        throw new SessionDeliveryGenerationUnavailableError();
      }
      assertSessionEntryCreationPublication(operation, {
        agentId: source.agentId,
        sessionKey: input.sessionKey,
        paths: new Set([source.path]),
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
