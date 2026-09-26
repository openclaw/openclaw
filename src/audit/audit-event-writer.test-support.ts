import type { DecisionReceiptV1 } from "../../packages/gateway-protocol/src/index.js";
import type { AuditEventInput } from "./audit-event-types.js";
import type { ExecutionIdentityAdmissionEnvelope } from "./execution-identity-admission.js";
import type { TrustedMessageAuditEvent } from "./message-audit-events.js";

export function input(): AuditEventInput {
  return {
    sourceId: "run-1:1:started",
    sourceSequence: 1,
    occurredAt: Date.now(),
    kind: "agent_run",
    action: "agent.run.started",
    status: "started",
    actorType: "agent",
    actorId: "main",
    agentId: "main",
    runId: "run-1",
  };
}

export function messageEvent(
  action:
    | "message.outbound.queued"
    | "message.outbound.platform-started"
    | "message.outbound.finished",
): TrustedMessageAuditEvent {
  const progress = action !== "message.outbound.finished";
  return {
    sourceId: `message-source:${action}`,
    occurredAt: Date.now(),
    kind: "message",
    action,
    status: progress ? "started" : "succeeded",
    outcome:
      action === "message.outbound.queued"
        ? "queued"
        : action === "message.outbound.platform-started"
          ? "platform_started"
          : "sent",
    actorType: "agent",
    actorId: "main",
    agentId: "main",
    runId: "message-worker-run",
    direction: "outbound",
    channel: "qa-channel",
    conversationKind: "direct",
    targetId: "raw-target",
  } as TrustedMessageAuditEvent;
}

export function decisionReceipt(): DecisionReceiptV1 {
  return {
    schemaVersion: 1,
    receiptId: "worker-decision",
    contextId: "worker-context",
    executionId: "worker-execution",
    runId: "worker-run",
    occurredAt: Date.now(),
    action: { family: "tool", operation: "policy" },
    decision: { outcome: "denied", reasonCode: "tool_policy_denied" },
    enforcement: {
      coverageState: "enforced",
      policyRefs: ["tool-policy:deny"],
      grantRefs: [],
      contextFieldsUsed: ["runId"],
    },
    source: {
      owner: "tool-policy",
      recordRef: "worker-record",
      decisionBoundary: "agent-tool.before-call",
    },
    missingEvidence: [],
    remediation: [{ code: "choose_allowed_tool", text: "Choose an allowed tool and retry." }],
  };
}

export function captureWork(envelope: ExecutionIdentityAdmissionEnvelope) {
  return { kind: "capture" as const, envelope };
}
