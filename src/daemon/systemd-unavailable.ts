/** Classifies systemd/systemctl unavailable errors into user-facing categories. */
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import type { ServiceInspectionReason } from "./service-inspection-error.js";
import type { GatewayServiceEnv } from "./service-types.js";

/** Failed user routes alone cannot distinguish a missing manager from a missing session bus. */
export async function resolveUnavailableSystemdInspectionReason(
  reason: "systemd-user-bus-unavailable" | "systemd-busctl-unavailable",
  env: GatewayServiceEnv,
  deadline: number,
): Promise<ServiceInspectionReason> {
  const { execFileUtf8 } = await import("./exec-file.js");
  const timeout = Math.floor(deadline - performance.now());
  if (timeout <= 0) {
    return reason;
  }
  const result = await execFileUtf8("systemctl", ["--system", "is-system-running"], {
    env: { ...process.env, ...env },
    timeout,
    killSignal: "SIGKILL",
  });
  return (reason === "systemd-busctl-unavailable" &&
    result.termination === "error" &&
    result.errorCode === "ENOENT") ||
    (result.termination === "exit" &&
      (result.stdout.trim() === "offline" ||
        result.stderr.includes("System has not been booted with systemd")))
    ? "service-manager-unavailable"
    : reason;
}

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
    normalized === "call failed: process org.freedesktop.systemd1 exited with status 1" ||
    normalized ===
      "call failed: the name org.freedesktop.systemd1 was not provided by any .service files" ||
    normalized.includes("enomedium") ||
    normalized.includes("no medium found")
  );
}

export function classifySystemdUnavailableDetail(detail?: string): SystemdUnavailableKind | null {
  const normalized = normalizeDetail(detail);
  if (!normalized) {
    return null;
  }
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
