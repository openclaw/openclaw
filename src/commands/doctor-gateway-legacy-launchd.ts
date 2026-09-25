// Removes legacy launchd services only after confirming their jobs are unloaded.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execLaunchctl, isLaunchctlNotLoaded } from "../daemon/launchd-exec.js";
import { hasErrnoCode } from "../infra/errno.js";

const DOCTOR_LAUNCHCTL_TIMEOUT_MS = 5_000;
const DOCTOR_LAUNCHCTL_CONFIRM_POLL_MS = 100;
async function confirmLegacyLaunchdServiceUnloaded(serviceTarget: string): Promise<boolean> {
  const deadline = Date.now() + DOCTOR_LAUNCHCTL_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const remainingMs = Math.max(1, deadline - Date.now());
    const probe = await execLaunchctl(
      ["print", serviceTarget],
      Math.min(DOCTOR_LAUNCHCTL_TIMEOUT_MS, remainingMs),
    );
    if (probe.code !== 0) {
      // A successful print (including a stopped job) means launchd still owns
      // the label. Unknown errors and probe timeouts stay fail-closed.
      return isLaunchctlNotLoaded(probe);
    }
    const delayMs = Math.min(DOCTOR_LAUNCHCTL_CONFIRM_POLL_MS, deadline - Date.now());
    if (delayMs <= 0) {
      break;
    }
    await new Promise<void>((resolve) => {
      setTimeout(resolve, delayMs);
    });
  }
  return false;
}

export async function cleanupLegacyLaunchdService(params: {
  label: string;
  plistPath: string;
}): Promise<{ status: "removed"; destination?: string } | { status: "failed"; reason: string }> {
  const domain = typeof process.getuid === "function" ? `gui/${process.getuid()}` : "gui/501";
  await execLaunchctl(["bootout", domain, params.plistPath], DOCTOR_LAUNCHCTL_TIMEOUT_MS);
  await execLaunchctl(["unload", params.plistPath], DOCTOR_LAUNCHCTL_TIMEOUT_MS);

  // bootout/unload can return before launchd finishes stopping the job. A plist
  // must stay in place unless a bounded print probe observes the label gone.
  if (!(await confirmLegacyLaunchdServiceUnloaded(`${domain}/${params.label}`))) {
    return { status: "failed", reason: "launchctl could not confirm unload" };
  }

  const trashDir = path.join(os.homedir(), ".Trash");
  try {
    await fs.mkdir(trashDir, { recursive: true });
  } catch {
    // ignore
  }

  try {
    await fs.access(params.plistPath);
  } catch (error) {
    if (hasErrnoCode(error, "ENOENT")) {
      return { status: "removed" };
    }
    return { status: "failed", reason: "could not inspect plist" };
  }

  const dest = path.join(trashDir, `${params.label}-${Date.now()}.plist`);
  try {
    await fs.rename(params.plistPath, dest);
    return { status: "removed", destination: dest };
  } catch {
    return { status: "failed", reason: "could not move plist" };
  }
}
