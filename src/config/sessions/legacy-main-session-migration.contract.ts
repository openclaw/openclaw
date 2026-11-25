import type { OpenClawAgentDatabaseIdentity } from "../../state/openclaw-agent-db-identity.js";
import type {
  SqliteSessionGenerationClaim,
  SqliteSessionGenerationComparison,
} from "./session-accessor.sqlite-generation.types.js";
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

export type SessionComparisonClaim = {
  canonicalKey: string;
  entry: SessionEntry;
  generations: SqliteSessionGenerationComparison[];
  key: string;
  store: PhysicalStore;
};

export type SessionClaim = Omit<SessionComparisonClaim, "generations"> & {
  databaseIdentity: OpenClawAgentDatabaseIdentity;
  generations: SqliteSessionGenerationClaim[];
  nodeArtifactFingerprint: string;
};
