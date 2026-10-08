import { isRecord } from "@openclaw/normalization-core/record-coerce";
import {
  createSqliteWorkerOperationAdmission,
  type SqliteWorkerOperationAdmission,
} from "../infra/sqlite-worker-operation-admission.js";
import { executeExistingOpenClawStateRead } from "../state/openclaw-state-db-readonly.js";
import type { OpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.types.js";
import {
  hydrateOpenClawStateWorkerError,
  retainOpenClawStateWorkerErrorPayload,
} from "../state/openclaw-state-worker-error.js";
import { runOpenClawStateWorkerOperation } from "../state/openclaw-state-worker-store.js";
import type { MentionStoreSnapshot } from "./mention-inbox-store.js";
import type { MentionMutation, MentionMutationResult } from "./mention-inbox.worker-contract.js";

export async function readMentionSnapshot(
  context: OpenClawStateWorkerContext,
  revision: number,
): Promise<MentionStoreSnapshot | undefined> {
  const reply = await executeExistingOpenClawStateRead(
    { path: context.admission.databasePath, env: context.environment },
    { type: "mentions.snapshot", input: revision },
    { context, current: true },
  );
  context.admission.assertCurrent();
  if (!reply) {
    return revision === 0 ? undefined : { head: { revision: 0, nextSequence: 0 }, sources: [] };
  }
  if (!reply.ok) {
    const error = new Error(reply.message);
    retainOpenClawStateWorkerErrorPayload(error, reply.error);
    throw hydrateOpenClawStateWorkerError(error, { includeOrdinary: true });
  }
  if (reply.type !== "mentions.snapshot") {
    throw new Error("Unexpected Mention Inbox snapshot reply");
  }
  return reply.snapshot;
}

export async function commitMentionChanges(
  context: OpenClawStateWorkerContext,
  input: MentionMutation,
  assertCurrent: () => void,
): Promise<MentionMutationResult> {
  const captured = structuredClone(input);
  let admission: SqliteWorkerOperationAdmission | undefined;
  try {
    return await runOpenClawStateWorkerOperation(
      context,
      (scope) => scope.execute({ type: "mentions.mutate", input: captured }),
      {
        assertCurrent,
        createAdmission: () => {
          admission = createSqliteWorkerOperationAdmission((_request, grant) => {
            context.admission.assertCurrent();
            assertCurrent();
            grant();
          });
          return { admission, nativeLocations: [context.admission.databasePath] };
        },
      },
    );
  } catch (error) {
    // A lost ordinary reply cannot undo its native commit or justify replaying the mutation.
    const facts = admission?.committed?.facts;
    if (
      isRecord(facts) &&
      facts.kind === "committed" &&
      isRecord(facts.head) &&
      facts.head.revision === captured.expectedHead.revision + (captured.changes.length ? 1 : 0) &&
      facts.head.nextSequence === captured.nextSequence
    ) {
      return {
        kind: "committed",
        head: { revision: facts.head.revision, nextSequence: facts.head.nextSequence },
      };
    }
    throw error;
  }
}
