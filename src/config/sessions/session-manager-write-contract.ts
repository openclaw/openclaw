import type { Result } from "@openclaw/normalization-core/result";
import type { BashExecutionMessage, CustomMessage } from "../../agents/sessions/messages.js";
import type {
  CommittedCompactionAppend,
  PreparedCompactionAppend,
} from "../../agents/sessions/session-compaction-persistence.js";
import type {
  SessionEntry,
  SessionLeafControl,
  SessionMessageEntry,
} from "../../agents/sessions/session-manager-types.js";
import type { SqliteWorkerStore } from "../../infra/sqlite-worker-contract.js";
import type { Message } from "../../llm/types.js";
import type { UserTurnTranscriptAdmissionReceipt } from "../../sessions/user-turn-transcript.types.js";
import type { OpenClawStateWorkerErrorPayload } from "../../state/openclaw-state-worker-error.js";
import type { CliHistoryWriterFacts } from "./cli-history-boundary.js";
import type {
  SessionTranscriptContextVersion,
  SessionTranscriptWriteScope,
  TranscriptAppendRefusal,
  TranscriptEventAppendOptions,
  TranscriptEventAppendResult,
  TranscriptMessageAppendResult,
  TranscriptMessageWriteSnapshot,
  TranscriptWriteSnapshot,
} from "./session-accessor.sqlite-contract.js";
import type {
  SessionPendingInputWorkerFacts,
  SessionPendingInputWorkerReceipt,
} from "./session-accessor.sqlite-pending-inputs.js";
import type { SessionTranscriptRuntimeTarget } from "./session-accessor.types.js";
import type { PreparedSessionTranscriptHydration as PreparedSessionTranscriptReload } from "./session-history-read.types.js";
import type {
  InitialSessionTranscriptWriter,
  SessionTranscriptWriterFence,
} from "./transcript-write-context.js";
import type { InternalSessionEntry } from "./types.js";

type MetadataTarget = Omit<SessionTranscriptWriteScope, "env"> & SessionTranscriptRuntimeTarget;
type SessionManagerBoundedContextLimits = { maxBytes: number; maxEvents: number };

/** Host metadata capability; SDK-visible admissions do not expose the actor's other domains. */
export type SessionManagerIncognitoDatabase = {
  readonly path: string;
  readonly identity: { readonly incarnation: string };
  withMetadata<T>(
    assertCurrent: () => void,
    operation: (scope: Pick<SqliteWorkerStore<SessionMetadataOperations>, "execute">) => Promise<T>,
    controls?: {
      beforeFreshMessageCommit?: () => void;
      initialWriter?: InitialSessionTranscriptWriter;
    },
  ): Promise<T>;
};

export type InitialSessionEntryCommit = {
  owned: boolean;
  fence?: SessionTranscriptWriterFence;
  identity?: {
    previous: Map<string, InternalSessionEntry>;
    current: Map<string, InternalSessionEntry>;
  };
};

export type SessionMetadataMessageControl = {
  pendingInput?: { facts: SessionPendingInputWorkerFacts; relocation?: string };
  freshMessageCheck?: true;
};

export type SessionMaintenanceOperations = {
  "session.transcript.branch": {
    input: {
      scope: MetadataTarget;
      branch: { sessionId: string; events: unknown[] };
      expectedLifecycleRevision: SessionTranscriptWriteScope["expectedLifecycleRevision"];
    };
    output: {
      identity: NonNullable<InitialSessionEntryCommit["identity"]>;
      version: SessionTranscriptContextVersion;
      projectionNeedsReconcile: boolean;
    };
  };
  "session.transcript.replaceSuffix": {
    input: {
      scope: MetadataTarget;
      args: [
        expectedEvents: readonly unknown[],
        nextEvents: readonly unknown[],
        prefixLength: number,
        expectedMutationAt: number | null | undefined,
        eventsStartAtPersistedPrefix: boolean,
        retainedCustomDataIds: readonly string[],
      ];
    };
    output: {
      replaced: boolean;
      version?: SessionTranscriptContextVersion;
      projectionNeedsReconcile: boolean;
    };
  };
  "session.transcript.rewrite": {
    input: {
      scope: MetadataTarget;
      appendParentId: string | null;
      version: SessionTranscriptContextVersion;
      entries: Array<SessionEntry | SessionLeafControl>;
      sources: Array<[string, SessionEntry]>;
      pendingInput?: { facts: SessionPendingInputWorkerFacts; relocation?: string };
    };
    output: {
      version: SessionTranscriptContextVersion;
      entries: Array<SessionEntry | SessionLeafControl>;
      pendingInputReceipt?: SessionPendingInputWorkerReceipt;
      projectionNeedsReconcile: boolean;
    };
  };
};

export type CompactionBoundaryOperations = {
  "session.transcript.compactionBoundary": {
    input: {
      scope: Omit<PreparedCompactionAppend["scope"], "env">;
      prepared: Omit<PreparedCompactionAppend, "scope"> & {
        scope: Omit<PreparedCompactionAppend["scope"], "env">;
      };
      transcriptByteCompactionLatch: NonNullable<
        InternalSessionEntry["transcriptByteCompactionLatch"]
      >;
      initialWriterRunId?: string;
    };
    output: {
      committed: CommittedCompactionAppend;
      initialEntry?: InitialSessionEntryCommit;
      projectionNeedsReconcile: boolean;
    };
  };
};

export type SessionMetadataOperations = SessionMaintenanceOperations &
  CompactionBoundaryOperations & {
    "session.transcript.appendMessage": {
      input: {
        scope: MetadataTarget;
        messageJson: string;
        cwd: string;
        cliWriter?: CliHistoryWriterFacts;
      } & SessionMetadataMessageControl;
      output: {
        snapshot: Result<
          TranscriptMessageWriteSnapshot<
            Message | CustomMessage | BashExecutionMessage | undefined
          >,
          TranscriptAppendRefusal
        >;
        projectionNeedsReconcile: boolean;
        pendingInputReceipt?: SessionPendingInputWorkerReceipt;
      };
    };
    "session.metadata.initialize": {
      input: {
        scope: MetadataTarget;
        entry: InternalSessionEntry;
        initialWriterRunId?: string;
      };
      output: InitialSessionEntryCommit;
    };
    "session.metadata.append": {
      input: {
        scope: MetadataTarget;
        event: Omit<SessionMessageEntry, "message"> | string;
        cliWriter?: CliHistoryWriterFacts;
        message?: {
          messageJson: string;
          cwd: string;
          validateTurn: boolean;
          idempotencyLookup?: "scan" | "scan-assistant" | "caller-checked";
        } & SessionMetadataMessageControl;
        options: Pick<TranscriptEventAppendOptions, "appendIntent" | "expectedMutationAt">;
        view?: {
          loadedVersion?: SessionTranscriptContextVersion;
          limits?: SessionManagerBoundedContextLimits;
          admission?: UserTurnTranscriptAdmissionReceipt;
        };
      };
      output: {
        snapshot: Result<
          TranscriptWriteSnapshot<
            | TranscriptEventAppendResult
            | TranscriptMessageAppendResult<SessionMessageEntry["message"] | undefined>
            | undefined
          >,
          TranscriptAppendRefusal
        >;
        projectionNeedsReconcile: boolean;
        pendingInputReceipt?: SessionPendingInputWorkerReceipt;
        reload?: Result<
          PreparedSessionTranscriptReload,
          OpenClawStateWorkerErrorPayload | undefined
        >;
      };
    };
    "session.metadata.mutation": {
      input: { scope: MetadataTarget };
      output: number | null;
    };
  };

export type SessionMetadataWorkerOperations = {
  [Key in keyof SessionMetadataOperations]: {
    input: SessionMetadataOperations[Key]["input"];
    output:
      | { ok: true; value: SessionMetadataOperations[Key]["output"] }
      | { ok: false; refusal?: TranscriptAppendRefusal };
  };
};
