import fs from "node:fs";

/**
 * Best-effort check for whether the process is running inside a container
 * (Docker, Kubernetes, LXC, etc.) on Linux.
 *
 * Chrome requires --no-sandbox when running as root or in most container
 * environments because the kernel sandboxing primitives (user namespaces)
 * are typically unavailable or restricted.
 *
 * Returns false on non-Linux platforms or when the check cannot be performed.
 */
export function isRunningInContainer(): boolean {
  if (process.platform !== "linux") {
    return false;
  }
  try {
    // Docker/OCI creates /.dockerenv; Podman creates /run/.containerenv.
    if (fs.existsSync("/.dockerenv") || fs.existsSync("/run/.containerenv")) {
      return true;
    }
    // cgroup v1: look for "docker" or "kubepods" in /proc/1/cgroup.
    try {
      const cgroup = fs.readFileSync("/proc/1/cgroup", "utf8");
      if (/docker|kubepods|lxc|containerd/i.test(cgroup)) {
        return true;
      }
    } catch {
      // /proc/1/cgroup may not be readable from unprivileged processes.
    }
    // Running as root is a strong signal for a container/CI environment where
    // Chrome's SUID sandbox is typically not available.
    if (process.getuid?.() === 0) {
      return true;
    }
  } catch {
    // Any unexpected error: be conservative and return false.
  }
  return false;
}
