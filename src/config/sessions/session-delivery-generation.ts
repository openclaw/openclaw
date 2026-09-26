import path from "node:path";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { readDatabasePathIdentitySync } from "../../infra/sqlite-worker-identity.js";
import { isIncognitoSessionKey } from "../../routing/session-key.js";
import { isSessionLifecycleMutationActive } from "../../sessions/session-lifecycle-admission.js";
import { sessionChanges, type SessionRowChange } from "../../sessions/session-row-changes.js";
import { getOpenIncognitoAgentDatabase } from "../../state/openclaw-agent-db-lifecycle.js";
import {
  registerOpenClawAgentDatabaseAsyncResource,
  registerOpenClawAgentDatabaseReadCandidateResource,
} from "../../state/openclaw-agent-db-resources.js";
import {
  isPreparedSessionSharingChange,
  projectSessionSharingEntry,
  readCommittedIncognitoSessionSharing,
  retainPreparedSessionGenerationFacts,
} from "./session-accessor.sqlite-entry-cache.js";
import type { SessionDeliveryGeneration } from "./session-delivery-generation.types.js";
import { withSessionEntriesFromStoresInWorker } from "./session-entry-read-runtime.js";
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

function isSessionDeliveryGeneration(value: unknown): value is SessionDeliveryGeneration {
  return (
    isRecord(value) &&
    [value.agentId, value.storePath, value.sessionKey, value.sessionId].every(
      (field) => typeof field === "string" && field.length > 0 && field === field.trim(),
    ) &&
    typeof value.storePath === "string" &&
    path.isAbsolute(value.storePath) &&
    (value.lifecycleRevision === null ||
      (typeof value.lifecycleRevision === "string" && value.lifecycleRevision.length > 0))
  );
}

/** Prepare once per delivery attempt; committed entry publications keep final I/O checks live. */
export async function prepareSessionDeliveryGeneration(input: SessionDeliveryGeneration): Promise<{
  assertCurrent: () => void;
  release: () => void;
}> {
  if (!isSessionDeliveryGeneration(input)) {
    throw new SessionDeliveryGenerationUnavailableError();
  }
  const generation = { ...input };
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
      entry === null ||
      entry.sessionId !== generation.sessionId ||
      (entry.lifecycleRevision ?? null) !== generation.lifecycleRevision
    ) {
      revoked = true;
      throw new SessionDeliveryGenerationRevokedError();
    }
  };
  const changed = (change: SessionRowChange) => {
    if ("all" in change) {
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
          "worker-placements",
          "worker-environments",
          "config",
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
    if (!isPreparedSessionSharingChange(change)) {
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
    if (isIncognitoSessionKey(generation.sessionKey)) {
      const database = getOpenIncognitoAgentDatabase(generation.agentId, generation.storePath);
      if (!database) {
        throw new SessionDeliveryGenerationRevokedError();
      }
      releases.push(
        registerOpenClawAgentDatabaseAsyncResource({
          agentId: generation.agentId,
          path: generation.storePath,
          revoke: release,
          close: async () => release(),
        }),
      );
      readCurrent = () => {
        if (getOpenIncognitoAgentDatabase(generation.agentId, generation.storePath) !== database) {
          throw new SessionDeliveryGenerationUnavailableError();
        }
        checkEntry(readCommittedIncognitoSessionSharing(database.db, generation.sessionKey)?.entry);
      };
      observeIncognito = readCurrent;
    } else {
      const candidates = captureSessionStoreReadCandidates(generation.storePath);
      for (const candidate of candidates) {
        paths.add(path.resolve(candidate.path));
        paths.add(path.resolve(candidate.physicalPath));
        for (const pathname of new Set([candidate.path, candidate.physicalPath])) {
          releases.push(
            registerOpenClawAgentDatabaseReadCandidateResource({
              ...candidate,
              path: pathname,
              revoke: release,
              close: async () => release(),
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
            if (!sharing) {
              throw new SessionDeliveryGenerationUnavailableError();
            }
            source = { path: sharing.source.path, identity: sharing.databaseIdentity };
            paths.add(path.resolve(source.path));
            const prepared = retainPreparedSessionGenerationFacts({
              databaseIdentity: sharing.databaseIdentity,
              sessionKey: generation.sessionKey,
              entry: entry ? projectSessionSharingEntry(entry) : undefined,
            });
            releases.push(prepared.release);
            return prepared;
          },
        );
      }
      readCurrent = () => {
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
        checkEntry(retained?.readCurrent());
      };
    }
    const assertCurrent = () => {
      try {
        assertActive();
        if (
          [...paths].some((scope) =>
            isSessionLifecycleMutationActive(scope, [generation.sessionKey, generation.sessionId]),
          )
        ) {
          throw new SessionDeliveryGenerationUnavailableError();
        }
        readCurrent();
      } catch (error) {
        if (
          isSessionDeliveryGenerationRevokedError(error) ||
          isSessionDeliveryGenerationUnavailableError(error)
        ) {
          throw error;
        }
        throw new SessionDeliveryGenerationUnavailableError({ cause: error });
      }
    };
    assertCurrent();
    return { assertCurrent, release };
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
