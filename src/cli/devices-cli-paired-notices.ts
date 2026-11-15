// Notes printed with the paired-device list: pending node approvals and OpenClaw ID browsers.
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { sanitizeForLog } from "../../packages/terminal-core/src/ansi.js";
import { terminalText } from "../../packages/terminal-core/src/safe-text.js";
import type { PairedDevice } from "../gateway/device-pairing-list.types.js";
import { formatConnectionFlagReminder } from "./nodes-cli/cli-utils.js";
import type { NodesRpcOpts } from "./nodes-cli/types.js";
import { formatPairingApproveCommand } from "./pairing-command-format.js";

export function stringsMatch(left: unknown, right: unknown): boolean {
  const normalizedLeft = normalizeOptionalString(left);
  const normalizedRight = normalizeOptionalString(right);
  return Boolean(normalizedLeft && normalizedRight && normalizedLeft === normalizedRight);
}

export function pairedDeviceMatchesNodeApprovalQuery(device: PairedDevice, query: string): boolean {
  return (
    stringsMatch(device.deviceId, query) ||
    stringsMatch(device.remoteIp, query) ||
    stringsMatch(device.pendingNodeSurface?.requestId, query) ||
    stringsMatch(device.pendingNodeSurface?.remoteIp, query)
  );
}

function buildPendingNodeApprovalNotice(device: PairedDevice, opts: NodesRpcOpts): string | null {
  const pending = device.pendingNodeSurface;
  const requestId = normalizeOptionalString(pending?.requestId);
  if (!pending || !requestId) {
    return null;
  }
  const action = device.nodeSurface ? "reapproval" : "approval";
  const label =
    normalizeOptionalString(device.operatorLabel) ??
    normalizeOptionalString(pending.displayName) ??
    normalizeOptionalString(device.nodeSurface?.displayName) ??
    normalizeOptionalString(device.displayName) ??
    device.deviceId;
  const command = formatPairingApproveCommand("nodes", requestId, { timeout: opts.timeout });
  const connectionReminder = formatConnectionFlagReminder(opts);
  const lines = [
    terminalText`Node ${action} pending for ${sanitizeForLog(label)}. Run ${sanitizeForLog(command)}`,
  ];
  if (connectionReminder) {
    lines.push(connectionReminder);
  }
  return lines.join("\n");
}

export function findPairedDevicePendingNodeApprovalNotices(
  opts: NodesRpcOpts,
  paired: PairedDevice[] | undefined,
): string[] {
  return (paired ?? []).flatMap((device) => {
    const notice = buildPendingNodeApprovalNotice(device, opts);
    return notice ? [notice] : [];
  });
}

/** Marks a browser the Access page manages; the Gateway refuses to remove it as a device. */
export function openclawIdSuffix(device: PairedDevice): string {
  return device.managedBy === "openclaw-id" ? " (OpenClaw ID)" : "";
}

export function formatOpenClawIdListNote(paired: PairedDevice[]): string | null {
  return paired.some((device) => device.managedBy === "openclaw-id")
    ? "Browsers marked (OpenClaw ID) connect through OpenClaw ID. Manage them on the Access page."
    : null;
}

export function formatKeptOpenClawIdNote(count: number): string {
  return `Kept ${count} OpenClaw ID browser${count === 1 ? "" : "s"}. Manage them on the Access page.`;
}
