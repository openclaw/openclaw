import { normalizeLowercaseStringOrEmpty } from "../shared/string-coerce.js";

export type SystemdUnavailableKind =
  | "missing_systemctl"
  | "user_bus_unavailable"
  | "generic_unavailable";

function normalizeDetail(detail?: string): string {
  return normalizeLowercaseStringOrEmpty(detail);
}

export function isSystemctlMissingDetail(detail?: string): boolean {
  const normalized = normalizeDetail(detail);
  return (
    normalized.includes("not found") ||
    normalized.includes("no such file or directory") ||
    normalized.includes("spawn systemctl enoent") ||
    normalized.includes("spawn systemctl eacces") ||
    normalized.includes("systemctl not available")
  );
}

export function isSystemdUserBusUnavailableDetail(detail?: string): boolean {
  const normalized = normalizeDetail(detail);
  return (
    normalized.includes("failed to connect to bus") ||
    normalized.includes("failed to connect to user scope bus") ||
    normalized.includes("dbus_session_bus_address") ||
    normalized.includes("xdg_runtime_dir") ||
    normalized.includes("no medium found")
  );
}

export function classifySystemdUnavailableDetail(detail?: string): SystemdUnavailableKind | null {
  const normalized = normalizeDetail(detail);
  if (!normalized) {
    return null;
  }
  // Check user-bus failures before missing-systemctl because WSL2's
  // `Failed to connect to bus: No such file or directory` shares the loose
  // "no such file or directory" substring that isSystemctlMissingDetail uses;
  // without this order a present-but-unreachable systemctl gets misreported
  // as "systemctl not available".
  if (isSystemdUserBusUnavailableDetail(normalized)) {
    return "user_bus_unavailable";
  }
  if (isSystemctlMissingDetail(normalized)) {
    return "missing_systemctl";
  }
  if (
    normalized.includes("systemctl --user unavailable") ||
    normalized.includes("systemd user services are required") ||
    normalized.includes("not been booted with systemd") ||
    normalized.includes("not supported")
  ) {
    return "generic_unavailable";
  }
  return null;
}
