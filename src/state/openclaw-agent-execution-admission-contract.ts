import type {
  SqliteWorkerAdmissionFactory,
  SqliteWorkerAdmissionRequest,
} from "../infra/sqlite-worker-operation-admission.js";
import type { AgentDatabaseRegistryChange } from "./openclaw-agent-db-contract.js";

/** A borrowed native generation, never a file locator that can adopt a later open. */
export type AgentDatabaseGenerationClaim = {
  readonly identity: string;
  readonly incarnation: string;
  assertCurrent(): void;
};

/** A request owner composes its retained admission with the native owner's validation. */
export type AgentDatabaseRequestExecutionSource = {
  assertCurrent(): void;
  onRegistryChange?: (change: AgentDatabaseRegistryChange) => void;
  createAdmission(params: {
    attachment: { kind: "agent-execution"; startupJournal: boolean };
    nativeLocations: readonly string[];
    authorize(request: SqliteWorkerAdmissionRequest): void;
    assertCurrent(): void;
  }): SqliteWorkerAdmissionFactory;
};

export type OpenClawAgentDatabaseAdmissionExecution = {
  readonly agentId: string;
  readonly path: string;
  assertCurrent(): void;
  captureGenerationClaim(): AgentDatabaseGenerationClaim;
  /** Reuse native preparation; host handle admission explicitly requests current schema proof. */
  prepare(
    source: AgentDatabaseRequestExecutionSource,
    signal?: AbortSignal,
    options?: { readmitSchema: true },
  ): Promise<void>;
};
