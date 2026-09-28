import type { GatewayClient } from "./server-methods/client-types.js";

type QuestionSessionCurrentRead = {
  readonly target: {
    agentId: string;
    canonicalKey: string;
    storePath: string;
    entry: {
      sessionId: string;
      lifecycleRevision?: string;
      incognito?: boolean;
    };
  } | null;
  readonly read: {
    database: { path: string };
    result: {
      databaseIdentity?: { identity: string; birthtime?: string };
    };
  };
  assertCurrent: () => void;
};

/** Original source and database generation survive until the manager retires this entry. */
export type QuestionSessionAccess = {
  readonly agentId: string;
  readonly sessionKey: string;
  /** Pure original-person selection, before session reads or liveness transitions. */
  canSelect: (client: GatewayClient | null) => boolean;
  assertSourceCurrent: () => void;
  assertCurrent: (read: QuestionSessionCurrentRead) => void;
  release: () => void;
};
