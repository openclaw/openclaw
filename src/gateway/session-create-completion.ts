import { isDeepStrictEqual } from "node:util";
import type { SessionEntry } from "../config/sessions.js";
import { deleteSessionEntryLifecycle } from "../config/sessions/session-accessor.js";
import { getSessionActorStorageBinding } from "../config/sessions/session-actor-storage-binding.js";
import { projectPublicSessionEntry } from "../config/sessions/session-entry-projection.js";
import { readSessionEntryReadOnlyInWorker } from "../config/sessions/session-entry-read-runtime.js";
import { formatErrorMessage } from "../infra/errors.js";
import type {
  CreatedGatewaySession,
  CreateGatewaySessionParams,
  CreateGatewaySessionResult,
  GatewaySessionCommitResult,
} from "./session-create-service.types.js";
import { finalizeSessionCreateTarget } from "./session-create-target.js";
import { unavailableSessionRequest } from "./session-request-error.js";

export async function completeGatewaySessionCreation(
  params: CreateGatewaySessionParams,
  result: Extract<GatewaySessionCommitResult, { ok: true }>,
  createdContext: CreatedGatewaySession | undefined,
  commitGuard: CreateGatewaySessionParams["commitGuard"],
  initializationEntry: SessionEntry | undefined,
): Promise<CreateGatewaySessionResult> {
  if (result.resetExisting || !createdContext || !params.afterCreate) {
    return params.atomicInitialization === true
      ? unavailableSessionRequest("atomic session initialization did not create a session")
      : { ...result, postCommit: { status: "completed" } };
  }
  if (params.atomicInitialization === true) {
    const initializingSession = createdContext;
    const scope = {
      agentId: initializingSession.agentId,
      storePath: initializingSession.storePath,
      sessionKey: initializingSession.key,
    };
    if (!initializationEntry) {
      return unavailableSessionRequest("atomic session initialization lost its commit witness");
    }
    const expectedEntry = structuredClone(initializationEntry);
    try {
      const memory = getSessionActorStorageBinding(scope);
      const stored = memory
        ? memory.actor.storage.readCurrent(
            { type: "session.entry.read", input: {} },
            memory.authority,
          )
        : await readSessionEntryReadOnlyInWorker(scope, commitGuard);
      if (
        !stored ||
        !isDeepStrictEqual(stored, expectedEntry) ||
        stored.initializationPending !== true
      ) {
        return unavailableSessionRequest("atomic session initialization lost its owner");
      }
      await params.afterCreate(initializingSession);
      const finalized = await finalizeSessionCreateTarget(
        initializingSession,
        expectedEntry,
        params.commitGuard,
      );
      return {
        ...result,
        entry: projectPublicSessionEntry(finalized),
        postCommit: { status: "completed" },
      };
    } catch (error) {
      return rollbackAtomicGatewaySessionCreation(initializingSession, expectedEntry, error);
    }
  }
  // The row, transcript, and prepared lifecycle are already durable here. A
  // fallible initializer must report that committed identity instead of making
  // callers infer that creation never happened and retry the key.
  try {
    await params.afterCreate(createdContext);
    return { ...result, postCommit: { status: "completed" } };
  } catch (error) {
    return { ...result, postCommit: { status: "failed", error } };
  }
}

/** Cleanup authority is the exact committed pending row, never a caller's expired source grant. */
export async function rollbackAtomicGatewaySessionCreation(
  session: CreatedGatewaySession,
  expectedEntry: SessionEntry,
  error: unknown,
): Promise<CreateGatewaySessionResult> {
  try {
    const rollback = await deleteSessionEntryLifecycle({
      agentId: session.agentId,
      archiveTranscript: false,
      deleteTranscriptWithoutArchive: true,
      expectedEntry,
      expectedSessionId: expectedEntry.sessionId,
      expectedUpdatedAt: expectedEntry.updatedAt,
      requireWriteSuccess: true,
      storePath: session.storePath,
      target: {
        canonicalKey: session.key,
        storeKeys: [session.key],
      },
    });
    if (!rollback.deleted) {
      throw new Error(`created session ${session.key} changed before rollback`, {
        cause: error,
      });
    }
  } catch (rollbackError) {
    return unavailableSessionRequest(
      `session initialization failed and rollback did not complete: ${formatErrorMessage(
        new AggregateError([error, rollbackError]),
      )}`,
    );
  }
  return {
    ...unavailableSessionRequest(`session initialization failed: ${formatErrorMessage(error)}`),
    initializationRolledBack: true,
  };
}
