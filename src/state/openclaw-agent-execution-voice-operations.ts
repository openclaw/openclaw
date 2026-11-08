import { deferSqliteWorkerCommitReceipt } from "../infra/sqlite-worker-operation-admission.js";
import type { AgentWorkerOperationContext } from "./openclaw-agent-operation-context.js";
import type { WorkerOperationHandlers } from "./worker-operation-registry.js";

type Handlers = WorkerOperationHandlers<AgentWorkerOperationContext>;

export async function loadAgentVoiceSessionOperations() {
  const { readSessionSourceValidation } =
    await import("../config/sessions/session-source-predicate.worker.js");
  const kernel = await import("../talk/client-voice-session-write.kernel.js");
  const store = await import("../talk/client-voice-session-store.js");
  const entries = await import("../config/sessions/session-accessor.sqlite-entry-read.js");
  const keys = await import("../config/sessions/session-accessor.sqlite-scope-helpers.js");
  const canonical = await import("../config/sessions/session-canonical-key.js");
  const { isIncognitoSessionKey } = await import("../shared/incognito-session-key.js");
  const { readSessionPendingInputAuthorityFactsInTransaction } =
    await import("../config/sessions/session-pending-input-authority.kernel.js");
  return {
    "voice.session.read": (input: { voiceSessionId: string }, { open }) => {
      const database = open();
      const record = store.readVoiceSessionRecordInTransaction(database, input.voiceSessionId);
      let entry;
      if (
        record &&
        record.effects.length > 0 &&
        !record.digestDeliveredAt &&
        !isIncognitoSessionKey(record.sessionKey)
      ) {
        canonical.assertCanonicalSqliteSessionKeysCurrent(database);
        const key = keys.resolveSqliteSessionKey(record.sessionKey, database.agentId);
        entry = entries.prepareExactSessionEntryRowReads(
          database,
          [key],
          "delivery",
          "canonical",
        )(key)?.entry;
      }
      return { record, entry };
    },
    "voice.session.mutate": (
      input: Parameters<typeof kernel.mutateVoiceSessionInDatabase>[1] & {
        sources?: import("../config/sessions/session-source-authority.js").SessionSourcePredicate[];
        transactionSource?: Omit<
          import("../config/sessions/session-source-authority.js").SessionSourceTransactionGrant,
          "assertCurrent"
        >;
      },
      { writeTransaction, admit },
    ) =>
      writeTransaction(`voice.session.${input.kind}`, "Voice session", (database) => {
        const sourceFacts = input.transactionSource
          ? readSessionPendingInputAuthorityFactsInTransaction(
              database,
              input.transactionSource.sessionKey,
              input.transactionSource.agentId,
            )
          : undefined;
        const sourceValidation = readSessionSourceValidation(database, input.sources);
        if (sourceFacts || input.sources?.length) {
          admit("transaction", {
            kind: "voice-session-authority",
            facts: sourceFacts,
            sourceValidation,
          });
        }
        if (sourceValidation.refusedSource) {
          throw new Error("Voice session source refusal was not rejected");
        }
        const entry =
          input.kind === "reserve" && input.transcriptSessionKey
            ? entries.readSessionEntryIdentity(
                database,
                keys.resolveSqliteSessionKey(input.transcriptSessionKey, database.agentId),
              )
            : undefined;
        if (input.kind === "reserve" && input.transcriptSessionKey && !entry?.sessionId) {
          throw new Error(`agent session not found (${input.sessionKey})`);
        }
        const result = { record: kernel.mutateVoiceSessionInDatabase(database, input), entry };
        deferSqliteWorkerCommitReceipt(database.db, result);
        admit(
          "commit",
          sourceFacts ? { kind: "voice-session-authority", facts: sourceFacts } : undefined,
        );
        return result;
      }),
  } satisfies Handlers;
}
