import type { AgentDatabaseAdmissionRefusal } from "./agent-database-admission.js";
import type { AgentDatabaseStartupVerifier } from "./agent-database-startup-integrity.js";
import type { AgentSchemaInspection } from "./openclaw-agent-schema-inspection.js";
import type { OpenClawDatabaseSchemaPreflight } from "./openclaw-database-preflight.types.js";

export type PendingAgentDatabaseInspection = {
  target: { agentId?: string; path: string };
  result: Promise<OpenClawDatabaseSchemaPreflight>;
};
export type AgentRestartInputRecovery = {
  run: () => Promise<void>;
  sessions: ReadonlyMap<string, Promise<void>>;
};
type AgentDatabaseStartupPreparationInput = {
  agentId: string;
  paths: readonly string[];
  env: NodeJS.ProcessEnv;
  signal: AbortSignal;
  assertCurrent: () => void;
  phase: (name: "secrets" | "models") => void;
};
export type AgentDatabaseStartupActivation = {
  isCurrent: () => boolean;
  preparationReady: Promise<void>;
  openAgent: (input: AgentDatabaseStartupPreparationInput) => Promise<AsyncDisposable | void>;
  migrateAgent: (input: AgentDatabaseStartupPreparationInput) => Promise<void | {
    maintain?: () => Promise<void>;
    recoverInputs?: AgentRestartInputRecovery;
  }>;
  /** Admission may fail after publication; its publisher owns withdrawal of retained inputs. */
  publishAgent: (input: AgentDatabaseStartupPreparationInput) => Promise<void | (() => void)>;
  captureReadAdmission?: (input: AgentDatabaseStartupPreparationInput) => () => void;
  /** The Gateway owns full verification after bounded current-schema admission. */
  verifyIntegrity?: AgentDatabaseStartupVerifier;
};
export type AgentDatabaseStartupPreparationPhase =
  | "inspection"
  | "activation"
  | "readiness"
  | "open-wait"
  | "open"
  | "migration-wait"
  | "migration"
  | "publication-wait"
  | "secrets"
  | "models"
  | "publication"
  | "input-recovery";
export type PendingAgentDatabaseRecovery = {
  refusal: AgentDatabaseAdmissionRefusal;
  completion: Promise<void>;
  readReady?: Promise<void>;
  startedAt: number;
  phase: AgentDatabaseStartupPreparationPhase;
  phaseStartedAt: number;
  phaseDurationsMs: Partial<Record<AgentDatabaseStartupPreparationPhase, number>>;
};

export type PreparedSchemaHeader = Pick<
  AgentSchemaInspection,
  "version" | "writerAppVersion" | "agentSchemaMeta"
>;
export type PreparedSchemaHeaders = {
  statePath: string;
  headers: Map<string, PreparedSchemaHeader>;
  state?: { identity: string; schemaAdmissionId: string };
};
