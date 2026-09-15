import type { DatabaseSync } from "node:sqlite";
import type { McpOAuthReadOnlyOperations } from "../agents/mcp-oauth-store.kernel.js";
import type { FleetCellRecord } from "../fleet/registry.types.js";
import type { SqliteWorkerStateContext } from "../infra/sqlite-worker-state-context.js";
import type { AsyncWorkScope } from "../shared/async-work-scope.js";
import type { SkillLibraryReadOnlyOperations } from "../skills/library/selection-read.kernel.js";
import type { OpenClawStateWorkerContext } from "./openclaw-state-worker-context.types.js";
import type { OpenClawStateWorkerErrorPayload } from "./openclaw-state-worker-error.js";

export type OpenClawStateReadLocation = {
  context: OpenClawStateWorkerContext;
  location: string;
  checkFreshAdmission: boolean;
};

export type OpenClawStateReadAuthority = {
  signal: AbortSignal;
  assertCurrent(this: void): void;
};

type OpenClawStateReadOperations = McpOAuthReadOnlyOperations & SkillLibraryReadOnlyOperations;

export type OpenClawStateReadCommand =
  | { type: "fleet.list" }
  | { type: "fleet.get"; tenantId: string }
  | {
      [Kind in keyof OpenClawStateReadOperations]: {
        type: Kind;
        input: OpenClawStateReadOperations[Kind]["input"];
      };
    }[keyof OpenClawStateReadOperations];
export type OpenClawStateReadRequest = {
  context: SqliteWorkerStateContext;
  databasePath: string;
  location: string;
  checkFreshAdmission: boolean;
  command: OpenClawStateReadCommand | { type: "admit" };
};
export type OpenClawStateReadReply =
  | { ok: true; type: "admit" }
  | { ok: true; type: "fleet.list"; sourceAdmitted: true; cells: FleetCellRecord[] }
  | { ok: true; type: "fleet.get"; sourceAdmitted: true; cell: FleetCellRecord | undefined }
  | {
      [Kind in keyof OpenClawStateReadOperations]: {
        ok: true;
        type: Kind;
        sourceAdmitted: true;
        value: OpenClawStateReadOperations[Kind]["output"];
      };
    }[keyof OpenClawStateReadOperations]
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

export type OpenClawStateReadCaller = {
  context: OpenClawStateWorkerContext;
  signal?: AbortSignal;
  assertCurrent?: () => void;
};
