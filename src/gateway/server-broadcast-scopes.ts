import { isProxy } from "node:util/types";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
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
  SESSION_READ_SCOPE,
  TALK_SCOPE,
  WRITE_SCOPE,
} from "./operator-scopes.js";
import type { GatewayPluginEventScope } from "./server-broadcast-types.js";
import type { GatewayWsClient } from "./server/ws-types.js";

// Pairing scope is for device-pairing handshakes only; chat transcript events
// require operator-level session access. Pairing-scoped and node-role clients
// must not passively receive chat-class broadcasts.
const EVENT_SCOPE_GUARDS: Record<string, string[]> = {
  agent: [SESSION_READ_SCOPE],
  chat: [SESSION_READ_SCOPE],
  // This keyless, redacted invalidation tells session readers to refresh their own projection.
  "chat.metadata.changed": [SESSION_READ_SCOPE],
  "board.changed": [READ_SCOPE],
  "board.command": [READ_SCOPE],
  "progressCard.changed": [SESSION_READ_SCOPE],
  "ui.command": [READ_SCOPE],
  "chat.send_timing": [READ_SCOPE],
  "chat.side_result": [SESSION_READ_SCOPE],
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
  "users.prefs.changed": [SESSION_READ_SCOPE],
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
  "sessions.changed": [SESSION_READ_SCOPE],
  "controlUi.sessionPullRequests.changed": [READ_SCOPE],
  "plugins.controlUi.changed": [READ_SCOPE],
  "session.approval": [APPROVALS_SCOPE],
  "session.message": [SESSION_READ_SCOPE],
  "session.observer": [SESSION_READ_SCOPE],
  "session.operation": [READ_SCOPE],
  "session.sharing": [READ_SCOPE],
  "session.sharing.evidence": [READ_SCOPE],
  "session.suggestion": [SESSION_READ_SCOPE],
  "session.typing": [SESSION_READ_SCOPE],
  "session.tool": [SESSION_READ_SCOPE],
  // Operator terminal byte/exit streams. Admin-gated to match the terminal.*
  // methods; also targeted to the owning connection at broadcast time.
  "terminal.data": [ADMIN_SCOPE],
  "terminal.exit": [ADMIN_SCOPE],
  "portal.changed": [READ_SCOPE],
};

const SESSION_CATALOG_INVALIDATIONS = new Set(["delete", "groups", "sharing", "profile-identity"]);

export function isSessionReadInvalidation(
  event: string,
  payload: unknown,
  targeted: boolean,
): boolean {
  if (isProxy(payload) || !isRecord(payload)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(payload);
  if ((prototype !== null && prototype !== Object.prototype) || "toJSON" in payload) {
    return false;
  }
  const fields = Object.entries(Object.getOwnPropertyDescriptors(payload));
  // Hidden/deleted rows send subscribed readers only a signal to repeat an authorized read.
  return (
    event === "sessions.changed" &&
    targeted &&
    Object.hasOwn(payload, "reason") &&
    fields.every(
      ([key, field]) =>
        "value" in field &&
        ((key === "reason" && SESSION_CATALOG_INVALIDATIONS.has(field.value)) ||
          (key === "ts" && typeof field.value === "number" && Number.isFinite(field.value))),
    )
  );
}

export function modelMetadataInvalidationFragment(payload: unknown): string | undefined {
  if (isProxy(payload) || !isRecord(payload)) {
    return undefined;
  }
  const prototype = Object.getPrototypeOf(payload);
  if ((prototype !== null && prototype !== Object.prototype) || "toJSON" in payload) {
    return undefined;
  }
  const keys = Reflect.ownKeys(payload);
  if (keys.length === 0) {
    return ',"payload":{}';
  }
  if (keys.length !== 1 || keys[0] !== "modelSelectionChanged") {
    return undefined;
  }
  const field = Object.getOwnPropertyDescriptor(payload, "modelSelectionChanged");
  return field?.value === true && field.enumerable
    ? ',"payload":{"modelSelectionChanged":true}'
    : undefined;
}

export function hasEventScope(
  client: GatewayWsClient,
  event: string,
  explicitPluginScope?: GatewayPluginEventScope,
  ownRunQuestion = false,
  hasSessionReadContext?: () => boolean,
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
      (required.some(
        (scope) =>
          operatorScopeSatisfied(scope, scopes) &&
          (scope !== SESSION_READ_SCOPE ||
            operatorScopeSatisfied(READ_SCOPE, scopes) ||
            hasSessionReadContext?.() === true),
      ) ||
        (ownRunQuestion && operatorScopeSatisfied("operator.sessions.write", scopes))))
  );
}
