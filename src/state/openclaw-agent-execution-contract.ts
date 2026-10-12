import type { SessionActorOperations } from "../config/sessions/session-actor-contract.js";
import type {
  SqliteWalPeriodicRequest,
  SqliteWalPeriodicResult,
} from "../infra/sqlite-wal-write-admission.js";
import type { SqliteWorkerStore } from "../infra/sqlite-worker-contract.js";
import type { DatabasePathIdentity } from "../infra/sqlite-worker-identity.js";
import type { SqliteWorkerStateContext } from "../infra/sqlite-worker-state-context.js";
import type { AgentCreationClaimWitness } from "./agent-creation-claim.js";
import type { OpenClawAgentDatabase } from "./openclaw-agent-db-contract.js";
import type {
  AgentDatabaseGenerationClaim,
  AgentDatabaseRequestExecutionSource,
  OpenClawAgentDatabaseAdmissionExecution,
} from "./openclaw-agent-execution-admission-contract.js";
import type { AgentDatabaseDomainOperations } from "./openclaw-agent-execution-domain.js";
import type {
  AgentDatabaseExecutionFileIdentity,
  AgentDatabaseIncognitoIdentity,
} from "./openclaw-agent-execution-identity.types.js";
import type { RegisteredAgentWorkerOperations } from "./openclaw-agent-execution-operations.js";

export type {
  AgentDatabaseFileExecutionIdentity,
  AgentDatabaseExecutionFileIdentity,
  AgentDatabaseIncognitoIdentity,
} from "./openclaw-agent-execution-identity.types.js";

export type AgentDatabaseNativeStore = SqliteWorkerStore<AgentDatabaseOperations>;
export type AgentDatabaseExecutionScope = Pick<AgentDatabaseNativeStore, "execute">;

export type OpenClawAgentDatabaseExecution = OpenClawAgentDatabaseAdmissionExecution & {
  /** The accepted native receipt; reading this never adopts the current pathname. */
  readonly fileIdentity: AgentDatabaseExecutionFileIdentity | undefined;
  /** Accept the admitted native handle used by a synchronous SDK operation. */
  adoptNativeDatabase(database: OpenClawAgentDatabase): Promise<void>;
  /** Reuse only a native generation whose preparation and registration publication settled. */
  capturePreparedGenerationClaim(): AgentDatabaseGenerationClaim | undefined;
  /** Admit a write against existing storage; a missing store remains missing. */
  runExisting<T>(
    source: AgentDatabaseRequestExecutionSource,
    operation: (scope: AgentDatabaseExecutionScope) => Promise<T>,
    options?:
      | { retireNativeOnFailure: true; withAdmission?: never }
      | {
          retireNativeOnFailure?: never;
          /** Track read admission; cancellation removes only a waiting host-queue task. */
          withAdmission: <Result>(
            run: () => Promise<Result>,
            signal: AbortSignal,
          ) => Promise<Result>;
        },
  ): Promise<T | undefined>;
  /**
   * Join this reference's work; native cleanup failures remain with its resource owner.
   * The owner may retain one bounded idle generation.
   */
  release(): Promise<void>;
};

export type AgentDatabaseFileExecutionOwner = {
  readonly kind: "file";
  readonly agentId: string;
  readonly sharedDatabaseKey: string;
  readonly creationIdentity?: DatabasePathIdentity;
  borrow(
    pathname: string,
    expectedIdentity?: AgentDatabaseExecutionFileIdentity,
    expectedCreationIdentity?: DatabasePathIdentity,
    requestedPath?: string,
  ): OpenClawAgentDatabaseExecution;
  closeIdle(): Promise<void>;
  retireForCleanup(): Promise<void>;
  close(): Promise<void>;
};

export type AgentDatabaseNativeGeneration = {
  failure(): "open-refused" | "native" | undefined;
  isPrepared(): boolean;
  captureClaim(): AgentDatabaseGenerationClaim;
  run<T>(
    source: AgentDatabaseRequestExecutionSource,
    operation: (scope: AgentDatabaseExecutionScope) => Promise<T>,
    assertCallerCurrent?: (identity?: AgentDatabaseExecutionFileIdentity) => void,
    createIfMissing?: boolean,
    signal?: AbortSignal,
    readmitSchema?: boolean,
  ): Promise<T | undefined>;
  close(): Promise<void>;
};

export type AgentDatabaseFileExecutionOpen = {
  kind?: "file";
  leaseId: string;
  agentId: string;
  databasePath: string;
  stateDatabasePath: string;
  environment: SqliteWorkerStateContext["environment"];
  expectedIdentity?: AgentDatabaseExecutionFileIdentity;
  /** Captured before a creating request yields; absence is an identity too. */
  creatingIdentity?: DatabasePathIdentity;
  creationClaim?: AgentCreationClaimWitness;
};

export type AgentDatabaseIncognitoOpen = {
  kind: "ephemeral";
  identity: AgentDatabaseIncognitoIdentity;
  agentId: string;
  databasePath: string;
  environment: SqliteWorkerStateContext["environment"];
};

export type AgentDatabaseExecutionOpen =
  | AgentDatabaseFileExecutionOpen
  | AgentDatabaseIncognitoOpen;

export type AgentDatabaseIncognitoAuthority = { assertCurrent(): void };

export type AgentDatabaseOperations = AgentDatabaseDomainOperations &
  SessionActorOperations &
  RegisteredAgentWorkerOperations & {
    "database.walMaintenance": { input: SqliteWalPeriodicRequest; output: SqliteWalPeriodicResult };
    "database.prepareWrite": { input: undefined; output: void };
    "database.recordIntegrity": { input: undefined; output: boolean };
  };
