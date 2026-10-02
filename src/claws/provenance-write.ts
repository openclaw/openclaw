import { createSqliteWorkerWriteAdmission } from "../infra/sqlite-worker-store.js";
import {
  captureClawPackageLifecycleWriteAuthority,
  type MaintainedClawPackageLifecycleLease,
} from "../state/claw-package-lifecycle-lease.js";
import type { OpenClawStateDatabaseOptions } from "../state/openclaw-state-db.js";
import { captureOpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.js";
import {
  executeOpenClawStateWorker,
  runOpenClawStateWorkerOperation,
} from "../state/openclaw-state-worker-store.js";
import type {
  ClawPackageRefStatus,
  PersistedClawPackageRef,
} from "./package-extension-provenance.js";

export async function claimClawPackageRefStatus(
  ref: PersistedClawPackageRef,
  status: ClawPackageRefStatus,
  options: OpenClawStateDatabaseOptions & {
    lease: MaintainedClawPackageLifecycleLease;
    nowMs?: number;
    assertCurrent?: () => void;
  },
): Promise<PersistedClawPackageRef> {
  if (options.readOnly) {
    throw new Error("Claw provenance writes require writable state.");
  }
  // Store admission can yield before execute captures the command.
  const capturedRef = structuredClone(ref);
  const owner = captureClawPackageLifecycleWriteAuthority(options.lease, capturedRef);
  const input = { ref: capturedRef, status, nowMs: options.nowMs, lease: { ...owner.identity } };
  const assertCaller = options.assertCurrent?.bind(options);
  const context = captureOpenClawStateWorkerContext({
    ...options,
    path: options.database?.path ?? options.path ?? owner.path,
  });
  const assertCurrent = () => {
    context.admission.assertCurrent();
    owner.assertCurrent();
    assertCaller?.();
    if (context.admission.databasePath !== owner.path) {
      throw new Error("Package write differs from its lifecycle database.");
    }
  };
  const result = await runOpenClawStateWorkerOperation(
    context,
    (scope) =>
      scope.execute({
        type: "clawProvenance.packageStatus",
        input,
      }),
    {
      assertCurrent,
      createAdmission: createSqliteWorkerWriteAdmission(assertCurrent, [owner.path]),
    },
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
