import type { DatabaseSync } from "node:sqlite";
import type { Selectable } from "kysely";
import type {
  SandboxBrowserRegistryEntry,
  SandboxRegistryEntry,
} from "../agents/sandbox/registry.types.js";
import type { WorkspaceStateSnapshot } from "../agents/workspace-state-store.kernel.js";
import type {
  ExecutionIdentityInspectionQuery,
  ExecutionIdentityInspectionOutcome,
} from "../audit/execution-identity-inspection.types.js";
import type { FleetCellRecord } from "../fleet/registry.types.js";
import type { readExecApprovalsConfigRow } from "../infra/exec-approvals-sqlite.js";
import type { SqliteWorkerStateContext } from "../infra/sqlite-worker-state-context.js";
import type {
  readUpdateRunRecord,
  readUpdateRuns,
  UpdateRunListInput,
} from "../infra/update-run-read.kernel.js";
import type {
  PluginBlobReadCommand,
  PluginBlobReadReply,
} from "../plugin-state/plugin-blob-worker-contract.js";
import type { AsyncWorkScope } from "../shared/async-work-scope.js";
import type { SkillLibraryReadOnlyOperations } from "../skills/library/selection-read.kernel.js";
import type { OnboardingRecommendationsRecord } from "./onboarding-recommendations.contract.js";
import type { OpenClawAgentDatabaseRegistryReadResult } from "./openclaw-agent-db-contract.js";
import type { ConfigMachineState } from "./openclaw-state-db.generated.js";
import type { OpenClawStateWorkerContext } from "./openclaw-state-worker-context.types.js";
import type { OpenClawStateWorkerErrorPayload } from "./openclaw-state-worker-error.js";
import type { ProfileDisplayRow } from "./user-profiles.types.js";

export type OpenClawStateReadLocation = {
  context: OpenClawStateWorkerContext;
  location: string;
  checkFreshAdmission: boolean;
  expectedIdentity?: string;
  snapshotRoot?: string;
};

export type OpenClawStateReadAuthority = {
  signal: AbortSignal;
  assertCurrent(this: void): void;
};

export type OpenClawStateReadCommand =
  | PluginBlobReadCommand
  | { type: "exec-approvals.read" }
  | {
      [Kind in keyof SkillLibraryReadOnlyOperations]: {
        type: Kind;
        input: SkillLibraryReadOnlyOperations[Kind]["input"];
      };
    }[keyof SkillLibraryReadOnlyOperations]
  | { type: "agentDatabaseRegistry.read" }
  | { type: "onboardingRecommendations.read"; configKey: string }
  | { type: "userProfiles.avatar.reconcile"; profileId: string }
  | { type: "audit.run.inspect"; input: ExecutionIdentityInspectionQuery }
  | { type: "updateRuns.get"; runId: string }
  | { type: "updateRuns.list"; input: UpdateRunListInput }
  | { type: "fleet.list" }
  | { type: "fleet.get"; tenantId: string }
  | { type: "nodeHost.config" }
  | { type: "workspace.snapshot"; workspaceDir: string }
  | { type: "sandboxRegistry.list" }
  | { type: "sandboxRegistry.get"; containerName: string }
  | { type: "sandboxRegistry.runtimeIds"; backendId: string; scopeKey: string }
  | { type: "sandboxRegistry.browsers" };
export type OpenClawStateReadRequest = {
  context: SqliteWorkerStateContext;
  databasePath: string;
  location: string;
  checkFreshAdmission: boolean;
  expectedIdentity?: string;
  snapshotRoot?: string;
  command: OpenClawStateReadCommand | { type: "admit" };
};
export type OpenClawStateReadReply = (
  | PluginBlobReadReply
  | {
      [Kind in keyof SkillLibraryReadOnlyOperations]: {
        ok: true;
        type: Kind;
        sourceAdmitted: true;
        value: SkillLibraryReadOnlyOperations[Kind]["output"];
      };
    }[keyof SkillLibraryReadOnlyOperations]
  | {
      ok: true;
      type: "agentDatabaseRegistry.read";
      sourceAdmitted?: true;
      result: OpenClawAgentDatabaseRegistryReadResult;
    }
  | {
      ok: true;
      type: "onboardingRecommendations.read";
      sourceAdmitted: true;
      record: OnboardingRecommendationsRecord | null;
    }
  | {
      ok: true;
      type: "userProfiles.avatar.reconcile";
      sourceAdmitted: true;
      profile: ProfileDisplayRow | undefined;
    }
  | {
      ok: true;
      type: "audit.run.inspect";
      sourceAdmitted: true;
      result: ExecutionIdentityInspectionOutcome;
    }
  | { ok: true; type: "admit" }
  | {
      ok: true;
      type: "exec-approvals.read";
      sourceAdmitted: true;
      row: ReturnType<typeof readExecApprovalsConfigRow>;
    }
  | {
      ok: true;
      type: "updateRuns.get";
      sourceAdmitted: true;
      run: ReturnType<typeof readUpdateRunRecord>;
    }
  | {
      ok: true;
      type: "updateRuns.list";
      sourceAdmitted: true;
      runs: ReturnType<typeof readUpdateRuns>;
    }
  | { ok: true; type: "fleet.list"; sourceAdmitted: true; cells: FleetCellRecord[] }
  | { ok: true; type: "fleet.get"; sourceAdmitted: true; cell: FleetCellRecord | undefined }
  | {
      ok: true;
      type: "nodeHost.config";
      sourceAdmitted: true;
      row: Pick<Selectable<ConfigMachineState>, "value_json" | "updated_at_ms"> | undefined;
    }
  | { ok: true; type: "workspace.snapshot"; sourceAdmitted: true; snapshot: WorkspaceStateSnapshot }
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
    }
) & {
  /** A best-effort admission read completed without confirmed native cleanup. */
  nativeCleanupFailure?: { error: OpenClawStateWorkerErrorPayload | undefined };
};

export type OpenClawStateReadOutcome =
  | { value: Extract<OpenClawStateReadReply, { ok: true }> }
  | { error: unknown; sourceAdmitted?: boolean };

export type OpenClawStateReadPhase = "before-read" | "read" | "unobserved";
export type OpenClawStateReadOptions = {
  mapError?: (error: unknown, phase: OpenClawStateReadPhase) => unknown;
};

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
