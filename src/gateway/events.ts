import type {
  UpdateAvailable,
  UpdateScheduleState,
} from "../../packages/gateway-protocol/src/index.js";
import { roleScopesAllow } from "../shared/operator-scope-compat.js";
import { READ_SCOPE } from "./operator-scopes.js";

export const GATEWAY_EVENT_DEVICE_PAIR_CHANGED = "device.pair.changed" as const;

export const GATEWAY_EVENT_NODE_RUNNER_INVENTORY_CHANGED = "node.runnerInventory.changed" as const;

export const GATEWAY_EVENT_UPDATE_AVAILABLE = "update.available" as const;

/** Active update ledger progress; detailed records remain admin-scoped. */
export const GATEWAY_EVENT_UPDATE_RUN_CHANGED = "update.run.changed" as const;

/** Gateway event names that clients can subscribe to or receive over the wire. */
export const GATEWAY_EVENTS = [
  "connect.challenge",
  "agent",
  "agent.identity.changed",
  "chat",
  "chat.metadata.changed",
  "models.snapshot",
  "ui.command",
  "session.approval",
  "session.message",
  "session.narration",
  "session.observer",
  "session.operation",
  "session.sharing",
  "session.sharing.evidence",
  "session.suggestion",
  "session.reaction",
  "session.typing",
  "session.tool",
  "sessions.changed",
  "sessions.processes.changed",
  "socket.drain",
  "controlUi.sessionPullRequests.changed",
  "plugins.controlUi.changed",
  "presence",
  "tick",
  "talk.mode",
  "talk.event",
  "talk.voice.change",
  "shutdown",
  "gateway.suspension",
  "health",
  "heartbeat",
  "cron",
  "cron.inventory.changed",
  "task.suggestion",
  "node.pair.requested",
  "node.pair.resolved",
  "node.presence",
  "node.hostStats",
  GATEWAY_EVENT_NODE_RUNNER_INVENTORY_CHANGED,
  "node.invoke.cancel",
  "node.invoke.input",
  "node.invoke.request",
  GATEWAY_EVENT_DEVICE_PAIR_CHANGED,
  "device.pair.requested",
  "device.pair.resolved",
  "device.pair.setup.completed",
  "device.pair.setup.deliveryUncertain",
  "users.prefs.changed",
  "skills.changed",
  "plugins.changed",
  "plugins.install.progress",
  "voicewake.changed",
  "voicewake.routing.changed",
  "exec.approval.requested",
  "exec.approval.resolved",
  "question.requested",
  "question.resolved",
  "plugin.approval.requested",
  "plugin.approval.resolved",
  "openclaw.approval.requested",
  "openclaw.approval.resolved",
  "terminal.data",
  "terminal.exit",
  GATEWAY_EVENT_UPDATE_AVAILABLE,
  GATEWAY_EVENT_UPDATE_RUN_CHANGED,
  "portal.changed",
  "progressCard.changed",
  "mentions.changed",
  "mentions.failed",
];

export function canReadDetailedUpdateMetadata(role: string, scopes: readonly string[]): boolean {
  return roleScopesAllow({
    role,
    requestedScopes: [READ_SCOPE],
    allowedScopes: scopes,
  });
}

/** Projects update availability to the pre-detail wire shape for clients without read access. */
export function projectUpdateAvailable(
  updateAvailable: UpdateAvailable | null | undefined,
  includeDetails: boolean,
): UpdateAvailable | null | undefined {
  if (!updateAvailable || includeDetails) {
    return updateAvailable;
  }
  return {
    currentVersion: updateAvailable.currentVersion,
    latestVersion: updateAvailable.latestVersion,
    channel: updateAvailable.channel,
  };
}

export type GatewayUpdateAvailableEventPayload = {
  updateAvailable: UpdateAvailable | null;
  schedule?: UpdateScheduleState;
};
