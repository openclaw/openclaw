import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { managedHandoffBootSchema } from "./update-managed-service-handoff-schema.js";

/** Bind the lease environment without caching boot identity or selecting an OS early. */
export function createManagedHandoffBootIdentityReader(serviceManagerEnv: NodeJS.ProcessEnv) {
  return function bootIdentity() {
    let value: string | undefined;
    if (process.platform === "linux") {
      value = fs.readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
    } else if (process.platform === "freebsd") {
      // kern.boot_id is 16 random bytes fixed for this boot; kern.boottime changes
      // when the wall clock steps and cannot prove a foreground lease has expired.
      const result = spawnSync("/sbin/sysctl", ["-b", "kern.boot_id"], {
        env: serviceManagerEnv,
        timeout: 1000,
        maxBuffer: 16,
        killSignal: "SIGKILL",
        stdio: ["ignore", "pipe", "ignore"],
      });
      if (
        !result.error &&
        result.status === 0 &&
        Buffer.isBuffer(result.stdout) &&
        result.stdout.length === 16
      ) {
        value = result.stdout.toString("hex");
      }
    } else if (process.platform === "darwin" || process.platform === "win32") {
      const windows = process.platform === "win32";
      const result = spawnSync(
        windows ? "powershell.exe" : "/usr/sbin/sysctl",
        windows
          ? [
              "-NoProfile",
              "-NonInteractive",
              "-Command",
              "(Get-CimInstance -ClassName Win32_OperatingSystem).LastBootUpTime.ToUniversalTime().ToString('o')",
            ]
          : ["-n", "kern.bootsessionuuid"],
        {
          env: serviceManagerEnv,
          encoding: "utf8",
          timeout: windows ? 5000 : 1000,
          killSignal: "SIGKILL",
          windowsHide: true,
          stdio: ["ignore", "pipe", "ignore"],
        },
      );
      if (!result.error && result.status === 0) {
        value = result.stdout.trim();
      }
    }
    // Unknown boot identities cannot be replaced with uptime or a wall-clock guess.
    const boot = {
      platform: process.platform,
      identity: process.platform === "win32" ? value : value?.toLowerCase(),
    };
    const parsed = managedHandoffBootSchema.safeParse(boot);
    if (!parsed.success) {
      throw new Error("OS boot identity unavailable; run openclaw triage manually");
    }
    return parsed.data;
  };
}
