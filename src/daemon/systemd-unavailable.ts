/** Classifies systemd/systemctl unavailable errors into user-facing categories. */
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import type { ExecResult } from "./exec-file.js";

export type SystemdUnavailableKind =
  | "missing_systemctl"
  | "user_bus_unavailable"
  | "generic_unavailable";

// Normalizes platform command output before matching known systemd failure families.
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
    normalized.includes("enomedium") ||
    normalized.includes("no medium found")
  );
}
/** True when busctl itself rejected the invocation, e.g. systemd < 240 has no --json flag. */
function isBusctlJsonUnsupportedDetail(detail?: string): boolean {
  const normalized = normalizeDetail(detail);
  return normalized.includes("unrecognized option") && normalized.includes("--json");
}
/** errno-style marker: busctl rejected --json, so no JSON inspection is possible on this host. */
export const BUSCTL_JSON_UNSUPPORTED_CODE = "BUSCTL_JSON_UNSUPPORTED";
/**
 * Throws the branded marker when busctl itself rejected the --json invocation.
 * Native stderr never leaves the boundary; callers match the marker with hasErrnoCode.
 */
export function throwIfBusctlJsonUnsupported(result: ExecResult): void {
  if (result.termination === "exit" && isBusctlJsonUnsupportedDetail(result.stderr.trim())) {
    const unsupported: NodeJS.ErrnoException = new Error(
      "busctl does not support --json output on this host.",
    );
    unsupported.code = BUSCTL_JSON_UNSUPPORTED_CODE;
    throw unsupported;
  }
}

export function classifySystemdUnavailableDetail(detail?: string): SystemdUnavailableKind | null {
  const normalized = normalizeDetail(detail);
  if (!normalized) {
    return null;
  }
  // Order matters: missing systemctl has different remediation from a live
  // systemd install whose user bus is unavailable.
  if (isSystemctlMissingDetail(normalized)) {
    return "missing_systemctl";
  }
  if (isSystemdUserBusUnavailableDetail(normalized)) {
    return "user_bus_unavailable";
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
