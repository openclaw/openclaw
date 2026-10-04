import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { resolveExecutablePath } from "./executable-path.js";
import type { PackageActivationRuntime } from "./package-update-activation-runtime.types.js";
import type { PackageActivationRecord } from "./package-update-activation-schema.js";

const PACKAGE_ACTIVATION_PREFIX = ".openclaw.package-activation-";

export function packageActivationRuntimeIdentity(file: string): string {
  const stat = fs.lstatSync(file, { bigint: true });
  // System runtimes may be root-owned even when the installation is user-owned.
  if (!stat.isFile() || stat.ino === 0n) {
    throw new Error("Package recovery requires a regular external runtime executable.");
  }
  return [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join(":");
}

export function capturePackageActivationRuntime(
  kind: PackageActivationRuntime["kind"],
  executable: string,
): PackageActivationRuntime {
  const resolved = resolveExecutablePath(executable, { useCache: false });
  if (!resolved) {
    throw new Error("The selected package recovery executable could not be resolved.");
  }
  const runtimePath = fs.realpathSync(resolved);
  return { kind, path: runtimePath, identity: packageActivationRuntimeIdentity(runtimePath) };
}

export function resolvePackageActivationAnchor(installKey: string): string {
  const key = createHash("sha256").update(installKey).digest("hex").slice(0, 24);
  return path.join(path.dirname(installKey), `${PACKAGE_ACTIVATION_PREFIX}${key}`);
}

export function isPackageActivationControlName(name: string): boolean {
  return (
    name.startsWith(PACKAGE_ACTIVATION_PREFIX) &&
    /^[a-f0-9]{24}\.control$/u.test(name.slice(PACKAGE_ACTIVATION_PREFIX.length))
  );
}

export function resolvePackageActivationControl(anchor: string): string {
  return `${anchor}.control`;
}

export function resolvePackageActivationJournalPath(anchor: string): string {
  return path.join(resolvePackageActivationControl(anchor), "operation.sqlite");
}

export function resolvePackageActivationHelper(anchor: string): string {
  return path.join(resolvePackageActivationControl(anchor), "recovery.mjs");
}

export function packageActivationIdentity(
  file: string,
  directory: boolean | "launcher" | "parent" | "symlink",
): string {
  const stat = fs.lstatSync(file, { bigint: true });
  const expectedUid = process.getuid?.();
  const validType =
    directory === "launcher"
      ? stat.isSymbolicLink() || stat.isFile()
      : directory === "symlink"
        ? stat.isSymbolicLink()
        : directory
          ? stat.isDirectory() && !stat.isSymbolicLink()
          : stat.isFile();
  // Prefix parents are observed for replacement, not published as owned objects.
  const foreignOwner =
    directory !== "parent" && expectedUid !== undefined && stat.uid !== BigInt(expectedUid);
  const reason =
    stat.ino === 0n
      ? "missing inode"
      : !validType
        ? "unexpected type"
        : foreignOwner
          ? "owner mismatch"
          : null;
  if (reason) {
    throw new Error(
      `Package publication object ${JSON.stringify(file)} has an unsafe identity (${reason}; owner UID ${stat.uid}, expected UID ${expectedUid ?? "unavailable"}). Verify this object's ownership and type before retrying openclaw update.`,
    );
  }
  return `${stat.dev}:${stat.ino}`;
}

export function privatePackageActivationIdentity(
  file: string,
  role: "anchor" | "control" | "journal" | "helper" | "rollback-journal",
): string {
  const directory = role === "anchor" || role === "control";
  const value = packageActivationIdentity(file, directory);
  const stat = fs.lstatSync(file);
  if ((stat.mode & 0o077) !== 0 || (!directory && stat.nlink !== 1)) {
    const basename = path
      .basename(file)
      .replace(/[^A-Za-z0-9_.-]/gu, "_")
      .slice(0, 64);
    const mode = (stat.mode & 0o7777).toString(8).padStart(4, "0");
    throw new Error(
      `Package recovery ${role} ${JSON.stringify(basename)} unsafe: mode=${mode} nlink=${stat.nlink} uid=${stat.uid}; expected owner-only mode${directory ? "" : " nlink=1"}.`,
    );
  }
  return value;
}

export function assertPackageActivationLayout(anchor: string): void {
  if (
    [path.join(anchor, "operation.sqlite"), `${anchor}.sqlite`, `${anchor}.recovery.mjs`].some(
      (file) => fs.lstatSync(file, { throwIfNoEntry: false }),
    )
  ) {
    throw new Error(
      "Legacy package activation artifacts require their original recovery owner; no migration is performed.",
    );
  }
}

/** A receipt is a read-only completion fact, never a grant for another effect. */
export function isPackageActivationComplete(
  anchor: string,
  record: PackageActivationRecord,
): boolean {
  if (record.phase === "superseded") {
    if (
      record.intent?.kind !== "superseded-by-manual-install" &&
      record.intent?.kind !== "recovery-lease-identity-changed"
    ) {
      throw new Error("Package supersession fact is missing.");
    }
    if (
      !record.intent.settled ||
      fs.lstatSync(anchor, { throwIfNoEntry: false }) ||
      fs.lstatSync(resolvePackageActivationHelper(anchor), { throwIfNoEntry: false })
    ) {
      return false;
    }
    const retained = `${anchor}.superseded-${record.descriptor.operationId}`;
    return (
      packageActivationIdentity(retained, true) === record.descriptor.anchorIdentity &&
      packageActivationIdentity(path.join(retained, "recovery.mjs"), false) ===
        record.descriptor.helperIdentity
    );
  }
  if (record.phase !== "anchor-retired" || record.intent?.kind !== "unlink-helper") {
    return false;
  }
  if (record.intent.identity !== record.descriptor.helperIdentity) {
    throw new Error("Final helper unlink identity is invalid.");
  }
  for (const file of [anchor, resolvePackageActivationHelper(anchor)]) {
    try {
      fs.lstatSync(file);
      return false;
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
        throw error;
      }
    }
  }
  return true;
}
