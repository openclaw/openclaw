import type {
  CapturedSessionEntryReadSource,
  SessionEntryReadSource,
} from "../config/sessions/session-accessor.types.js";
import type { InternalSessionEntry } from "../config/sessions/types.js";

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
};

export type GatewaySessionStoreReadSources = Record<string, readonly SessionEntryReadSource[]>;
