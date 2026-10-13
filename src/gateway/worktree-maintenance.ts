import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import {
  listAgentEntries,
  listAgentIds,
  tryResolveLegacyCompatibilityAgentId,
  tryResolveLegacyDataOwnerAgentId,
} from "../agents/agent-scope-config.js";
import { WorktreeGcProgress } from "../agents/worktrees/gc-progress.js";
import { createManagedWorktreeOwnerPolicy } from "../agents/worktrees/owner-protection.js";
import { managedWorktrees, WORKTREE_GC_INTERVAL_MS } from "../agents/worktrees/service.js";
import type {
  ManagedWorktreeGcReceipt,
  ManagedWorktreeGcResult,
} from "../agents/worktrees/types.js";
import { getRuntimeConfigSnapshotMetadata } from "../config/runtime-snapshot.js";
import { listConfiguredSessionStoreAgentIds } from "../config/sessions/targets-configured-agents.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { toErrorObject } from "../infra/errors.js";
import type { GatewayScheduler } from "../infra/gateway-scheduler.js";
import {
  isGatewayWorkAdmissionClosed,
  runWithGatewayIndependentRootWorkAdmission,
} from "../process/gateway-work-admission.js";

type MaintenanceRequest = { jobId?: string; retryDeferred?: boolean };
type MaintenanceOwner = {
  request: (options?: MaintenanceRequest) => ManagedWorktreeGcReceipt;
  notifyArchive: () => void;
  stop: () => Promise<void>;
};
const owners = new WeakMap<() => OpenClawConfig, MaintenanceOwner>();

function captureCleanupInputs(config: OpenClawConfig) {
  const defaults = config.agents?.defaults;
  return {
    worktreeRoot: config.worktreeRoot,
    worktreeMaxCount: config.worktreeMaxCount,
    sessionStore: config.session?.store,
    mainKey: config.session?.mainKey,
    sessionScope: config.session?.scope,
    agentIds: listAgentIds(config),
    compatibilityOwner: tryResolveLegacyCompatibilityAgentId(config),
    legacyDataOwner: tryResolveLegacyDataOwnerAgentId(config),
    sessionStoreOwner: defaults?.sessionStore?.agentId,
    storeAgentIds: listConfiguredSessionStoreAgentIds(config),
    workspace: defaults?.workspace,
    sandboxMode: defaults?.sandbox?.mode,
    agents: listAgentEntries(config).map(({ id, workspace, agentDir, sandbox }) => ({
      id,
      workspace,
      agentDir,
      sandboxMode: sandbox?.mode,
    })),
  };
}

/** Hourly and requested cleanup share a cursor, admission, progress, and shutdown drain. */
export function startWorktreeMaintenance(params: {
  scheduler: GatewayScheduler;
  getRuntimeConfig: () => OpenClawConfig;
  onComplete: (result: ManagedWorktreeGcResult) => void;
  onError: (message: string) => void;
  runGc?: () => Promise<ManagedWorktreeGcResult | void>;
}): MaintenanceOwner {
  const previousDrain = owners.get(params.getRuntimeConfig)?.stop();
  const scheduler = params.scheduler.scope();
  const inOwnerContext = AsyncLocalStorage.snapshot();
  let receipt: ManagedWorktreeGcReceipt | undefined;
  let inFlight: Promise<void> | undefined;
  let archivePending = false;
  const isActive = () =>
    !scheduler.signal.aborted &&
    owners.get(params.getRuntimeConfig) === owner &&
    !isGatewayWorkAdmissionClosed();
  const assertActive = () => {
    if (!isActive()) {
      throw new Error(
        "Worktree cleanup canceled because the Gateway maintenance owner is stopping",
      );
    }
  };
  const owner: MaintenanceOwner = {
    request: ({ jobId, retryDeferred } = {}) => {
      assertActive();
      if (jobId) {
        if (!receipt || receipt.jobId !== jobId) {
          throw new Error(
            "Worktree cleanup job is no longer available; only the latest job is retained",
          );
        }
        return structuredClone(receipt);
      }
      if (receipt?.state === "queued" || receipt?.state === "running") {
        return structuredClone(receipt);
      }
      const config = params.getRuntimeConfig();
      const cleanupInputs = captureCleanupInputs(config);
      let checkedConfig = config;
      let checkedPublication = getRuntimeConfigSnapshotMetadata();
      const current: ManagedWorktreeGcReceipt = {
        ...new WorktreeGcProgress().result,
        jobId: randomUUID(),
        state: "queued",
        startedAt: null,
        completedAt: null,
        error: null,
      };
      receipt = current;
      const assertCurrent = () => {
        assertActive();
        const nextConfig = params.getRuntimeConfig();
        const publication = getRuntimeConfigSnapshotMetadata();
        // Recheck once per publication, including a republished object edited in place.
        if (nextConfig !== checkedConfig || publication !== checkedPublication) {
          if (!isDeepStrictEqual(captureCleanupInputs(nextConfig), cleanupInputs)) {
            throw new Error("Worktree cleanup canceled because its runtime configuration changed");
          }
          checkedConfig = nextConfig;
          checkedPublication = publication;
        }
      };
      inOwnerContext(() =>
        scheduler.schedule({
          id: "maintenance:worktrees:run",
          delayMs: 0,
          run: () => {
            current.state = "running";
            current.startedAt = scheduler.now();
            let batchStartedAt = scheduler.now();
            let batchItems = 0;
            // The scheduler already detaches this job and joins its tracked cleanup.
            // Preserve that work scope when admitting the maintenance root.
            inFlight = runWithGatewayIndependentRootWorkAdmission(
              async () => {
                await previousDrain;
                assertCurrent();
                const result = await (params.runGc
                  ? params.runGc()
                  : managedWorktrees.gc({
                      ...createManagedWorktreeOwnerPolicy(config),
                      retryDeferred,
                      signal: scheduler.signal,
                      commitGuard: assertCurrent,
                      checkpoint: async (progress) => {
                        Object.assign(current, progress);
                        assertCurrent();
                        if (++batchItems < 8 && scheduler.now() - batchStartedAt < 5_000) {
                          return;
                        }
                        await new Promise<void>((resolve, reject) => {
                          const abort = () =>
                            reject(
                              toErrorObject(scheduler.signal.reason, "Worktree cleanup canceled"),
                            );
                          scheduler.signal.addEventListener("abort", abort, { once: true });
                          scheduler.schedule({
                            id: "maintenance:worktrees:resume",
                            delayMs: 1_000,
                            run: () => {
                              scheduler.signal.removeEventListener("abort", abort);
                              resolve();
                            },
                          });
                        });
                        assertCurrent();
                        batchItems = 0;
                        batchStartedAt = scheduler.now();
                      },
                    }));
                assertCurrent();
                if (result) {
                  Object.assign(current, result);
                  params.onComplete(result);
                }
                current.state = "completed";
              },
              "runtime:worktree-cleanup",
              scheduler.signal,
            )
              .catch((error: unknown) => {
                current.state = "failed";
                current.error = error instanceof Error ? error.message : String(error);
                params.onError(current.error);
              })
              .finally(() => {
                current.completedAt = scheduler.now();
                inFlight = undefined;
                if (archivePending && isActive()) {
                  archivePending = false;
                  owner.request();
                }
              });
            return inFlight;
          },
        }),
      );
      return structuredClone(current);
    },
    notifyArchive: () => {
      if (!isActive()) {
        return;
      }
      if (receipt?.state === "running") {
        // The current sweep may already have passed this newly archived session.
        archivePending = true;
      } else {
        owner.request();
      }
    },
    stop: async () => {
      // Aborting also wakes a paused batch before joining worker settlement.
      await scheduler.stop();
      await inFlight;
      await previousDrain;
      if (owners.get(params.getRuntimeConfig) === owner) {
        owners.delete(params.getRuntimeConfig);
      }
    },
  };
  owners.set(params.getRuntimeConfig, owner);
  scheduler.schedule({
    id: "maintenance:worktrees",
    delayMs: WORKTREE_GC_INTERVAL_MS,
    everyMs: WORKTREE_GC_INTERVAL_MS,
    run: () => {
      if (!isGatewayWorkAdmissionClosed()) {
        owner.request();
      }
    },
  });
  return owner;
}

export function requestGatewayWorktreeMaintenance(
  getRuntimeConfig: () => OpenClawConfig,
  options: MaintenanceRequest = {},
): ManagedWorktreeGcReceipt {
  const owner = owners.get(getRuntimeConfig);
  if (!owner) {
    throw new Error("Worktree maintenance is not running; wait for Gateway startup to finish");
  }
  return owner.request(options);
}

/** Durable archive metadata survives startup and shutdown without a live maintenance owner. */
export function notifyGatewayWorktreeArchive(getRuntimeConfig: () => OpenClawConfig): void {
  owners.get(getRuntimeConfig)?.notifyArchive();
}
