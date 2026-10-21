import type { SessionPendingInput } from "../config/sessions/session-pending-input.types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { SessionSendDelivery } from "./session-send-delivery.js";

export const delivery: SessionSendDelivery = {
  version: 1,
  runId: "saved-delivery",
  source: {
    agentId: "main",
    sessionKey: "agent:main:source",
    sessionId: "source-id",
    lifecycleRevision: "source-before-reset",
  },
  target: { agentId: "main", sessionKey: "agent:main:target", sessionId: "target-id" },
  sandboxed: false,
  message: "Saved peer update",
};
export const input: SessionPendingInput = {
  id: "saved-input",
  runId: delivery.runId,
  acceptedAt: 1,
  state: "interrupted",
  message: {
    role: "user",
    content: delivery.message,
    timestamp: 1,
    idempotencyKey: `${delivery.runId}:user`,
    provenance: {
      kind: "inter_session",
      sourceTool: "sessions_send",
      sourceSessionKey: delivery.source.sessionKey,
    },
    __openclaw: { sessionSendDelivery: { ...delivery, operatorSource: null } },
  },
};
export const config: OpenClawConfig = {
  agents: { entries: { main: {} } },
  tools: { sessions: { visibility: "all" } },
  session: { communication: { send: "always", receive: "always" } },
};
export const sourceSnapshot = (
  pending = input,
  state = "interrupted",
  consumed_event_id: string | null = null,
) => ({
  snapshot: {
    current: true,
    pending: {
      input_id: pending.id,
      run_id: pending.runId,
      request_hash: "request:original-request-fingerprint",
      state,
      consumed_event_id,
      message_json: JSON.stringify(pending.message),
    },
  },
  assertCurrent() {},
});
