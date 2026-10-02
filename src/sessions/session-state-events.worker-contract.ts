import type { AcpSessionControlConstraint } from "../acp/runtime/session-meta-control.types.js";
import type { SessionEntryCurrentSource } from "../config/sessions/session-entry-current.types.js";
import type {
  SessionStateEventInput,
  SessionStateEventRow,
  SessionStateNotice,
} from "./session-state-events.kernel.js";
import type { SessionUpstreamLink } from "./session-upstream-links.kernel.js";

export type SessionStateWorkerOperations = {
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
