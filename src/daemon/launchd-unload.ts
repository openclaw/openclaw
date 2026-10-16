import { sleep } from "../utils/sleep.js";
import { execLaunchctl, isLaunchctlNotLoaded } from "./launchd-exec.js";

/** Native bootout can finish before launchd releases the job's label. */
export async function confirmLaunchdServiceUnloaded(
  serviceTarget: string,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const remainingMs = Math.max(1, deadline - Date.now());
    const probe = await execLaunchctl(["print", serviceTarget], remainingMs);
    if (probe.code !== 0) {
      // A stopped job is still owned; unknown errors and timeouts stay fail-closed.
      return isLaunchctlNotLoaded(probe);
    }
    const delayMs = Math.min(100, deadline - Date.now());
    if (delayMs <= 0) {
      break;
    }
    await sleep(delayMs);
  }
  return false;
}
