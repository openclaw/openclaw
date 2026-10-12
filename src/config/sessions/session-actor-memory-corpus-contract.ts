import type { SessionResetRecallCutoff } from "../../../packages/memory-host-sdk/src/host/session-reset-recall.js";
import type { SessionTranscriptStats } from "./session-accessor.types.js";

type Selection = { sessionId?: string; sessionKey?: string };
export type SessionActorMemoryCorpusReads = {
  "session.memory.entry": {
    input: Selection & { includeMessages?: boolean };
    output:
      | { sessionId: string; sessionKey: string; events: unknown[]; stats: SessionTranscriptStats }
      | undefined;
  };
  "session.memory.resetRecall": {
    input: Selection;
    output: SessionResetRecallCutoff;
  };
};
