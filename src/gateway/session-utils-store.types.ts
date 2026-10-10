import type { SessionLifecycleTimestamps } from "../config/sessions/lifecycle.types.js";
import type {
  CapturedSessionEntryReadSource,
  SessionEntryReadSource,
} from "../config/sessions/session-entry-read-source.types.js";
import type { SessionStoreReadCandidate } from "../config/sessions/session-store-read-candidates.js";
import type { InternalSessionEntry } from "../config/sessions/types.js";
import type { OpenClawRegisteredAgentDatabase } from "../state/openclaw-agent-db-contract.js";

export type GatewaySessionStoreTarget = {
  agentId: string;
  storePath: string;
  canonicalKey: string;
  storeKeys: string[];
};

export type GatewaySessionStoreTargetWithStore = GatewaySessionStoreTarget & {
  canonicalValidationError?: Error;
  store: Record<string, InternalSessionEntry>;
  readSource?: SessionEntryReadSource;
  capturedReadSource?: CapturedSessionEntryReadSource;
  capturedReadSources?: CapturedSessionEntryReadSource[];
  lifecycleTimestamps?: SessionLifecycleTimestamps;
};

export type GatewaySessionStoreReadSources = Record<string, readonly SessionEntryReadSource[]>;

export type GatewaySessionStoreSourceRequest = {
  routing: {
    agentIds: string[];
    store?: string;
    compatibilityAgentId: string;
  };
  currentSource: SessionEntryReadSource;
  env: NodeJS.ProcessEnv;
  registeredDatabases: readonly Pick<
    OpenClawRegisteredAgentDatabase,
    "agentId" | "path" | "schemaVersion"
  >[];
  candidates?: readonly SessionStoreReadCandidate[];
};
