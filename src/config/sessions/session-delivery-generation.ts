import path from "node:path";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { readDatabasePathIdentitySync } from "../../infra/sqlite-worker-identity.js";
import { isIncognitoSessionKey } from "../../routing/session-key.js";
import { isCronRunSessionKey, isCronSessionKey } from "../../sessions/session-key-utils.js";
import { isSessionLifecycleMutationActive } from "../../sessions/session-lifecycle-admission.js";
import {
  isSessionStoreTopologyChange,
  sessionChanges,
  type SessionRowChange,
} from "../../sessions/session-row-changes.js";
import { getOpenIncognitoAgentDatabase } from "../../state/openclaw-agent-db-lifecycle.js";
import {
  registerOpenClawAgentDatabaseAsyncResource,
  registerOpenClawAgentDatabaseReadCandidateResource,
} from "../../state/openclaw-agent-db-resources.js";
import {
  isPreparedSessionSharingChange,
  projectSessionSharingEntry,
  retainPreparedSessionGenerationFacts,
} from "./session-accessor.sqlite-entry-cache.js";
import { loadSessionEntryReadOnlyResultInScope } from "./session-accessor.sqlite-entry.js";
import { readCommittedIncognitoSessionSharing } from "./session-accessor.sqlite-incognito-sharing.js";
import type { SessionDeliveryGeneration } from "./session-delivery-generation.types.js";
import { withSessionEntriesFromStoresInWorker } from "./session-entry-read-runtime.js";
import { captureIncognitoSessionBinding } from "./session-incognito-binding.js";
import { captureSessionStoreReadCandidate } from "./session-store-read-candidates.js";
import { captureSessionStoreReadCandidates } from "./session-store-target-inventory.js";

class SessionDeliveryGenerationRevokedError extends Error {
  readonly code = "SESSION_DELIVERY_GENERATION_REVOKED";
  constructor() {
    super("The original session generation no longer accepts this delivery.");
    this.name = "SessionDeliveryGenerationRevokedError";
  }
}

class SessionDeliveryGenerationUnavailableError extends Error {
  readonly code = "SESSION_DELIVERY_GENERATION_UNAVAILABLE";
  constructor(options?: ErrorOptions) {
    super(
      "Session delivery generation is unavailable; retry after session storage is ready.",
      options,
    );
    this.name = "SessionDeliveryGenerationUnavailableError";
  }
}

export const isSessionDeliveryGenerationRevokedError = (error: unknown) =>
  isRecord(error) && error.code === "SESSION_DELIVERY_GENERATION_REVOKED";
const isSessionDeliveryGenerationUnavailableError = (error: unknown) =>
  isRecord(error) && error.code === "SESSION_DELIVERY_GENERATION_UNAVAILABLE";

type SessionGenerationFacts = Omit<SessionDeliveryGeneration, "sessionId"> & {
  sessionId: string | null;
};

function isSessionGenerationFacts(value: unknown): value is SessionGenerationFacts {
  return (
    isRecord(value) &&
    [value.agentId, value.storePath, value.sessionKey].every(
      (field) => typeof field === "string" && field.length > 0 && field === field.trim(),
    ) &&
    (value.sessionId === null ||
      (typeof value.sessionId === "string" &&
        value.sessionId.length > 0 &&
        value.sessionId === value.sessionId.trim())) &&
    typeof value.storePath === "string" &&
    path.isAbsolute(value.storePath) &&
    (value.lifecycleRevision === null ||
      (typeof value.lifecycleRevision === "string" && value.lifecycleRevision.length > 0))
  );
}

/** Prepare once per delivery attempt; committed entry publications keep final I/O checks live. */
async function prepareSessionGenerationLease(
  input: SessionGenerationFacts,
  onRevoked?: (reason: unknown) => void,
): Promise<{
  assertCurrent: () => void;
  assertDeliveryCurrent: () => void;
  prepareRead: () => Promise<void> | undefined;
  release: () => void;
}> {
  if (!isSessionGenerationFacts(input)) {
    throw new SessionDeliveryGenerationUnavailableError();
  }
  const generation = { ...input };
  const binding = captureIncognitoSessionBinding(generation);
  const releases: Array<() => void> = [];
  const paths = new Set([path.resolve(generation.storePath)]);
  let active = true;
  let invalidated = false;
  let revoked = false;
  let publications = 0;
  let retained: ReturnType<typeof retainPreparedSessionGenerationFacts> | undefined;
  let observeIncognito: (() => void) | undefined;
  const release = () => {
    if (!active) {
      return;
    }
    active = false;
    for (const stop of releases.splice(0).toReversed()) {
      stop();
    }
  };
  const revoke = () => {
    release();
    onRevoked?.(new SessionDeliveryGenerationUnavailableError());
  };
  const assertActive = () => {
    if (revoked) {
      throw new SessionDeliveryGenerationRevokedError();
    }
    if (!active || invalidated) {
      throw new SessionDeliveryGenerationUnavailableError();
    }
  };
  const checkEntry = (
    entry: { sessionId: string; lifecycleRevision?: string } | null | undefined,
  ) => {
    if (entry === undefined) {
      throw new SessionDeliveryGenerationUnavailableError();
    }
    if (
      (entry?.sessionId ?? null) !== generation.sessionId ||
      (entry?.lifecycleRevision ?? null) !== generation.lifecycleRevision
    ) {
      revoked = true;
      throw new SessionDeliveryGenerationRevokedError();
    }
  };
  const changed = (change: SessionRowChange) => {
    if ("all" in change) {
      if (isSessionStoreTopologyChange(change)) {
        invalidated = true;
        return;
      }
      if (typeof change.scope === "object") {
        if (change.scope.agentId && change.scope.agentId !== generation.agentId) {
          return;
        }
        if (change.scope.storePath && !paths.has(path.resolve(change.scope.storePath))) {
          return;
        }
      } else if (
        [
          "profiles",
          "catalog",
          "acp",
          "agent-runs",
          "subagent-runs",
          "worker-placements",
          "worker-environments",
          "config",
          "config-presentation",
          "config-profiles",
        ].includes(change.scope)
      ) {
        return;
      }
      invalidated = true;
      return;
    }
    if (
      change.scope === "automation" ||
      change.sessionKey !== generation.sessionKey ||
      (change.agentId && change.agentId !== generation.agentId) ||
      !change.storePath ||
      !paths.has(path.resolve(change.storePath))
    ) {
      return;
    }
    publications += 1;
    if (
      !change.factsInvalidated &&
      ["unchanged", "participants", "category", "member"].includes(change.facts?.kind ?? "")
    ) {
      return;
    }
    if (binding && observeIncognito) {
      try {
        observeIncognito();
      } catch (error) {
        if (!isSessionDeliveryGenerationRevokedError(error)) {
          invalidated = true;
        }
      }
    } else if (!isPreparedSessionSharingChange(change)) {
      invalidated = true;
    } else if (observeIncognito && change.facts?.kind === "removed") {
      revoked = true;
    } else if (observeIncognito) {
      // Observe each committed transition, even if another write restores the old values.
      try {
        observeIncognito();
      } catch (error) {
        if (!isSessionDeliveryGenerationRevokedError(error)) {
          invalidated = true;
        }
      }
    }
  };
  releases.push(sessionChanges.subscribeFacts(changed));
  try {
    let readCurrent: () => void;
    let prepareRead: () => Promise<void> | undefined = () => {
      assertActive();
      return undefined;
    };
    if (binding) {
      const { actor, admissionSignal } = binding;
      const claim = actor.sessions.captureCurrent(generation.sessionKey);
      readCurrent = () => {
        admissionSignal?.throwIfAborted();
        actor.assertReadable();
        claim.assertCurrent();
        checkEntry(actor.sessions.readSharing(generation.sessionKey)?.entry ?? null);
      };
      observeIncognito = readCurrent;
    } else if (isIncognitoSessionKey(generation.sessionKey)) {
      const database = getOpenIncognitoAgentDatabase(generation.agentId, generation.storePath);
      if (!database && generation.sessionId !== null) {
        throw new SessionDeliveryGenerationRevokedError();
      }
      releases.push(
        registerOpenClawAgentDatabaseAsyncResource({
          agentId: generation.agentId,
          path: generation.storePath,
          revoke,
          close: async () => revoke(),
        }),
      );
      readCurrent = () => {
        if (getOpenIncognitoAgentDatabase(generation.agentId, generation.storePath) !== database) {
          throw new SessionDeliveryGenerationUnavailableError();
        }
        if (!database) {
          checkEntry(null);
          return;
        }
        const committed = readCommittedIncognitoSessionSharing(database.db, generation.sessionKey);
        if (committed === undefined && generation.sessionId === null) {
          // Temporary process-held compatibility: only its existing native reader can
          // prove rowless absence. An unavailable/pending projection still throws above.
          const read = loadSessionEntryReadOnlyResultInScope({
            agentId: generation.agentId,
            storePath: generation.storePath,
            sessionKey: generation.sessionKey,
          });
          if (!read.ok) {
            throw read.error;
          }
          checkEntry(read.value ?? null);
        } else {
          checkEntry(committed?.entry ?? (committed ? null : undefined));
        }
      };
      observeIncognito = readCurrent;
    } else {
      const candidates = captureSessionStoreReadCandidates(generation.storePath);
      const originalSources = new Map(
        candidates.map((candidate) => [
          path.resolve(candidate.physicalPath),
          readDatabasePathIdentitySync(candidate.physicalPath),
        ]),
      );
      for (const candidate of candidates) {
        paths.add(path.resolve(candidate.path));
        paths.add(path.resolve(candidate.physicalPath));
        for (const pathname of new Set([candidate.path, candidate.physicalPath])) {
          releases.push(
            registerOpenClawAgentDatabaseReadCandidateResource({
              ...candidate,
              path: pathname,
              revoke,
              close: async () => revoke(),
            }),
          );
        }
      }
      let source: { path: string; identity: string } | undefined;
      while (!retained) {
        assertActive();
        const before = publications;
        retained = await withSessionEntriesFromStoresInWorker(
          [{ ...generation, sessionKeys: [generation.sessionKey], projection: "sharing" }],
          ([read]) => {
            assertActive();
            if (before !== publications) {
              return undefined;
            }
            const entry = read!.result.entries.find(
              (row) => row.sessionKey === generation.sessionKey,
            )?.entry;
            checkEntry(entry ?? null);
            const sharing = read!.result.sharing;
            if (sharing) {
              source = { path: sharing.source.path, identity: sharing.databaseIdentity };
            } else {
              const pathname = path.resolve(read!.database.path);
              const original = originalSources.get(pathname);
              // The existing-only worker returns no sharing metadata for a missing file.
              // Retain that exact absent source; creation can never inherit this selection.
              if (
                generation.sessionId !== null ||
                !original?.key.startsWith("path:") ||
                readDatabasePathIdentitySync(pathname).key !== original.key
              ) {
                throw new SessionDeliveryGenerationUnavailableError();
              }
              source = { path: pathname, identity: original.key };
            }
            paths.add(path.resolve(source.path));
            const prepared = retainPreparedSessionGenerationFacts({
              databaseIdentity: source.identity,
              sessionKey: generation.sessionKey,
              entry: entry ? projectSessionSharingEntry(entry) : undefined,
            });
            releases.push(prepared.release);
            return prepared;
          },
        );
      }
      const assertSourceCurrent = () => {
        assertActive();
        for (const candidate of candidates) {
          if (
            captureSessionStoreReadCandidate(candidate.path, candidate.scope).physicalPath !==
            candidate.physicalPath
          ) {
            throw new SessionDeliveryGenerationUnavailableError();
          }
        }
        if (!source || readDatabasePathIdentitySync(source.path).key !== source.identity) {
          throw new SessionDeliveryGenerationUnavailableError();
        }
      };
      readCurrent = () => {
        assertSourceCurrent();
        checkEntry(retained?.readCurrent());
      };
      prepareRead = () => {
        assertSourceCurrent();
        return retained?.prepareRead()?.then(assertSourceCurrent);
      };
    }
    const assertCurrent = (delivery = false) => {
      try {
        assertActive();
        if (
          delivery &&
          [...paths].some((scope) =>
            isSessionLifecycleMutationActive(
              scope,
              generation.sessionId
                ? [generation.sessionKey, generation.sessionId]
                : [generation.sessionKey],
            ),
          )
        ) {
          throw new SessionDeliveryGenerationUnavailableError();
        }
        readCurrent();
      } catch (error) {
        const failure =
          isSessionDeliveryGenerationRevokedError(error) ||
          isSessionDeliveryGenerationUnavailableError(error)
            ? error
            : new SessionDeliveryGenerationUnavailableError({ cause: error });
        onRevoked?.(failure);
        throw failure;
      }
    };
    for (let pending = prepareRead(); pending; pending = prepareRead()) {
      await pending;
    }
    assertCurrent();
    if (onRevoked) {
      let checkedPublications = publications;
      // Public notifications run after every committed generation fact is installed.
      releases.push(
        sessionChanges.subscribe(() => {
          if (checkedPublications === publications && !invalidated && !revoked) {
            return;
          }
          checkedPublications = publications;
          try {
            assertCurrent();
          } catch {
            // assertCurrent has already revoked the execution owner.
          }
        }),
      );
    }
    return {
      assertCurrent,
      assertDeliveryCurrent: () => assertCurrent(true),
      prepareRead,
      release,
    };
  } catch (error) {
    release();
    if (
      isSessionDeliveryGenerationRevokedError(error) ||
      isSessionDeliveryGenerationUnavailableError(error)
    ) {
      throw error;
    }
    throw new SessionDeliveryGenerationUnavailableError({ cause: error });
  }
}

/** Session lifecycle owners compose these facts with their own admitted mutation authority. */
export async function prepareSessionGenerationFacts(input: SessionGenerationFacts) {
  const { assertCurrent, prepareRead, release } = await prepareSessionGenerationLease(input);
  return { assertCurrent, prepareRead, release };
}

/** Stable cron roots retain their admitted run; exact-run keys already name one generation. */
export async function prepareCronRootSessionGeneration(
  input: Omit<SessionDeliveryGeneration, "lifecycleRevision"> & { lifecycleRevision?: string },
  onRevoked?: (reason: unknown) => void,
) {
  if (!isCronSessionKey(input.sessionKey) || isCronRunSessionKey(input.sessionKey)) {
    return undefined;
  }
  const { assertCurrent, release } = await prepareSessionGenerationLease(
    {
      ...input,
      lifecycleRevision: input.lifecycleRevision ?? null,
    },
    onRevoked,
  );
  return { assertCurrent, release };
}

/** Delivery remains unavailable while any lifecycle mutation owns the session. */
export async function prepareSessionDeliveryGeneration(input: SessionDeliveryGeneration) {
  if (!isSessionGenerationFacts(input) || input.sessionId === null) {
    throw new SessionDeliveryGenerationUnavailableError();
  }
  const lease = await prepareSessionGenerationLease(input);
  try {
    lease.assertDeliveryCurrent();
    return { assertCurrent: lease.assertDeliveryCurrent, release: lease.release };
  } catch (error) {
    lease.release();
    throw error;
  }
}
