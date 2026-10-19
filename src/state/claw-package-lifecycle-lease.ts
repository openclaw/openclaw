import { formatErrorMessage } from "../infra/errors.js";
import {
  CLAW_PACKAGE_LIFECYCLE_LEASE_SCOPE,
  clawPackageLifecycleLeaseKey,
  type ClawPackageLifecycleArtifact,
} from "./claw-package-lifecycle-lease-key.js";
import type { OpenClawStateDatabaseOptions } from "./openclaw-state-db.js";
import { OpenClawStateLeaseError } from "./openclaw-state-lease-error.js";
import { withOpenClawStateLease, type OpenClawStateLeaseContext } from "./openclaw-state-lease.js";

export type ClawPackageLifecycleLeaseIdentity = {
  scope: typeof CLAW_PACKAGE_LIFECYCLE_LEASE_SCOPE;
  key: string;
  owner: string;
};

type ClawPackageLifecycleLease = {
  identity: ClawPackageLifecycleLeaseIdentity;
  heartbeat: (nowMs?: number) => void;
  assertCurrent?: () => void;
  release: () => Promise<void> | void;
};

export type MaintainedClawPackageLifecycleLease = {
  identity: ClawPackageLifecycleLeaseIdentity;
  assertCurrent: () => void;
  withHeartbeatPaused: <T>(operation: () => Promise<T>) => Promise<T>;
  release: () => Promise<void> | void;
};

type ClawPackageLifecycleLeaseOptions = OpenClawStateDatabaseOptions & {
  required?: boolean;
};

const LEASE_TTL_MS = 5 * 60_000;

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
          lease.assertOwned();
        },
        heartbeat: () => {
          if (!active) {
            throw new Error("Package lifecycle lease has been released.");
          }
          lease.assertOwned();
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

/** Check an Add lease during asynchronous package installation; its state owner renews it. */
export function maintainClawPackageLifecycleLease(
  lease: ClawPackageLifecycleLease,
): MaintainedClawPackageLifecycleLease {
  let heartbeatError: unknown;
  let paused = 0;
  const heartbeat = setInterval(() => {
    if (paused > 0) {
      return;
    }
    try {
      lease.heartbeat();
    } catch (error) {
      heartbeatError ??= error;
    }
  }, LEASE_TTL_MS / 3);
  heartbeat.unref();
  const assertActive = () => {
    if (heartbeatError) {
      throw heartbeatError instanceof Error
        ? heartbeatError
        : new Error(formatErrorMessage(heartbeatError));
    }
    lease.assertCurrent?.();
  };
  return {
    identity: lease.identity,
    assertCurrent: () => {
      assertActive();
      lease.heartbeat();
    },
    async withHeartbeatPaused<T>(operation: () => Promise<T>): Promise<T> {
      paused++;
      try {
        return await operation();
      } finally {
        paused--;
      }
    },
    release: () => {
      clearInterval(heartbeat);
      return lease.release();
    },
  };
}

/** Retain shared artifact ownership through asynchronous work and worker settlement. */
export function withClawPackageLifecycleLease<T>(
  artifact: ClawPackageLifecycleArtifact,
  operation: (
    lease: OpenClawStateLeaseContext,
    identity: ClawPackageLifecycleLeaseIdentity,
  ) => Promise<T>,
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
    (lease, identity) => {
      return operation(lease, {
        scope: CLAW_PACKAGE_LIFECYCLE_LEASE_SCOPE,
        key: identity.key,
        owner: identity.owner,
      });
    },
  );
}
