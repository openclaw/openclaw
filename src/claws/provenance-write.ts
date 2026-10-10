import type { AgentDeletionWorkerAuthority } from "../state/agent-deletion-worker.types.js";
import { assertClawPackageLifecycleWriteArtifact } from "../state/claw-package-lifecycle-lease.js";
import type { OpenClawStateDatabaseOptions } from "../state/openclaw-state-db.js";
import type { OpenClawStateWorkerLeaseContext } from "../state/openclaw-state-lease-context.js";
import { runWithOpenClawStateLeaseWorker } from "../state/openclaw-state-lease-worker-operation.js";
import { captureOpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.js";
import { executeOpenClawStateWorker } from "../state/openclaw-state-worker-store.js";
import type {
  ClawPackageRefStatus,
  PersistedClawPackageRef,
} from "./package-extension-provenance.js";

export async function claimClawPackageRefStatus(
  ref: PersistedClawPackageRef,
  status: ClawPackageRefStatus,
  options: OpenClawStateDatabaseOptions & {
    lease: OpenClawStateWorkerLeaseContext;
    deletion?: AgentDeletionWorkerAuthority;
    nowMs?: number;
    assertCurrent?: () => void;
  },
): Promise<PersistedClawPackageRef> {
  if (options.readOnly) {
    throw new Error("Claw provenance writes require writable state.");
  }
  // Store admission can yield before execute captures the command.
  const capturedRef = structuredClone(ref);
  const nowMs = options.nowMs;
  assertClawPackageLifecycleWriteArtifact(options.lease, capturedRef);
  if (options.deletion) {
    return await options.deletion.runWithWorker(
      (scope, deletion, additionalLeases) => {
        const lease = additionalLeases[0];
        if (!lease) {
          throw new Error("Claw package write lost its additional lease");
        }
        return scope.execute({
          type: "clawProvenance.packageStatus",
          input: { ref: capturedRef, status, nowMs, lease, deletion },
        });
      },
      { additionalLeases: [options.lease], assertCurrent: options.assertCurrent },
    );
  }
  const assertCaller = options.assertCurrent?.bind(options);
  const context = captureOpenClawStateWorkerContext({
    ...options,
    path: options.database?.path ?? options.path,
  });
  const assertCurrent = () => {
    context.admission.assertCurrent();
    assertCaller?.();
  };
  const result = await runWithOpenClawStateLeaseWorker(
    options.lease,
    context,
    (scope, identity) =>
      scope.execute({
        type: "clawProvenance.packageStatus",
        input: { ref: capturedRef, status, nowMs, lease: identity },
      }),
    { assertCurrent },
  );
  assertCurrent();
  return result;
}

export function reconcileClawMcpServerRefsInWorker(
  agentId: string,
  digests: Record<string, string>,
  options: OpenClawStateDatabaseOptions & { nowMs?: number },
) {
  if (options.readOnly) {
    throw new Error("Claw provenance writes require writable state.");
  }
  const context = captureOpenClawStateWorkerContext({
    ...options,
    path: options.database?.path ?? options.path,
  });
  return executeOpenClawStateWorker(context, {
    type: "clawProvenance.reconcileMcp",
    input: { agentId, digests, nowMs: options.nowMs },
  });
}
