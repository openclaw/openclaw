import fsSync from "node:fs";

const LINUX_BOOT_ID_PATH = "/proc/sys/kernel/random/boot_id";
const BOOT_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Cache only a successful read: the kernel boot identity lasts for the process.
// Failed reads must retry so a transiently unreadable procfs cannot pin null.
let cachedBootId: string | null = null;

/**
 * Read the current kernel boot identity.
 *
 * Linux exposes a per-boot UUID at /proc/sys/kernel/random/boot_id that stays
 * readable under hidepid procfs mounts, SELinux signal denials, and systemd
 * ProtectProc=, where foreign PID probes (kill(pid, 0) → EPERM, missing
 * /proc/<pid>/stat) cannot distinguish a live owner from a reused PID after a
 * reboot. Returns null on other platforms or when the identity is unavailable.
 */
export function readBootId(): string | null {
  if (cachedBootId !== null) {
    return cachedBootId;
  }
  if (process.platform !== "linux") {
    return null;
  }
  try {
    const bootId = fsSync.readFileSync(LINUX_BOOT_ID_PATH, "utf8").trim();
    if (!BOOT_ID_PATTERN.test(bootId)) {
      return null;
    }
    cachedBootId = bootId.toLowerCase();
    return cachedBootId;
  } catch {
    return null;
  }
}

/** Drop the cached boot identity so tests can mock procfs reads again. */
export function resetBootIdCacheForTest(): void {
  cachedBootId = null;
}
