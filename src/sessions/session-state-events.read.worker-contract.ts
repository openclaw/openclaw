import type {
  SessionStateEventRecord,
  SessionStateSweepAddress,
} from "./session-state-events.types.js";

export type SessionStateReadOperations = {
  "sessionState.pendingNotices": {
    input: undefined;
    output: { type: "sessionState.pendingNotices"; cursors: SessionStateSweepAddress[] };
  };
  "sessionState.ambientTargets": {
    input: { watcherSessionKey: string };
    output: { type: "sessionState.ambientTargets"; targets: string[] };
  };
  "sessionState.versions": {
    input: ReadonlyArray<{ sessionKey: string; agentId: string }>;
    output: { type: "sessionState.versions"; versions: Record<string, Record<string, number>> };
  };
  "sessionState.events": {
    input: { sessionKey: string; agentId: string; afterSequence: number; limit: number };
    output: {
      type: "sessionState.events";
      page: {
        events: SessionStateEventRecord[];
        truncated: boolean;
        earliestAvailableSequence: number;
        historyGap: boolean;
      };
    };
  };
};
