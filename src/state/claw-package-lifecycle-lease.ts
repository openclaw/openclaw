import type { AgentDeletionWorkerAuthority } from "./agent-deletion-worker.types.js";
import {
  CLAW_PACKAGE_LIFECYCLE_LEASE_SCOPE,
  clawPackageLifecycleLeaseKey,
  type ClawPackageLifecycleArtifact,
} from "./claw-package-lifecycle-lease-key.js";
import type { OpenClawStateDatabaseOptions } from "./openclaw-state-db.js";
import type {
  OpenClawStateAsyncLeaseContext,
  OpenClawStateWorkerLeaseContext,
} from "./openclaw-state-lease-context.js";
import { withOpenClawStateLease, type OpenClawStateLeaseContext } from "./openclaw-state-lease.js";

// Skill serialization covers a workspace; claims remain bound to its selected artifact.
const artifacts = new WeakMap<OpenClawStateWorkerLeaseContext, ClawPackageLifecycleArtifact>();

export function assertClawPackageLifecycleWriteArtifact(
  lease: OpenClawStateWorkerLeaseContext,
  artifact: Pick<ClawPackageLifecycleArtifact, "kind" | "source" | "ref">,
): void {
  const original = artifacts.get(lease);
  if (
    !original ||
    original.kind !== artifact.kind ||
    original.source !== artifact.source ||
    original.ref !== artifact.ref
  ) {
    throw new Error("Package write requires its original lifecycle owner.");
  }
}

/** Deletion and package writes retain leases admitted from the same physical state owner. */
export function withClawPackageDeletionLease<T>(
  artifact: ClawPackageLifecycleArtifact,
  deletion: AgentDeletionWorkerAuthority,
  operation: (
    lease: OpenClawStateAsyncLeaseContext,
    assertCurrentHost: () => void,
    assertCurrentFinal: () => void,
  ) => Promise<T>,
): Promise<T> {
  const capturedArtifact = { ...artifact };
  return deletion.withStateLease(
    {
      scope: CLAW_PACKAGE_LIFECYCLE_LEASE_SCOPE,
      key: clawPackageLifecycleLeaseKey(capturedArtifact),
      leaseMs: 5 * 60_000,
      waitMs: 0,
      leaseLabel: "Claw package lifecycle",
      operationLabel: "claw.package.lifecycle",
    },
    (lease, assertCurrentHost, assertCurrentFinal) => {
      artifacts.set(lease, capturedArtifact);
      return operation(lease, assertCurrentHost, assertCurrentFinal);
    },
  );
}

/** Retain shared artifact ownership through asynchronous work and worker settlement. */
export function withClawPackageLifecycleLease<T>(
  artifact: ClawPackageLifecycleArtifact,
  operation: (lease: OpenClawStateLeaseContext) => Promise<T>,
  options: OpenClawStateDatabaseOptions & { signal?: AbortSignal } = {},
): Promise<T> {
  const capturedArtifact = { ...artifact };
  return withOpenClawStateLease(
    {
      scope: CLAW_PACKAGE_LIFECYCLE_LEASE_SCOPE,
      key: clawPackageLifecycleLeaseKey(capturedArtifact),
      database: { scope: "shared", options },
      leaseMs: 5 * 60_000,
      waitMs: 0,
      signal: options.signal,
      leaseLabel: "Claw package lifecycle",
      operationLabel: "claw.package.lifecycle",
    },
    (lease) => {
      artifacts.set(lease, capturedArtifact);
      return operation(lease);
    },
  );
}
