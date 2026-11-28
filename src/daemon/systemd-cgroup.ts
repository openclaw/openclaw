import fs from "node:fs";
import path from "node:path";
import { hasErrnoCode } from "../infra/errno.js";

const CGROUP2_SUPER_MAGIC = 0x63677270;
const CGROUP_SUPER_MAGIC = 0x27e0eb;

function systemdControlGroupParts(controlGroup: string): string[] {
  const parts = controlGroup.split("/").slice(1);
  if (
    !controlGroup.startsWith("/") ||
    controlGroup === "/" ||
    parts.some((part) => !part || part === ".." || part === ".")
  ) {
    throw new Error("The systemd cgroup cannot be verified.");
  }
  return parts;
}

function isFilesystem(directory: string, magic: number): boolean {
  try {
    return fs.statfsSync(directory).type === magic;
  } catch {
    return false;
  }
}

function hasProcessesBelow(directory: string): boolean {
  let entries: fs.Dirent[];
  try {
    if (fs.readFileSync(path.join(directory, "cgroup.procs"), "utf8").trim()) {
      return true;
    }
    entries = fs.readdirSync(directory, { withFileTypes: true });
  } catch (error) {
    if (hasErrnoCode(error, "ENOENT")) {
      return false;
    }
    throw error;
  }
  return entries.some(
    (entry) => entry.isDirectory() && hasProcessesBelow(path.join(directory, entry.name)),
  );
}

/**
 * Whether no process remains in a systemd unit's cgroup, including descendants. A missing
 * group counts as empty only inside a hierarchy systemd is known to track units in: the
 * unified hierarchy (at the cgroup root, or `unified/` on hybrid hosts) or, on legacy hosts,
 * its named `systemd/` hierarchy. Anything else cannot be verified and throws.
 */
export function isSystemdControlGroupEmpty(
  controlGroup: string,
  cgroupRoot = "/sys/fs/cgroup",
): boolean {
  const parts = systemdControlGroupParts(controlGroup);
  const unified = [cgroupRoot, path.join(cgroupRoot, "unified")].find((root) =>
    isFilesystem(root, CGROUP2_SUPER_MAGIC),
  );
  if (unified) {
    try {
      // cgroup v2 populated includes descendants, unlike MainPID or cgroup.procs.
      const events = fs.readFileSync(path.join(unified, ...parts, "cgroup.events"), "utf8");
      const populated = /^populated ([01])$/mu.exec(events)?.[1];
      if (populated === undefined) {
        throw new Error("The systemd cgroup population is unavailable.");
      }
      return populated === "0";
    } catch (error) {
      if (hasErrnoCode(error, "ENOENT")) {
        return true;
      }
      throw error;
    }
  }
  const legacy = path.join(cgroupRoot, "systemd");
  if (isFilesystem(legacy, CGROUP_SUPER_MAGIC)) {
    return !hasProcessesBelow(path.join(legacy, ...parts));
  }
  throw new Error("The systemd cgroup hierarchy cannot be verified.");
}
