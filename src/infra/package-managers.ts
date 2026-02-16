import fs from "node:fs";
import { hasBinary } from "../shared/config-eval.js";

export type PackageManager =
  | "brew"
  | "apt"
  | "dnf"
  | "pacman"
  | "apk"
  | "npm"
  | "pnpm"
  | "yarn"
  | "bun"
  | "go"
  | "uv";

export type LinuxDistroFamily = "debian" | "rhel" | "arch" | "alpine" | "unknown";

/**
 * Detect the Linux distribution family by reading /etc/os-release.
 */
export function detectLinuxDistroFamily(): LinuxDistroFamily {
  if (process.platform !== "linux") {
    return "unknown";
  }

  try {
    const osRelease = fs.readFileSync("/etc/os-release", "utf-8");
    const lines = osRelease.split("\n");
    let id = "";
    let idLike = "";

    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.startsWith("ID=")) {
        id = trimmed.slice(3).replace(/"/g, "").toLowerCase();
      } else if (trimmed.startsWith("ID_LIKE=")) {
        idLike = trimmed.slice(8).replace(/"/g, "").toLowerCase();
      }
    }

    // Check ID_LIKE first (more specific)
    if (idLike.includes("debian") || idLike.includes("ubuntu")) {
      return "debian";
    }
    if (idLike.includes("rhel") || idLike.includes("fedora") || idLike.includes("centos")) {
      return "rhel";
    }
    if (idLike.includes("arch")) {
      return "arch";
    }
    if (idLike.includes("alpine")) {
      return "alpine";
    }

    // Fallback to ID
    if (id === "debian" || id === "ubuntu") {
      return "debian";
    }
    if (id === "fedora" || id === "rhel" || id === "centos" || id === "rocky" || id === "alma") {
      return "rhel";
    }
    if (id === "arch" || id === "manjaro") {
      return "arch";
    }
    if (id === "alpine") {
      return "alpine";
    }

    return "unknown";
  } catch {
    return "unknown";
  }
}

/**
 * Check if a specific package manager is available on the system.
 */
export function hasPackageManager(pm: PackageManager): boolean {
  switch (pm) {
    case "brew":
      return hasBinary("brew");
    case "apt":
      return hasBinary("apt-get");
    case "dnf":
      return hasBinary("dnf");
    case "pacman":
      return hasBinary("pacman");
    case "apk":
      return hasBinary("apk");
    case "npm":
      return hasBinary("npm");
    case "pnpm":
      return hasBinary("pnpm");
    case "yarn":
      return hasBinary("yarn");
    case "bun":
      return hasBinary("bun");
    case "go":
      return hasBinary("go");
    case "uv":
      return hasBinary("uv");
    default:
      return false;
  }
}

/**
 * Get the native package manager for the current platform.
 * Returns undefined if not on a supported Linux distro or macOS.
 */
export function getNativePackageManager(): PackageManager | undefined {
  const platform = process.platform;

  if (platform === "darwin") {
    return hasPackageManager("brew") ? "brew" : undefined;
  }

  if (platform === "linux") {
    const distro = detectLinuxDistroFamily();
    switch (distro) {
      case "debian":
        return hasPackageManager("apt") ? "apt" : undefined;
      case "rhel":
        return hasPackageManager("dnf") ? "dnf" : undefined;
      case "arch":
        return hasPackageManager("pacman") ? "pacman" : undefined;
      case "alpine":
        return hasPackageManager("apk") ? "apk" : undefined;
      default:
        return undefined;
    }
  }

  return undefined;
}

/**
 * Get available package managers in priority order for the current platform.
 * This helps determine the install fallback chain.
 */
export function getAvailablePackageManagers(): PackageManager[] {
  const available: PackageManager[] = [];
  const platform = process.platform;

  if (platform === "darwin") {
    // macOS: prefer brew
    if (hasPackageManager("brew")) {
      available.push("brew");
    }
  } else if (platform === "linux") {
    // Linux: prefer native package manager, then brew (Linuxbrew)
    const native = getNativePackageManager();
    if (native) {
      available.push(native);
    }
    if (hasPackageManager("brew")) {
      available.push("brew");
    }
  } else {
    // Windows or other: check for brew
    if (hasPackageManager("brew")) {
      available.push("brew");
    }
  }

  // Add language-specific package managers
  if (hasPackageManager("uv")) {
    available.push("uv");
  }
  if (hasPackageManager("go")) {
    available.push("go");
  }

  // Add Node package managers
  if (hasPackageManager("pnpm")) {
    available.push("pnpm");
  }
  if (hasPackageManager("yarn")) {
    available.push("yarn");
  }
  if (hasPackageManager("bun")) {
    available.push("bun");
  }
  if (hasPackageManager("npm")) {
    available.push("npm");
  }

  return available;
}
