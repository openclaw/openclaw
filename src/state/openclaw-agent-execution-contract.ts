import type {
  SqliteWalPeriodicRequest,
  SqliteWalPeriodicResult,
} from "../infra/sqlite-wal-write-admission.js";
import type { DatabasePathIdentity } from "../infra/sqlite-worker-identity.js";
import type {
  SqliteWorkerAdmissionFactory,
  SqliteWorkerAdmissionRequest,
} from "../infra/sqlite-worker-operation-admission.js";
import type { SqliteWorkerStateContext } from "../infra/sqlite-worker-state-context.js";
import type { AgentDatabaseRegistryChange } from "./openclaw-agent-db-registry-listing.js";
import type { AgentDatabaseDomainOperations } from "./openclaw-agent-execution-domain.js";
import type { RegisteredAgentWorkerOperations } from "./openclaw-agent-execution-operations.js";

/** Recorded by the native owner; a descriptor never grants access to that owner. */
export type AgentDatabaseFileExecutionIdentity = {
  kind: "file";
  physicalIdentity: string;
  birthtime?: string;
  incarnation: string;
  nativeLocation: string;
};

export type AgentDatabaseExecutionFileIdentity = Pick<
  AgentDatabaseFileExecutionIdentity,
  "kind" | "physicalIdentity" | "birthtime" | "nativeLocation"
>;

/** A borrowed native generation, never a file locator that can adopt a later open. */
export type AgentDatabaseGenerationClaim = {
  readonly identity: string;
  readonly incarnation: string;
  assertCurrent(): void;
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
};

/** Process-private locators; neither a handle nor its incarnation grants authority. */
export type AgentDatabaseIncognitoIdentity = Readonly<{
  kind: "ephemeral";
  handle: string;
  incarnation: string;
}>;

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

type AgentDatabaseIncognitoMemory = {
  agentId: string;
  /** SQLite page allocation only, excluding allocator, decoded results, and transport memory. */
  databaseBytes: number;
  pageCount: number;
  pageSize: number;
};

/** P1 deliberately admits no session-domain operation before its complete caller cutover. */
export type AgentDatabaseIncognitoOperations = {
  "database.incognito.memory": { input: undefined; output: AgentDatabaseIncognitoMemory };
};

export type AgentDatabaseIncognitoAuthority = { assertCurrent(): void };

export class IncognitoSessionEndedError extends Error {
  readonly code = "INCOGNITO_SESSION_ENDED";

  constructor(options?: ErrorOptions) {
    super("Incognito session ended. Create a new incognito session to continue.", options);
    this.name = "IncognitoSessionEndedError";
  }
}

export type AgentDatabaseOperations = AgentDatabaseDomainOperations &
  RegisteredAgentWorkerOperations & {
    "database.walMaintenance": { input: SqliteWalPeriodicRequest; output: SqliteWalPeriodicResult };
    "database.prepareWrite": { input: undefined; output: void };
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
