import type { DatabaseFileIdentity } from "../../infra/sqlite-worker-identity.js";
import type {
  PhysicalStore,
  SessionComparisonClaim,
} from "./legacy-main-session-migration.contract.js";

export type SessionRetirementReadOperation =
  | { operation: "keys"; ordered?: true }
  | {
      operation: "comparison-claims";
      store: PhysicalStore;
      keys: Array<{ key: string; canonicalKey: string }>;
    };

export type SessionRetirementReadWorkerInput = {
  kind: "session-retirement-read";
  database: { agentId: string; path: string };
  env: NodeJS.ProcessEnv;
  expectedIdentity: DatabaseFileIdentity;
  request: SessionRetirementReadOperation;
};

export type SessionRetirementReadResult =
  | { operation: "keys"; keys: string[] }
  | { operation: "comparison-claims"; claims: SessionComparisonClaim[] };
