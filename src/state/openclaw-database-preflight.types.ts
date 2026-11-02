import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { SqliteSchemaIssue } from "../infra/sqlite-schema-contract.js";
import type { PreparedAgentDatabaseMigrationDiscovery } from "../infra/state-migrations.media-persistence-targets.js";
import type { AgentDatabaseAdmissionRefusal } from "./agent-database-admission.js";
import type { OpenClawSchemaVersions } from "./openclaw-schema-versions.js";
import type { OpenClawStateSchemaReadAdmission } from "./openclaw-state-db-contract.js";
import type { OpenClawExternalStateOwnership } from "./openclaw-state-ownership.js";

export type AgentDatabasePreflightStats = {
  schemaProcessCount: number;
  schemaInspectionCount: number;
  schemaSnapshotCount: number;
};

export type IncompatibleOpenClawDatabase = {
  kind: "agent" | "state";
  path: string;
  agentId?: string;
  foundVersion: number;
  supportedVersion: number;
  writerAppVersion?: string;
};

export type IndeterminateOpenClawDatabase = {
  kind: "agent" | "state";
  path: string;
  reason: string;
  agentId?: string;
};

export type DeferredStateSchemaPublication = {
  kind: "state";
  path: string;
  foundVersion: number;
  contentVersion: number;
  runId?: string;
  publishAfterMs?: number | null;
  message: string;
};

export type OpenClawDatabaseSchemaPreflight = {
  incompatible: IncompatibleOpenClawDatabase[];
  indeterminate: IndeterminateOpenClawDatabase[];
  agentRefusals?: AgentDatabaseAdmissionRefusal[];
  pendingMigrations?: Omit<IncompatibleOpenClawDatabase, "writerAppVersion">[];
  deferredSchemaPublications?: DeferredStateSchemaPublication[];
};

export type OpenClawStateSchemaPreflightResult = {
  databasePath: string;
  foundVersion: number | null;
  contentVersion?: number;
  deferredPublication?: DeferredStateSchemaPublication;
  issues: SqliteSchemaIssue[];
  ownership: OpenClawExternalStateOwnership | null;
  reason?: string;
  requiresWrite: boolean;
  schema: "openclaw.state-schema-preflight.v1";
  status: "exact" | "startup-repairable" | "migration-required" | "incompatible" | "indeterminate";
  targetVersion: number;
};

export type OpenClawAgentSchemaPreflightResult = Omit<
  OpenClawStateSchemaPreflightResult,
  "schema" | "ownership" | "status"
> & {
  schema: "openclaw.agent-schema-preflight.v1";
  agentId: string;
  status: "exact" | "incompatible" | "indeterminate";
};

export type OpenClawDatabaseSchemaPreflightOperation =
  | "doctor"
  | "gateway-restart"
  | "gateway-startup";

export type OpenClawDatabasePreflightOptions = {
  env: NodeJS.ProcessEnv;
  onAgentDatabaseDiscovery?: (prepared: PreparedAgentDatabaseMigrationDiscovery) => void;
  onAgentInspection?: (stats: AgentDatabasePreflightStats) => void;
  scope?: "state";
  signal?: AbortSignal;
  /** Omit for current-runtime checks; updates pass their complete target pair. */
  supportedVersions?: OpenClawSchemaVersions;
  verifyCurrentSchemaShape?: boolean;
  requireStartupMigrationReadiness?: boolean;
  /** Consume this startup owner's unchanged compatibility headers once, never readiness proof. */
  reuseStartupSchemaPreparation?: boolean;
  configuredAgentDatabaseTargets?:
    | readonly { agentId: string; path: string }[]
    | ((
        registeredDatabases: readonly { agentId: string; path: string }[],
      ) => readonly { agentId: string; path: string }[]);
  configuredAgentDatabaseCandidatePaths?: readonly string[];
  agentAdmissionConfig?: OpenClawConfig;
  openStateSchemaReadAdmission?: OpenClawStateSchemaReadAdmission;
};
