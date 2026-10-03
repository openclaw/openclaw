import type { SessionEntryCurrentSource } from "../config/sessions/session-entry-current.types.js";
import type { SessionUpstreamJsonValue } from "../plugins/session-catalog.js";
import type { SessionUpstreamLink } from "./session-upstream-links.kernel.js";

export type SessionUpstreamSettlement =
  | { kind: "missing" }
  | { kind: "activity"; marker: SessionUpstreamJsonValue; now: number };

export type SessionUpstreamWorkerOperations = {
  "sessionUpstream.current": { input: SessionUpstreamLink; output: boolean };
  "sessionUpstream.settle": {
    input: {
      expected: SessionUpstreamLink;
      settlement: SessionUpstreamSettlement;
      sessionEntryCurrentSource?: SessionEntryCurrentSource;
    };
    output: boolean;
  };
};
