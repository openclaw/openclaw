import type { DatabaseSync } from "node:sqlite";
import type {
  SandboxBrowserRegistryEntry,
  SandboxRegistryEntry,
} from "../agents/sandbox/registry.types.js";
import type { FleetCellRecord } from "../fleet/registry.types.js";
import type { SqliteWorkerStateContext } from "../infra/sqlite-worker-state-context.js";
import type { AsyncWorkScope } from "../shared/async-work-scope.js";
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

export type OpenClawStateReadCommand =
  | { type: "fleet.list" }
  | { type: "fleet.get"; tenantId: string }
  | { type: "sandboxRegistry.list" }
  | { type: "sandboxRegistry.get"; containerName: string }
  | { type: "sandboxRegistry.runtimeIds"; backendId: string; scopeKey: string }
  | { type: "sandboxRegistry.browsers" };
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
      ok: true;
      type: "sandboxRegistry.list";
      sourceAdmitted: true;
      entries: SandboxRegistryEntry[];
    }
  | {
      ok: true;
      type: "sandboxRegistry.get";
      sourceAdmitted: true;
      entry: SandboxRegistryEntry | null;
    }
  | { ok: true; type: "sandboxRegistry.runtimeIds"; sourceAdmitted: true; runtimeIds: string[] }
  | {
      ok: true;
      type: "sandboxRegistry.browsers";
      sourceAdmitted: true;
      entries: SandboxBrowserRegistryEntry[];
    }
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
