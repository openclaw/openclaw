import type { UserTurnTranscriptAdmissionReceipt } from "../../sessions/user-turn-transcript.types.js";
import type { SessionTranscriptBoundedActiveContext } from "./session-accessor.sqlite-active-context.js";
import type {
  SessionTranscriptContextVersion,
  TranscriptEvent,
} from "./session-accessor.sqlite-contract.js";
import type { loadTranscriptReadSnapshotSync } from "./session-accessor.sqlite-read.js";
import type { ResolvedTranscriptReadScope } from "./session-accessor.sqlite-scope.js";
import type { SessionTranscriptRuntimeTarget } from "./session-accessor.types.js";
import type { SessionTranscriptMaintenanceRead } from "./session-transcript-maintenance-read.js";
import type { TranscriptEntryAnchor } from "./transcript-entry-anchor.js";

export type PreparedSessionTranscriptHydration =
  | { kind: "full"; snapshot: ReturnType<typeof loadTranscriptReadSnapshotSync> }
  | { kind: "bounded"; snapshot: SessionTranscriptBoundedActiveContext };

export type SessionTranscriptHydrationWorkerResult =
  | {
      kind: "full";
      version: ReturnType<typeof loadTranscriptReadSnapshotSync>["version"];
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
  target: SessionTranscriptRuntimeTarget & { env?: NodeJS.ProcessEnv };
  resolvedScope: ResolvedTranscriptReadScope;
  limits?: { maxBytes: number; maxEvents: number };
  admission?: UserTurnTranscriptAdmissionReceipt;
};

export type SessionTranscriptCurrentTurnEntryWorkerInput = Omit<
  SessionTranscriptHydrationWorkerInput,
  "kind" | "limits"
> &
  SessionTranscriptCurrentTurnEntryRequest & { kind: "current-turn-entry" };

export type SessionTranscriptRecentActiveEventsWorkerInput = Omit<
  SessionTranscriptHydrationWorkerInput,
  "kind" | "limits"
> & { kind: "recent-active-events"; maxEvents: number };

export type SessionTranscriptLatestActiveMessageWorkerInput = Omit<
  SessionTranscriptHydrationWorkerInput,
  "kind" | "limits"
> & { kind: "latest-active-message" };

export type SessionTranscriptMaintenanceWorkerInput = Omit<
  SessionTranscriptHydrationWorkerInput,
  "kind" | "limits"
> & { kind: "transcript-maintenance"; request: SessionTranscriptMaintenanceRead };

export type SessionTranscriptHydrationWorkerRequest =
  | SessionTranscriptHydrationWorkerInput
  | SessionTranscriptMaintenanceWorkerInput
  | SessionTranscriptCurrentTurnEntryWorkerInput
  | SessionTranscriptRecentActiveEventsWorkerInput
  | SessionTranscriptLatestActiveMessageWorkerInput;
