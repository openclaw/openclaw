import type { UserTurnTranscriptAdmissionReceipt } from "../../sessions/user-turn-transcript.types.js";
import type { SessionTranscriptContextVersion } from "./session-accessor.sqlite-contract.js";
import type { ResolvedTranscriptReadScope } from "./session-accessor.sqlite-scope.js";
import type { SessionTranscriptRuntimeTarget } from "./session-accessor.types.js";

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

export type SessionTranscriptHydrationWorkerRequest =
  | SessionTranscriptHydrationWorkerInput
  | SessionTranscriptCurrentTurnEntryWorkerInput
  | SessionTranscriptRecentActiveEventsWorkerInput
  | SessionTranscriptLatestActiveMessageWorkerInput;
