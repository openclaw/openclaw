import { createSqliteWorkerOperationAdmission } from "../infra/sqlite-worker-operation-admission.js";
import type { OpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.types.js";
import { runOpenClawStateWorkerOperation } from "../state/openclaw-state-worker-store.js";
import type {
  MentionInboxMutation,
  MentionInboxMutationResult,
} from "./mention-inbox.worker-contract.js";

/** Keep the shared actor retained through acknowledged publication, never retry an uncertain write. */
export function mutateMentionInbox(
  context: OpenClawStateWorkerContext,
  input: MentionInboxMutation,
  assertCurrent: () => void,
  publish: (result: MentionInboxMutationResult) => void,
): Promise<MentionInboxMutationResult> {
  const captured = structuredClone(input);
  return runOpenClawStateWorkerOperation(
    context,
    async (scope) => {
      const result = await scope.execute({ type: "mentions.mutate", input: captured });
      publish(result);
      return result;
    },
    {
      assertCurrent,
      createAdmission: () => ({
        nativeLocations: [context.admission.databasePath],
        admission: createSqliteWorkerOperationAdmission((request, grant) => {
          if (request.stage !== "transaction" && request.stage !== "commit") {
            throw new Error("Mention mutation requires transaction admission");
          }
          context.admission.assertCurrent();
          assertCurrent();
          grant();
        }),
      }),
    },
  );
}
