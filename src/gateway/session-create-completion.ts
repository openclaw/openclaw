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
    const memory = getSessionActorStorageBinding(scope);
    const stored = memory
      ? memory.actor.storage.readCurrent(
          { type: "session.entry.read", input: {} },
          memory.authority,
        )
      : await readSessionEntryReadOnlyInWorker(scope, commitGuard);
    if (
      !stored ||
      stored.sessionId !== initializingSession.entry.sessionId ||
      stored.initializationPending !== true
    ) {
      return unavailableSessionRequest("atomic session initialization lost its owner");
    }
    const expectedEntry = structuredClone(stored);
    try {
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
      try {
        const rollback = await deleteSessionEntryLifecycle({
          agentId: initializingSession.agentId,
          archiveTranscript: false,
          deleteTranscriptWithoutArchive: true,
          expectedEntry,
          expectedSessionId: expectedEntry.sessionId,
          expectedUpdatedAt: expectedEntry.updatedAt,
          requireWriteSuccess: true,
          storePath: initializingSession.storePath,
          target: {
            canonicalKey: initializingSession.key,
            storeKeys: [initializingSession.key],
          },
        });
        if (!rollback.deleted) {
          throw new Error(`created session ${initializingSession.key} changed before rollback`, {
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
      return unavailableSessionRequest(
        `session initialization failed: ${formatErrorMessage(error)}`,
      );
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
