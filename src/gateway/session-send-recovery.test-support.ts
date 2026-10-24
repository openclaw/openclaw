import { WorkerTaskError } from "@openclaw/worker-runtime";
import { GatewayClientRequestError } from "../../packages/gateway-client/src/request-error.js";
import type { SessionPendingInput } from "../config/sessions/session-pending-input.types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { SqliteWorkerError } from "../infra/sqlite-worker-contract.js";
import { AgentDatabaseAdmissionError } from "../state/agent-database-admission.js";
import type { SessionSendDelivery } from "./session-send-delivery.js";
import { SessionStoreUnavailableError } from "./session-utils-store-error.js";

export const terminalRecoveryFailures = [
  new GatewayClientRequestError({
    code: "UNAVAILABLE",
    message: "Admission denied",
    retryable: false,
  }),
  new SqliteWorkerError("Native outcome is unknown", "outcome-unknown"),
  new SessionStoreUnavailableError("main", "read-failed", {
    name: "SqliteError",
    code: "SQLITE_CORRUPT",
    message: "Database is corrupt",
  }),
  new AgentDatabaseAdmissionError({
    agentId: "main",
    paths: [],
    code: "agent-database-ownership-mismatch",
    embeddedOwnerId: "other",
    reason: "Database owner differs",
    repairHint: "Inspect the database owner",
  }),
];

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

export const privateDatabasePath = "/synthetic/private/agents/main/openclaw-agent.sqlite";
export const quarantineCommand = `mv ${privateDatabasePath} /synthetic/private/quarantine/`;
const privateDiagnostic = `Inspection failed at ${privateDatabasePath}; ${quarantineCommand}`;
export const inspectionError = (code: "pending" | "failed", privatePaths = true) =>
  new AgentDatabaseAdmissionError({
    agentId: "main",
    paths: privatePaths ? [privateDatabasePath] : [],
    code: `agent-database-inspection-${code}`,
    reason: privatePaths ? privateDiagnostic : "Inspection is starting",
    repairHint: privatePaths ? quarantineCommand : "Wait for inspection",
  });
const exhausted = {
  reason: "transient-admission",
  attempts: 3,
  description: "the Gateway was still unavailable after 3 automatic attempts",
};

export const recoveryDiagnosticCases = [
  ["capacity", "endpoint", new WorkerTaskError(privateDiagnostic, "overloaded"), exhausted],
  ["pending inspection", "endpoint", inspectionError("pending"), exhausted],
  [
    "failed inspection",
    "endpoint",
    inspectionError("failed"),
    {
      reason: "store-unavailable",
      attempts: 1,
      description: "session storage was unavailable",
    },
  ],
  [
    "unknown",
    "endpoint",
    new Error(privateDiagnostic),
    {
      reason: "unknown",
      attempts: 1,
      description: "delivery failed",
    },
  ],
  [
    "requester preparation capacity",
    "requester",
    new WorkerTaskError(privateDiagnostic, "overloaded"),
    exhausted,
  ],
  [
    "requester authority refusal",
    "requester",
    new Error(privateDiagnostic),
    {
      reason: "requester-unavailable",
      attempts: 1,
      description: "original requester authority is unavailable; submit a new request",
    },
  ],
] as const;
