import type { CompactionEntry } from "../../agents/sessions/session-manager-types.js";
import type {
  SessionTranscriptRuntimeTarget,
  SessionTranscriptWriteScope,
} from "./session-accessor.types.js";
import type { SessionTranscriptContextVersion } from "./session-transcript-context-version.types.js";
import type { InternalSessionEntry } from "./types.js";

/** Prepared data only; the original runtime owner still authorizes the commit. */
export type PreparedCompactionAppend = {
  scope: SessionTranscriptRuntimeTarget &
    Pick<
      SessionTranscriptWriteScope,
      "env" | "expectedLifecycleRevision" | "expectedWriterRunId" | "expectedOwner"
    >;
  event: CompactionEntry;
  appendIntent?: "active-branch";
  expectedMutationAt?: number | null;
  initializeEntry?: boolean;
};

export type CommittedCompactionAppend = {
  result: CompactionEntry;
  before: SessionTranscriptContextVersion;
  after: SessionTranscriptContextVersion;
};

export type CommittedCompactionBoundary = CommittedCompactionAppend & {
  entry: InternalSessionEntry;
};
