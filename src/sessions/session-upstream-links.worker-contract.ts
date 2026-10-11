import type { SessionEntryCurrentSource } from "../config/sessions/session-entry-current.types.js";
import type { SessionUpstreamJsonValue } from "../plugins/session-catalog.js";
import type { OpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.types.js";
import type {
  SessionUpstreamLink,
  SessionUpstreamLinkInput,
} from "./session-upstream-links.kernel.js";

/** Host-owned fork assertion; its source is checked in the committing transaction. */
export type SessionUpstreamLinkCurrentCheck = {
  context: OpenClawStateWorkerContext;
  expected: SessionUpstreamLink;
  withCurrent<T>(run: () => T): T;
};

export type SessionUpstreamSettlement =
  | { kind: "missing" }
  | { kind: "activity"; marker: SessionUpstreamJsonValue; now: number };

export type SessionUpstreamWorkerOperations = {
  "sessionUpstream.upsert": {
    input: {
      link: SessionUpstreamLinkInput;
      now: number;
      ifAbsent?: true;
      source?: SessionUpstreamLink;
    };
    output: boolean;
  };
  "sessionUpstream.delete": {
    input: { sessionKey: string; agentId: string; expected?: SessionUpstreamLink };
    output: "deleted" | "absent" | "changed";
  };
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
