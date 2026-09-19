/** Native probe facts are diagnostic only; they never grant lifecycle authority. */
const SERVICE_INSPECTION_MESSAGES = {
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

export function isServiceInspectionReason(value: string): value is ServiceInspectionReason {
  return Object.hasOwn(SERVICE_INSPECTION_MESSAGES, value);
}

export function formatServiceInspectionReason(reason: ServiceInspectionReason): string {
  return reason === "service-manager-unavailable" ||
    reason === "systemd-inspection-deadline-exceeded"
    ? SERVICE_INSPECTION_MESSAGES[reason]
    : `${SERVICE_INSPECTION_MESSAGES[reason]} ${EXTERNAL_SERVICE_RECOVERY}`;
}

export class ServiceInspectionError extends Error {
  constructor(readonly reason: ServiceInspectionReason) {
    super(formatServiceInspectionReason(reason));
    this.name = "ServiceInspectionError";
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

export function sanitizeServiceInspectionError(error: unknown): Error {
  return error instanceof ServiceInspectionError ||
    error instanceof ServiceDefinitionInspectionError
    ? error
    : new Error("SERVICE_DEFINITION_UNKNOWN: Service definition cannot be safely inspected.");
}
