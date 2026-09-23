import type { OpenClawAgentDatabaseIdentity } from "../../state/openclaw-agent-db-identity.js";
import type { SqliteSessionGenerationClaim } from "./session-accessor.sqlite-generation.types.js";
import type { SessionEntry } from "./types.js";

export type LegacyMainSessionMigrationMode = "detect" | "doctor-fix";

type LegacyMainSessionMigrationOutcomeKind =
  | "not-armed"
  | "no-legacy-rows"
  | "migrated-in-place"
  | "migrated-cross-store"
  | "canonical-exists-identical"
  | "divergent-canonical"
  | "divergent-aliases"
  | "legacy-json-store"
  | "store-unreadable";

export type LegacyMainSessionMigrationOutcome = {
  kind: LegacyMainSessionMigrationOutcomeKind;
  canonicalKey?: string;
  detail?: string;
  paths?: string[];
  quarantinedKeys?: string[];
  resolved?: true;
  sourceKeys?: string[];
};

export type LegacyMainSessionMigrationResult = {
  armed: boolean;
  changes: string[];
  complete: boolean;
  /** The current owner, main key, and physical source layout have a completed doctor ledger. */
  ledgerComplete: boolean;
  legacyAgentId: string;
  mainKey: string;
  outcomes: LegacyMainSessionMigrationOutcome[];
  ownerAgentId?: string;
  warnings: string[];
};

export type PhysicalStore = {
  databaseAgentId: string;
  ownerStorePath: string;
  path: string;
};

export type SessionClaim = {
  canonicalKey: string;
  databaseIdentity: OpenClawAgentDatabaseIdentity;
  entry: SessionEntry;
  generations: SqliteSessionGenerationClaim[];
  key: string;
  nodeArtifactFingerprint: string;
  store: PhysicalStore;
};
