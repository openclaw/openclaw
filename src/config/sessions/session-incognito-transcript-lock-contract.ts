import type { readTranscriptMirrorFacts } from "./session-accessor.sqlite-transcript-mirror.js";
import type { SessionTranscriptWriteScope, TranscriptEvent } from "./session-accessor.types.js";
import type {
  SessionSourcePredicate,
  SessionSourceValidation,
} from "./session-source-authority.js";
import type { SessionTranscriptContextVersion } from "./session-transcript-context-version.types.js";
import type { RefusedTranscriptOwnerSource } from "./session-transcript-mutation.types.js";

type Target = {
  sessionKey: string;
  sessionId: string;
  ownerSources?: SessionSourcePredicate[];
  fence: Pick<
    SessionTranscriptWriteScope,
    "expectedLifecycleRevision" | "expectedWriterRunId" | "expectedOwner"
  >;
};
export type IncognitoTranscriptLockOperations = {
  "session.lock.events": {
    input: Target;
    output:
      | {
          version: SessionTranscriptContextVersion;
          events: TranscriptEvent[];
          sourceValidation: SessionSourceValidation;
        }
      | RefusedTranscriptOwnerSource;
  };
  "session.lock.facts": {
    input: Target & { idempotencyKeys: readonly string[]; sourceRunId?: string };
    output:
      | {
          version: SessionTranscriptContextVersion;
          facts: ReturnType<typeof readTranscriptMirrorFacts>;
          sourceValidation: SessionSourceValidation;
        }
      | RefusedTranscriptOwnerSource;
  };
  "session.lock.replace": {
    input: Target & {
      events: readonly TranscriptEvent[];
      expected: SessionTranscriptContextVersion;
    };
    output: SessionTranscriptContextVersion | RefusedTranscriptOwnerSource;
  };
};
