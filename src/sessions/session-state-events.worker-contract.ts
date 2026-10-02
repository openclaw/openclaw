import type { AcpSessionControlConstraint } from "../acp/runtime/session-meta-control.types.js";
import type { SessionEntryCurrentSource } from "../config/sessions/session-entry-current.types.js";
import type { SessionWatchCursorProvenance } from "../state/session-watch-cursor-provenance.js";
import type {
  SessionStateEventInput,
  SessionStateEventRow,
  SessionStateNotice,
} from "./session-state-events.kernel.js";
import type { SessionUpstreamLink } from "./session-upstream-links.kernel.js";

export type SessionStateWatchAddress = {
  targetSessionKey: string;
  watcherStorePath: string | null;
};

export type SessionStateWorkerOperations = {
  "sessionState.registerWatch": {
    input: {
      watcherSessionKey: string;
      watcherStorePath: string;
      targetSessionKey: string;
      targetAgentId: string;
      provenance: SessionWatchCursorProvenance;
      now: number;
      sessionEntryCurrentSources?: readonly SessionEntryCurrentSource[];
    };
    output: boolean;
  };
  "sessionState.acknowledge": {
    input: {
      watcherSessionKey: string;
      cursors: readonly SessionStateWatchAddress[];
      now: number;
      sessionEntryCurrentSources?: readonly SessionEntryCurrentSource[];
    };
    output: SessionStateNotice[];
  };
  "sessionState.record": {
    input: {
      event: SessionStateEventInput;
      now: number;
      onlyIfWatched?: boolean;
      expectedUpstream?: SessionUpstreamLink;
      acpControl?: AcpSessionControlConstraint;
      sessionEntryCurrentSource?: SessionEntryCurrentSource;
    };
    output: { row?: SessionStateEventRow; notices: SessionStateNotice[] };
  };
  "sessionState.prune": {
    input: { now: number; sessionEntryCurrentSource?: SessionEntryCurrentSource };
    output: void;
  };
};
