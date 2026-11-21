import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { extractErrorCode } from "@openclaw/normalization-core/error-coercion";
import { isStatePostgres } from "../state/openclaw-state-db-engine.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { acquireFileLockSync } from "./file-lock-manager.js";
import { resolveLegacyGatewayLockPath } from "./gateway-lock-legacy.js";
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

type ObservedFile = { path: string; raw: string; identity: string; holder: LockPayload | null };

/** Bounded sidecar metadata, the same limit the file-lock holder reader applies. */
const MAX_LEGACY_LOCK_BYTES = 16_384;

/** Only this user may own or write a record that recovery will show and clear. */
function describeUntrustedLegacyEntry(stat: { uid: bigint; mode: bigint }): string | undefined {
  const uid = process.getuid?.();
  if (uid === undefined) {
    return "the current user id is unavailable";
  }
  if (stat.uid !== BigInt(uid)) {
    return "it is not owned by the current user";
  }
  if ((stat.mode & 0o022n) !== 0n) {
    return "it is writable by other users";
  }
  return undefined;
}

/**
 * Every parent of the legacy lock directory must be controlled by this user or by root, and
 * a parent that others may write must carry sticky protection: otherwise another local user
 * could rename a parent and redirect the confirmed path between inspection and confirmation.
 * Returns the canonical directory. Ownership and mode bits are the checked facts; ACL entries
 * are not inspected.
 */
function resolveTrustedLegacyLockDir(directory: string): { canonical?: string; reason?: string } {
  const uid = process.getuid?.();
  if (uid === undefined) {
    return { reason: "the current user id is unavailable" };
  }
  // The configured path is walked before it is resolved: a symlink in it that another
  // account controls could redirect the lookup to a directory that passes every later check.
  for (let link = path.resolve(directory); ; link = path.dirname(link)) {
    const stat = fs.lstatSync(link, { bigint: true });
    const owner = Number(stat.uid);
    if (stat.isSymbolicLink() && owner !== uid && owner !== 0) {
      return { reason: `${link} is a symbolic link controlled by another user` };
    }
    if (path.dirname(link) === link) {
      break;
    }
  }
  const canonical = fs.realpathSync.native(directory);
  for (let parent = path.dirname(canonical); ; parent = path.dirname(parent)) {
    const stat = fs.lstatSync(parent, { bigint: true });
    const owner = Number(stat.uid);
    if (!stat.isDirectory() || (owner !== uid && owner !== 0)) {
      return { reason: `its parent directory ${parent} is controlled by another user` };
    }
    if ((stat.mode & 0o022n) !== 0n && (stat.mode & 0o1000n) === 0n) {
      return {
        reason: `its parent directory ${parent} is writable by others without sticky protection`,
      };
    }
    if (path.dirname(parent) === parent) {
      return { canonical };
    }
  }
}

function readObservedFile(
  pathname: string,
  trusted: (stat: fs.BigIntStats) => boolean = () => true,
): ObservedFile | null {
  let fd: number;
  try {
    fd = fs.openSync(
      pathname,
      fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0),
    );
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
    if (!trusted(stat)) {
      return null;
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

/**
 * The historical lock lives in a shared temporary directory, so its bytes are read only from a
 * bounded regular file that this user alone owns and may write, inside a directory with the
 * same ownership and a trusted parent chain. Anything else is reported, not read, and leaves
 * state-local recovery available. An absent file is simply absent.
 */
function readLegacyObservedFile(pathname: string): {
  observed: ObservedFile | null;
  note?: string;
} {
  const skipped = (reason: string) => ({
    observed: null,
    note: `Legacy Gateway lock ${pathname} was not inspected because ${reason}. Check that entry as the Gateway service account with the Gateway stopped, then inspect again.`,
  });
  try {
    fs.lstatSync(pathname);
  } catch (error) {
    return extractErrorCode(error) === "ENOENT"
      ? { observed: null }
      : skipped(error instanceof Error ? error.message : String(error));
  }
  try {
    const directory = path.dirname(pathname);
    const dir = fs.lstatSync(directory, { bigint: true });
    if (!dir.isDirectory()) {
      return skipped("its directory is not a directory");
    }
    const untrustedDir = describeUntrustedLegacyEntry(dir);
    if (untrustedDir) {
      return skipped(`its directory ${untrustedDir.replace(/^it /, "")}`);
    }
    const trusted = resolveTrustedLegacyLockDir(directory);
    if (!trusted.canonical) {
      return skipped(trusted.reason ?? "its location cannot be verified");
    }
    const canonicalPath = path.join(trusted.canonical, path.basename(pathname));
    let reason: string | undefined;
    const observed = readObservedFile(canonicalPath, (stat) => {
      reason =
        describeUntrustedLegacyEntry(stat) ??
        (stat.size > MAX_LEGACY_LOCK_BYTES
          ? `it is larger than ${MAX_LEGACY_LOCK_BYTES} bytes`
          : undefined);
      return reason === undefined;
    });
    return reason ? skipped(reason) : { observed };
  } catch (error) {
    return skipped(error instanceof Error ? error.message : String(error));
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
  // Doctor maintenance also refuses on the historical config lock in the system temporary
  // directory; a service TMPDIR inside the state directory makes it the same file as above.
  // Only Linux needs this: macOS and Windows admit a stopped namespace-less owner by themselves.
  const notes: string[] = [];
  const legacyLockPath = resolveLegacyGatewayLockPath(env);
  const legacy =
    process.platform !== "linux" ||
    lockPaths.some((pathname) => path.resolve(pathname) === path.resolve(legacyLockPath))
      ? { observed: null }
      : readLegacyObservedFile(legacyLockPath);
  if (legacy.note) {
    notes.push(legacy.note);
  }
  if (
    legacy.observed &&
    !files.some(({ observed }) => observed?.identity === legacy.observed?.identity)
  ) {
    // First in line, so a failure to take custody of it leaves the state-local records intact.
    files.unshift({ path: legacy.observed.path, observed: legacy.observed });
  }
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
    ...(notes.length > 0 ? { notes } : {}),
    present: holders.length > 0,
  };
}

/** Explicit operator confirmation is bound to file identity, bytes, heartbeat and lease facts. */
export async function recoverGatewayLock(options: { confirmation: string }) {
  const inspection = await inspectGatewayLockRecovery();
  if (inspection.confirmation !== options.confirmation) {
    throw new Error(
      "Gateway lock or heartbeat changed since inspection; run `openclaw gateway recover-lock` again.",
    );
  }
  if (inspection.postgres) {
    assertPostgresGatewayRecoveryMutationSupported(inspection.postgres);
  }
  if (!inspection.present) {
    return {
      recovered: false,
      removed: 0,
      ...(inspection.notes ? { notes: inspection.notes } : {}),
    };
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
  return {
    recovered: inspection.present,
    removed: inspection.holders.length,
    ...(inspection.notes ? { notes: inspection.notes } : {}),
  };
}
