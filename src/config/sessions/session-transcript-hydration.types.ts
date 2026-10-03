import type { DatabaseFileIdentity } from "../../infra/sqlite-worker-identity.js";
import type { UserTurnTranscriptAdmissionReceipt } from "../../sessions/user-turn-transcript.types.js";
import type {
  SessionTranscriptContextVersion,
  SessionTranscriptReadScope,
  SessionTranscriptWriteScope,
  TranscriptEvent,
} from "./session-accessor.sqlite-contract.js";
import type { ResolvedTranscriptReadScope } from "./session-accessor.sqlite-scope.js";
import type { SessionTranscriptRuntimeTarget } from "./session-accessor.types.js";
import type {
  PreparedSessionTranscriptHydration,
  SessionTranscriptReadSnapshot,
} from "./session-history-read.types.js";
import type { TranscriptEntryAnchor } from "./transcript-entry-anchor.js";

export type { PreparedSessionTranscriptHydration } from "./session-history-read.types.js";

export type SessionTranscriptMaintenanceRead =
  | { operation: "previous"; beforeSeq: number }
  | { operation: "identity"; eventId: string }
  | { operation: "version" }
  | {
      operation: "suffix";
      startSeq: number;
      maxBytes: number;
      maxEvents: number;
      retainedCustomDataIds: readonly string[];
    };

export type SessionTranscriptMaintenanceFacts = {
  kind: "transcript-maintenance";
  previous?: TranscriptEvent;
  seq?: number;
  version?: SessionTranscriptContextVersion;
  appendParentId?: string | null;
  lifecycleRevision?: SessionTranscriptWriteScope["expectedLifecycleRevision"];
  events?: TranscriptEvent[];
};

export type SessionTranscriptHydrationWorkerResult =
  | {
      kind: "full";
      version: SessionTranscriptReadSnapshot["version"];
      eventCount: number;
    }
  | Extract<PreparedSessionTranscriptHydration, { kind: "bounded" }>;

export type SessionTranscriptHydrationChunk = {
  kind: "transcript-hydration-chunk";
  encoding: string;
  frames: Array<{ data: Uint8Array; endOfEvent: boolean }>;
};

export type SessionTranscriptCurrentTurnEntryRead = {
  kind: "current-turn-entry";
  version: SessionTranscriptContextVersion;
  anchor?: TranscriptEntryAnchor;
  event?: TranscriptEvent;
};

export type SessionTranscriptCurrentTurnEntryRequest = {
  entryId: string;
  version: SessionTranscriptContextVersion;
  includeEntry: boolean;
};

export type SessionTranscriptHydrationWorkerInput = {
  kind: "transcript-hydration";
  database: { agentId: string; path: string };
  target: SessionTranscriptReadScope;
  resolvedScope: ResolvedTranscriptReadScope;
  expectedIdentity?: DatabaseFileIdentity;
  limits?: { maxBytes: number; maxEvents: number };
  admission?: UserTurnTranscriptAdmissionReceipt;
};

type SessionTranscriptRuntimeHydrationInput = Omit<
  SessionTranscriptHydrationWorkerInput,
  "kind" | "limits" | "target" | "expectedIdentity"
> & { target: SessionTranscriptRuntimeTarget & { env?: NodeJS.ProcessEnv } };

export type SessionTranscriptCurrentTurnEntryWorkerInput = SessionTranscriptRuntimeHydrationInput &
  SessionTranscriptCurrentTurnEntryRequest & { kind: "current-turn-entry" };

export type SessionTranscriptRecentActiveEventsWorkerInput =
  SessionTranscriptRuntimeHydrationInput & {
    kind: "recent-active-events";
    maxEvents: number;
  };

export type SessionTranscriptLatestActiveMessageWorkerInput =
  SessionTranscriptRuntimeHydrationInput & {
    kind: "latest-active-message";
  };

export type SessionTranscriptMaintenanceWorkerInput = SessionTranscriptRuntimeHydrationInput & {
  kind: "transcript-maintenance";
  request: SessionTranscriptMaintenanceRead;
};

export type SessionTranscriptHydrationWorkerRequest =
  | SessionTranscriptHydrationWorkerInput
  | SessionTranscriptMaintenanceWorkerInput
  | SessionTranscriptCurrentTurnEntryWorkerInput
  | SessionTranscriptRecentActiveEventsWorkerInput
  | SessionTranscriptLatestActiveMessageWorkerInput;
