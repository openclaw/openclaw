import { randomUUID } from "node:crypto";
import type { SessionActorAuthority } from "../../config/sessions/session-actor-contract.js";
import {
  runSessionActorCommand,
  withSessionActor,
} from "../../config/sessions/session-actor-scope.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import { SqliteWorkerError } from "../../infra/sqlite-worker-contract.js";
import type { RunReplyAgentParams } from "./agent-runner-core.js";

export async function commitQueuedReplySessionActivity(params: {
  target: { agentId?: string; storePath: string; sessionKey: string };
  expected: SessionEntry;
  updatedAt: number;
  assertCurrent: () => void;
  onCommittedEntry: (entry: SessionEntry | undefined) => void;
}): Promise<void> {
  const assertCurrent = () => params.assertCurrent();
  const authority: SessionActorAuthority = {
    assertCurrent,
    authorize(_stage, facts) {
      const current = facts.entry;
      if (
        !current ||
        current.sessionId !== params.expected.sessionId ||
        current.lifecycleRevision !== params.expected.lifecycleRevision
      ) {
        throw new Error("Queued activity session changed");
      }
    },
  };
  // This queue/steering branch has no later durable command before returning.
  await withSessionActor(
    params.target,
    { assertCurrent, assertReadable: assertCurrent },
    async (actor) => {
      const outcome = await runSessionActorCommand(actor, authority, (snapshot) =>
        actor.patch(
          {
            commandId: randomUUID(),
            phaseId: `activity:${params.target.sessionKey}`,
            expected: snapshot?.version,
            reducers: [{ kind: "activity", updatedAt: params.updatedAt }],
          },
          authority,
        ),
      );
      if (outcome.kind !== "committed") {
        throw new SqliteWorkerError(
          outcome.error.message,
          outcome.kind === "unknown" ? "outcome-unknown" : "unavailable",
        );
      }
      params.onCommittedEntry(outcome.receipt.postimage.entry);
      if (outcome.failure) {
        throw new Error(outcome.failure.message);
      }
    },
  );
}

/** Keep queued/steered activity and its in-memory session projection at one write boundary. */
export async function touchQueuedReplySessionActivity(
  params: Pick<
    RunReplyAgentParams,
    "opts" | "followupRun" | "sessionKey" | "sessionStore" | "storePath"
  >,
  activeSessionEntry: SessionEntry | undefined,
  onCommittedEntry: (entry: SessionEntry | undefined) => void,
): Promise<void> {
  const { opts, followupRun, sessionKey, sessionStore: activeSessionStore, storePath } = params;
  if (opts?.internalEventExecution || !activeSessionEntry || !activeSessionStore || !sessionKey) {
    return;
  }
  // Keep the in-memory snapshot aligned with the pending-reset write boundary.
  const updatedAt = activeSessionEntry.updatedAt === 0 ? 0 : Date.now();
  if (storePath) {
    await commitQueuedReplySessionActivity({
      target: { agentId: followupRun.run.agentId, storePath, sessionKey },
      expected: activeSessionEntry,
      updatedAt,
      assertCurrent: () => {
        followupRun.operatorAuthority?.assertCurrent();
      },
      onCommittedEntry: (entry) => {
        onCommittedEntry(entry);
        if (entry) {
          activeSessionStore[sessionKey] = entry;
        }
      },
    });
  } else {
    activeSessionEntry.updatedAt = updatedAt;
    activeSessionStore[sessionKey] = activeSessionEntry;
  }
}
