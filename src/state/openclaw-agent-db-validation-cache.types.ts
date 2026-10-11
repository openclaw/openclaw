import type { DatabaseSync } from "node:sqlite";
import type { OpenClawAgentDatabaseValidation } from "./openclaw-agent-db-validation-facts.js";

export type ValidationDatabase = { db: DatabaseSync; path: string; agentId: string };
export type CanonicalValidationDatabase = { db: DatabaseSync; path?: string; agentId: string };
export type ValidationEntry = {
  agentId?: string;
  validation?: OpenClawAgentDatabaseValidation;
  integrityVerified: boolean;
  revoked?: true;
};

export type ValidationLifetimeBinding = {
  validation: OpenClawAgentDatabaseValidation;
  unregister: () => void;
};
