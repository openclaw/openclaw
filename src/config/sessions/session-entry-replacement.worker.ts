import { deferSqliteWorkerCommitReceipt } from "../../infra/sqlite-worker-operation-admission.js";
import type { OpenClawAgentDatabase } from "../../state/openclaw-agent-db-contract.js";
import {
  initializeReplacementTranscript,
  type TranscriptInitialization,
} from "../../state/openclaw-agent-execution-transcript.worker.js";
import type { AgentWorkerOperationContext } from "../../state/openclaw-agent-operation-context.js";
import type { SessionEntryReplacementPublication } from "./session-accessor.sqlite-entry-cache.types.js";
import {
  boundSessionEntryReplacementPublication,
  commitSessionEntryReplacementsInDatabase,
  prepareSessionEntryReplacementPublication,
} from "./session-accessor.sqlite-replacement-state.js";
import type {
  SessionEntryReplacementCommit,
  SessionEntryReplacementCommitted,
} from "./session-accessor.sqlite-replacement-types.js";
import { transferSessionEntryWorkerCandidate } from "./session-entry-patch.worker.js";
import { sealSessionEntryPublicationSource } from "./session-entry-publication-source.js";
import type { SessionEntryWritePostimages } from "./session-entry-write-postimage.js";
import type { SessionNativeBindingParticipants } from "./session-native-binding.types.js";
import { runSessionNativeBindingTransaction } from "./session-native-binding.worker.js";

type ReplacementInput = SessionEntryReplacementCommit & {
  initializeTranscript?: TranscriptInitialization;
};

export type SessionEntryNativeReplacementCandidate = {
  kind: "session-entry-native-replacement";
  result: SessionEntryReplacementCommitted;
  publication: SessionEntryReplacementPublication;
};

function replace(
  current: OpenClawAgentDatabase,
  input: ReplacementInput,
  context: AgentWorkerOperationContext,
) {
  const postimages: SessionEntryWritePostimages = new Map();
  const result = commitSessionEntryReplacementsInDatabase(
    current,
    input,
    () => initializeReplacementTranscript(current, context.options, input.initializeTranscript),
    undefined,
    undefined,
    postimages,
  );
  const publication = prepareSessionEntryReplacementPublication(result, current, {
    captureFullFacts: true,
    postimages,
  });
  return { result, publication };
}

export function replaceSessionEntriesInWorker(
  input: ReplacementInput,
  context: AgentWorkerOperationContext,
) {
  return context.writeTransaction(
    "session.entry-replacements",
    "Session replacement",
    (current) => {
      const { result, publication } = replace(current, input, context);
      const candidate = { ...result, publication };
      if (publication.source && publication.fullEntries?.size) {
        sealSessionEntryPublicationSource(publication.source);
      }
      boundSessionEntryReplacementPublication(publication, candidate);
      deferSqliteWorkerCommitReceipt(current.db, publication);
      context.admit("commit", publication);
      return candidate;
    },
  );
}

export function replaceSessionEntriesWithNativeBindingsInWorker(
  input: ReplacementInput & { nativeBindings: SessionNativeBindingParticipants },
  context: AgentWorkerOperationContext,
) {
  return runSessionNativeBindingTransaction(
    input.nativeBindings,
    context,
    "session.entry-replacements",
    "Session replacement",
    (current, wrapReceipt) => {
      const candidate: SessionEntryNativeReplacementCandidate = {
        kind: "session-entry-native-replacement",
        ...replace(current, input, context),
      };
      return transferSessionEntryWorkerCandidate(current, context.admit, candidate, wrapReceipt);
    },
  );
}
