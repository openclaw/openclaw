import type { DatabaseSync } from "node:sqlite";
import type { McpOAuthReadOnlyOperations } from "../agents/mcp-oauth-store.kernel.js";
import type { FleetCellRecord } from "../fleet/registry.types.js";
import type { SqliteWorkerStateContext } from "../infra/sqlite-worker-state-context.js";
import type { AsyncWorkScope } from "../shared/async-work-scope.js";
import type { OnboardingRecommendationsRecord } from "./onboarding-recommendations.contract.js";
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
  | { type: "onboardingRecommendations.read"; configKey: string }
  | { type: "fleet.list" }
  | { type: "fleet.get"; tenantId: string }
  | {
      [Kind in keyof McpOAuthReadOnlyOperations]: {
        type: Kind;
        input: McpOAuthReadOnlyOperations[Kind]["input"];
      };
    }[keyof McpOAuthReadOnlyOperations];
export type OpenClawStateReadRequest = {
  context: SqliteWorkerStateContext;
  databasePath: string;
  location: string;
  checkFreshAdmission: boolean;
  command: OpenClawStateReadCommand | { type: "admit" };
};
export type OpenClawStateReadReply =
  | { ok: true; type: "admit" }
  | {
      ok: true;
      type: "onboardingRecommendations.read";
      sourceAdmitted: true;
      record: OnboardingRecommendationsRecord | null;
    }
  | { ok: true; type: "fleet.list"; sourceAdmitted: true; cells: FleetCellRecord[] }
  | { ok: true; type: "fleet.get"; sourceAdmitted: true; cell: FleetCellRecord | undefined }
  | {
      [Kind in keyof McpOAuthReadOnlyOperations]: {
        ok: true;
        type: Kind;
        sourceAdmitted: true;
        value: McpOAuthReadOnlyOperations[Kind]["output"];
      };
    }[keyof McpOAuthReadOnlyOperations]
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
