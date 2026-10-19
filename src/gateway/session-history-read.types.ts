import type { SessionTranscriptReadTarget } from "../config/sessions/session-accessor.types.js";
import type { SqliteWorkerStateContext } from "../infra/sqlite-worker-state-context.js";
import type {
  GatewaySessionStoreReadSources,
  GatewaySessionStoreSourceRequest,
} from "./session-utils-store.types.js";

/** Serializable host bindings; no open handle, ambient config, or secrets cross isolates. */
export type PreparedSessionHistoryReadTarget = {
  transcript: SessionTranscriptReadTarget & { agentId: string; sessionFile: string };
  database: { agentId: string; path: string };
  stateDatabase?: SqliteWorkerStateContext & { path: string };
  sourceDatabases?: GatewaySessionStoreReadSources;
  sourceDiscovery?: GatewaySessionStoreSourceRequest;
  entryValidationKey?: string;
};
