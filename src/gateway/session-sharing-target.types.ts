import type { SessionEntryCreationOperation } from "../config/sessions/session-accessor.sqlite-entry-cache.types.js";
import type { CapturedSessionEntryReadSource } from "../config/sessions/session-entry-read-source.types.js";
import type { SessionExactEntriesWorkerResult } from "../config/sessions/session-entry-read.types.js";
import type { SessionEntry } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { AgentDatabaseRegistryChange } from "../state/openclaw-agent-db-contract.js";
import type { GatewaySessionStoreTarget } from "./session-utils-store.types.js";

export type SessionSharingTarget = {
  agentId: string;
  canonicalKey: string;
  entry: SessionEntry;
  storeKey: string;
  storeKeys: string[];
  storePath: string;
  /** Physical source selected by the store reader, independent of its configured locator. */
  readSource?: CapturedSessionEntryReadSource;
};

export type PreparedSessionMutationFacts = {
  target: SessionSharingTarget | null;
  membership: ReadonlySet<string>;
};

export type PreparedSessionSourceFacts = PreparedSessionMutationFacts & {
  /** Physical source retained by the same read custody as the sharing facts. */
  sourcePath?: string;
  sourceAgentId?: string;
  readSource?: CapturedSessionEntryReadSource;
};

export type ExistingSessionMutationFacts = PreparedSessionSourceFacts & {
  target: NonNullable<PreparedSessionMutationFacts["target"]>;
};

export type SessionFactsRequest = {
  cfg: OpenClawConfig;
  sessionKey: string;
  agentId: string;
  followLifecycle?: boolean;
  followTranscript?: boolean;
  sessionAccessOnly?: boolean;
  preserveQualifiedAddress?: boolean;
  storageReady?: Promise<void>;
};
export type SessionFactsRead<Facts extends PreparedSessionMutationFacts> = {
  readonly storageTarget: Pick<GatewaySessionStoreTarget, "agentId" | "canonicalKey" | "storePath">;
  bindCreation(this: void, operation: SessionEntryCreationOperation): void;
  followRegistration?(this: void, change: AgentDatabaseRegistryChange): void;
  prepareRead(this: void): Promise<void> | undefined;
  readCurrent(this: void, cfg: OpenClawConfig): Facts;
  release(this: void): void;
};

export type PreparedSessionSharingSource = {
  facts: NonNullable<SessionExactEntriesWorkerResult["sharing"]>;
  source: CapturedSessionEntryReadSource;
};
