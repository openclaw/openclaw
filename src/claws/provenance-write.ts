import { createSqliteWorkerWriteAdmission } from "../infra/sqlite-worker-store.js";
import {
  captureClawPackageLifecycleWriteAuthority,
  type MaintainedClawPackageLifecycleLease,
} from "../state/claw-package-lifecycle-lease.js";
import type { OpenClawStateDatabaseOptions } from "../state/openclaw-state-db.js";
import {
  getOpenClawStateLeaseOwnerIdentity,
  type OpenClawStateLeaseContext,
} from "../state/openclaw-state-lease.js";
import { captureOpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.js";
import { runOpenClawStateWorkerOperation } from "../state/openclaw-state-worker-store.js";
import type { PersistedClawMcpServerRef } from "./mcp-records.js";
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

export async function recoverClawMcpPendingRef(
  agentId: string,
  name: string,
  action: "complete" | "release",
  expectedRefs: readonly PersistedClawMcpServerRef[],
  options: OpenClawStateDatabaseOptions & {
    agentLease: OpenClawStateLeaseContext;
    mcpLease: OpenClawStateLeaseContext;
    nowMs?: number;
    assertCurrent?: () => void;
  },
) {
  if (options.readOnly) {
    throw new Error("Claw provenance writes require writable state.");
  }
  const agentLease = getOpenClawStateLeaseOwnerIdentity(options.agentLease);
  const mcpLease = getOpenClawStateLeaseOwnerIdentity(options.mcpLease);
  if (
    agentLease.scope !== "core:agent-deletion" ||
    agentLease.key !== agentId ||
    mcpLease.scope !== "core:claw-mcp-lifecycle" ||
    mcpLease.key !== name
  ) {
    throw new Error("Claw MCP recovery requires its agent and MCP lifecycle owners.");
  }
  const input = {
    agentId,
    name,
    action,
    expectedRefs: structuredClone([...expectedRefs]),
    agentLease: { ...agentLease },
    mcpLease: { ...mcpLease },
    nowMs: options.nowMs,
  };
  const context = captureOpenClawStateWorkerContext({
    ...options,
    path: options.database?.path ?? options.path,
  });
  const assertCurrent = () => {
    context.admission.assertCurrent();
    options.agentLease.assertOwned();
    options.mcpLease.assertOwned();
    options.assertCurrent?.();
  };
  const result = await runOpenClawStateWorkerOperation(
    context,
    (scope) => scope.execute({ type: "clawProvenance.recoverMcp", input }),
    {
      assertCurrent,
      createAdmission: createSqliteWorkerWriteAdmission(assertCurrent, [
        context.admission.databasePath,
      ]),
    },
  );
  assertCurrent();
  return result;
}
