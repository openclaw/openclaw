import type { DatabaseSync } from "node:sqlite";
import type { FleetCellRecord } from "../fleet/registry.types.js";
import type { readExecApprovalsConfigRow } from "../infra/exec-approvals-sqlite.js";
import type { SqliteWorkerStateContext } from "../infra/sqlite-worker-state-context.js";
import type { AsyncWorkScope } from "../shared/async-work-scope.js";
import type { OpenClawStateWorkerContext } from "./openclaw-state-worker-context.types.js";
import type { OpenClawStateWorkerErrorPayload } from "./openclaw-state-worker-error.js";

export type OpenClawStateReadLocation = {
  context: OpenClawStateWorkerContext;
  location: string;
  checkFreshAdmission: boolean;
  expectedIdentity?: string;
};

export type OpenClawStateReadAuthority = {
  signal: AbortSignal;
  assertCurrent(this: void): void;
};

export type OpenClawStateReadCommand =
  | { type: "exec-approvals.read" }
  | { type: "fleet.list" }
  | { type: "fleet.get"; tenantId: string };
export type OpenClawStateReadRequest = {
  context: SqliteWorkerStateContext;
  databasePath: string;
  location: string;
  checkFreshAdmission: boolean;
  expectedIdentity?: string;
  command: OpenClawStateReadCommand | { type: "admit" };
};
export type OpenClawStateReadReply =
  | { ok: true; type: "admit" }
  | {
      ok: true;
      type: "exec-approvals.read";
      sourceAdmitted: true;
      row: ReturnType<typeof readExecApprovalsConfigRow>;
    }
  | { ok: true; type: "fleet.list"; sourceAdmitted: true; cells: FleetCellRecord[] }
  | { ok: true; type: "fleet.get"; sourceAdmitted: true; cell: FleetCellRecord | undefined }
  | {
      ok: false;
      sourceAdmitted?: true;
      message: string;
      error: OpenClawStateWorkerErrorPayload | undefined;
    };

export type OpenClawStateReadOutcome =
  | { value: Extract<OpenClawStateReadReply, { ok: true }> }
  | { error: unknown; sourceAdmitted?: true };

export type ReadResource = { close(): Promise<void> };
export type RetainedReadScope = {
  path: string;
  active: boolean;
  work: AsyncWorkScope;
  resources: Set<ReadResource>;
  close(): Promise<void>;
};

export type OpenClawStateReadOnlyDatabase = {
  db: DatabaseSync;
  path: string;
};
