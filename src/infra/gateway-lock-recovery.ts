import { createHash } from "node:crypto";
import fs from "node:fs";
import { extractErrorCode } from "@openclaw/normalization-core/error-coercion";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { acquireFileLockSync } from "./file-lock-manager.js";
import {
  describeGatewayLockHolder,
  parseGatewayLockPayload,
  type LockPayload,
} from "./gateway-lock-payload.js";
import {
  assertGatewayRecoveryLeaseNotLive,
  inspectGatewayRecoveryLease,
  removeGatewayRecoveryLease,
} from "./gateway-lock-recovery-lease.js";
import { resolveGatewayLockPaths, resolveGatewayOwnerStatus } from "./gateway-lock.js";
import { decodeGatewayOwnerLease } from "./gateway-owner-lease.read.js";
import { defaultPayload } from "./gateway-state-owner-record.js";
import { acquireGatewayStateOwner, type StateDatabaseSchemaLease } from "./gateway-state-owner.js";
import { throwSqliteLifecycleErrors } from "./sqlite-lifecycle-errors.js";

type ObservedFile = { path: string; raw: string; identity: string; holder: LockPayload | null };

function readObservedFile(pathname: string): ObservedFile | null {
  let fd: number;
  try {
    fd = fs.openSync(pathname, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  } catch (error) {
    if (extractErrorCode(error) === "ENOENT") {
      return null;
    }
    throw error;
  }
  try {
    const stat = fs.fstatSync(fd, { bigint: true });
    if (!stat.isFile() || stat.nlink !== 1n) {
      throw new Error(`Gateway recovery requires a regular, single-link lock file: ${pathname}`);
    }
    const raw = fs.readFileSync(fd, "utf8");
    return {
      path: pathname,
      raw,
      identity: [stat.dev, stat.ino, stat.birthtimeNs, stat.ctimeNs, stat.mtimeNs, stat.size].join(
        ":",
      ),
      holder: parseGatewayLockPayload(raw),
    };
  } finally {
    fs.closeSync(fd);
  }
}

function sameObservation(actual: ObservedFile | null, expected: ObservedFile | null): boolean {
  return actual?.identity === expected?.identity && actual?.raw === expected?.raw;
}

export async function inspectGatewayLockRecovery(options: { env?: NodeJS.ProcessEnv } = {}) {
  const env = options.env ?? process.env;
  const paths = resolveGatewayLockPaths(env);
  const lockPaths = [paths.ownerLockPath, paths.stateLockPath, paths.configLockPath];
  const files = lockPaths.map((pathname) => ({
    path: pathname,
    observed: readObservedFile(pathname),
  }));
  const databasePath = resolveOpenClawStateSqlitePath(env);
  const lease = await inspectGatewayRecoveryLease(databasePath);
  const confirmation = createHash("sha256")
    .update(JSON.stringify({ databasePath, files, lease }))
    .digest("hex");
  const holders = files.flatMap(({ observed }) =>
    observed
      ? [
          `${observed.path}: ${describeGatewayLockHolder(observed.holder ?? {}, observed.path, "unknown")}`,
        ]
      : [],
  );
  if (lease) {
    holders.push(
      `SQLite Gateway owner lease: ${describeGatewayLockHolder(decodeGatewayOwnerLease(lease) ?? {}, undefined, "unknown")}`,
    );
  }
  return { databasePath, files, lease, confirmation, holders, present: holders.length > 0 };
}

/** Explicit operator confirmation is bound to file identity, bytes, heartbeat and lease facts. */
export async function recoverGatewayLock(options: { confirmation: string }) {
  const inspection = await inspectGatewayLockRecovery();
  if (inspection.confirmation !== options.confirmation) {
    throw new Error(
      "Gateway lock or heartbeat changed since inspection; run `openclaw gateway recover-lock` again.",
    );
  }
  if (!inspection.present) {
    return { recovered: false, removed: 0 };
  }
  assertGatewayRecoveryLeaseNotLive(inspection.lease);
  for (const { observed } of inspection.files) {
    if (
      observed?.holder &&
      (await resolveGatewayOwnerStatus(observed.holder.pid, observed.holder, process.platform, {
        lockPath: observed.path,
      })) === "alive"
    ) {
      throw new Error(
        `Gateway holder ${observed.holder.pid} is still live; stop it before recovering its lock.`,
      );
    }
  }
  const payload = defaultPayload(inspection.databasePath);
  const held: ReturnType<typeof acquireFileLockSync>[] = [];
  let custody: StateDatabaseSchemaLease | undefined;
  const errors: unknown[] = [];
  try {
    for (const { path: pathname, observed } of inspection.files) {
      const unchanged = () => {
        if (!sameObservation(readObservedFile(pathname), observed)) {
          throw new Error(`Gateway lock changed at ${pathname}; inspect the lock again.`);
        }
        return true;
      };
      unchanged();
      held.push(
        acquireFileLockSync(pathname, {
          lockPath: pathname,
          retry: { retries: 0 },
          timeoutMs: 0,
          staleRecovery: "remove-if-unchanged",
          reentrantOwner: payload.ownerId,
          payload: () => payload,
          parsePayload: (raw) => ({ raw }),
          shouldReclaim: unchanged,
          shouldRemoveStaleLock: ({ raw }) => {
            unchanged();
            return raw === observed?.raw;
          },
        }),
      );
    }
    const acquiredCustody = acquireGatewayStateOwner({
      databasePath: inspection.databasePath,
      payload,
    });
    custody = acquiredCustody;
    acquiredCustody.run(() =>
      removeGatewayRecoveryLease(inspection.databasePath, inspection.lease, acquiredCustody),
    );
  } catch (error) {
    errors.push(error);
  }
  try {
    custody?.release();
  } catch (error) {
    errors.push(error);
  }
  for (const handle of held.toReversed()) {
    try {
      handle.release();
    } catch (error) {
      errors.push(error);
    }
  }
  throwSqliteLifecycleErrors(errors, "Gateway lock recovery or cleanup failed.");
  return { recovered: inspection.present, removed: inspection.holders.length };
}
