import { operatorScopeSatisfied } from "../shared/operator-scope-compat.js";
import {
  GATEWAY_EVENT_DEVICE_PAIR_CHANGED,
  GATEWAY_EVENT_NODE_RUNNER_INVENTORY_CHANGED,
  GATEWAY_EVENT_UPDATE_RUN_CHANGED,
} from "./events.js";
import {
  ADMIN_SCOPE,
  APPROVALS_SCOPE,
  PAIRING_SCOPE,
  QUESTIONS_SCOPE,
  READ_SCOPE,
  TALK_SCOPE,
  WRITE_SCOPE,
} from "./method-scopes.js";
import type { GatewayPluginEventScope } from "./server-broadcast-types.js";
import type { GatewayWsClient } from "./server/ws-types.js";

// Pairing scope is for device-pairing handshakes only; chat transcript events
// require operator-level session access. Pairing-scoped and node-role clients
// must not passively receive chat-class broadcasts.
const EVENT_SCOPE_GUARDS: Record<string, string[]> = {
  agent: [READ_SCOPE],
  chat: [READ_SCOPE],
  // This keyless, redacted invalidation tells session readers to refresh their own projection.
  "chat.metadata.changed": [READ_SCOPE, "operator.sessions.read"],
  "board.changed": [READ_SCOPE],
  "board.command": [READ_SCOPE],
  "progressCard.changed": [READ_SCOPE],
  "ui.command": [READ_SCOPE],
  "chat.send_timing": [READ_SCOPE],
  "chat.side_result": [READ_SCOPE],
  cron: [READ_SCOPE],
  health: [],
  "exec.approval.requested": [APPROVALS_SCOPE],
  "exec.approval.resolved": [APPROVALS_SCOPE],
  "question.requested": [QUESTIONS_SCOPE],
  "question.resolved": [QUESTIONS_SCOPE],
  heartbeat: [],
  "plugin.approval.requested": [APPROVALS_SCOPE],
  "plugin.approval.resolved": [APPROVALS_SCOPE],
  "openclaw.approval.requested": [APPROVALS_SCOPE],
  "openclaw.approval.resolved": [APPROVALS_SCOPE],
  // The frame cadence itself exposes person activity; match system-presence access.
  presence: [READ_SCOPE],
  shutdown: [],
  "gateway.suspension": [],
  tick: [],
  "talk.event": [READ_SCOPE],
  "talk.mode": [TALK_SCOPE],
  "talk.voice.change": [TALK_SCOPE],
  task: [READ_SCOPE],
  "task.suggestion": [READ_SCOPE],
  "update.available": [],
  [GATEWAY_EVENT_UPDATE_RUN_CHANGED]: [ADMIN_SCOPE],
  // Hash-only change notice after a persisted config write; content stays
  // behind the operator-scoped config.get.
  "config.changed": [READ_SCOPE],
  "users.prefs.changed": [READ_SCOPE],
  "mentions.changed": [READ_SCOPE],
  "skills.changed": [READ_SCOPE],
  "plugins.changed": [READ_SCOPE],
  "plugins.install.progress": [ADMIN_SCOPE],
  "voicewake.changed": [READ_SCOPE],
  "voicewake.routing.changed": [READ_SCOPE],
  [GATEWAY_EVENT_DEVICE_PAIR_CHANGED]: [PAIRING_SCOPE],
  "device.pair.requested": [PAIRING_SCOPE],
  "device.pair.resolved": [PAIRING_SCOPE],
  "device.pair.setup.completed": [PAIRING_SCOPE],
  "device.pair.setup.deliveryUncertain": [PAIRING_SCOPE],
  "node.pair.requested": [PAIRING_SCOPE],
  "node.pair.resolved": [PAIRING_SCOPE],
  "node.presence": [READ_SCOPE],
  "node.hostStats": [READ_SCOPE],
  [GATEWAY_EVENT_NODE_RUNNER_INVENTORY_CHANGED]: [READ_SCOPE],
  "sessions.catalog.host": [READ_SCOPE],
  "sessions.changed": [READ_SCOPE],
  "controlUi.sessionPullRequests.changed": [READ_SCOPE],
  "plugins.controlUi.changed": [READ_SCOPE],
  "session.approval": [APPROVALS_SCOPE],
  "session.message": [READ_SCOPE],
  "session.observer": [READ_SCOPE],
  "session.operation": [READ_SCOPE],
  "session.sharing": [READ_SCOPE],
  "session.sharing.evidence": [READ_SCOPE],
  "session.suggestion": [READ_SCOPE],
  "session.typing": [READ_SCOPE],
  "session.tool": [READ_SCOPE],
  // Operator terminal byte/exit streams. Admin-gated to match the terminal.*
  // methods; also targeted to the owning connection at broadcast time.
  "terminal.data": [ADMIN_SCOPE],
  "terminal.exit": [ADMIN_SCOPE],
  "portal.changed": [READ_SCOPE],
};

export function hasEventScope(
  client: GatewayWsClient,
  event: string,
  explicitPluginScope?: GatewayPluginEventScope,
  ownRunQuestion = false,
): boolean {
  if (client.connectionKind === "worker") {
    return false;
  }
  const role = client.connect.role ?? "operator";
  const scopes = Array.isArray(client.connect.scopes) ? client.connect.scopes : [];
  const required = EVENT_SCOPE_GUARDS[event];
  const pluginScope =
    explicitPluginScope || (!required && event.startsWith("plugin.") ? WRITE_SCOPE : undefined);
  if (pluginScope) {
    return role === "operator" && operatorScopeSatisfied(pluginScope, scopes);
  }
  if (!required) {
    return false;
  }
  return (
    required.length === 0 ||
    (role === "operator" &&
      (required.some((scope) => operatorScopeSatisfied(scope, scopes)) ||
        (ownRunQuestion && operatorScopeSatisfied("operator.sessions.write", scopes))))
  );
}
