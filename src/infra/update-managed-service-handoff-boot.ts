import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { managedHandoffBootSchema } from "./update-managed-service-handoff-schema.js";

/** Bind the lease environment without caching boot identity or selecting an OS early. */
export function createManagedHandoffBootIdentityReader(serviceManagerEnv: NodeJS.ProcessEnv) {
  return function bootIdentity() {
    let value: string | undefined;
    if (process.platform === "linux") {
      value = fs.readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
    } else if (["freebsd", "darwin", "win32"].includes(process.platform)) {
      const freebsd = process.platform === "freebsd";
      const windows = process.platform === "win32";
      const result = spawnSync(
        windows ? "powershell.exe" : freebsd ? "/sbin/sysctl" : "/usr/sbin/sysctl",
        windows
          ? [
              "-NoProfile",
              "-NonInteractive",
              "-Command",
              "(Get-CimInstance -ClassName Win32_OperatingSystem).LastBootUpTime.ToUniversalTime().ToString('o')",
            ]
          : freebsd
            ? ["-b", "kern.boot_id"]
            : ["-n", "kern.bootsessionuuid"],
        {
          env: serviceManagerEnv,
          ...(freebsd ? { maxBuffer: 16 } : { encoding: "utf8" as const, windowsHide: true }),
          timeout: windows ? 5000 : 1000,
          killSignal: "SIGKILL",
          stdio: ["ignore", "pipe", "ignore"],
        },
      );
      if (!result.error && result.status === 0) {
        // kern.boot_id is 16 random bytes fixed for this boot; kern.boottime changes
        // when the wall clock steps and cannot prove a foreground lease has expired.
        value = freebsd
          ? Buffer.isBuffer(result.stdout) && result.stdout.length === 16
            ? result.stdout.toString("hex")
            : undefined
          : result.stdout.toString().trim();
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
