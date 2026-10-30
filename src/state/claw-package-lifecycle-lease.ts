import {
  CLAW_PACKAGE_LIFECYCLE_LEASE_SCOPE,
  clawPackageLifecycleLeaseKey,
  type ClawPackageLifecycleArtifact,
} from "./claw-package-lifecycle-lease-key.js";
import type { OpenClawStateDatabaseOptions } from "./openclaw-state-db.js";
import { OpenClawStateLeaseError } from "./openclaw-state-lease-error.js";
import {
  withOpenClawStateLeaseAsync,
  type OpenClawStateAsyncLeaseContext,
} from "./openclaw-state-lease.js";
import { captureOpenClawStateWorkerContext } from "./openclaw-state-worker-context.js";

export type ClawPackageLifecycleLeaseIdentity = {
  scope: typeof CLAW_PACKAGE_LIFECYCLE_LEASE_SCOPE;
  key: string;
  owner: string;
};

export type ClawPackageLifecycleLease = {
  identity: ClawPackageLifecycleLeaseIdentity;
  assertCurrent: () => void;
  assertOwned: () => Promise<void>;
  release: () => Promise<void> | void;
};

type ClawPackageLifecycleLeaseOptions = OpenClawStateDatabaseOptions & {
  required?: boolean;
};

/** Add holds this lease while it commits package references through the state worker. */
export async function acquireClawPackageLifecycleLease(
  artifact: ClawPackageLifecycleArtifact,
  options: ClawPackageLifecycleLeaseOptions = {},
): Promise<ClawPackageLifecycleLease | null> {
  const ready = Promise.withResolvers<ClawPackageLifecycleLease>();
  const released = Promise.withResolvers<void>();
  let active = true;
  const operation = withClawPackageLifecycleLease(
    artifact,
    async (lease, identity) => {
      ready.resolve({
        identity,
        assertCurrent: () => {
          if (!active) {
            throw new Error("Package lifecycle lease has been released.");
          }
          lease.assertCurrent();
        },
        assertOwned: async () => {
          if (!active) {
            throw new Error("Package lifecycle lease has been released.");
          }
          await lease.assertOwned();
          if (!active) {
            throw new Error("Package lifecycle lease has been released.");
          }
        },
        release: async () => {
          if (active) {
            active = false;
            released.resolve();
          }
          await operation;
        },
      });
      await released.promise;
    },
    options,
  );
  void operation.catch((error: unknown) => ready.reject(error));
  try {
    return await ready.promise;
  } catch (error) {
    if (
      options.required ||
      (error instanceof OpenClawStateLeaseError && error.code === "OPENCLAW_STATE_LEASE_HELD")
    ) {
      throw error;
    }
    return null;
  }
}

/** Retain shared artifact ownership through asynchronous work and worker settlement. */
export function withClawPackageLifecycleLease<T>(
  artifact: ClawPackageLifecycleArtifact,
  operation: (
    lease: OpenClawStateAsyncLeaseContext,
    identity: ClawPackageLifecycleLeaseIdentity,
  ) => Promise<T>,
  options: OpenClawStateDatabaseOptions & { signal?: AbortSignal } = {},
): Promise<T> {
  const context = captureOpenClawStateWorkerContext({
    env: options.env,
    path: options.database?.path ?? options.path,
  });
  return withOpenClawStateLeaseAsync(
    {
      scope: CLAW_PACKAGE_LIFECYCLE_LEASE_SCOPE,
      key: clawPackageLifecycleLeaseKey(artifact),
      leaseMs: 5 * 60_000,
      waitMs: 0,
      signal: options.signal,
      leaseLabel: "Claw package lifecycle",
      operationLabel: "claw.package.lifecycle",
    },
    context,
    (lease, identity) => {
      return operation(lease, {
        scope: CLAW_PACKAGE_LIFECYCLE_LEASE_SCOPE,
        key: identity.key,
        owner: identity.owner,
      });
    },
  );
}
