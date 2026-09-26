import { collectNestedErrorCandidates } from "../infra/error-graph-internal.js";
import { UPDATE_PREFLIGHT_DETAILS } from "../infra/update-preflight-details.js";
import { hasCommandProcessCleanupError } from "../process/exec-result.js";

/** Native probe facts are diagnostic only; they never grant lifecycle authority. */
const SERVICE_INSPECTION_MESSAGES = {
  "service-membership-unverified": UPDATE_PREFLIGHT_DETAILS["service-membership-unverified"],
  "service-ancestry-unverified": UPDATE_PREFLIGHT_DETAILS["service-ancestry-unverified"],
  "service-manager-unavailable":
    "No supported service manager detected. Restart the Gateway you launched manually after the update.",
  "systemd-user-bus-unavailable":
    "The systemd user session bus is unavailable. Check XDG_RUNTIME_DIR for the service account. Log in once or enable the user manager with sudo loginctl enable-linger <user>, then verify systemctl --user status. On Debian/Ubuntu, install dbus-user-session and run systemctl --user start dbus.socket if the runtime bus is missing. Verify busctl --user list with DBUS_SESSION_BUS_ADDRESS=unix:path=$XDG_RUNTIME_DIR/bus, then retry.",
  "systemd-inspection-deadline-exceeded":
    "The systemd manager inspection deadline expired while probing the manager or checking custody/admission guards. This does not establish that the user session bus is unavailable. Run openclaw gateway status --deep to inspect the service after recovery.",
  "systemd-busctl-unavailable":
    "The busctl executable is unavailable. Install the systemd package providing busctl and verify busctl --user list from the service account, then retry.",
  "service-manager-access-denied":
    "The service-manager probe could not start (EACCES/EPERM). Check executable permissions and directory access for the service account, then retry from an accessible directory.",
  "windows-task-inspection-failed":
    "Effective Scheduled Task service command could not be inspected. Verify that Windows Task Scheduler is available and that this account can query the task, then run openclaw gateway status --deep before retrying.",
  "launchd-gui-domain-unavailable":
    "The launchd GUI domain is unavailable for this account. Manage its LaunchAgent from the target user's logged-in macOS desktop session.",
  "launchd-system-domain-unavailable":
    "The launchd system domain cannot be queried by this account. Ask root to inspect it with sudo launchctl print system/<label>. OpenClaw manages user LaunchAgents, not custom system LaunchDaemons.",
  "launchd-system-owned":
    "The Gateway label belongs to a system LaunchDaemon. OpenClaw manages user LaunchAgents; the custom system daemon belongs to its deployment owner.",
} as const;

const EXTERNAL_SERVICE_RECOVERY =
  "If an external supervisor owns this Gateway, have its owner stop it, then run Doctor as the state-owning account with OPENCLAW_SERVICE_REPAIR_POLICY=external. This skips native maintenance inspection and service mutations, keeps Gateway/state coordinators and agent-database lease checks, and leaves shutdown/restart with the owner. See https://docs.openclaw.ai/gateway#existing-system-launchdaemons.";

export type ServiceInspectionReason = keyof typeof SERVICE_INSPECTION_MESSAGES;

export type ServiceInspectionDiagnostic =
  | { kind: "timeout"; timeoutMs: number }
  | { kind: "spawn"; errno?: number }
  | { kind: "invalid-response" }
  | { kind: "native"; exitCode: number | null; hresult?: number };

export function isServiceInspectionReason(value: string): value is ServiceInspectionReason {
  return Object.hasOwn(SERVICE_INSPECTION_MESSAGES, value);
}

export function formatServiceInspectionReason(reason: ServiceInspectionReason): string {
  return reason === "service-ancestry-unverified" ||
    reason === "service-membership-unverified" ||
    reason === "service-manager-unavailable" ||
    reason === "systemd-inspection-deadline-exceeded" ||
    reason === "windows-task-inspection-failed"
    ? SERVICE_INSPECTION_MESSAGES[reason]
    : `${SERVICE_INSPECTION_MESSAGES[reason]} ${EXTERNAL_SERVICE_RECOVERY}`;
}

function formatServiceInspectionDiagnostic(
  diagnostic: ServiceInspectionDiagnostic,
): string | undefined {
  switch (diagnostic.kind) {
    case "timeout":
      return Number.isSafeInteger(diagnostic.timeoutMs) && diagnostic.timeoutMs > 0
        ? `Task Scheduler probe timed out after ${diagnostic.timeoutMs} ms.`
        : "Task Scheduler probe timed out.";
    case "spawn":
      return `Task Scheduler probe could not start${Number.isSafeInteger(diagnostic.errno) ? ` (errno ${diagnostic.errno})` : ""}.`;
    case "invalid-response":
      return "Task Scheduler probe returned an invalid response.";
    case "native": {
      const facts: string[] = [];
      if (Number.isSafeInteger(diagnostic.exitCode)) {
        facts.push(`exit ${diagnostic.exitCode}`);
      }
      if (
        typeof diagnostic.hresult === "number" &&
        Number.isInteger(diagnostic.hresult) &&
        diagnostic.hresult >= -0x80000000 &&
        diagnostic.hresult <= 0x7fffffff
      ) {
        facts.push(`HRESULT 0x${(diagnostic.hresult >>> 0).toString(16).padStart(8, "0")}`);
      }
      return `Task Scheduler probe failed${facts.length ? ` (${facts.join(", ")})` : ""}.`;
    }
  }
  return undefined;
}

export class ServiceInspectionError extends Error {
  constructor(
    readonly reason: ServiceInspectionReason,
    diagnostic?: ServiceInspectionDiagnostic,
  ) {
    const detail =
      reason === "windows-task-inspection-failed" && diagnostic
        ? formatServiceInspectionDiagnostic(diagnostic)
        : undefined;
    super(
      [detail, formatServiceInspectionReason(reason)].filter(Boolean).join(" "),
      diagnostic ? { cause: diagnostic } : undefined,
    );
    this.name = "ServiceInspectionError";
  }
}

const SERVICE_OWNERSHIP_REFUSALS = {
  "systemd-account-refused":
    "System systemd Gateway runs as another account; run Doctor as the service's User= account.",
  "systemd-manager-changed":
    "The systemd manager identity changed after Gateway inspection; refusing service activation. Run openclaw gateway status --deep and inspect its current owner.",
  "systemd-unit-changed":
    "The systemd Gateway unit identity changed after inspection; refusing service activation. Run openclaw gateway status --deep and inspect its current definition.",
  "systemd-competing-managers":
    "Both user and system systemd units own this Gateway name. Run openclaw doctor interactively to inspect the competing supervisors before maintenance.",
  "launchd-system-owned": SERVICE_INSPECTION_MESSAGES["launchd-system-owned"],
} as const;

/** An observed ownership decision must never become diagnostic fallback authority. */
export class ServiceOwnershipRefusalError extends Error {
  constructor(
    readonly reason: keyof typeof SERVICE_OWNERSHIP_REFUSALS,
    message: string = SERVICE_OWNERSHIP_REFUSALS[reason],
  ) {
    super(message);
    this.name = "ServiceOwnershipRefusalError";
  }
}

export function findServiceOwnershipRefusal(
  error: unknown,
): ServiceOwnershipRefusalError | undefined {
  for (const candidate of collectNestedErrorCandidates(error)) {
    if (candidate instanceof ServiceOwnershipRefusalError) {
      return candidate;
    }
    if (
      candidate instanceof ServiceInspectionError &&
      candidate.reason === "launchd-system-owned"
    ) {
      return new ServiceOwnershipRefusalError(candidate.reason);
    }
  }
  return undefined;
}

/** Neither unsettled native children nor ownership refusals are diagnostic failures. */
export function assertServiceInspectionFallbackAllowed(error: unknown): void {
  if (hasCommandProcessCleanupError(error)) {
    throw error;
  }
  const refusal = findServiceOwnershipRefusal(error);
  if (refusal) {
    throw refusal;
  }
}

export class ServiceDefinitionInspectionError extends Error {
  constructor(pathname: string) {
    super(
      `SERVICE_DEFINITION_UNKNOWN: Service definition ${JSON.stringify(pathname)} is unreadable. Inspect the file and its parent directory permissions as the service account; ask its owner to repair it before retrying.`,
    );
    this.name = "ServiceDefinitionInspectionError";
  }
}

export class GatewayServiceStopUnsafeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GatewayServiceStopUnsafeError";
  }
}

/** Native preparation can wrap a custody refusal alongside an authority or cleanup failure. */
export function hasGatewayServiceStopUnsafeError(error: unknown): boolean {
  return collectNestedErrorCandidates(error).some(
    (candidate) => candidate instanceof GatewayServiceStopUnsafeError,
  );
}

export function sanitizeServiceInspectionError(error: unknown): Error {
  return error instanceof ServiceInspectionError ||
    error instanceof ServiceDefinitionInspectionError ||
    error instanceof ServiceOwnershipRefusalError
    ? error
    : new Error("SERVICE_DEFINITION_UNKNOWN: Service definition cannot be safely inspected.");
}
