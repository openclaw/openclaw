import type { SessionsListResult } from "../../api/types.ts";
import type {
  SessionConnectionOwner,
  SessionGateway,
  SessionListScope,
  SessionState,
} from "./session-types.ts";

export type SessionListRefreshHost = {
  background: (key: string | object, task: () => Promise<unknown>) => Promise<void>;
  connection: SessionConnectionOwner;
  snapshot: () => SessionGateway["snapshot"];
  readState: () => SessionState;
  decorate: (
    result: SessionsListResult | null,
    owner: { scope: SessionListScope },
  ) => SessionsListResult | null;
  reconcileList: (
    result: SessionsListResult | null,
    issuedRevision: number,
    agentId?: string,
  ) => SessionsListResult | null;
};

export type SessionRosterRefreshHost = SessionListRefreshHost & {
  publish: (state: SessionState, errorSource?: "session-observer" | "operation" | "list") => void;
  onWarmListsRetired: (agentIds: ReadonlySet<string>) => void;
  observerError: () => string | null;
  onCanonicalList: (
    result: SessionsListResult | null,
    requestRevision: number,
    agentId?: string,
    observed?: SessionsListResult | null,
  ) => void;
};
