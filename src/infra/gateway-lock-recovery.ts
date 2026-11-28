import { createHash } from "node:crypto";
import fs from "node:fs";
import { extractErrorCode } from "@openclaw/normalization-core/error-coercion";
import { safeParseJsonRecord } from "@openclaw/normalization-core/json-coercion";
import { z } from "zod";
import { getProcessStartTime } from "../shared/pid-alive.js";
import { isStatePostgres } from "../state/openclaw-state-db-engine.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { acquireFileLockSync } from "./file-lock-manager.js";
import {
  describeGatewayLockHolder,
  GatewayProcessNamespaceSchema,
  readGatewayLockProcessNamespace,
  parseGatewayLockPayload,
  type LockPayload,
} from "./gateway-lock-payload.js";
import {
  assertGatewayRecoveryLeaseNotLive,
  inspectGatewayRecoveryLease,
  removeGatewayRecoveryLease,
} from "./gateway-lock-recovery-lease.js";
import {
  assertPostgresGatewayRecoveryMutationSupported,
  inspectPostgresGatewayRecovery,
  recoverPostgresGatewayLease,
} from "./gateway-lock-recovery-postgres.js";
import { resolveGatewayLockPaths, resolveGatewayOwnerStatus } from "./gateway-lock.js";
import { decodeGatewayOwnerLease } from "./gateway-owner-lease.read.js";
import { defaultPayload } from "./gateway-state-owner-record.js";
import { acquireGatewayStateOwner, type StateDatabaseSchemaLease } from "./gateway-state-owner.js";
import { throwSqliteLifecycleErrors } from "./sqlite-lifecycle-errors.js";
import { readSameNamespaceProcessOwnerStatus } from "./state-lease-process-owner.js";

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
  const postgres = isStatePostgres()
    ? await inspectPostgresGatewayRecovery(databasePath)
    : undefined;
  const lease = postgres ? postgres.lease : await inspectGatewayRecoveryLease(databasePath);
  const confirmation = createHash("sha256")
    .update(JSON.stringify({ databasePath, files, lease, postgres }))
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
      `${postgres ? "PostgreSQL" : "SQLite"} Gateway owner lease: ${describeGatewayLockHolder(decodeGatewayOwnerLease(lease) ?? {}, undefined, "unknown")}`,
    );
  }
  return {
    databasePath,
    files,
    lease,
    postgres,
    confirmation,
    holders,
    present: holders.length > 0,
  };
}

const terminatedNamespaceSchema = GatewayProcessNamespaceSchema.options[0].extend({
  pidNsInode: z.string().regex(/^[1-9]\d*$/u),
  pidNsInitStartTicks: z.number().int().nonnegative(),
});

/** The supervisor verifies termination. OpenClaw verifies which holders belonged to it. */
function assertTerminatedNamespace(
  inspection: Awaited<ReturnType<typeof inspectGatewayLockRecovery>>,
  namespace: unknown,
) {
  const parsed = terminatedNamespaceSchema.safeParse(namespace);
  const local = readGatewayLockProcessNamespace();
  if (!parsed.success || local?.platform !== "linux") {
    throw new Error("Recovery requires the kernel identity of a terminated Linux PID namespace.");
  }
  const expected = parsed.data;
  const sharesPidNumbers =
    expected.identity === local.identity && expected.pidNsInode === local.pidNsInode;
  const ownNamespace = sharesPidNumbers && getProcessStartTime(1) === expected.pidNsInitStartTicks;
  function assertHolder(
    label: string,
    holder: {
      processNamespace?: LockPayload["processNamespace"];
      pid: number;
      startTime?: number | null;
    },
    matchesIncarnation: boolean,
  ) {
    const { processNamespace: placement, pid, startTime } = holder;
    if (
      placement?.platform !== "linux" ||
      placement.host !== expected.host ||
      placement.identity !== expected.identity ||
      placement.pidNsInode !== expected.pidNsInode ||
      !matchesIncarnation ||
      !Number.isSafeInteger(pid) ||
      pid <= 0
    ) {
      throw new Error(`${label} does not belong to the supplied namespace.`);
    }
    // A local PID can still be live under another UTS hostname or after inode reuse.
    if (
      sharesPidNumbers &&
      readSameNamespaceProcessOwnerStatus({
        pid,
        startedAt:
          typeof startTime === "number" && Number.isSafeInteger(startTime) && startTime >= 0
            ? startTime
            : null,
      }) !== "dead"
    ) {
      throw new Error(`Cannot verify that PID ${pid} stopped in the supplied namespace.`);
    }
  }
  for (const { observed } of inspection.files) {
    if (!observed) {
      continue;
    }
    const holder = observed.holder;
    if (!holder) {
      throw new Error(`Cannot identify the Gateway holder at ${observed.path}.`);
    }
    // Only locally comparable PIDs can be checked without a recorded PID 1 start time.
    const matchesIncarnation =
      holder.pidNsInitStartTicks === undefined
        ? ownNamespace
        : holder.role !== undefined && holder.pidNsInitStartTicks === expected.pidNsInitStartTicks;
    assertHolder(observed.path, holder, matchesIncarnation);
  }
  if (inspection.lease) {
    const owner = decodeGatewayOwnerLease(inspection.lease);
    const payload = safeParseJsonRecord(inspection.lease.payloadJson ?? "");
    if (!owner || owner.host !== expected.host) {
      throw new Error("Gateway owner lease does not belong to the supplied namespace.");
    }
    assertHolder(
      "Gateway owner lease",
      { ...owner, startTime: owner.startedAt },
      payload?.pidNsInitStartTicks === expected.pidNsInitStartTicks,
    );
  }
}

export async function recoverGatewayLock(
  options: { confirmation: string } | { terminatedNamespace: unknown },
) {
  const inspection = await inspectGatewayLockRecovery();
  if ("terminatedNamespace" in options) {
    assertTerminatedNamespace(inspection, options.terminatedNamespace);
  } else if (inspection.confirmation !== options.confirmation) {
    throw new Error("Gateway lock or heartbeat changed since inspection; inspect the lock again.");
  }
  if (inspection.postgres) {
    assertPostgresGatewayRecoveryMutationSupported(inspection.postgres);
  }
  if (!inspection.present) {
    return { recovered: false, removed: 0 };
  }
  assertGatewayRecoveryLeaseNotLive(inspection.lease);
  for (const { observed } of inspection.files) {
    if (!observed?.holder) {
      continue;
    }
    const status = await resolveGatewayOwnerStatus(
      observed.holder.pid,
      observed.holder,
      process.platform,
      {
        lockPath: observed.path,
      },
    );
    if (
      status === "alive" ||
      (status !== "dead" &&
        process.platform === "win32" &&
        observed.holder.processNamespace === undefined)
    ) {
      throw new Error(
        `Gateway holder ${observed.holder.pid} ${status === "alive" ? "is still live" : "could not be verified dead"}; stop it before recovering its lock.`,
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
    if (inspection.postgres) {
      await recoverPostgresGatewayLease(
        inspection.databasePath,
        inspection.postgres,
        acquiredCustody,
      );
    } else {
      acquiredCustody.run(() =>
        removeGatewayRecoveryLease(inspection.databasePath, inspection.lease, acquiredCustody),
      );
    }
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
