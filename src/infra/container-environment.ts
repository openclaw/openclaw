import fs from "node:fs";

// Container identity is process-stable; cache misses as well as detections.
let containerEnvironmentCache: boolean | undefined;

export function isContainerEnvironment(): boolean {
  return (containerEnvironmentCache ??= detectContainerEnvironment());
}

function detectContainerEnvironment(): boolean {
  if (process.env.FLY_MACHINE_ID?.trim() && process.env.FLY_APP_NAME?.trim()) {
    return true;
  }

  for (const sentinelPath of ["/.dockerenv", "/run/.containerenv", "/var/run/.containerenv"]) {
    try {
      fs.accessSync(sentinelPath, fs.constants.F_OK);
      return true;
    } catch {
      // Not present; try the next signal.
    }
  }

  try {
    const cgroup = fs.readFileSync("/proc/1/cgroup", "utf8");
    if (
      /\/docker\/|cri-containerd-[0-9a-f]|containerd\/[0-9a-f]{64}|\/kubepods[/.]|\blxc\b/.test(
        cgroup,
      )
    ) {
      return true;
    }
  } catch {
    // /proc may not exist on non-Linux platforms.
  }

  return false;
}

/** @internal test helper */
export function resetContainerEnvironmentCacheForTest(): void {
  containerEnvironmentCache = undefined;
}
