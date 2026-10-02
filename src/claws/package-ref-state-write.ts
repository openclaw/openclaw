import {
  acquireClawPackageLifecycleLease,
  maintainClawPackageLifecycleLease,
  type MaintainedClawPackageLifecycleLease,
} from "../state/claw-package-lifecycle-lease.js";
import type {
  ClawAddStateOptions,
  ClawPackageRefStateOptions,
  persistClawPackageRefForAdd,
} from "./add-state-write.js";
import type { PlannedClawPackage } from "./package-plan-action.js";
import type { PersistedClawPackageRef } from "./provenance.js";

type RefOptions = Pick<
  NonNullable<Parameters<typeof persistClawPackageRefForAdd>[2]>,
  "status" | "relationship" | "origin" | "independentOwner"
>;

export function acquireMaintainedClawPackageLease(
  pkg: PlannedClawPackage,
  workspace: string,
  options: ClawAddStateOptions,
  acquire: typeof acquireClawPackageLifecycleLease,
): MaintainedClawPackageLifecycleLease {
  const artifact =
    pkg.kind === "skill"
      ? { kind: pkg.kind, source: pkg.source, ref: pkg.ref, workspace }
      : { kind: pkg.kind, source: pkg.source, ref: pkg.ref };
  const lease = acquire(artifact, { env: options.env, path: options.path, required: true });
  if (!lease) {
    throw new Error(`Could not acquire package lifecycle lease for ${pkg.ref}.`);
  }
  return maintainClawPackageLifecycleLease(lease);
}

/** Check the package lease locally, then fence its worker write inside the worker transaction. */
export async function withClawPackageRefWrite<T>(
  lease: MaintainedClawPackageLifecycleLease,
  options: ClawAddStateOptions,
  assertOwnerCurrent: () => void,
  operation: (stateOptions: ClawPackageRefStateOptions) => Promise<T>,
): Promise<T> {
  const assertCurrent = () => {
    lease.assertCurrent();
    assertOwnerCurrent();
  };
  assertCurrent();
  if (options.stateMode !== "worker") {
    return await operation({ ...options, assertCurrent });
  }
  const packageLease = lease.identity;
  if (!packageLease) {
    throw new Error("Worker-backed package reference writes require a package lifecycle lease.");
  }
  return await lease.withHeartbeatPaused(() =>
    operation({ ...options, assertCurrent: assertOwnerCurrent, packageLease }),
  );
}

export function createClawPackageRefWriter(
  lease: MaintainedClawPackageLifecycleLease,
  options: ClawAddStateOptions & { assertForwardCurrent?: () => void },
  persist: (
    refOptions: RefOptions,
    stateOptions: ClawPackageRefStateOptions,
  ) => Promise<PersistedClawPackageRef> | PersistedClawPackageRef,
  complete: (
    ref: PersistedClawPackageRef,
    status: PersistedClawPackageRef["status"],
    stateOptions: ClawPackageRefStateOptions,
  ) => Promise<PersistedClawPackageRef> | PersistedClawPackageRef,
) {
  const assertOwnerCurrent = () => {
    options.assertCurrent?.();
    options.assertForwardCurrent?.();
  };
  const assertCurrent = () => {
    lease.assertCurrent();
    options.assertCurrent?.();
  };
  return {
    assertCurrent,
    assertForwardCurrent: () => {
      assertCurrent();
      options.assertForwardCurrent?.();
    },
    persist: (refOptions: RefOptions) =>
      withClawPackageRefWrite(
        lease,
        options,
        assertOwnerCurrent,
        async (stateOptions) => await persist(refOptions, stateOptions),
      ),
    complete: (ref: PersistedClawPackageRef, status: PersistedClawPackageRef["status"]) =>
      withClawPackageRefWrite(
        lease,
        options,
        assertOwnerCurrent,
        async (stateOptions) => await complete(ref, status, stateOptions),
      ),
  };
}
