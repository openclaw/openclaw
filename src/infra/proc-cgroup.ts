import fs from "node:fs";

/**
 * Read the systemd service cgroup for a pid from `/proc/<pid>/cgroup`.
 *
 * Returns the service unit name (e.g. `openclaw-host-gateway.service`) when
 * the pid lives inside a `*.service` cgroup (either cgroup v2 unified
 * hierarchy or a legacy controller), or `null` when:
 *   - the file does not exist or cannot be read (non-Linux, permission issues);
 *   - the pid is not inside a `.service` cgroup (e.g. a user-session scope);
 *   - the content cannot be parsed.
 *
 * This is intentionally best-effort and synchronous: callers use it as a
 * cheap tie-breaker when classifying listener processes.
 */
export function readProcessServiceCgroup(pid: number): string | null {
  if (!Number.isFinite(pid) || pid <= 0) {
    return null;
  }
  if (process.platform !== "linux") {
    return null;
  }
  let content: string;
  try {
    content = fs.readFileSync(`/proc/${pid}/cgroup`, "utf8");
  } catch {
    return null;
  }
  return extractServiceCgroupFromCgroupContent(content);
}

/**
 * Extract the first `*.service` basename from the content of
 * `/proc/<pid>/cgroup`. Exported for tests.
 */
export function extractServiceCgroupFromCgroupContent(content: string): string | null {
  if (!content) {
    return null;
  }
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) {
      continue;
    }
    // cgroup v2: "0::/system.slice/openclaw-host-gateway.service"
    // cgroup v1: "<id>:<controller>:/system.slice/foo.service"
    // Take the portion after the last ":" (the path) and find the
    // last ".service" segment.
    const pathIdx = line.lastIndexOf(":");
    const pathPart = pathIdx >= 0 ? line.slice(pathIdx + 1) : line;
    const serviceName = findServiceSegment(pathPart);
    if (serviceName) {
      return serviceName;
    }
  }
  return null;
}

function findServiceSegment(pathPart: string): string | null {
  if (!pathPart) {
    return null;
  }
  // Walk segments from leaf to root so scoped subunits (e.g.
  // "/system.slice/foo.service/bar") still resolve to the owning service.
  const segments = pathPart.split("/").filter(Boolean);
  for (let i = segments.length - 1; i >= 0; i -= 1) {
    const segment = segments[i];
    if (segment && segment.endsWith(".service")) {
      return segment;
    }
  }
  return null;
}
