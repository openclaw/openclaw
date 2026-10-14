import { buildApprovalResolutionRef } from "../infra/approval-resolution-ref.js";
import type { OperatorApprovalRecord } from "./operator-approval-store.js";
import type { GatewayClient } from "./server-methods/types.js";

export const SOURCE_SESSION_KEY = "agent:main:child";
export const PARENT_SESSION_KEY = "agent:main:parent";

export function createClient(params: {
  connId: string;
  scopes: string[];
  deviceId?: string;
  invalidated?: boolean;
}): GatewayClient {
  return {
    connId: params.connId,
    connect: {
      client: { id: "approval-session-events", displayName: "Approval Session Events" },
      scopes: params.scopes,
      ...(params.deviceId ? { device: { id: params.deviceId } } : {}),
    },
    ...(params.invalidated ? { invalidated: true } : {}),
  } as unknown as GatewayClient;
}

export function createPendingRecord(
  params: {
    id?: string;
    audienceSessionKeys?: string[];
    sourceSessionKey?: string | null;
    reviewerDeviceIds?: string[];
    createdAtMs?: number;
    expiresAtMs?: number;
  } = {},
): OperatorApprovalRecord {
  const id = params.id ?? "approval:child/request?1";
  const createdAtMs = params.createdAtMs ?? 1_000;
  return {
    id,
    resolutionRef: buildApprovalResolutionRef({ approvalId: id, approvalKind: "exec" }),
    kind: "exec",
    status: "pending",
    presentation: {
      kind: "exec",
      commandText: "printf session-approval",
      commandPreview: "printf session-approval",
      warningText: "Review this command",
      host: "gateway",
      nodeId: null,
      agentId: "main",
      allowedDecisions: ["allow-once", "allow-always", "deny"],
    },
    requester: {
      deviceId: "requester-device",
      clientId: "requester-client",
      deviceTokenAuth: true,
    },
    reviewerDeviceIds: params.reviewerDeviceIds ?? ["reviewer-device"],
    source: {
      agentId: "main",
      sessionKey: params.sourceSessionKey ?? SOURCE_SESSION_KEY,
      sessionId: "private-session-id",
      runId: "private-run-id",
      toolCallId: "private-tool-call-id",
      toolName: "exec",
    },
    audienceSessionKeys: params.audienceSessionKeys ?? [SOURCE_SESSION_KEY, PARENT_SESSION_KEY],
    runtimeEpoch: "private-runtime-epoch",
    createdAtMs,
    expiresAtMs: params.expiresAtMs ?? 10_000,
    updatedAtMs: createdAtMs,
    decision: null,
    terminalReason: null,
    resolvedAtMs: null,
    resolver: null,
    consumedAtMs: null,
    consumedBy: null,
  };
}

export function createTerminalRecord(
  pending: OperatorApprovalRecord,
  resolvedAtMs = 2_000,
): OperatorApprovalRecord {
  return {
    ...pending,
    status: "denied",
    updatedAtMs: resolvedAtMs,
    decision: "deny",
    terminalReason: "user",
    resolvedAtMs,
    resolver: { kind: "device", id: "reviewer-device" },
  };
}
