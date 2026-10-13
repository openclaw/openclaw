import fs from "node:fs";
import path from "node:path";
import { hasErrnoCode } from "../infra/errno.js";

function systemdCgroupEventsPath(controlGroup: string): string {
  if (
    !controlGroup.startsWith("/") ||
    controlGroup === "/" ||
    controlGroup
      .split("/")
      .slice(1)
      .some((part) => !part || part === ".." || part === ".")
  ) {
    throw new Error("The systemd cgroup cannot be verified.");
  }
  return path.join("/sys/fs/cgroup", controlGroup, "cgroup.events");
}

export function isSystemdControlGroupEmpty(controlGroup: string): boolean {
  const file = systemdCgroupEventsPath(controlGroup);
  try {
    // cgroup v2 populated includes descendants, unlike MainPID or cgroup.procs.
    const events = fs.readFileSync(file, "utf8");
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
