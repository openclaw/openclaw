import type { SessionEntry } from "../config/sessions/types.js";
import type { GatewayClient } from "./server-methods/client-types.js";

/** Current caller and session facts supplied by the question access owner. */
export type QuestionClientAuthorization = (
  client: GatewayClient | null,
  target?: { agentId: string; canonicalKey: string; entry: SessionEntry } | null,
) => boolean;

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

/** Plain generation binding; correlation never substitutes for current caller authorization. */
export type DurableQuestionSessionBinding = {
  agentId: string;
  sessionKey: string;
  storePath: string;
  databasePath: string;
  databaseIdentity: { identity: string; birthtime?: string };
  sessionId: string;
  lifecycleRevision: string;
  profileId?: string;
};

/** Original source and database generation survive until the manager retires this entry. */
export type QuestionSessionAccess = {
  readonly agentId: string;
  readonly sessionKey: string;
  readonly durableBinding?: DurableQuestionSessionBinding;
  /** Native durable custody requires its exact conversation at every publication boundary. */
  readonly durableCustody?: true;
  /** Pure original-person selection, before session reads or liveness transitions. */
  canSelect: (client: GatewayClient | null) => boolean;
  assertSourceCurrent: () => void;
  assertCurrent: (read: QuestionSessionCurrentRead) => void;
  release: () => void;
};
