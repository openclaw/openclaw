import type { AgentDatabaseAdmissionRefusal } from "./agent-database-admission.js";
import type { OpenClawDatabaseSchemaPreflight } from "./openclaw-database-preflight.types.js";

export type PendingAgentDatabaseInspection = {
  target: { agentId?: string; path: string };
  result: Promise<OpenClawDatabaseSchemaPreflight>;
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
  migrateAgent: (
    input: AgentDatabaseStartupPreparationInput,
  ) => Promise<void | { maintain: () => Promise<void> }>;
  publishAgent: (input: AgentDatabaseStartupPreparationInput) => Promise<void>;
  captureReadAdmission?: (input: AgentDatabaseStartupPreparationInput) => () => void;
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
  | "publication";
export type PendingAgentDatabaseRecovery = {
  refusal: AgentDatabaseAdmissionRefusal;
  completion: Promise<void>;
  readReady?: Promise<void>;
  startedAt: number;
  phase: AgentDatabaseStartupPreparationPhase;
  phaseStartedAt: number;
  phaseDurationsMs: Partial<Record<AgentDatabaseStartupPreparationPhase, number>>;
};
