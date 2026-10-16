import type { SessionActor } from "./session-entry-provenance.js";
import type { InternalSessionEntry, SessionEntry } from "./types.js";

export type RestartTombstoneRecoveryResult =
  | {
      status: "created" | "existing";
      sourceEntry: SessionEntry;
      successorEntry: SessionEntry;
      successorKey: string;
    }
  | {
      status: "conflict";
      reason:
        | "not-tombstoned"
        | "source-changed"
        | "successor-missing"
        | "target-exists"
        | "transcript-missing";
    };

export type RestartTombstoneRecoveryParams = {
  agentId: string;
  archivedBy?: SessionActor;
  expected: {
    cycleId: string;
    lifecycleRevision?: string;
    pluginOwnerId?: string;
    revision: number;
    sessionId: string;
  };
  commitGuard?: () => void;
  sourceTarget: { canonicalKey: string; storeKeys: readonly string[] };
  storePath: string;
  successorEntry: InternalSessionEntry & { sessionId: string };
  successorTarget: { canonicalKey: string; storeKeys: readonly string[] };
};

export type RestartTombstoneRecoveryInput = Omit<
  RestartTombstoneRecoveryParams,
  "commitGuard" | "storePath"
>;
