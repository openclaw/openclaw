import type { MessagePort } from "node:worker_threads";
import type {
  RetainedWorkerTransactionAdmission,
  SqliteWorkerNativeSettlementOwner,
} from "./sqlite-worker-operation-settlement.js";

export type SqliteWorkerAdmissionRequest = {
  stage: "open" | "prepare" | "transaction" | "commit";
  facts: unknown;
  /** Opt-in wait budget in milliseconds; omission retains the live-owner wait. */
  deadlineMs?: number;
};

export type AdmissionFailureSource = "authority" | "domain" | "protocol";
export type DatabaseAuthority = {
  databasePath: string;
  assertRequest?(): void;
  assertAccess(): void;
  assertCreate?(databasePath: string): void;
  acquireSchema(): { assertCurrent(): void; release(): void };
};

export type SqliteWorkerOperationAdmission = SqliteWorkerNativeSettlementOwner & {
  readonly port: MessagePort;
  readonly failure: unknown;
  readonly failureSource: AdmissionFailureSource | undefined;
  readonly cleanupFailures: readonly unknown[];
  observeRequests(observer: (request: SqliteWorkerAdmissionRequest) => void): void;
  service(): void;
  finish(): void;
  bindDatabaseAuthority(authority: DatabaseAuthority): void;
};

export type SqliteWorkerAdmissionFactory = (operation: RetainedWorkerTransactionAdmission) => {
  admission: SqliteWorkerOperationAdmission;
  nativeLocations: readonly string[];
};

export type CommitObserver = (committed: { facts: unknown }) => void;
export type AdmissionHandler = (
  request: SqliteWorkerAdmissionRequest,
  grant: (beforeRelease?: () => void) => boolean,
) => void;
