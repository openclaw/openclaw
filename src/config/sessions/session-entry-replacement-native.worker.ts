import type { OpenClawAgentDatabase } from "../../state/openclaw-agent-db-contract.js";
import {
  initializeReplacementTranscript,
  type TranscriptInitialization,
} from "../../state/openclaw-agent-execution-transcript.worker.js";
import type { AgentWorkerOperationContext } from "../../state/openclaw-agent-operation-context.js";
import {
  commitSessionEntryReplacementsInDatabase,
  prepareSessionEntryReplacementPublication,
} from "./session-accessor.sqlite-replacement-state.js";
import type { SessionEntryReplacementCommit } from "./session-accessor.sqlite-replacement-types.js";
import { transferSessionEntryWorkerCandidate } from "./session-entry-patch.worker.js";
import type { SessionEntryWritePostimages } from "./session-entry-write-postimage.js";
import type { SessionNativeBindingParticipants } from "./session-native-binding.types.js";
import { runSessionNativeBindingTransaction } from "./session-native-binding.worker.js";

export function commitSessionEntryReplacementWithBindings(
  input: SessionEntryReplacementCommit & {
    initializeTranscript?: TranscriptInitialization;
    nativeBindings: SessionNativeBindingParticipants;
  },
  context: AgentWorkerOperationContext,
) {
  const mutate = (database: OpenClawAgentDatabase) => {
    const postimages: SessionEntryWritePostimages = new Map();
    const result = commitSessionEntryReplacementsInDatabase(
      database,
      input,
      () => initializeReplacementTranscript(database, context.options, input.initializeTranscript),
      undefined,
      undefined,
      postimages,
    );
    return {
      kind: "session-entry-replacements" as const,
      result,
      publication: prepareSessionEntryReplacementPublication(result, database, {
        captureFullFacts: true,
        postimages,
      }),
    };
  };
  return runSessionNativeBindingTransaction(
    input.nativeBindings,
    context,
    "session.entry-replacements",
    "Session replacement",
    (database, wrapReceipt) =>
      transferSessionEntryWorkerCandidate(database, context.admit, mutate(database), wrapReceipt),
  );
}
