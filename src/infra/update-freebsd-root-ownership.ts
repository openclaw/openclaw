import type { BigIntStats } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { resolveConfigPath, resolveStateDir } from "../config/paths.js";
import { runCommandBuffered } from "../process/exec.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import {
  ABSOLUTE_DEADLINE_EXPIRED,
  awaitWithinDeadline,
  scheduleAbsoluteDeadline,
} from "../utils/absolute-deadline.js";
import { resolveRequiredHomeDir, resolveRequiredOsHomeDir } from "./home-dir.js";
import { hasNodeErrorCode } from "./path-guards.js";

export class FreeBsdUpdateRootOwnershipError extends Error {
  readonly reason = "freebsd-update-ownership";

  constructor() {
    super(
      "FreeBSD foreground updates require real and effective root identity, root-owned physical installation and state paths, and trivial ACLs. Use the installation's owning account and physical paths; resolve foreign ownership, writable ancestors, or unavailable ACL inspection before retrying. No ownership or permissions were changed.",
    );
    this.name = "FreeBsdUpdateRootOwnershipError";
  }
}

export class FreeBsdUpdateServiceDiscoveryError extends Error {
  readonly reason: "freebsd-service-present" | "freebsd-service-inspection-unavailable";

  constructor(status: "present" | "unknown", detail?: string) {
    super(
      status === "present"
        ? "FreeBSD foreground updates require no openclaw rc.d definition. An existing definition was found; update through its service owner. This command does not manage rc.d services."
        : `FreeBSD rc.d absence could not be verified${detail ? ` (${detail})` : ""}. Inspect the native service definition and resolve discovery before retrying; no service was changed.`,
    );
    this.name = "FreeBsdUpdateServiceDiscoveryError";
    this.reason =
      status === "present" ? "freebsd-service-present" : "freebsd-service-inspection-unavailable";
  }
}

function admissionBudget(timeoutMs: number | undefined): number {
  return Number.isFinite(timeoutMs) ? Math.min(10_000, Math.max(1, timeoutMs!)) : 10_000;
}

/** Read-only admission, outside SQLite commit sections. The invoking code and
 * native tools must already be trusted; this cannot secure code already loaded. */
export async function assertFreeBsdUpdateRootOwnership(params: {
  roots: readonly string[];
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
}): Promise<void> {
  if (process.platform !== "freebsd") {
    return;
  }
  const refuse = (): never => {
    throw new FreeBsdUpdateRootOwnershipError();
  };
  if (process.getuid?.() !== 0 || process.geteuid?.() !== 0) {
    refuse();
  }
  const env = params.env ?? process.env;
  const deadline = Date.now() + admissionBudget(params.timeoutMs);
  const controller = new AbortController();
  const cancelDeadline = scheduleAbsoluteDeadline(deadline, () => controller.abort());
  const read = async <T>(operation: () => Promise<T>): Promise<T> => {
    const value = await awaitWithinDeadline(operation, deadline);
    return value === ABSOLUTE_DEADLINE_EXPIRED ? refuse() : value;
  };
  const stat = (file: string) =>
    read(() =>
      fs.lstat(file, { bigint: true }).catch((error: unknown) => {
        if (hasNodeErrorCode(error, "ENOENT")) {
          return null;
        }
        throw error;
      }),
    );
  const query = async (argv: string[]) => {
    if (controller.signal.aborted || Date.now() >= deadline) {
      refuse();
    }
    // The decision deadline cancels native work, but cleanup can finish later.
    // Await its owner rather than abandon a running query in a deadline race.
    const result = await runCommandBuffered(argv, {
      timeoutMs: Math.max(1, deadline - Date.now()),
      signal: controller.signal,
      env: { LC_ALL: "C" },
      maxOutputBytes: { stdout: 8192, stderr: 8192 },
    });
    if (
      controller.signal.aborted ||
      Date.now() >= deadline ||
      result.termination !== "exit" ||
      result.code !== 0 ||
      result.stderr.length !== 0
    ) {
      refuse();
    }
    return result.stdout.toString("utf8");
  };
  const inspectAcls = async (files: string[], defaults: boolean) => {
    let batch: string[] = [];
    let bytes = 0;
    const flush = async () => {
      if (batch.length === 0) {
        return;
      }
      const output = await query([
        "/bin/getfacl",
        ...(defaults ? ["-d"] : []),
        "-q",
        "-n",
        ...(defaults ? [] : ["-s"]),
        "--",
        ...batch,
      ]);
      // -s emits nothing for trivial access ACLs. Empty POSIX default ACLs
      // still have one native separator between paths; actual entries refuse.
      if (output !== (defaults ? "\n".repeat(batch.length - 1) : "")) {
        refuse();
      }
      batch = [];
      bytes = 0;
    };
    for (const file of files) {
      const size = Buffer.byteLength(file, "utf8") + 1;
      // Bound argv below FreeBSD's ARG_MAX, independently of the path-count cap.
      if (size > 16_384) {
        refuse();
      }
      if (batch.length === 32 || bytes + size > 16_384) {
        await flush();
      }
      batch.push(file);
      bytes += size;
    }
    await flush();
  };
  try {
    const database = resolveOpenClawStateSqlitePath(env);
    const targets = [
      ...params.roots,
      resolveRequiredHomeDir(env),
      resolveRequiredOsHomeDir(env),
      resolveStateDir(env),
      resolveConfigPath(env),
      database,
      ...["-wal", "-shm", "-journal"].map((suffix) => database + suffix),
    ];
    const observations = new Map<string, BigIntStats | null>();
    for (const target of targets) {
      let cursor = path.resolve(target);
      while (!observations.has(cursor)) {
        if (observations.size >= 512) {
          refuse();
        }
        const observed = await stat(cursor);
        if (
          observed &&
          (observed.uid !== 0n ||
            (observed.mode & 0o022n) !== 0n ||
            (!observed.isDirectory() && !observed.isFile()))
        ) {
          refuse();
        }
        observations.set(cursor, observed);
        const parent = path.dirname(cursor);
        if (parent === cursor) {
          break;
        }
        cursor = parent;
      }
    }
    // Native access batching preserves each vnode's ACL predicate. ACL_NFS4
    // must still be queried per directory: NFS can report different models.
    await inspectAcls(
      [...observations].flatMap(([file, observed]) => (observed ? [file] : [])),
      false,
    );
    const defaultAclPaths: string[] = [];
    for (const [file, observed] of observations) {
      if (observed?.isDirectory()) {
        const nfs4 = await query(["/usr/bin/getconf", "ACL_NFS4", file]);
        if (nfs4 !== "0\n" && nfs4 !== "1\n") {
          refuse();
        }
        if (nfs4 === "0\n") {
          defaultAclPaths.push(file);
        }
      }
    }
    await inspectAcls(defaultAclPaths, true);
    // No cached result authorizes a later phase. Reject identity/ACL metadata
    // changes during these awaits, including an entry appearing under a trusted parent.
    for (const [file, before] of observations) {
      const after = await stat(file);
      if (
        before === null || after === null
          ? before !== after
          : (["dev", "ino", "uid", "gid", "mode", "ctimeNs"] as const).some(
              (key) => before[key] !== after[key],
            )
      ) {
        refuse();
      }
    }
    if (process.getuid?.() !== 0 || process.geteuid?.() !== 0) {
      refuse();
    }
  } catch {
    refuse();
  } finally {
    cancelDeadline();
  }
}

/** Global rc absence is update eligibility, independent of whether this profile
 * may mutate services. Keep it in every fresh admission and phase revalidation. */
export async function assertFreeBsdForegroundUpdateAdmission(
  params: Parameters<typeof assertFreeBsdUpdateRootOwnership>[0],
): Promise<void> {
  if (process.platform !== "freebsd") {
    return;
  }
  const deadline = Date.now() + admissionBudget(params.timeoutMs);
  await assertFreeBsdUpdateRootOwnership(params);
  const { readFreeBsdGatewayServiceDiscovery } = await import("../daemon/freebsd-service.js");
  const remaining = deadline - Date.now();
  if (remaining <= 0) {
    throw new FreeBsdUpdateServiceDiscoveryError("unknown", "admission deadline expired");
  }
  const discovery = await readFreeBsdGatewayServiceDiscovery({ timeoutMs: remaining });
  if (Date.now() >= deadline) {
    throw new FreeBsdUpdateServiceDiscoveryError("unknown", "admission deadline expired");
  }
  if (discovery.status !== "absent") {
    throw new FreeBsdUpdateServiceDiscoveryError(
      discovery.status,
      discovery.status === "unknown" ? discovery.reason : undefined,
    );
  }
}

export type FreeBsdUpdateRootAdmission = {
  readonly canWrite: boolean;
  readonly failure:
    | FreeBsdUpdateRootOwnershipError
    | FreeBsdUpdateServiceDiscoveryError
    | undefined;
  assertCurrent: () => void;
  revalidate: (
    params: Parameters<typeof assertFreeBsdUpdateRootOwnership>[0],
    assertIdle: () => void,
  ) => Promise<void>;
};

/** Local admission survives executor release so failure reporting cannot reopen
 * rejected state. Workers must inspect afresh; this reference is not serializable authority. */
export async function admitFreeBsdUpdateRootOwnership(
  params: Parameters<typeof assertFreeBsdUpdateRootOwnership>[0],
): Promise<FreeBsdUpdateRootAdmission | undefined> {
  if (process.platform !== "freebsd") {
    return undefined;
  }
  let admitted = false;
  let checking = false;
  let revoked = false;
  let failure: FreeBsdUpdateRootAdmission["failure"];
  const admission: FreeBsdUpdateRootAdmission = {
    get canWrite() {
      return admitted && !checking && !revoked;
    },
    get failure() {
      return failure;
    },
    assertCurrent() {
      if (!admission.canWrite) {
        throw failure ?? new FreeBsdUpdateRootOwnershipError();
      }
    },
    async revalidate(next, assertIdle) {
      if (checking || revoked) {
        revoked = true;
        failure ??= new FreeBsdUpdateRootOwnershipError();
        throw failure;
      }
      // Signal/failure callbacks cannot write while native admission is pending.
      // An earlier rejection is irreversible, including a concurrent rejected recheck.
      checking = true;
      try {
        assertIdle();
        await assertFreeBsdForegroundUpdateAdmission(next);
        assertIdle();
        if (revoked) {
          throw new FreeBsdUpdateRootOwnershipError();
        }
        admitted = true;
      } catch (error) {
        revoked = true;
        failure ??=
          error instanceof FreeBsdUpdateRootOwnershipError ||
          error instanceof FreeBsdUpdateServiceDiscoveryError
            ? error
            : new FreeBsdUpdateRootOwnershipError();
        throw failure;
      } finally {
        checking = false;
      }
    },
  };
  // Initial admission precedes creation of any run/executor or delegated child.
  await admission.revalidate(params, () => {});
  return admission;
}
