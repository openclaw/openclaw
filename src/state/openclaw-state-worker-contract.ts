import type { SandboxRegistryCleanupOperations } from "../agents/sandbox/registry.kernel.js";
import type { reserveWorktreeCapacityInWorker } from "../agents/worktrees/capacity.worker.js";
import type { recoverPendingWorktreesInWorker } from "../agents/worktrees/registry-run-end.worker.js";
import type { WorktreeTemplateWorkerOperations } from "../agents/worktrees/template-registry.worker.js";
import type { ClawAddStateWorkerOperations } from "../claws/add-state-worker-contract.js";
import type { CronStateWorkerOperations } from "../cron/store/worker-contract.js";
import type { DeviceIdentity } from "../infra/device-identity-store.js";
import type { RestartLifecycleWorkerOperations } from "../infra/restart-lifecycle.worker.js";
import type {
  SqliteWalPeriodicRequest,
  SqliteWalPeriodicResult,
} from "../infra/sqlite-wal-write-admission.js";
import type { SqliteWorkerPreparedBackend } from "../infra/sqlite-worker-contract.js";
import type { SqliteWorkerAdmissionFactory } from "../infra/sqlite-worker-operation-admission.js";
import type { UpdateRunWorkerOperations } from "../infra/update-run-mutation.types.js";
import type { PluginStateWriteOperations } from "../plugin-state/plugin-state-worker-contract.js";
import type { CaptureWorkerOperations } from "../proxy-capture/store.worker-contract.js";
import type { SkillUploadWorkerOperations } from "../skills/lifecycle/upload-store.worker-contract.js";
import type { GitHubPublicationSourceOperations } from "./github-publication-source-contract.js";
import type { OpenClawAgentDatabaseWorkerLeaseReceipt } from "./openclaw-agent-db-lease.js";
import type { OpenClawStateLeaseLifecycleOperations } from "./openclaw-state-lease-context.js";
import type { StateSchemaPublicationBlocker } from "./openclaw-state-schema-publication.js";
import type { RegisteredStateWorkerOperations } from "./openclaw-state-worker-registry.js";
import type { WorkerOperations } from "./worker-operation-registry.js";

export type OpenClawStateWorkerOpenPreparation = { type: "deviceIdentity"; identityKey: string };

/** Commands share one physical shared-state actor; bindings belong to commands, not open input. */
export type OpenClawStateWorkerOperations = Omit<
  RegisteredStateWorkerOperations,
  keyof SandboxRegistryCleanupOperations
> &
  WorkerOperations<
    typeof import("../infra/device-auth-store.worker.js").deviceAuthWorkerOperations
  > &
  GitHubPublicationSourceOperations &
  RestartLifecycleWorkerOperations &
  WorktreeTemplateWorkerOperations &
  ClawAddStateWorkerOperations &
  UpdateRunWorkerOperations &
  CaptureWorkerOperations &
  PluginStateWriteOperations &
  CronStateWorkerOperations &
  OpenClawStateLeaseLifecycleOperations & {
    "worktrees.reserveCapacity": {
      input: Parameters<typeof reserveWorktreeCapacityInWorker>[0];
      output: ReturnType<typeof reserveWorktreeCapacityInWorker>;
    };
    "worktrees.recoverPending": {
      input: Parameters<typeof recoverPendingWorktreesInWorker>[0];
      output: ReturnType<typeof recoverPendingWorktreesInWorker>;
    };
    "database.walMaintenance": { input: SqliteWalPeriodicRequest; output: SqliteWalPeriodicResult };
    "database.publishSchema": {
      input: undefined;
      output: StateSchemaPublicationBlocker | undefined;
    };
    "deviceIdentity.load": { input: { identityKey: string }; output: DeviceIdentity };
  };

/** Retiring owners dispatch only exact, physically bound cleanup receipts. */
export type OpenClawStateWorkerCleanupOperations = Pick<
  OpenClawStateLeaseLifecycleOperations,
  "stateLease.release"
> &
  Pick<SkillUploadWorkerOperations, "skillUploads.release"> &
  SandboxRegistryCleanupOperations & {
    "agentDatabases.releaseExitedLease": {
      input: OpenClawAgentDatabaseWorkerLeaseReceipt;
      output: void;
    };
  };

export type OpenClawStateWorkerBackend = SqliteWorkerPreparedBackend<
  OpenClawStateWorkerOperations & OpenClawStateWorkerCleanupOperations
>;

/** Host-only admission options; never serialized with a worker command. */
export type OpenClawStateWorkerOperationOptions = {
  preparation?: OpenClawStateWorkerOpenPreparation;
  existingOnly?: boolean;
  signal?: AbortSignal;
  assertCurrent?: (commandType?: PropertyKey) => void;
  createAdmission?: SqliteWorkerAdmissionFactory;
};
