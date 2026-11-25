import type { SessionSourceAssertion } from "./session-source-authority.js";

export type SessionTranscriptWriterFence = Readonly<{
  expectedLifecycleRevision: string | undefined;
  expectedWriterRunId: string;
}>;

/** A first-insert lease, bound to the original admission rather than its run id. */
export type InitialSessionTranscriptWriter = Readonly<{
  writerRunId: string;
  committedFence: SessionTranscriptWriterFence | undefined;
  assertActive: SessionSourceAssertion;
  recordCommitted: (fence: SessionTranscriptWriterFence) => void;
  withTranscriptWrite: <T>(run: () => Promise<T> | T) => Promise<T>;
}>;
