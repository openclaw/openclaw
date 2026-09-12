/** Native probe facts are diagnostic only; they never grant lifecycle authority. */
const SERVICE_INSPECTION_MESSAGES = {
  "systemd-user-bus-unavailable":
    "The systemd user session bus is unavailable. Check XDG_RUNTIME_DIR and DBUS_SESSION_BUS_ADDRESS for the service account. On Debian/Ubuntu, install dbus-user-session and start dbus.socket in that account's user manager, then retry.",
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

export function formatServiceInspectionReason(reason: ServiceInspectionReason): string {
  return `${SERVICE_INSPECTION_MESSAGES[reason]} ${EXTERNAL_SERVICE_RECOVERY}`;
}

export class ServiceInspectionError extends Error {
  constructor(readonly reason: ServiceInspectionReason) {
    super(formatServiceInspectionReason(reason));
    this.name = "ServiceInspectionError";
  }
}
