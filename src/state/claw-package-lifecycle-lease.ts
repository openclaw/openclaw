import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { formatErrorMessage } from "../infra/errors.js";
import {
  runOpenClawStateWriteTransaction,
  type OpenClawStateDatabaseOptions,
} from "./openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "./openclaw-state-db.paths.js";
import {
  acquireOpenClawStateLeaseInTransaction,
  releaseOpenClawStateLeaseInTransaction,
  renewOpenClawStateLeaseInTransaction,
} from "./openclaw-state-lease-store.js";
import type { OpenClawStateLeaseIdentity } from "./openclaw-state-lease.types.js";

type ClawPackageLifecycleArtifact =
  | { kind: "plugin"; source: "clawhub"; ref: string }
  | { kind: "skill"; source: "clawhub"; ref: string; workspace: string };

type ClawPackageLifecycleLease = {
  heartbeat: (nowMs?: number) => void;
  release: () => void;
};

export type MaintainedClawPackageLifecycleLease = {
  assertCurrent: () => void;
  release: () => void;
};

const writeAuthorities = new WeakMap<
  object,
  {
    identity: OpenClawStateLeaseIdentity;
    artifact: ClawPackageLifecycleArtifact;
    path: string;
    assertCurrent: () => void;
  }
>();

export function captureClawPackageLifecycleWriteAuthority(
  lease: MaintainedClawPackageLifecycleLease,
  artifact: Pick<ClawPackageLifecycleArtifact, "kind" | "source" | "ref">,
) {
  const authority = writeAuthorities.get(lease);
  if (
    !authority ||
    authority.artifact.kind !== artifact.kind ||
    authority.artifact.source !== artifact.source ||
    authority.artifact.ref !== artifact.ref
  ) {
    throw new Error("Package write requires its original lifecycle owner.");
  }
  authority.assertCurrent();
  return authority;
}

type ClawPackageLifecycleLeaseOptions = OpenClawStateDatabaseOptions & {
  nowMs?: number;
  owner?: string;
  required?: boolean;
};

const LEASE_SCOPE = "claw-package-lifecycle";
const LEASE_TTL_MS = 5 * 60_000;

class ClawPackageLifecycleBusyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ClawPackageLifecycleBusyError";
  }
}

function packageLeaseKey(artifact: ClawPackageLifecycleArtifact): string {
  if (artifact.kind === "skill") {
    return `skill:${artifact.source}:workspace:${resolve(artifact.workspace)}`;
  }
  return `${artifact.kind}:${artifact.source}:${artifact.ref}`;
}

/** Serializes shared package ownership and artifact mutation across processes. */
export function acquireClawPackageLifecycleLease(
  artifact: ClawPackageLifecycleArtifact,
  options: ClawPackageLifecycleLeaseOptions = {},
): ClawPackageLifecycleLease | null {
  const env = options.env ?? process.env;
  const databasePath = options.path ?? resolveOpenClawStateSqlitePath(env);
  const nowMs = options.nowMs ?? Date.now();
  const expiresAt = nowMs + LEASE_TTL_MS;
  const identity = {
    owner: options.owner ?? randomUUID(),
    scope: LEASE_SCOPE,
    key: packageLeaseKey(artifact),
  };

  try {
    runOpenClawStateWriteTransaction(
      ({ db }) => {
        const acquired = acquireOpenClawStateLeaseInTransaction(
          db,
          identity,
          LEASE_TTL_MS,
          JSON.stringify(artifact),
          nowMs,
        );
        if (acquired.kind === "held") {
          throw new ClawPackageLifecycleBusyError(
            `Package ${artifact.ref} is being changed by another OpenClaw lifecycle; retry after ${new Date(acquired.holder.expiresAt ?? expiresAt).toISOString()}.`,
          );
        }
      },
      { env, path: databasePath },
    );
  } catch (error) {
    if (options.required || error instanceof ClawPackageLifecycleBusyError) {
      throw error;
    }
    return null;
  }

  let active = true;
  const lease: ClawPackageLifecycleLease = {
    heartbeat: (heartbeatNowMs = Date.now()) => {
      runOpenClawStateWriteTransaction(
        ({ db }) => {
          const renewed = renewOpenClawStateLeaseInTransaction(
            db,
            identity,
            LEASE_TTL_MS,
            undefined,
            heartbeatNowMs,
          );
          if (renewed === undefined) {
            throw new Error(`Package lifecycle lease was lost for ${artifact.ref}.`);
          }
        },
        { env, path: databasePath },
      );
    },
    release: () => {
      active = false;
      runOpenClawStateWriteTransaction(
        ({ db }) => releaseOpenClawStateLeaseInTransaction(db, identity),
        { env, path: databasePath },
      );
    },
  };
  writeAuthorities.set(lease, {
    identity,
    artifact: { ...artifact },
    path: databasePath,
    assertCurrent: () => {
      if (!active) {
        throw new Error("Package lifecycle lease has been released.");
      }
    },
  });
  return lease;
}

/** Renews an acquired lease while an asynchronous package mutation is in flight. */
export function maintainClawPackageLifecycleLease(
  lease: ClawPackageLifecycleLease,
): MaintainedClawPackageLifecycleLease {
  let heartbeatError: unknown;
  const heartbeat = setInterval(() => {
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
    writeAuthorities.get(lease)?.assertCurrent();
  };
  const maintained: MaintainedClawPackageLifecycleLease = {
    assertCurrent: () => {
      assertActive();
      lease.heartbeat();
    },
    release: () => {
      clearInterval(heartbeat);
      lease.release();
    },
  };
  const authority = writeAuthorities.get(lease);
  if (authority) {
    writeAuthorities.set(maintained, { ...authority, assertCurrent: assertActive });
  }
  return maintained;
}

export async function withClawPackageLifecycleLease<T>(
  artifact: ClawPackageLifecycleArtifact,
  operation: () => Promise<T>,
  options: ClawPackageLifecycleLeaseOptions = {},
): Promise<T> {
  const lease = acquireClawPackageLifecycleLease(artifact, options);
  if (!lease) {
    return await operation();
  }
  const maintained = maintainClawPackageLifecycleLease(lease);
  // CLI failures call process.exit(), which skips async finally blocks. Release
  // synchronously on exit so the next package command is not blocked until TTL.
  const release = () => {
    try {
      maintained.release();
    } catch {
      // Expiry recovers a lease whose cleanup cannot reach the shared database.
    }
  };
  process.once("exit", release);
  try {
    const result = await operation();
    maintained.assertCurrent();
    return result;
  } finally {
    process.removeListener("exit", release);
    release();
  }
}
