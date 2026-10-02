import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { createSqliteWorkerOperationAdmission } from "../infra/sqlite-worker-operation-admission.js";
import { sessionChanges } from "../sessions/session-row-changes.js";
import { captureAgentDatabasePreparationDeletionForWorker } from "../state/agent-database-admission.js";
import { closeOpenClawAgentDatabaseByPathAsync } from "../state/openclaw-agent-db-lifecycle.js";
import { invalidateRegisteredAgentDatabasesMemo } from "../state/openclaw-agent-db-registry-listing.js";
import { invalidateOpenClawAgentDatabaseValidationsForAgent } from "../state/openclaw-agent-db-validation-cache.js";
import type { OpenClawStateLeaseContext } from "../state/openclaw-state-lease-context.js";
import { getOpenClawStateLeaseOwnerIdentity } from "../state/openclaw-state-lease.js";
import { captureOpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.js";
import { runOpenClawStateWorkerOperation } from "../state/openclaw-state-worker-store.js";
import type { RemovedWorkspaceFile } from "./lifecycle-delete-support.js";
import { deleteCachedClawInstallSchemaVersion } from "./provenance-runtime-read.js";
import type { PersistedClawInstall } from "./provenance.js";
import { readClawRemoveFacts } from "./remove-facts-read.js";
import type {
  ClawRemoveStateGuard,
  ClawRemoveStateWorkerOperations,
} from "./remove-state-worker-contract.js";
import {
  executeClawMutationStateCommand,
  type ClawMutationStateOptions,
} from "./state-mutation-write.js";

type OwnedRemoveStateOptions = ClawMutationStateOptions & { lease: OpenClawStateLeaseContext };

function ownedOptions(options: OwnedRemoveStateOptions) {
  return {
    ...options,
    assertCurrent: () => {
      options.assertCurrent?.();
      options.lease.assertOwned();
    },
  };
}

function assertGuardOwner(guard: ClawRemoveStateGuard, lease: OpenClawStateLeaseContext) {
  if (!isDeepStrictEqual(guard.lease, getOpenClawStateLeaseOwnerIdentity(lease))) {
    throw new Error("Claw removal state belongs to another deletion lease.");
  }
}

export async function claimClawRemoveState(
  input: {
    agentId: string;
    expectedInstall: PersistedClawInstall | null;
    workspaceDir: string;
    agentDir: string;
    sessionsDir: string;
  },
  options: OwnedRemoveStateOptions,
) {
  const lease = getOpenClawStateLeaseOwnerIdentity(options.lease);
  const operationId = randomUUID();
  const publishDeletion = captureAgentDatabasePreparationDeletionForWorker(
    input.agentId,
    captureOpenClawStateWorkerContext(options),
  );
  let claimed: Awaited<ReturnType<typeof executeClawMutationStateCommand<"claws.remove.claim">>>;
  try {
    claimed = await executeClawMutationStateCommand(ownedOptions(options), {
      type: "claws.remove.claim",
      input: { ...input, operationId, lease },
    });
  } catch (error) {
    try {
      const facts = await readClawRemoveFacts(input.agentId, [], options);
      if (facts.journal?.operationId === operationId) {
        publishDeletion();
        sessionChanges.emit({ all: true, scope: "stores" });
      }
    } catch {
      // Unknown durability must not leave a pending startup admission live.
      publishDeletion();
      sessionChanges.emit({ all: true, scope: "stores" });
    }
    throw error;
  }
  publishDeletion();
  sessionChanges.emit({ all: true, scope: "stores" });
  return {
    ...claimed,
    guard: {
      agentId: input.agentId,
      operationId,
      expectedInstall: input.expectedInstall,
      lease,
    } satisfies ClawRemoveStateGuard,
  };
}

export async function assertClawRemoveState(
  guard: ClawRemoveStateGuard,
  options: OwnedRemoveStateOptions,
): Promise<void> {
  assertGuardOwner(guard, options.lease);
  await executeClawMutationStateCommand(ownedOptions(options), {
    type: "claws.remove.assert",
    input: guard,
  });
}

export async function assertNoAgentDatabaseLeasesForClawMonitor(
  agentId: string,
  operationId: string,
  options: ClawMutationStateOptions,
): Promise<void> {
  await executeClawMutationStateCommand(options, {
    type: "claws.monitors.assertNoAgentLeases",
    input: { agentId, operationId },
  });
}

export async function quiesceClawMonitorsUnderStateFence(
  input: ClawRemoveStateWorkerOperations["claws.monitors.quiesce"]["input"],
  cancel: () => void,
  options: ClawMutationStateOptions,
): Promise<void> {
  const context = captureOpenClawStateWorkerContext(options);
  let cancelled = false;
  await runOpenClawStateWorkerOperation(
    context,
    (scope) => scope.execute({ type: "claws.monitors.quiesce", input }),
    {
      assertCurrent: options.assertCurrent,
      createAdmission: () => ({
        nativeLocations: [context.admission.databasePath],
        admission: createSqliteWorkerOperationAdmission((request, grant) => {
          if (request.stage !== "transaction" && request.stage !== "commit") {
            throw new Error("Claw monitor cancellation requires transaction admission.");
          }
          context.admission.assertCurrent();
          options.assertCurrent?.();
          if (request.stage === "commit") {
            const facts = request.facts;
            if (
              !facts ||
              typeof facts !== "object" ||
              !("kind" in facts) ||
              facts.kind !== "claw-monitor-quiesce" ||
              !("agentId" in facts) ||
              facts.agentId !== input.agentId ||
              !("operationId" in facts) ||
              facts.operationId !== input.operationId
            ) {
              throw new Error("Claw monitor cancellation has no matching state-worker proof.");
            }
            // The worker still holds its verified write transaction until this grant returns.
            cancel();
            cancelled = true;
          }
          grant();
        }),
      }),
    },
  );
  if (!cancelled) {
    throw new Error("Claw monitor cancellation was not admitted by the state worker.");
  }
}

export async function closeClawMonitorAgentDatabaseUnderStateFence(
  input: ClawRemoveStateWorkerOperations["claws.monitors.prepareDatabaseClose"]["input"],
  options: ClawMutationStateOptions,
): Promise<void> {
  const context = captureOpenClawStateWorkerContext(options);
  let close: Promise<boolean> | undefined;
  try {
    await runOpenClawStateWorkerOperation(
      context,
      (scope) => scope.execute({ type: "claws.monitors.prepareDatabaseClose", input }),
      {
        assertCurrent: options.assertCurrent,
        createAdmission: () => ({
          nativeLocations: [context.admission.databasePath],
          admission: createSqliteWorkerOperationAdmission((request, grant) => {
            if (request.stage !== "transaction" && request.stage !== "commit") {
              throw new Error("Claw monitor database closure requires transaction admission.");
            }
            context.admission.assertCurrent();
            options.assertCurrent?.();
            if (request.stage === "commit") {
              const facts = request.facts;
              if (
                !facts ||
                typeof facts !== "object" ||
                !("kind" in facts) ||
                facts.kind !== "claw-monitor-database-close" ||
                !("agentId" in facts) ||
                facts.agentId !== input.agentId ||
                !("operationId" in facts) ||
                facts.operationId !== input.operationId ||
                !("databasePath" in facts) ||
                facts.databasePath !== input.databasePath
              ) {
                throw new Error("Claw monitor database closure has no matching worker proof.");
              }
              // Revocation and close selection start synchronously while the worker holds the fence.
              close = closeOpenClawAgentDatabaseByPathAsync(input.databasePath, input.agentId);
              void close.catch(() => {});
            }
            grant();
          }),
        }),
      },
    );
  } catch (error) {
    await close?.catch(() => {});
    throw error;
  }
  if (!close) {
    throw new Error("Claw monitor database closure was not admitted by the state worker.");
  }
  await close;
}

export async function rollbackClawRemoveState(
  guard: ClawRemoveStateGuard,
  options: OwnedRemoveStateOptions,
): Promise<void> {
  assertGuardOwner(guard, options.lease);
  await executeClawMutationStateCommand(ownedOptions(options), {
    type: "claws.remove.rollback",
    input: guard,
  });
  sessionChanges.emit({ all: true, scope: "stores" });
}

export async function releaseClawRemoveStateRows(
  guard: ClawRemoveStateGuard,
  files: RemovedWorkspaceFile[],
  cleanupErrors: string[],
  options: OwnedRemoveStateOptions,
) {
  assertGuardOwner(guard, options.lease);
  try {
    return await executeClawMutationStateCommand(ownedOptions(options), {
      type: "claws.remove.releaseRows",
      input: { ...guard, files, cleanupErrors },
    });
  } finally {
    // A committed release may lose its reply. Refresh host facts even when durability is unknown.
    invalidateRegisteredAgentDatabasesMemo(options);
    invalidateOpenClawAgentDatabaseValidationsForAgent(guard.agentId, []);
    deleteCachedClawInstallSchemaVersion(guard.agentId, options);
    sessionChanges.emit({ all: true, scope: { agentId: guard.agentId, topology: true } });
  }
}
