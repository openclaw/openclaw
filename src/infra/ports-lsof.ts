import fs from "node:fs";
import { canAccess, canAccessSync } from "./path-existence.js";

const LSOF_CANDIDATES =
  process.platform === "darwin"
    ? ["/usr/sbin/lsof", "/usr/bin/lsof"]
    : ["/usr/bin/lsof", "/usr/sbin/lsof"];

export async function resolveLsofCommand(signal?: AbortSignal): Promise<string> {
  for (const candidate of LSOF_CANDIDATES) {
    signal?.throwIfAborted();
    const executable = await canAccess(candidate, fs.constants.X_OK);
    signal?.throwIfAborted();
    if (executable) {
      return candidate;
    }
  }
  return "lsof";
}

export function resolveLsofCommandSync(): string {
  for (const candidate of LSOF_CANDIDATES) {
    if (canAccessSync(candidate, fs.constants.X_OK)) {
      return candidate;
    }
  }
  return "lsof";
}
