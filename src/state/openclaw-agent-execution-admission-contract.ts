import type { WorkspaceFilesystemEvidence } from "../agents/workspace-state-guard.js";
import type { SessionStoreReadCustody } from "../config/sessions/session-store-read-candidates.js";
import type { SqliteWorkerExecutionAuthority } from "../infra/sqlite-worker-contract.js";
import type {
  SqliteWorkerAdmissionFactory,
  SqliteWorkerAdmissionRequest,
} from "../infra/sqlite-worker-operation-admission.js";
import type { AgentDatabaseRegistryChange } from "./openclaw-agent-db-contract.js";

/** A borrowed native generation, never a file locator that can adopt a later open. */
export type AgentDatabaseGenerationClaim = {
  readonly identity: string;
  readonly incarnation: string;
  readonly authority: SqliteWorkerExecutionAuthority;
  assertCurrent(): void;
};

/** A request owner composes its retained admission with the native owner's validation. */
export type AgentDatabaseRequestExecutionSource = {
  readCustody?: readonly SessionStoreReadCustody[];
  workspaceEvidence?: readonly WorkspaceFilesystemEvidence[];
  assertCurrent(): void;
  onRegistryChange?: (change: AgentDatabaseRegistryChange) => void;
  createAdmission(params: {
    attachment: {
      kind: "agent-execution";
      startupJournal: boolean;
      startupIntegrityRequired: boolean;
      readCustody?: readonly SessionStoreReadCustody[];
      workspaceEvidence?: readonly WorkspaceFilesystemEvidence[];
    };
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
  /** Reuse the native owner's published preparation and schema proof. */
  prepare(source: AgentDatabaseRequestExecutionSource, signal?: AbortSignal): Promise<void>;
};
