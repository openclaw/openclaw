import type { DatabaseFileIdentity } from "../../infra/sqlite-worker-identity.js";
import type { SessionEntrySummary } from "./session-accessor.types.js";

export type SessionStoreProjectionWorkerInput = {
  kind: "session-store-projection";
  database: { agentId: string; path: string };
  env: NodeJS.ProcessEnv;
  expectedIdentity: DatabaseFileIdentity;
};

export type SessionStoreProjectionWorkerResult = {
  kind: "session-store-projection";
  entries: SessionEntrySummary[];
  source?: { identity: string; birthtime?: string; filename: string };
};
